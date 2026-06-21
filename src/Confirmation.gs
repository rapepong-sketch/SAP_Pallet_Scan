/**
 * Confirmation.gs — Phase 3 Step 2c/2d + Phase 3.5 Gate 4: SAP Order Confirmation
 * ==================================================================================
 * Step 2c: Builds the API_PROD_ORDER_CONFIRMATION_2_SRV payload for a QC-passed
 * pallet, POSTs to SAP (gated by SAP_WRITE_ENABLED + DRY_RUN), reads back
 * MaterialDocument, writes results to PalletMaster.
 * Step 2d: Admin batch confirmation — listConfirmablePallets() + batchConfirmPallets().
 * Gate 4: buildConfirmationPayload_ reads 4-bucket yield (GoodQty, RepairQty,
 *   DefectQty, AwaitConvQty) from PalletMaster. yield=Good+Repair+AwaitConv,
 *   scrap=Defect. Legacy fallback when buckets are empty.
 *
 * Reuses:
 *  - lookupPalletById_()        (PalletSheet.gs)      — PalletMaster row by PalletID
 *  - updatePalletScanFields_()  (PalletSheet.gs)      — write fields by column name
 *  - getFinalOperationCached_() (ProductionOrders.gs)  — sheet-only FinalOperation cache
 *  - sapWriteEnabled_() / isDryRun_() (Flags.gs)      — feature flag readers
 *  - getCsrfSession_(serviceUrl) (SapClient.gs)       — CSRF token + cookie pair
 *  - getSapCredentials_()       (Config.gs)           — Basic Auth credentials
 *  - getActiveUserSafe_()       (Config.gs)           — safe Session.getActiveUser()
 *  - buildSapUrl_(path)         (SapClient.gs)        — SAP URL builder
 *  - logEvent()                 (SapClient.gs)        — EventLog writer
 */

/**
 * Normalize an operation value to a 4-digit zero-padded string (e.g. "30" → "0030").
 * @param {string|number} v — raw operation from cache (may be numeric or string)
 * @return {string} 4-digit zero-padded operation string
 */
function padOperation_(v) {
  var op = String(v).trim().replace(/\D/g, '');
  op = ('0000' + op).slice(-4);
  if (op === '0000') {
    throw new Error('padOperation_: invalid operation value "' + v + '" resolved to 0000');
  }
  return op;
}

/**
 * Build the SAP order confirmation payload for one QC-passed pallet.
 * Pure read + transform — does not call SAP or write any sheet.
 *
 * Phase 3.5 Gate 4: reads 4-bucket yield columns from PalletMaster.
 *   yield = GoodQty + RepairQty + AwaitConvQty
 *   scrap = DefectQty
 * Fallback: if all 4 buckets are empty (legacy pallet), uses QtyPerPallet / scrap 0.
 * qtyOverride is IGNORED when buckets are present; only applies in legacy fallback.
 *
 * @param {string} palletId
 * @param {number} [qtyOverride] — reduce-only admin override (legacy path only).
 * @return {{OrderID:string, OrderOperation:string, Sequence:string,
 *   ConfirmationYieldQuantity:string, ConfirmationScrapQuantity:string,
 *   ConfirmationUnit:string, Plant:string, IsFinalConfirmation:boolean,
 *   FinalConfirmationType:string}|{error:string}}
 */
function buildConfirmationPayload_(palletId, qtyOverride) {
  const pallet = lookupPalletById_(palletId);
  if (!pallet) throw new Error('PalletID not found in PalletMaster: ' + palletId);

  if (pallet.ScanStatus !== 'QC_COMPLETE') {
    throw new Error('Pallet ' + palletId + ' is not eligible to confirm — ' +
      'ScanStatus=' + pallet.ScanStatus + ' (expected QC_COMPLETE)');
  }

  const mo = pallet.ManufacturingOrder;
  if (!mo) throw new Error('ManufacturingOrder is empty for PalletID: ' + palletId);
  const orderId = String(mo).trim().padStart(12, '0');

  const finalOp = getFinalOperationCached_(mo);
  if (!finalOp) {
    throw new Error('FinalOperation not cached for ManufacturingOrder: ' + mo +
      ' — cannot confirm');
  }

  // ---- Phase 3.5 Gate 4: 4-bucket yield resolution ----
  var good     = (pallet.GoodQty     != null && pallet.GoodQty     !== '') ? Number(pallet.GoodQty)     : NaN;
  var repair   = (pallet.RepairQty   != null && pallet.RepairQty   !== '') ? Number(pallet.RepairQty)   : NaN;
  var defect   = (pallet.DefectQty   != null && pallet.DefectQty   !== '') ? Number(pallet.DefectQty)   : NaN;
  var awaitCnv = (pallet.AwaitConvQty!= null && pallet.AwaitConvQty!== '') ? Number(pallet.AwaitConvQty): NaN;

  var bucketsPresent = !isNaN(good) || !isNaN(repair) || !isNaN(defect) || !isNaN(awaitCnv);

  var yieldQty, scrapQty, source;

  if (bucketsPresent) {
    // Treat any remaining NaN as 0 (partial fill = zero for that bucket)
    good     = isNaN(good)     ? 0 : good;
    repair   = isNaN(repair)   ? 0 : repair;
    defect   = isNaN(defect)   ? 0 : defect;
    awaitCnv = isNaN(awaitCnv) ? 0 : awaitCnv;

    // Validate sum == QtyPerPallet
    var bucketSum = good + repair + defect + awaitCnv;
    if (bucketSum !== pallet.QtyPerPallet) {
      var msg = 'Bucket sum mismatch for ' + palletId + ': Good(' + good +
        ')+Repair(' + repair + ')+Defect(' + defect + ')+AwaitConv(' + awaitCnv +
        ')=' + bucketSum + ' ≠ QtyPerPallet(' + pallet.QtyPerPallet + ')';
      logEvent('CONFIRM', 'ERROR', msg);
      return { error: msg };
    }

    yieldQty = good + repair + awaitCnv;
    scrapQty = defect;
    source   = 'BUCKETS';

    if (qtyOverride != null) {
      logEvent('CONFIRM', 'WARN', palletId + ' qtyOverride=' + qtyOverride +
        ' IGNORED — buckets are source of truth (yield=' + yieldQty + ' scrap=' + scrapQty + ')');
    }
  } else {
    // Legacy fallback: no bucket data recorded
    var qty = (qtyOverride != null) ? qtyOverride : pallet.QtyPerPallet;
    if (!qty || qty <= 0) {
      throw new Error('QtyPerPallet missing or invalid for PalletID: ' + palletId);
    }
    yieldQty = qty;
    scrapQty = 0;
    source   = (qtyOverride != null) ? 'OVERRIDE' : 'LEGACY';
  }

  logEvent('CONFIRM', 'PAYLOAD', palletId + ' source=' + source +
    ' yield=' + yieldQty + ' scrap=' + scrapQty);

  return {
    OrderID:                   orderId,
    OrderOperation:            padOperation_(finalOp),
    Sequence:                  '0',
    ConfirmationYieldQuantity: String(yieldQty),
    ConfirmationScrapQuantity: String(scrapQty),
    ConfirmationUnit:          pallet.Unit || 'PC',
    Plant:                     CFG.PLANT,
    IsFinalConfirmation:       true,
    FinalConfirmationType:     'X'
  };
}

/**
 * DRY-RUN gate for SAP order confirmation. Builds + logs the payload but
 * NEVER posts to SAP — live POST is implemented in Step 2c.
 * Behaviour matrix (flags read from Flags.gs):
 *   SAP_WRITE_ENABLED=false               → log SKIP, return undefined
 *   SAP_WRITE_ENABLED=true, DRY_RUN=true  → build + log payload, return it
 *   SAP_WRITE_ENABLED=true, DRY_RUN=false → log BLOCKED, return undefined
 * @param {string} palletId
 * @return {Object|undefined} the confirmation payload, only when dry-run fires
 */
function dryRunConfirmation_(palletId) {
  try {
    if (!sapWriteEnabled_()) {
      logEvent('CONFIRM', 'SKIP', 'SAP_WRITE_ENABLED is off');
      return;
    }

    if (isDryRun_()) {
      const payload = buildConfirmationPayload_(palletId);
      if (payload && payload.error) {
        logEvent('CONFIRM', 'ERROR', palletId + ' ' + payload.error);
        throw new Error(payload.error);
      }
      logEvent('CONFIRM', 'DRYRUN', JSON.stringify(payload));
      return payload;
    }

    logEvent('CONFIRM', 'BLOCKED', 'Live POST not implemented until Step 2c');
    return;

  } catch (e) {
    logEvent('CONFIRM', 'ERROR', e.message);
    throw e;
  }
}

// testDryRunConfirmation, checkWritebackColumns → moved to Tests.gs

// ============================================================================
// Phase 3 Step 2c — SAP Order Confirmation POST (flag-gated)
// ============================================================================

/**
 * POST a confirmation payload to SAP API_PROD_ORDER_CONFIRMATION_2_SRV / ProdnOrdConf2.
 * Strictly gated by feature flags:
 *   SAP_WRITE_ENABLED=false             → log SKIP, return {skipped:true}
 *   DRY_RUN=true                        → log DRYRUN + payload, return {dryRun:true, payload}
 *   SAP_WRITE_ENABLED=true & DRY_RUN=false → live POST to SAP
 *
 * @param {Object} payload — confirmation payload from buildConfirmationPayload_()
 * @return {{skipped?:boolean, dryRun?:boolean, payload?:Object,
 *   ok?:boolean, confirmationGroup?:string, confirmationCount?:string, raw?:string}}
 */
function postConfirmation_(payload) {
  // ---- Flag gate ----
  if (!sapWriteEnabled_()) {
    logEvent('CONFIRM', 'SKIP', 'write disabled');
    return { skipped: true };
  }

  if (isDryRun_()) {
    logEvent('CONFIRM', 'DRYRUN', JSON.stringify(payload));
    return { dryRun: true, payload: payload };
  }

  // ---- Live POST ----
  const serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.PROD_ORDER_CONF;
  const session = getCsrfSession_(serviceRoot);

  const creds = getSapCredentials_();
  const postUrl = buildSapUrl_(serviceRoot + 'ProdnOrdConf2');

  const resp = UrlFetchApp.fetch(postUrl, {
    method: 'post',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'X-CSRF-Token': session.token,
      'Cookie': session.cookies,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const body = resp.getContentText();

  if (code < 200 || code >= 300) {
    logEvent('CONFIRM', 'ERROR', code + ' ' + body.slice(0, 400));
    throw new Error('SAP Confirmation POST failed HTTP ' + code + ': ' + body.slice(0, 600));
  }

  // Parse response — OData V2 wraps in { d: { ... } }
  const parsed = JSON.parse(body);
  const entity = parsed.d || parsed;
  const group = entity.ConfirmationGroup || '';
  const count = entity.ConfirmationCount || '';

  logEvent('CONFIRM', 'POSTED', 'group=' + group + ' count=' + count);

  return {
    ok: true,
    confirmationGroup: group,
    confirmationCount: count,
    session: session,
    raw: body
  };
}

// testPostConfirmationDryRun → moved to Tests.gs

// ============================================================================
// Phase 3 Step 2c Part 2 — MaterialDocument readback + orchestrator
// ============================================================================

/**
 * Follow-up GET after a successful confirmation POST: reads the MaterialDocument
 * created by the confirmation (Goods Receipt) from the confirmation's navigation
 * property to_ProdnOrdConfMatlDocItm.
 *
 * Retries up to 3 times with 2 s sleep between attempts — the GR material
 * document may post asynchronously after the confirmation response.
 *
 * Reuses the SAME session (cookies) from the POST for session affinity.
 * Does NOT throw on failure — the confirmation itself already succeeded.
 *
 * @param {string} confirmationGroup
 * @param {string} confirmationCount
 * @param {{token:string, cookies:string}} session — session from postConfirmation_
 * @return {{materialDocument:string, materialDocumentYear:string}}
 */
function readMaterialDocument_(confirmationGroup, confirmationCount, session) {
  var entityPath = CFG.SAP_BASE_URL + CFG.SERVICES.PROD_ORDER_CONF +
    "ProdnOrdConf2(ConfirmationGroup='" + confirmationGroup +
    "',ConfirmationCount='" + confirmationCount + "')/to_ProdnOrdConfMatlDocItm";

  var url = buildSapUrl_(entityPath, { '$format': 'json' });
  var creds = getSapCredentials_();
  var MAX_ATTEMPTS = 3;

  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      Utilities.sleep(2000);
    }
    logEvent('READBACK', 'RETRY', 'attempt ' + attempt + ' group=' + confirmationGroup);

    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
        'Cookie': session.cookies
      },
      muteHttpExceptions: true
    });

    var code = resp.getResponseCode();
    var body = resp.getContentText();

    if (code < 200 || code >= 300) {
      logEvent('CONFIRM', 'WARN', 'matDoc readback HTTP ' + code + ' attempt ' + attempt + ': ' + body.slice(0, 200));
      continue;
    }

    var parsed = JSON.parse(body);
    var results = (parsed.d && parsed.d.results) || [];

    for (var i = 0; i < results.length; i++) {
      var md = results[i].MaterialDocument || '';
      if (md) {
        logEvent('CONFIRM', 'READBACK', 'matDoc=' + md + ' year=' + (results[i].MaterialDocumentYear || '') + ' attempt=' + attempt);
        return {
          materialDocument: md,
          materialDocumentYear: results[i].MaterialDocumentYear || ''
        };
      }
    }
  }

  logEvent('CONFIRM', 'WARN', 'no material doc after ' + MAX_ATTEMPTS + ' retries group=' + confirmationGroup);
  return { materialDocument: '', materialDocumentYear: '' };
}

/**
 * Orchestrator: build → POST → readback → writeback for a single pallet.
 * Idempotency guard: skips if ScanStatus is already CONFIRMED or ConfirmationGroup
 * is non-empty. Writes confirmation results + material document back to PalletMaster.
 *
 * @param {string} palletId
 * @return {{alreadyConfirmed?:boolean, skipped?:boolean, dryRun?:boolean,
 *   ok?:boolean, materialDocument?:string, confirmationGroup?:string,
 *   confirmationCount?:string}}
 */
function confirmPallet(palletId) {
  try {
    // ---- Lookup pallet ----
    var pallet = lookupPalletById_(palletId);
    if (!pallet) throw new Error('PalletID not found: ' + palletId);

    // ---- Idempotency guard: read ConfirmationGroup from sheet ----
    var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
    var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var cgColIdx = hdr.indexOf('ConfirmationGroup');
    var cgVal = (cgColIdx >= 0)
      ? String(sh.getRange(pallet.rowNum, cgColIdx + 1).getValue() || '').trim()
      : '';

    if (pallet.ScanStatus === 'CONFIRMED' || cgVal !== '') {
      logEvent('CONFIRM', 'SKIP', palletId + ' already confirmed');
      return { alreadyConfirmed: true };
    }

    // ---- Build + POST ----
    var payload = buildConfirmationPayload_(palletId);
    if (payload && payload.error) {
      logEvent('CONFIRM', 'ERROR', palletId + ' ' + payload.error);
      throw new Error(payload.error);
    }
    var result = postConfirmation_(payload);

    if (result.skipped || result.dryRun) return result;

    if (result.ok) {
      // ---- Readback MaterialDocument ----
      var matDoc = readMaterialDocument_(
        result.confirmationGroup, result.confirmationCount, result.session
      );

      // ---- Writeback to PalletMaster ----
      updatePalletScanFields_(palletId, {
        ConfirmationGroup:      result.confirmationGroup,
        ConfirmationCount:      result.confirmationCount,
        GRMaterialDocument:     matDoc.materialDocument,
        GRMaterialDocumentYear: matDoc.materialDocumentYear,
        ConfirmedAt:            new Date(),
        ConfirmedBy:            getActiveUserSafe_(),
        ScanStatus:             'CONFIRMED'
      });

      logEvent('CONFIRM', 'CONFIRMED', palletId + ' matDoc=' + matDoc.materialDocument);

      return {
        ok: true,
        materialDocument: matDoc.materialDocument,
        confirmationGroup: result.confirmationGroup,
        confirmationCount: result.confirmationCount
      };
    }

  } catch (e) {
    logEvent('CONFIRM', 'ERROR', palletId + ' ' + e.message);
    throw e;
  }
}

// testConfirmPallet → moved to Tests.gs

// ============================================================================
// Phase 3 Step 2d — Admin Batch Confirmation (backend)
// ============================================================================

/**
 * Return all PalletMaster rows eligible for confirmation (ScanStatus === 'QC_COMPLETE').
 * Each object includes a readiness check (FinalOperation cached + QtyPerPallet valid).
 * READ-ONLY — does not POST anything.
 * @return {Array<{PalletID:string, ManufacturingOrder:string, Material:string,
 *   QtyPerPallet:number, Unit:string, WorkCenter:string, QCResult:string,
 *   PalletSeq:number, finalOperation:string, ready:boolean, readyReason:string}>}
 */
function listConfirmablePallets() {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  var required = ['PalletID', 'ManufacturingOrder', 'Material', 'QtyPerPallet',
                  'Unit', 'WorkCenter', 'QCResult', 'PalletSeq', 'ScanStatus'];
  for (var k = 0; k < required.length; k++) {
    if (idx[required[k]] === undefined) {
      logEvent('BATCH_CONFIRM', 'ERROR', 'Missing column: ' + required[k]);
      return [];
    }
  }

  var results = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var status = String(row[idx['ScanStatus']] || '').trim();
    if (status !== 'QC_COMPLETE') continue;

    var mo  = String(row[idx['ManufacturingOrder']] || '').trim();
    var qty = Number(row[idx['QtyPerPallet']]) || 0;

    var finalOp = getFinalOperationCached_(mo);
    var ready = true;
    var readyReason = '';

    if (!finalOp) {
      ready = false;
      readyReason = 'FinalOperation not cached';
    } else if (qty <= 0) {
      ready = false;
      readyReason = 'QtyPerPallet invalid';
    }

    var wc = row[idx['WorkCenter']];
    results.push({
      PalletID:           String(row[idx['PalletID']] || '').trim(),
      ManufacturingOrder: mo,
      Material:           String(row[idx['Material']] || '').trim(),
      QtyPerPallet:       qty,
      Unit:               String(row[idx['Unit']] || '').trim(),
      WorkCenter:         (wc instanceof Date) ? dateToWorkCenter_(wc) : String(wc || '').trim(),
      QCResult:           String(row[idx['QCResult']] || '').trim(),
      PalletSeq:          Number(row[idx['PalletSeq']]) || 0,
      finalOperation:     finalOp,
      ready:              ready,
      readyReason:        readyReason
    });
  }

  results.sort(function(a, b) {
    if (a.ManufacturingOrder < b.ManufacturingOrder) return -1;
    if (a.ManufacturingOrder > b.ManufacturingOrder) return  1;
    return a.PalletSeq - b.PalletSeq;
  });

  logEvent('BATCH_CONFIRM', 'LIST', 'found ' + results.length + ' confirmable pallets');
  return results;
}

/**
 * Confirm a batch of pallets by delegating each to confirmPallet().
 * Fail-soft: one pallet's failure does not abort the batch.
 * Safety cap: max 15 pallets per call (GAS ~6min execution limit).
 *
 * @param {string[]} palletIds — array of PalletID strings
 * @return {{total:number, confirmed:Array, skipped:Array, failed:Array, dryRun:Array}|
 *          {error:string, message:string, requested:number}}
 */
function batchConfirmPallets(palletIds) {
  if (!Array.isArray(palletIds) || palletIds.length === 0) {
    return { total: 0, confirmed: [], skipped: [], failed: [], dryRun: [] };
  }

  if (palletIds.length > 15) {
    logEvent('BATCH_CONFIRM', 'BLOCKED', 'requested ' + palletIds.length + ' pallets (cap 15)');
    return {
      error: 'TOO_MANY',
      message: 'Select 15 or fewer per batch to avoid timeout',
      requested: palletIds.length
    };
  }

  var confirmed = [];
  var skipped   = [];
  var failed    = [];
  var dryRun    = [];

  for (var i = 0; i < palletIds.length; i++) {
    var pid = String(palletIds[i]).trim();
    try {
      var result = confirmPallet(pid);

      if (result.ok) {
        confirmed.push({
          palletId:          pid,
          materialDocument:  result.materialDocument || '',
          confirmationGroup: result.confirmationGroup || '',
          confirmationCount: result.confirmationCount || ''
        });
      } else if (result.alreadyConfirmed) {
        skipped.push({ palletId: pid, reason: 'already confirmed' });
      } else if (result.dryRun) {
        dryRun.push({ palletId: pid, payload: result.payload || null });
      } else if (result.skipped) {
        skipped.push({ palletId: pid, reason: 'write disabled' });
      }

    } catch (e) {
      logEvent('BATCH_CONFIRM', 'FAIL', pid + ' ' + e.message);
      failed.push({ palletId: pid, error: e.message });
    }
  }

  logEvent('BATCH_CONFIRM', 'SUMMARY',
    'confirmed=' + confirmed.length +
    ' skipped=' + skipped.length +
    ' failed=' + failed.length +
    ' dryRun=' + dryRun.length);

  return {
    total:     palletIds.length,
    confirmed: confirmed,
    skipped:   skipped,
    failed:    failed,
    dryRun:    dryRun
  };
}

/**
 * Test harness: list confirmable pallets and log the results.
 */
function testListConfirmable() {
  var pallets = listConfirmablePallets();
  Logger.log('Confirmable pallets: ' + pallets.length);
  Logger.log(JSON.stringify(pallets, null, 2));
}

// ============================================================================
// GRMaterialDocument backfill — READ-only against SAP, write to sheet
// ============================================================================

/**
 * Backfill GRMaterialDocument for a pallet that was confirmed but has an empty
 * material document (readback fired before SAP finished posting the GR).
 * READ-only against SAP — does NOT re-POST any confirmation.
 *
 * @param {string} palletId
 * @return {{found:boolean, materialDocument:string, materialDocumentYear:string}}
 */
function backfillMaterialDocument(palletId) {
  palletId = String(palletId || '').trim();
  if (!palletId) throw new Error('backfillMaterialDocument: palletId is required');

  // ---- Read ConfirmationGroup + ConfirmationCount by column name ----
  var sh  = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) throw new Error('PalletMaster sheet missing or empty');

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  var targetRow = -1;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['PalletID']] || '').trim() === palletId) {
      targetRow = r;
      break;
    }
  }
  if (targetRow < 0) throw new Error('PalletID not found in PalletMaster: ' + palletId);

  var group = String(data[targetRow][idx['ConfirmationGroup']] || '').trim();
  var count = String(data[targetRow][idx['ConfirmationCount']] || '').trim();

  if (!group || !count) {
    throw new Error('no confirmation group on pallet');
  }

  // ---- Readback from SAP ----
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.PROD_ORDER_CONF;
  var session = getCsrfSession_(serviceRoot);
  var matDoc  = readMaterialDocument_(group, count, session);

  if (matDoc.materialDocument) {
    // ---- Write back to PalletMaster ----
    updatePalletScanFields_(palletId, {
      GRMaterialDocument:     matDoc.materialDocument,
      GRMaterialDocumentYear: matDoc.materialDocumentYear
    });
    logEvent('BACKFILL', 'OK', palletId + ' matDoc=' + matDoc.materialDocument);
    return {
      found: true,
      materialDocument: matDoc.materialDocument,
      materialDocumentYear: matDoc.materialDocumentYear
    };
  }

  logEvent('BACKFILL', 'WARN', palletId + ' still empty');
  return { found: false, materialDocument: '', materialDocumentYear: '' };
}

// ============================================================================
// Phase 3.5 — Admin Override Confirmation
// ============================================================================

/**
 * Admin-only manual override confirmation for a pallet that never reached
 * QC_COMPLETE (e.g. operator missed scans) but HAS passed QC. Confirms the final
 * operation in SAP (auto-GR + backflush) exactly like confirmPallet, bypassing
 * the sequential-scan requirement, and records a mandatory audit trail.
 *
 * Optional qtyConfirmed lets admin REDUCE the confirmed quantity (never increase).
 * If omitted/null/empty the pallet's original QtyPerPallet is used unchanged.
 *
 * @param {string} palletId
 * @param {string} reason  Mandatory free-text override justification.
 * @param {number|string} [qtyConfirmed] — reduced qty (must be > 0 and <= original).
 * @return {{success:boolean, message:string, dryRun?:boolean,
 *           confirmationGroup?:string, materialDocument?:string,
 *           qtyConfirmed?:number}}
 */
function confirmPalletOverride(palletId, reason, qtyConfirmed) {
  // ---- 1. AUTHZ — server-side admin check ----
  var adminEmail = '';
  try { adminEmail = Session.getActiveUser().getEmail() || ''; } catch (_) {}
  if (!isAdminUser_()) {
    return { success: false, message: 'ไม่มีสิทธิ์ override' };
  }

  // ---- 2. REASON — mandatory, min 5 chars ----
  reason = String(reason || '').trim();
  if (reason.length < 5) {
    return { success: false, message: 'ต้องระบุเหตุผล override (อย่างน้อย 5 ตัวอักษร)' };
  }

  // ---- 3. LOAD pallet row ----
  var pallet = lookupPalletById_(palletId);
  if (!pallet) {
    return { success: false, message: 'ไม่พบ PalletID: ' + palletId };
  }

  // ---- 4. IDEMPOTENCY — already confirmed? ----
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cgColIdx = hdr.indexOf('ConfirmationGroup');
  var cgVal = (cgColIdx >= 0)
    ? String(sh.getRange(pallet.rowNum, cgColIdx + 1).getValue() || '').trim()
    : '';

  if (pallet.ScanStatus === 'CONFIRMED' || cgVal !== '') {
    return { success: true, message: 'พาเลทนี้ confirm แล้ว (skip)' };
  }

  // ---- 5. QC ALLOW-LIST ----
  if (pallet.QCStatus !== 'INSPECTED' || pallet.QCResult !== 'PASS') {
    if (pallet.QCResult === 'FAIL') {
      return { success: false, message: 'QC ไม่ผ่าน — override ไม่ได้' };
    }
    if (!pallet.QCResult) {
      return { success: false, message: 'ยังไม่ตรวจ QC — override ไม่ได้' };
    }
    return { success: false, message: 'QC ไม่ผ่าน — override ไม่ได้' };
  }

  // ---- 6. QTY guard — reduce-only, never exceed original ----
  var originalQty = Number(pallet.QtyPerPallet);
  var finalQty;
  if (qtyConfirmed == null || qtyConfirmed === '') {
    finalQty = originalQty;
  } else {
    var n = Number(qtyConfirmed);
    if (!isFinite(n) || n <= 0 || n > originalQty) {
      return { success: false, message: 'จำนวนต้องมากกว่า 0 และไม่เกิน ' + originalQty };
    }
    finalQty = n;
  }

  // ---- 7. Capture fromStatus for audit ----
  var fromStatus = pallet.ScanStatus || '';

  // ---- 8. DRY_RUN gate ----
  if (!sapWriteEnabled_() || isDryRun_()) {
    var detail = JSON.stringify({
      palletId: palletId, adminEmail: adminEmail, reason: reason,
      fromStatus: fromStatus, qtyOriginal: originalQty, qtyConfirmed: finalQty
    });
    logEvent('OVERRIDE_CONFIRM', 'DRY_RUN', detail);
    return {
      success: true, dryRun: true, qtyConfirmed: finalQty,
      message: 'DRY_RUN — would override-confirm ' + palletId +
        ' qty=' + finalQty + (finalQty !== originalQty ? ' (reduced from ' + originalQty + ')' : '')
    };
  }

  // ---- 9. LIVE — build payload + POST + readback + writeback ----
  try {
    // Build the same payload as buildConfirmationPayload_ but without QC_COMPLETE guard
    var mo = pallet.ManufacturingOrder;
    if (!mo) {
      return { success: false, message: 'ManufacturingOrder is empty for PalletID: ' + palletId };
    }
    var orderId = String(mo).trim().padStart(12, '0');

    var finalOp = getFinalOperationCached_(mo);
    if (!finalOp) {
      return { success: false, message: 'FinalOperation not cached for MO: ' + mo };
    }

    if (!finalQty || finalQty <= 0) {
      return { success: false, message: 'QtyPerPallet missing or invalid for PalletID: ' + palletId };
    }

    var payload = {
      OrderID:                   orderId,
      OrderOperation:            padOperation_(finalOp),
      Sequence:                  '0',
      ConfirmationYieldQuantity: String(finalQty),
      ConfirmationScrapQuantity: '0',
      ConfirmationUnit:          pallet.Unit || 'PC',
      Plant:                     CFG.PLANT,
      IsFinalConfirmation:       true,
      FinalConfirmationType:     'X'
    };

    var result = postConfirmation_(payload);

    if (result.skipped) {
      return { success: false, message: 'SAP write disabled' };
    }
    if (result.dryRun) {
      return {
        success: true, dryRun: true, qtyConfirmed: finalQty,
        message: 'DRY_RUN — would override-confirm ' + palletId +
          ' qty=' + finalQty + (finalQty !== originalQty ? ' (reduced from ' + originalQty + ')' : '')
      };
    }

    if (result.ok) {
      var matDoc = readMaterialDocument_(
        result.confirmationGroup, result.confirmationCount, result.session
      );

      var now = new Date();
      updatePalletScanFields_(palletId, {
        ScanStatus:             'CONFIRMED',
        ConfirmationGroup:      result.confirmationGroup,
        ConfirmationCount:      result.confirmationCount,
        ConfirmedAt:            now,
        ConfirmedBy:            adminEmail || getActiveUserSafe_(),
        GRMaterialDocument:     matDoc.materialDocument,
        GRMaterialDocumentYear: matDoc.materialDocumentYear,
        OverrideBy:             adminEmail,
        OverrideReason:         reason,
        OverrideAt:             now.toISOString()
      });

      // ---- 10. Audit log ----
      var auditDetail = JSON.stringify({
        palletId: palletId, adminEmail: adminEmail, reason: reason,
        fromStatus: fromStatus, qtyOriginal: originalQty, qtyConfirmed: finalQty,
        confirmationGroup: result.confirmationGroup
      });
      logEvent('OVERRIDE_CONFIRM', 'OK', auditDetail);

      // ---- 11. Return ----
      return {
        success: true,
        confirmationGroup: result.confirmationGroup,
        materialDocument: matDoc.materialDocument,
        qtyConfirmed: finalQty,
        message: 'Override confirm สำเร็จ' +
          (finalQty !== originalQty ? ' (ลดจำนวนจาก ' + originalQty + ' เป็น ' + finalQty + ')' : '')
      };
    }

    return { success: false, message: 'SAP POST returned unexpected result' };

  } catch (e) {
    logEvent('OVERRIDE_CONFIRM', 'FAIL', JSON.stringify({
      palletId: palletId, adminEmail: adminEmail, reason: reason,
      fromStatus: fromStatus, qtyOriginal: originalQty, qtyConfirmed: finalQty,
      error: e.message
    }));
    return { success: false, message: 'Override confirm failed: ' + e.message };
  }
}

/** Editor test — DRY_RUN ON first. */
function testConfirmPalletOverride() {
  Logger.log(JSON.stringify(
    confirmPalletOverride('PL-TEST-OVR-A1', 'ทดสอบ override ลดจำนวน', 1),
  null, 2));
}

// ============================================================================
// Phase 3.5 Gate 4 — TEST: buildConfirmationPayload_ with 4-bucket yield
// ============================================================================

/**
 * Self-cleaning test: seeds a fake pallet PL-TEST-BUCKET-G4 with 4-bucket
 * yield data (Good=440, Repair=5, AwaitConv=3, Defect=2, QtyPerPallet=450),
 * runs buildConfirmationPayload_, asserts yield==448 & scrap==2, then deletes
 * the test row. Run from menu: 🏭 Pallet Tracker ▸ 🧪 [Test] Yield Bucket Payload.
 */
function testBuildYieldBucketPayload() {
  var PALLET_ID = 'PL-TEST-BUCKET-G4';
  var MO        = '0000099999';
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  // ---- Seed test row ----
  var newRow = new Array(hdr.length).fill('');
  newRow[idx['PalletID']]           = PALLET_ID;
  newRow[idx['ManufacturingOrder']] = MO;
  newRow[idx['Material']]           = 'TEST-MAT-001';
  newRow[idx['QtyPerPallet']]       = 450;
  newRow[idx['Unit']]               = 'PC';
  newRow[idx['ScanStatus']]         = 'QC_COMPLETE';
  newRow[idx['GoodQty']]            = 440;
  newRow[idx['RepairQty']]          = 5;
  newRow[idx['DefectQty']]          = 2;
  newRow[idx['AwaitConvQty']]       = 3;
  if (idx['Plant'] !== undefined)   newRow[idx['Plant']] = CFG.PLANT;
  sh.appendRow(newRow);

  // Seed FinalOperation cache so getFinalOperationCached_ resolves
  var foSh = getSpreadsheet_().getSheetByName('ProductionOrders');
  var foHdr = foSh.getRange(1, 1, 1, foSh.getLastColumn()).getValues()[0];
  var foIdx = {};
  foHdr.forEach(function(h, i) { foIdx[h] = i; });
  var foRow = new Array(foHdr.length).fill('');
  foRow[foIdx['ManufacturingOrder']] = MO;
  foRow[foIdx['FinalOperation']]     = '0040';
  if (foIdx['Material'] !== undefined) foRow[foIdx['Material']] = 'TEST-MAT-001';
  foSh.appendRow(foRow);

  SpreadsheetApp.flush();

  var testPassed = false;
  var payload;
  try {
    payload = buildConfirmationPayload_(PALLET_ID);

    if (payload && payload.error) {
      Logger.log('FAIL — buildConfirmationPayload_ returned error: ' + payload.error);
    } else {
      var yieldVal = Number(payload.ConfirmationYieldQuantity);
      var scrapVal = Number(payload.ConfirmationScrapQuantity);

      Logger.log('yield = ' + yieldVal + ' (expected 448)');
      Logger.log('scrap = ' + scrapVal + ' (expected 2)');
      Logger.log('payload = ' + JSON.stringify(payload, null, 2));

      if (yieldVal === 448 && scrapVal === 2) {
        Logger.log('PASS — yield and scrap match expected values');
        testPassed = true;
      } else {
        Logger.log('FAIL — yield or scrap mismatch');
      }
    }
  } catch (e) {
    Logger.log('FAIL — exception: ' + e.message);
  }

  // ---- Cleanup: delete test rows ----
  var pmData = sh.getDataRange().getValues();
  for (var r = pmData.length - 1; r >= 1; r--) {
    if (String(pmData[r][idx['PalletID']] || '').trim() === PALLET_ID) {
      sh.deleteRow(r + 1);
    }
  }
  var foData = foSh.getDataRange().getValues();
  for (var r2 = foData.length - 1; r2 >= 1; r2--) {
    if (String(foData[r2][foIdx['ManufacturingOrder']] || '').trim() === MO) {
      foSh.deleteRow(r2 + 1);
    }
  }

  Logger.log(testPassed ? '✅ TEST PASSED' : '❌ TEST FAILED');
  return payload;
}

/**
 * Test harness: backfill GRMaterialDocument for PL-1000035952-L01 and verify.
 */
function testBackfillOne() {
  var PALLET_ID = 'PL-1000035952-L01';
  var result = backfillMaterialDocument(PALLET_ID);
  Logger.log('backfillMaterialDocument result: ' + JSON.stringify(result));

  // Re-read the row directly to verify both columns were written
  var sh   = getSpreadsheet_().getSheetByName(PM_SHEET);
  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['PalletID']] || '').trim() === PALLET_ID) {
      Logger.log('After backfill — GRMaterialDocument: ' + (data[r][idx['GRMaterialDocument']] || ''));
      Logger.log('After backfill — GRMaterialDocumentYear: ' + (data[r][idx['GRMaterialDocumentYear']] || ''));
      break;
    }
  }
}

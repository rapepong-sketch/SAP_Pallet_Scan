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
    FinalConfirmationType:     'X',
    ConfirmationText:          String(palletId).slice(0, 40)
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
 * SAP readback: check whether a confirmation with this PalletID token already exists.
 * Filters on ConfirmationText ALONE — PalletID is globally unique, so OrderID scoping
 * is unnecessary and avoids the padded/unpadded mismatch (SAP returns OrderID unpadded).
 * SAP creates multiple ConfirmationCount rows per POST; ConfirmationText lands on one
 * of them (not necessarily Count=1), so token-only filter is the reliable approach.
 *
 * READ-ONLY, best-effort — never throws. Returns {found:false, error} on any failure
 * so callers can fall through to normal POST behaviour.
 *
 * @param {string} palletId — PalletID stamped into ConfirmationText
 * @return {{found:boolean, confirmationGroup?:string, confirmationCount?:string,
 *   orderId?:string, confirmationText?:string, error?:string}}
 */
function sapReadbackConfirmation_(palletId) {
  try {
    var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.PROD_ORDER_CONF;
    var url = buildSapUrl_(serviceRoot + 'ProdnOrdConf2', {
      '$filter': "ConfirmationText eq '" + String(palletId) + "'",
      '$select': 'ConfirmationGroup,ConfirmationCount,OrderID,OrderOperation,ConfirmationText',
      '$top': '1',
      '$format': 'json'
    });

    logEvent('CONFIRM', 'READBACK_URL', url);
    var creds = getSapCredentials_();
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
        'Accept': 'application/json'
      },
      muteHttpExceptions: true
    });

    var code = resp.getResponseCode();
    var body = resp.getContentText();

    if (code < 200 || code >= 300) {
      logEvent('CONFIRM', 'READBACK_HTTP_ERR', code + ' ' + body.slice(0, 300));
      return { found: false, error: 'HTTP ' + code };
    }

    var parsed = JSON.parse(body);
    var results = (parsed.d && parsed.d.results) || [];

    if (results.length === 0) {
      return { found: false };
    }

    var hit = results[0];
    return {
      found: true,
      confirmationGroup: hit.ConfirmationGroup || '',
      confirmationCount: hit.ConfirmationCount || '',
      orderId:           hit.OrderID || '',
      confirmationText:  hit.ConfirmationText || ''
    };
  } catch (e) {
    logEvent('CONFIRM', 'READBACK_EXCEPTION', e.message);
    return { found: false, error: e.message };
  }
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

    // ---- SAP readback guard (best-effort, timeout-after-success recovery) ----
    var rb = sapReadbackConfirmation_(palletId);
    if (rb.found) {
      updatePalletScanFields_(palletId, {
        ConfirmationGroup: rb.confirmationGroup,
        ConfirmationCount: rb.confirmationCount,
        ScanStatus:        'CONFIRMED',
        ConfirmedAt:       new Date(),
        ConfirmedBy:       'HEAL'
      });
      try { backfillMaterialDocument(palletId); } catch (bfErr) {
        logEvent('CONFIRM', 'HEAL_BACKFILL_ERR', palletId + ' ' + bfErr.message);
      }
      logEvent('CONFIRM', 'HEAL_SKIP', palletId + ' found in SAP via readback');
      return { alreadyConfirmed: true, healed: true };
    }
    if (rb.error) {
      logEvent('CONFIRM', 'READBACK_DEGRADED', palletId + ' ' + rb.error);
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

    var pid = String(row[idx['PalletID']] || '').trim();
    if (/^PL-TEST-/i.test(pid)) continue;

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

  // ---- 4b. SAP readback guard (best-effort, timeout-after-success recovery) ----
  {
    var ovrRb = sapReadbackConfirmation_(palletId);
    if (ovrRb.found) {
      updatePalletScanFields_(palletId, {
        ConfirmationGroup: ovrRb.confirmationGroup,
        ConfirmationCount: ovrRb.confirmationCount,
        ScanStatus:        'CONFIRMED',
        ConfirmedAt:       new Date(),
        ConfirmedBy:       'HEAL'
      });
      try { backfillMaterialDocument(palletId); } catch (bfErr) {
        logEvent('OVERRIDE_CONFIRM', 'HEAL_BACKFILL_ERR', palletId + ' ' + bfErr.message);
      }
      logEvent('OVERRIDE_CONFIRM', 'HEAL_SKIP', palletId + ' found in SAP via readback');
      return { success: true, message: 'พาเลทนี้ confirm แล้วใน SAP (healed)' };
    }
    if (ovrRb.error) {
      logEvent('OVERRIDE_CONFIRM', 'READBACK_DEGRADED', palletId + ' ' + ovrRb.error);
    }
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
      FinalConfirmationType:     'X',
      ConfirmationText:          String(palletId).slice(0, 40)
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
 * Self-cleaning test: seeds PL-TEST-FB-1 with ALL bucket columns EMPTY to verify
 * the legacy fallback path in buildConfirmationPayload_. Two sub-tests:
 *   1) No override → source=LEGACY, yield=1000, scrap=0
 *   2) qtyOverride=800 → source=OVERRIDE, yield=800, scrap=0
 * Deletes the test row on exit (try/finally). No SAP POST.
 * Run from menu: 🏭 Pallet Tracker ▸ 🧪 [Test] Confirm Fallback (legacy)
 */
function TEST_confirmFallbackLegacy() {
  var PALLET_ID = 'PL-TEST-FB-1';
  var QTY       = 1000;
  var sh        = getSpreadsheet_().getSheetByName(PM_SHEET);
  var hdr       = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx       = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  // ---- Find a real MO from an existing PalletMaster row that has FinalOperation cached ----
  var donorMo = '';
  var pmData  = sh.getDataRange().getValues();
  for (var r = 1; r < pmData.length; r++) {
    var mo = String(pmData[r][idx['ManufacturingOrder']] || '').trim();
    if (mo && getFinalOperationCached_(mo)) {
      donorMo = mo;
      break;
    }
  }
  if (!donorMo) throw new Error('TEST_confirmFallbackLegacy: no existing MO with FinalOperation found');
  Logger.log('Using donor MO: ' + donorMo + ' (FinalOperation=' + getFinalOperationCached_(donorMo) + ')');

  // ---- Seed test row — bucket columns deliberately EMPTY ----
  var newRow = new Array(hdr.length).fill('');
  newRow[idx['PalletID']]           = PALLET_ID;
  newRow[idx['ManufacturingOrder']] = donorMo;
  newRow[idx['Material']]           = 'TEST-FALLBACK';
  newRow[idx['QtyPerPallet']]       = QTY;
  newRow[idx['Unit']]               = 'PC';
  newRow[idx['ScanStatus']]         = 'QC_COMPLETE';
  if (idx['Plant'] !== undefined)   newRow[idx['Plant']] = CFG.PLANT;
  sh.appendRow(newRow);
  SpreadsheetApp.flush();
  Logger.log('Seeded ' + PALLET_ID + ' with QtyPerPallet=' + QTY + ', all bucket columns EMPTY');

  var pass = false;
  var legacyPayload  = null;
  var overridePayload = null;

  try {
    // ---- Sub-test 1: no qtyOverride → LEGACY path ----
    Logger.log('');
    Logger.log('── Sub-test 1: no qtyOverride (expect LEGACY, yield=1000, scrap=0) ──');
    legacyPayload = buildConfirmationPayload_(PALLET_ID);

    if (legacyPayload && legacyPayload.error) {
      Logger.log('  ❌ FAIL — returned error: ' + legacyPayload.error);
      return JSON.parse(JSON.stringify({ pass: false, legacyPayload: legacyPayload, overridePayload: null }));
    }

    var legacySource = readConfirmSource_(PALLET_ID);
    Logger.log('  source path = ' + legacySource + ' (expected LEGACY)');
    Logger.log('  yield = ' + legacyPayload.ConfirmationYieldQuantity + ' (expected 1000)');
    Logger.log('  scrap = ' + legacyPayload.ConfirmationScrapQuantity + ' (expected 0)');
    Logger.log('  payload = ' + JSON.stringify(legacyPayload, null, 2));

    var legacyOk = legacyPayload.ConfirmationYieldQuantity === String(QTY) &&
                   legacyPayload.ConfirmationScrapQuantity === '0' &&
                   legacySource === 'LEGACY';
    Logger.log(legacyOk ? '  ✅ Sub-test 1 PASSED' : '  ❌ Sub-test 1 FAILED');

    // ---- Sub-test 2: qtyOverride=800 → OVERRIDE path ----
    Logger.log('');
    Logger.log('── Sub-test 2: qtyOverride=800 (expect OVERRIDE, yield=800, scrap=0) ──');
    overridePayload = buildConfirmationPayload_(PALLET_ID, 800);

    if (overridePayload && overridePayload.error) {
      Logger.log('  ❌ FAIL — returned error: ' + overridePayload.error);
      return JSON.parse(JSON.stringify({ pass: false, legacyPayload: legacyPayload, overridePayload: overridePayload }));
    }

    var overrideSource = readConfirmSource_(PALLET_ID);
    Logger.log('  source path = ' + overrideSource + ' (expected OVERRIDE)');
    Logger.log('  yield = ' + overridePayload.ConfirmationYieldQuantity + ' (expected 800)');
    Logger.log('  scrap = ' + overridePayload.ConfirmationScrapQuantity + ' (expected 0)');
    Logger.log('  payload = ' + JSON.stringify(overridePayload, null, 2));

    var overrideOk = overridePayload.ConfirmationYieldQuantity === '800' &&
                     overridePayload.ConfirmationScrapQuantity === '0' &&
                     overrideSource === 'OVERRIDE';
    Logger.log(overrideOk ? '  ✅ Sub-test 2 PASSED' : '  ❌ Sub-test 2 FAILED');

    pass = legacyOk && overrideOk;

  } finally {
    // ---- Cleanup: delete test row (always runs) ----
    Logger.log('');
    Logger.log('── Cleanup ──');
    var freshData = sh.getDataRange().getValues();
    var deleted = false;
    for (var d = freshData.length - 1; d >= 1; d--) {
      if (String(freshData[d][idx['PalletID']] || '').trim() === PALLET_ID) {
        sh.deleteRow(d + 1);
        deleted = true;
      }
    }
    SpreadsheetApp.flush();
    var verifyGone = lookupPalletById_(PALLET_ID);
    Logger.log('Row deleted: ' + deleted + ' | Verify gone: ' + (verifyGone === null));
    if (verifyGone !== null) {
      Logger.log('⚠️ WARNING: ' + PALLET_ID + ' still exists after cleanup!');
    }
  }

  Logger.log('');
  Logger.log(pass ? '✅ TEST_confirmFallbackLegacy PASSED' : '❌ TEST_confirmFallbackLegacy FAILED');

  var detail = JSON.stringify({
    donorMo: donorMo,
    legacyYield:   legacyPayload  ? legacyPayload.ConfirmationYieldQuantity  : null,
    legacyScrap:   legacyPayload  ? legacyPayload.ConfirmationScrapQuantity  : null,
    overrideYield: overridePayload ? overridePayload.ConfirmationYieldQuantity : null,
    overrideScrap: overridePayload ? overridePayload.ConfirmationScrapQuantity : null
  });
  logEvent('TEST_CONFIRM_FALLBACK', pass ? 'PASS' : 'FAIL', detail);

  return JSON.parse(JSON.stringify({ pass: pass, legacyPayload: legacyPayload, overridePayload: overridePayload }));
}

/**
 * Read the most recent CONFIRM/PAYLOAD source for a given palletId from EventLog.
 * Scans bottom-up for the last matching entry and extracts 'source=XXX'.
 * @param {string} palletId
 * @return {string} source value (e.g. 'LEGACY', 'OVERRIDE', 'BUCKETS') or 'UNKNOWN'
 */
function readConfirmSource_(palletId) {
  var elSh = getSpreadsheet_().getSheetByName(CFG.SHEETS.EVENT_LOG);
  if (!elSh || elSh.getLastRow() < 2) return 'UNKNOWN';

  var data = elSh.getDataRange().getValues();
  for (var r = data.length - 1; r >= 1; r--) {
    var fn       = String(data[r][1] || '').trim();
    var endpoint = String(data[r][2] || '').trim();
    var status   = String(data[r][3] || '').trim();
    if (fn === 'CONFIRM' && endpoint === 'PAYLOAD' && status.indexOf(palletId) !== -1) {
      var match = status.match(/source=(\S+)/);
      return match ? match[1] : 'UNKNOWN';
    }
  }
  return 'UNKNOWN';
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

// ============================================================================
// Diagnostic — Confirm Drift (read-only)
// ============================================================================

/**
 * Read-only diagnostic: profile PalletMaster confirmation data and probe SAP.
 * Run from Editor. NO writes. Logs FETCH_URL before every UrlFetchApp call.
 * See docs/diagnostics/CONFIRM_DRIFT_DIAG.md for analysis framework.
 */
function diagConfirmDrift() {
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' Confirm Drift — Read-Only Diagnostic');
  Logger.log('══════════════════════════════════════════');

  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('PalletMaster empty'); return; }

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  // ── A1: Status profile ──
  Logger.log('');
  Logger.log('── A1: PalletMaster profile ──');
  Logger.log('Total rows: ' + (data.length - 1));

  var byStatus = {};
  for (var r = 1; r < data.length; r++) {
    var ss = String(data[r][idx['ScanStatus']] || '').trim() || '(empty)';
    byStatus[ss] = (byStatus[ss] || 0) + 1;
  }
  Logger.log('By ScanStatus:');
  Object.keys(byStatus).sort().forEach(function(s) {
    Logger.log('  ' + s + ': ' + byStatus[s]);
  });

  // ── A2: Confirmation fields on CONFIRMED rows ──
  Logger.log('');
  Logger.log('── A2: CONFIRMED rows — confirmation fields ──');

  var confirmFields = ['GRMaterialDocument', 'GRMaterialDocumentYear',
    'ConfirmationGroup', 'ConfirmationCount', 'ConfirmedAt', 'ConfirmedBy'];
  var present = {};
  confirmFields.forEach(function(f) {
    present[f] = idx[f] !== undefined ? 'col ' + idx[f] : 'MISSING';
  });
  Logger.log('Column presence:');
  confirmFields.forEach(function(f) { Logger.log('  ' + f + ': ' + present[f]); });

  var withDoc = 0, withGroup = 0, withNeither = 0;
  var samples = [];
  for (var r2 = 1; r2 < data.length; r2++) {
    if (String(data[r2][idx['ScanStatus']] || '').trim() !== 'CONFIRMED') continue;
    var pid   = String(data[r2][idx['PalletID']] || '').trim();
    var mo    = String(data[r2][idx['ManufacturingOrder']] || '').trim();
    var mat   = String(data[r2][idx['Material']] || '').trim();
    var grDoc = idx['GRMaterialDocument'] !== undefined
      ? String(data[r2][idx['GRMaterialDocument']] == null ? '' : data[r2][idx['GRMaterialDocument']]).trim() : '';
    var grYear = idx['GRMaterialDocumentYear'] !== undefined
      ? String(data[r2][idx['GRMaterialDocumentYear']] == null ? '' : data[r2][idx['GRMaterialDocumentYear']]).trim() : '';
    var cGroup = idx['ConfirmationGroup'] !== undefined
      ? String(data[r2][idx['ConfirmationGroup']] == null ? '' : data[r2][idx['ConfirmationGroup']]).trim() : '';
    var cCount = idx['ConfirmationCount'] !== undefined
      ? String(data[r2][idx['ConfirmationCount']] == null ? '' : data[r2][idx['ConfirmationCount']]).trim() : '';
    var cAt    = idx['ConfirmedAt'] !== undefined ? data[r2][idx['ConfirmedAt']] : '';
    var cBy    = idx['ConfirmedBy'] !== undefined
      ? String(data[r2][idx['ConfirmedBy']] == null ? '' : data[r2][idx['ConfirmedBy']]).trim() : '';

    if (grDoc) withDoc++;
    if (cGroup) withGroup++;
    if (!grDoc && !cGroup) withNeither++;

    if (samples.length < 3) {
      samples.push({ pid: pid, mo: mo, mat: mat, grDoc: grDoc, grYear: grYear,
        cGroup: cGroup, cCount: cCount, cAt: cAt, cBy: cBy });
    }
  }

  var confirmed = (byStatus['CONFIRMED'] || 0);
  Logger.log('');
  Logger.log('CONFIRMED rows: ' + confirmed);
  Logger.log('  with GRMaterialDocument: ' + withDoc);
  Logger.log('  with ConfirmationGroup:  ' + withGroup);
  Logger.log('  with NEITHER (unverifiable): ' + withNeither);

  Logger.log('');
  Logger.log('Sample CONFIRMED rows (up to 3):');
  samples.forEach(function(s, i) {
    Logger.log('  [' + (i + 1) + '] ' + s.pid + ' MO=' + s.mo + ' Mat=' + s.mat);
    Logger.log('      GRDoc=' + (s.grDoc || '(empty)') + ' Year=' + (s.grYear || '(empty)'));
    Logger.log('      ConfGrp=' + (s.cGroup || '(empty)') + ' Count=' + (s.cCount || '(empty)'));
    Logger.log('      ConfirmedAt=' + s.cAt + ' By=' + (s.cBy || '(empty)'));
  });

  // ── B3: SAP verification for samples with GRMaterialDocument ──
  Logger.log('');
  Logger.log('── B3: SAP Material Document verification ──');

  var creds = getSapCredentials_();
  var authHeader = 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass);

  samples.forEach(function(s, i) {
    if (!s.grDoc || !s.grYear) {
      Logger.log('  [' + (i + 1) + '] ' + s.pid + ': SKIP — no GRMaterialDocument');
      return;
    }
    var path = CFG.SERVICES.MATERIAL_DOCUMENT + 'A_MaterialDocumentHeader';
    var params = {
      '$filter': "MaterialDocument eq '" + s.grDoc + "' and MaterialDocumentYear eq '" + s.grYear + "'",
      '$select': 'MaterialDocument,MaterialDocumentYear,PostingDate,DocumentDate,ReferenceDocument',
      '$format': 'json'
    };
    var url = buildSapUrl_(path, params);
    Logger.log('  FETCH_URL: ' + url);
    try {
      var resp = UrlFetchApp.fetch(url, {
        method: 'get', headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      var body = resp.getContentText();
      Logger.log('  [' + (i + 1) + '] ' + s.pid + ': HTTP ' + code);
      if (code >= 200 && code < 300) {
        var parsed = JSON.parse(body);
        var results = (parsed.d && parsed.d.results) || [];
        Logger.log('    found=' + results.length);
        if (results.length > 0) {
          var doc = results[0];
          Logger.log('    PostingDate=' + (doc.PostingDate || '') +
            ' ReferenceDocument=' + (doc.ReferenceDocument || ''));
        }
      } else {
        Logger.log('    body=' + body.slice(0, 300));
      }
    } catch (e) {
      Logger.log('  [' + (i + 1) + '] ERROR: ' + e.message);
    }
  });

  // ── B4: Reverse lookup for samples WITHOUT GRMaterialDocument ──
  Logger.log('');
  Logger.log('── B4: Reverse lookup by MO (ConfirmationGroup) ──');

  var mosSeen = {};
  samples.forEach(function(s, i) {
    if (s.grDoc) {
      Logger.log('  [' + (i + 1) + '] ' + s.pid + ': SKIP — has GRDoc');
      return;
    }
    if (!s.mo || mosSeen[s.mo]) return;
    mosSeen[s.mo] = true;

    var paddedMo = s.mo.padStart(12, '0');
    var path = CFG.SERVICES.PROD_ORDER_CONF + 'ProdnOrdConf2';
    var params = {
      '$filter': "OrderID eq '" + paddedMo + "'",
      '$select': 'ConfirmationGroup,ConfirmationCount,OrderID,OrderOperation,' +
        'ConfirmationYieldQuantity,ConfirmationScrapQuantity',
      '$format': 'json', '$top': '10'
    };
    var url = buildSapUrl_(path, params);
    Logger.log('  FETCH_URL: ' + url);
    try {
      var resp = UrlFetchApp.fetch(url, {
        method: 'get', headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      Logger.log('  MO=' + s.mo + ': HTTP ' + code);
      if (code >= 200 && code < 300) {
        var parsed = JSON.parse(resp.getContentText());
        var results = (parsed.d && parsed.d.results) || [];
        Logger.log('    confirmations found: ' + results.length);
        results.forEach(function(c, ci) {
          Logger.log('    [' + ci + '] Group=' + c.ConfirmationGroup +
            ' Count=' + c.ConfirmationCount +
            ' Op=' + c.OrderOperation +
            ' Yield=' + c.ConfirmationYieldQuantity +
            ' Scrap=' + c.ConfirmationScrapQuantity);
        });
      }
    } catch (e) {
      Logger.log('  MO=' + s.mo + ' ERROR: ' + e.message);
    }
  });

  // ── B5: Metadata probe (GR join fields) ──
  Logger.log('');
  Logger.log('── B5: MaterialDocument item filter probe ──');
  var itemPath = CFG.SERVICES.MATERIAL_DOCUMENT + 'A_MaterialDocumentItem';
  var itemParams = {
    '$filter': "GoodsMovementType eq '101'",
    '$select': 'MaterialDocument,MaterialDocumentYear,ManufacturingOrder,GoodsMovementType,Material,Plant,Batch,QuantityInEntryUnit',
    '$top': '3', '$format': 'json'
  };
  var itemUrl = buildSapUrl_(itemPath, itemParams);
  Logger.log('  FETCH_URL: ' + itemUrl);
  try {
    var itemResp = UrlFetchApp.fetch(itemUrl, {
      method: 'get', headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
      muteHttpExceptions: true
    });
    Logger.log('  HTTP ' + itemResp.getResponseCode());
    if (itemResp.getResponseCode() >= 200 && itemResp.getResponseCode() < 300) {
      var itemParsed = JSON.parse(itemResp.getContentText());
      var items = (itemParsed.d && itemParsed.d.results) || [];
      Logger.log('  sample GR items: ' + items.length);
      items.forEach(function(it, ii) {
        Logger.log('    [' + ii + '] MatDoc=' + it.MaterialDocument +
          ' MO=' + it.ManufacturingOrder +
          ' Mat=' + it.Material +
          ' Qty=' + it.QuantityInEntryUnit);
      });
    } else {
      Logger.log('  body=' + itemResp.getContentText().slice(0, 300));
    }
  } catch (e) {
    Logger.log('  ERROR: ' + e.message);
  }

  // ── C6: Gap analysis summary ──
  Logger.log('');
  Logger.log('── C6: Gap analysis ──');
  Logger.log('CONFIRMED pallets:         ' + confirmed);
  Logger.log('  verifiable (GRDoc):      ' + withDoc);
  Logger.log('  recoverable (ConfGrp):   ' + (withGroup - withDoc));
  Logger.log('  unverifiable (neither):  ' + withNeither);
  Logger.log('');
  Logger.log('Join key: GRMaterialDocument (direct, exact) is primary.');
  Logger.log('Recovery: ConfirmationGroup → readMaterialDocument_ (backfill).');
  Logger.log('Fallback: MO → ProdnOrdConf2 (ambiguous for multi-pallet MOs).');
  Logger.log('══════════════════════════════════════════');
}

// ============================================================================
// Phase 5 — TEST: confirmation readback guard
// ============================================================================

/**
 * Self-cleaning test for the confirmation SAP readback guard (Phase 5 item 2b).
 * Seeds a fake pallet, verifies payload stamping + readback behaviour, cleans up.
 * Calls SAP GET (read-only) — never POSTs.
 */
function TEST_confirmReadbackGuard() {
  var fn = 'TEST_confirmReadbackGuard';
  var t0 = Date.now();

  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' ' + fn);
  Logger.log('══════════════════════════════════════════');

  var pass = true;
  var results = [];

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    Logger.log((ok ? '✅' : '❌') + ' ' + name + (detail ? ' — ' + detail : ''));
    if (!ok) pass = false;
  }

  // ---- Pick a real confirmed MO for SAP readback probes ----
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  var data = sh.getDataRange().getValues();
  var idx = {};
  data[0].forEach(function(h, i) { idx[String(h).trim()] = i; });

  var realMO = '', realPaddedMO = '', realPalletId = '';
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['ScanStatus']] || '').trim() !== 'CONFIRMED') continue;
    var pid = String(data[r][idx['PalletID']] || '').trim();
    if (/^PL-TEST-/i.test(pid)) continue;
    realMO = String(data[r][idx['ManufacturingOrder']] || '').trim();
    if (!realMO) continue;
    realPaddedMO = realMO.padStart(12, '0');
    realPalletId = pid;
    break;
  }

  if (!realMO) {
    Logger.log('⚠️ No real CONFIRMED MO found — SAP readback probes will be skipped');
  }

  // ---- Seed a test pallet for payload stamp verification ----
  var TEST_PID = 'PL-TEST-RB-GUARD-L01';
  var donorMo = '';
  for (var d2 = 1; d2 < data.length; d2++) {
    var mo2 = String(data[d2][idx['ManufacturingOrder']] || '').trim();
    if (mo2 && getFinalOperationCached_(mo2)) { donorMo = mo2; break; }
  }

  if (!donorMo) {
    Logger.log('⚠️ No donor MO with FinalOperation — payload stamp tests skipped');
    assert('(1a) payload stamp — normal builder', false, 'no donor MO');
  } else {
    var seedRow = data[0].map(function(h) { return ''; });
    seedRow[idx['PalletID']] = TEST_PID;
    seedRow[idx['ManufacturingOrder']] = donorMo;
    seedRow[idx['Material']] = 'TEST-RB-MAT';
    seedRow[idx['QtyPerPallet']] = 100;
    seedRow[idx['Unit']] = 'PC';
    seedRow[idx['ScanStatus']] = 'QC_COMPLETE';
    if (idx['Plant'] !== undefined) seedRow[idx['Plant']] = CFG.PLANT;
    sh.getRange(sh.getLastRow() + 1, 1, 1, data[0].length).setValues([seedRow]);
    SpreadsheetApp.flush();
    Logger.log('Seeded ' + TEST_PID + ' with MO=' + donorMo);

    try {
      // ---- (1a) Normal builder stamps ConfirmationText ----
      var p1 = buildConfirmationPayload_(TEST_PID);
      assert('(1a) payload stamp — normal builder',
        p1 && !p1.error && p1.ConfirmationText === TEST_PID,
        'ConfirmationText=' + (p1 ? p1.ConfirmationText : '(error)'));

      assert('(1a) ConfirmationText is string',
        typeof (p1 || {}).ConfirmationText === 'string',
        'typeof=' + typeof (p1 || {}).ConfirmationText);

      assert('(1a) ConfirmationText ≤ 40',
        ((p1 || {}).ConfirmationText || '').length <= 40,
        'len=' + ((p1 || {}).ConfirmationText || '').length);

    } finally {
      var freshData = sh.getDataRange().getValues();
      for (var del = freshData.length - 1; del >= 1; del--) {
        if (String(freshData[del][idx['PalletID']] || '').trim() === TEST_PID) {
          sh.deleteRow(del + 1);
        }
      }
      Logger.log('Cleaned up ' + TEST_PID);
    }
  }

  // ---- (2) sapReadbackConfirmation_ — deliberate no-hit (token-only filter) ----
  var rb1 = sapReadbackConfirmation_('PL-TEST-NOHIT');
  assert('(2) readback no-hit — found:false',
    rb1.found === false,
    'found=' + rb1.found + (rb1.error ? ' error=' + rb1.error : ''));
  assert('(2) readback no-hit — no error (filter accepted)',
    !rb1.error,
    rb1.error || 'clean');

  // ---- (3) No false positive on legacy (pre-stamp) records ----
  if (realPalletId) {
    var rb2 = sapReadbackConfirmation_(realPalletId);
    assert('(3) no false positive on legacy records — found:false',
      rb2.found === false,
      'PID=' + realPalletId + ' found=' + rb2.found);
  } else {
    assert('(3) no false positive on legacy', false, 'skipped — no real data');
  }

  // ---- (4) Graceful degrade on nonsense token ----
  var rb3 = sapReadbackConfirmation_('PL-TEST-BADMO');
  assert('(4) graceful degrade — found:false, no throw',
    rb3.found === false,
    'found=' + rb3.found + ' error=' + (rb3.error || 'none'));

  // ---- (5) Positive hit on known post-stamp pallet (PL-1000036346-L02) ----
  var KNOWN_STAMPED = 'PL-1000036346-L02';
  var rb5 = sapReadbackConfirmation_(KNOWN_STAMPED);
  assert('(5) known post-stamp pallet — found:true',
    rb5.found === true,
    'found=' + rb5.found + (rb5.error ? ' error=' + rb5.error : '') +
    ' grp=' + (rb5.confirmationGroup || '') + ' cnt=' + (rb5.confirmationCount || ''));
  assert('(5) confirmationText matches PalletID',
    rb5.confirmationText === KNOWN_STAMPED,
    'got="' + (rb5.confirmationText || '') + '" expected="' + KNOWN_STAMPED + '"');

  var elapsed = Date.now() - t0;
  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  Logger.log(fn + ': ' + (pass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name);
  });
  Logger.log('──────────────────────────────────────────');

  logEvent('TEST_CONFIRM_RB', 'Confirmation', pass ? 'PASS' : 'FAIL', elapsed,
    results.length + ' assertions');
}

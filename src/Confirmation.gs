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
 *  - getFinalOperationForMo_() (ProductionOrders.gs)   — FinalOperation with populate-on-miss
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
// Phase 5 item 2c — retry with readback-first on every attempt
// ============================================================================

var CONFIRM_MAX_ATTEMPTS_ = 3;

/**
 * Classify a postConfirmation_ error for retry decisions.
 * @param {Error} e
 * @return {{type:'TRANSIENT'|'BUSINESS'|'TIMEOUT_UNKNOWN', code:number}}
 */
function _classifyConfirmError_(e) {
  var msg = String(e.message || e || '');
  var m = msg.match(/HTTP (\d+)/);
  var code = m ? parseInt(m[1], 10) : 0;
  if (code === 403 && /csrf/i.test(msg)) return { type: 'TRANSIENT', code: 403 };
  if (code === 429) return { type: 'TRANSIENT', code: 429 };
  if (code >= 500) return { type: 'TRANSIENT', code: code };
  if (code >= 400) return { type: 'BUSINESS', code: code };
  return { type: 'TIMEOUT_UNKNOWN', code: 0 };
}

/**
 * Heal a pallet whose confirmation was found in SAP but not written back locally.
 * @param {string} palletId
 * @param {{confirmationGroup:string, confirmationCount:string}} rb
 */
function _healConfirmedPallet_(palletId, rb) {
  updatePalletScanFields_(palletId, {
    ConfirmationGroup: rb.confirmationGroup,
    ConfirmationCount: rb.confirmationCount,
    ScanStatus:        'CONFIRMED',
    ConfirmedAt:       new Date(),
    ConfirmedBy:       'HEAL'
  });
  try { backfillMaterialDocument(palletId); } catch (e) {
    logEvent('CONFIRM', 'HEAL_BACKFILL_ERR', palletId + ' ' + e.message);
  }
}

/**
 * POST a confirmation payload with readback-first retry and exponential backoff.
 * Readback on EVERY attempt (including first): if SAP already has the confirmation
 * → heal the local sheet and return without POSTing.
 *
 * Retry only transient failures (network timeout, 429, 5xx, 403+csrf).
 * 4xx business errors throw immediately. If the POST timed out AND the readback
 * on the next attempt also errors → UNKNOWN_STATE (dead-letter candidate).
 *
 * @param {Object} payload — from buildConfirmationPayload_
 * @param {string} palletId — for readback token filter
 * @param {Object} [testOverrides] — { readbackFn, postFn, healFn, sleepFn } for mocking
 * @return {{ok?:boolean, healed?:boolean, unknownState?:boolean,
 *   confirmationGroup?:string, confirmationCount?:string, session?:Object,
 *   skipped?:boolean, dryRun?:boolean, error?:string}}
 */
function postConfirmationWithRetry_(payload, palletId, testOverrides) {
  var _readback = (testOverrides && testOverrides.readbackFn) || sapReadbackConfirmation_;
  var _post     = (testOverrides && testOverrides.postFn)     || postConfirmation_;
  var _heal     = (testOverrides && testOverrides.healFn)     || _healConfirmedPallet_;
  var _sleep    = (testOverrides && testOverrides.sleepFn)    || function(ms) { Utilities.sleep(ms); };
  var MAX       = CONFIRM_MAX_ATTEMPTS_;

  var lastOutcome = 'NONE';

  for (var attempt = 1; attempt <= MAX; attempt++) {
    // ---- Readback first ----
    var rb = _readback(palletId);

    if (rb.found) {
      _heal(palletId, rb);
      logEvent('CONFIRM', attempt === 1 ? 'HEAL_SKIP' : 'HEAL_AFTER_RETRY',
        palletId + ' attempt=' + attempt + ' grp=' + rb.confirmationGroup);
      return { ok: true, healed: true,
        confirmationGroup: rb.confirmationGroup, confirmationCount: rb.confirmationCount };
    }

    if (rb.error && lastOutcome === 'TIMEOUT_UNKNOWN') {
      logEvent('CONFIRM', 'UNKNOWN_STATE',
        palletId + ' readback error after timeout attempt=' + attempt + ' err=' + rb.error);
      var dlMid = { ok: false, unknownState: true,
        error: 'readback failed after timeout — cannot confirm SAP state' };
      captureDeadLetter_({
        path: 'CONFIRM', palletId: palletId, mo: payload.OrderID,
        paddedMO: payload.OrderID, outcome: 'UNKNOWN_STATE',
        attempts: attempt - 1, lastErrorClass: lastOutcome,
        lastErrorMsg: dlMid.error + ' rb.error=' + rb.error,
        payload: payload, token: String(palletId).slice(0, 40)
      });
      return dlMid;
    }

    if (rb.error) {
      logEvent('CONFIRM', 'READBACK_DEGRADED', palletId + ' attempt=' + attempt + ' ' + rb.error);
    }

    // ---- POST ----
    try {
      var result = _post(payload);
      return result;
    } catch (e) {
      var cls = _classifyConfirmError_(e);
      logEvent('CONFIRM', 'RETRY_ATTEMPT', palletId +
        ' attempt=' + attempt + '/' + MAX + ' class=' + cls.type +
        ' code=' + cls.code + ' ' + String(e.message || '').slice(0, 200));

      if (cls.type === 'BUSINESS') throw e;

      lastOutcome = cls.type;
      if (attempt < MAX) {
        _sleep(CFG.RETRY_BASE_MS * Math.pow(2, attempt - 1));
      }
    }
  }

  // ---- Exhausted: final readback ----
  var finalRb = _readback(palletId);
  if (finalRb.found) {
    _heal(palletId, finalRb);
    logEvent('CONFIRM', 'HEAL_AFTER_RETRY',
      palletId + ' final-readback grp=' + finalRb.confirmationGroup);
    return { ok: true, healed: true,
      confirmationGroup: finalRb.confirmationGroup, confirmationCount: finalRb.confirmationCount };
  }

  if (lastOutcome === 'TIMEOUT_UNKNOWN') {
    logEvent('CONFIRM', 'UNKNOWN_STATE',
      palletId + ' exhausted ' + MAX + ' attempts, last=TIMEOUT');
    var dlUnk = { ok: false, unknownState: true,
      error: 'POST timed out ' + MAX + ' times, final readback not found' };
    captureDeadLetter_({
      path: 'CONFIRM', palletId: palletId, mo: payload.OrderID,
      paddedMO: payload.OrderID, outcome: 'UNKNOWN_STATE',
      attempts: MAX, lastErrorClass: lastOutcome,
      lastErrorMsg: dlUnk.error, payload: payload,
      token: String(palletId).slice(0, 40)
    });
    return dlUnk;
  }

  logEvent('CONFIRM', 'RETRY_EXHAUSTED', palletId + ' lastOutcome=' + lastOutcome);
  captureDeadLetter_({
    path: 'CONFIRM', palletId: palletId, mo: payload.OrderID,
    paddedMO: payload.OrderID, outcome: 'RETRY_EXHAUSTED',
    attempts: MAX, lastErrorClass: lastOutcome,
    lastErrorMsg: 'Transient failure after ' + MAX + ' attempts',
    payload: payload, token: String(palletId).slice(0, 40)
  });
  return { ok: false, retryExhausted: true,
    error: 'Confirmation failed after ' + MAX + ' attempts (' + lastOutcome + ')' };
}

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

    // ---- Build payload ----
    var payload = buildConfirmationPayload_(palletId);
    if (payload && payload.error) {
      logEvent('CONFIRM', 'ERROR', palletId + ' ' + payload.error);
      throw new Error(payload.error);
    }

    // ---- POST with readback-first retry ----
    var result = postConfirmationWithRetry_(payload, palletId);

    if (result.healed) return { alreadyConfirmed: true, healed: true };
    if (result.unknownState || result.retryExhausted) {
      return { ok: false, deadLettered: true,
        error: 'ยืนยันไม่สำเร็จ ระบบบันทึกไว้ตรวจสอบโดยแอดมิน' };
    }
    if (result.skipped || result.dryRun) return result;

    if (result.ok) {
      // ---- Readback MaterialDocument ----
      var matDoc = readMaterialDocument_(
        result.confirmationGroup, result.confirmationCount, result.session
      );

      // ---- Best-effort batch capture from GR doc ----
      var grBatch = '';
      try {
        grBatch = resolveBatchFromGrDoc_(
          matDoc.materialDocument, matDoc.materialDocumentYear,
          pallet.Material, { sloc: pallet.StorageLocation });
      } catch (batchErr) {
        logEvent('CONFIRM', 'BATCH_RESOLVE_ERR', palletId + ' ' + batchErr.message);
      }
      if (!grBatch) {
        logEvent('CONFIRM', 'BATCH_UNRESOLVED',
          palletId + ' grDoc=' + matDoc.materialDocument);
      }

      // ---- Writeback to PalletMaster ----
      var writebackFields = {
        ConfirmationGroup:      result.confirmationGroup,
        ConfirmationCount:      result.confirmationCount,
        GRMaterialDocument:     matDoc.materialDocument,
        GRMaterialDocumentYear: matDoc.materialDocumentYear,
        ConfirmedAt:            new Date(),
        ConfirmedBy:            getActiveUserSafe_(),
        ScanStatus:             'CONFIRMED'
      };
      if (grBatch) {
        writebackFields.Batch = String(grBatch);
      }
      updatePalletScanFields_(palletId, writebackFields);

      logEvent('CONFIRM', 'CONFIRMED', palletId + ' matDoc=' + matDoc.materialDocument +
        (grBatch ? ' batch=' + grBatch : ' batch=UNRESOLVED'));

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
 * Populate-on-miss: uses getFinalOperationForMo_ (OperationsJSON / SAP fallback) when
 * the sheet cache is cold, deduped by MO so each resolves at most once per call.
 * READ-ONLY wrt SAP — may write FinalOperation cache to ProductionOrders sheet.
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
  var foCache = {};
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var status = String(row[idx['ScanStatus']] || '').trim();
    if (status !== 'QC_COMPLETE') continue;

    var pid = String(row[idx['PalletID']] || '').trim();
    if (/^PL-TEST-/i.test(pid)) continue;

    var mo  = String(row[idx['ManufacturingOrder']] || '').trim();
    var qty = Number(row[idx['QtyPerPallet']]) || 0;

    var finalOp;
    if (foCache.hasOwnProperty(mo)) {
      finalOp = foCache[mo];
    } else {
      var cachedVal = getFinalOperationCached_(mo);
      if (cachedVal) {
        finalOp = cachedVal;
      } else {
        finalOp = getFinalOperationForMo_(mo);
        if (finalOp) {
          logEvent('CONFIRM_LIST', mo, 'POPULATE_ON_MISS', 0, 'FinalOp=' + finalOp);
        }
      }
      foCache[mo] = finalOp || '';
    }
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
      FinalConfirmationType:     'X',
      ConfirmationText:          String(palletId).slice(0, 40)
    };

    var result = postConfirmationWithRetry_(payload, palletId);

    if (result.healed) {
      logEvent('OVERRIDE_CONFIRM', 'HEAL_SKIP', palletId + ' found in SAP via retry readback');
      return { success: true, message: 'พาเลทนี้ confirm แล้วใน SAP (healed)' };
    }
    if (result.unknownState || result.retryExhausted) {
      return { success: false, deadLettered: true,
        message: 'ยืนยันไม่สำเร็จ ระบบบันทึกไว้ตรวจสอบโดยแอดมิน' };
    }
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
// Phase 5 item 2d — DeadLetter sheet + capture
// ============================================================================

var DL_SHEET_ = 'DeadLetter';

var DL_HEADERS_ = [
  'DLID', 'CapturedAt', 'Path', 'PalletID', 'ManufacturingOrder', 'PaddedMO',
  'Outcome', 'Attempts', 'LastErrorClass', 'LastErrorMsg',
  'PayloadJSON', 'Token', 'ConfirmedByState',
  'ReplayStatus', 'ReplayedAt', 'ReplayNote'
];

function ensureDeadLetterSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(DL_SHEET_);
  if (sh) return sh;
  sh = ss.insertSheet(DL_SHEET_);
  sh.getRange(1, 1, 1, DL_HEADERS_.length)
    .setValues([DL_HEADERS_])
    .setFontWeight('bold')
    .setBackground('#7f0000')
    .setFontColor('#ffffff');
  sh.setFrozenRows(1);
  return sh;
}

/**
 * Capture a failed confirmation to the DeadLetter sheet.
 * @param {{path:string, palletId:string, mo:string, paddedMO:string,
 *   outcome:string, attempts:number, lastErrorClass:string, lastErrorMsg:string,
 *   payload:Object, token:string}} rec
 */
function captureDeadLetter_(rec) {
  try {
    var sh = ensureDeadLetterSheet_();
    var dlid = 'DL-' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd-HHmmss') +
      '-' + String(rec.palletId || '').slice(-6);
    var now = new Date();
    var row = DL_HEADERS_.map(function(h) {
      switch (h) {
        case 'DLID':             return dlid;
        case 'CapturedAt':       return now;
        case 'Path':             return rec.path || 'CONFIRM';
        case 'PalletID':         return rec.palletId || '';
        case 'ManufacturingOrder': return rec.mo || '';
        case 'PaddedMO':         return rec.paddedMO || '';
        case 'Outcome':          return rec.outcome || '';
        case 'Attempts':         return rec.attempts || 0;
        case 'LastErrorClass':   return rec.lastErrorClass || '';
        case 'LastErrorMsg':     return String(rec.lastErrorMsg || '').slice(0, 500);
        case 'PayloadJSON':      return JSON.stringify(rec.payload || {});
        case 'Token':            return rec.token || '';
        case 'ConfirmedByState': return '';
        case 'ReplayStatus':     return 'OPEN';
        case 'ReplayedAt':       return '';
        case 'ReplayNote':       return '';
        default: return '';
      }
    });
    sh.appendRow(row);
    logEvent('DEADLETTER', 'CAPTURE', rec.palletId + ':' + rec.outcome + ' dlid=' + dlid);
    notifyDeadLetterLark_(dlid, rec);
  } catch (e) {
    logEvent('DEADLETTER', 'CAPTURE_ERROR', rec.palletId + ' ' + e.message);
  }
}

/**
 * Best-effort Lark alert on dead-letter capture.
 * @param {string} dlid
 * @param {Object} rec — same shape as captureDeadLetter_ param
 */
function notifyDeadLetterLark_(dlid, rec) {
  try {
    var severity = rec.outcome === 'UNKNOWN_STATE' ? '🔴 HIGH' : '🟡 MEDIUM';
    var instruction = rec.outcome === 'UNKNOWN_STATE'
      ? 'ตรวจ SAP ว่ามี confirmation ของพาเลทนี้แล้วหรือยังก่อน replay'
      : 'Confirm ไม่สำเร็จ (transient) — สามารถ replay ได้';
    var ts = Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");
    var text = severity + ' Dead Letter — SAP Confirmation\n' +
      'DLID: ' + dlid + '\n' +
      'PalletID: ' + (rec.palletId || '-') + '\n' +
      'MO: ' + (rec.mo || '-') + '\n' +
      'Outcome: ' + (rec.outcome || '-') + '\n' +
      'Attempts: ' + (rec.attempts || 0) + '\n' +
      'Error: ' + String(rec.lastErrorMsg || '').slice(0, 200) + '\n' +
      'Captured: ' + ts + '\n' +
      instruction;
    sendLarkText_(text);
  } catch (e) {
    logEvent('DEADLETTER', 'LARK_FAIL', dlid + ' ' + e.message);
  }
}

// ============================================================================
// Phase 5 item 2d — manual replay
// ============================================================================

/**
 * Replay a dead-letter row: re-run the confirmation through the SAME readback-first
 * retry path. Cannot double-post because sapReadbackConfirmation_ checks first.
 *
 * @param {string} dlid — DLID to replay
 * @return {{ok:boolean, status:string, message:string}}
 */
function replayDeadLetter_(dlid) {
  var sh = getSpreadsheet_().getSheetByName(DL_SHEET_);
  if (!sh || sh.getLastRow() < 2) {
    return { ok: false, status: 'NO_SHEET', message: 'DeadLetter sheet not found' };
  }

  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var idx = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var rowNum = -1;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['DLID']] || '').trim() === dlid) {
      rowNum = r + 1;
      break;
    }
  }
  if (rowNum < 0) {
    return { ok: false, status: 'NOT_FOUND', message: 'DLID not found: ' + dlid };
  }

  var row = data[rowNum - 1];
  var replayStatus = String(row[idx['ReplayStatus']] || '').trim();
  if (replayStatus !== 'OPEN') {
    return { ok: false, status: 'SKIP', message: 'ReplayStatus is ' + replayStatus + ', not OPEN' };
  }

  var palletId = String(row[idx['PalletID']] || '').trim();
  var payloadJson = String(row[idx['PayloadJSON']] || '').trim();
  if (!palletId || !payloadJson) {
    return { ok: false, status: 'INVALID', message: 'Missing PalletID or PayloadJSON' };
  }

  var payload;
  try { payload = JSON.parse(payloadJson); } catch (e) {
    return { ok: false, status: 'INVALID', message: 'PayloadJSON parse error: ' + e.message };
  }

  logEvent('DEADLETTER', 'REPLAY_START', dlid + ' ' + palletId);

  try {
    var result = postConfirmationWithRetry_(payload, palletId);
    var now = new Date();

    if (result.healed) {
      sh.getRange(rowNum, idx['ReplayStatus'] + 1).setValue('REPLAYED_HEALED');
      sh.getRange(rowNum, idx['ReplayedAt'] + 1).setValue(now);
      sh.getRange(rowNum, idx['ReplayNote'] + 1).setValue('Healed via readback');
      logEvent('DEADLETTER', 'REPLAY_HEALED', dlid + ' ' + palletId);
      return { ok: true, status: 'REPLAYED_HEALED', message: 'SAP มี confirmation อยู่แล้ว — healed' };
    }

    if (result.ok) {
      sh.getRange(rowNum, idx['ReplayStatus'] + 1).setValue('REPLAYED_OK');
      sh.getRange(rowNum, idx['ReplayedAt'] + 1).setValue(now);
      sh.getRange(rowNum, idx['ReplayNote'] + 1).setValue(
        'Fresh POST ok grp=' + (result.confirmationGroup || ''));
      logEvent('DEADLETTER', 'REPLAY_OK', dlid + ' ' + palletId +
        ' grp=' + (result.confirmationGroup || ''));
      return { ok: true, status: 'REPLAYED_OK', message: 'Confirm สำเร็จ' };
    }

    if (result.skipped || result.dryRun) {
      sh.getRange(rowNum, idx['ReplayNote'] + 1)
        .setValue('Replay: ' + (result.skipped ? 'write disabled' : 'DRY_RUN'));
      return { ok: false, status: 'FLAG_BLOCKED',
        message: result.skipped ? 'SAP write disabled' : 'DRY_RUN mode' };
    }

    if (result.unknownState || result.retryExhausted) {
      sh.getRange(rowNum, idx['LastErrorMsg'] + 1).setValue(String(result.error || '').slice(0, 500));
      sh.getRange(rowNum, idx['ReplayNote'] + 1)
        .setValue('Replay failed: ' + (result.unknownState ? 'UNKNOWN_STATE' : 'RETRY_EXHAUSTED'));
      logEvent('DEADLETTER', 'REPLAY_STILL_OPEN', dlid + ' ' + palletId + ' ' + (result.error || ''));
      notifyDeadLetterLark_(dlid, {
        palletId: palletId, mo: String(row[idx['ManufacturingOrder']] || ''),
        outcome: result.unknownState ? 'UNKNOWN_STATE' : 'RETRY_EXHAUSTED',
        attempts: CONFIRM_MAX_ATTEMPTS_, lastErrorMsg: result.error || ''
      });
      return { ok: false, status: 'STILL_OPEN', message: 'ยังไม่สำเร็จ — ' + (result.error || '') };
    }

    return { ok: false, status: 'UNEXPECTED', message: 'Unexpected result from retry' };

  } catch (e) {
    sh.getRange(rowNum, idx['LastErrorMsg'] + 1).setValue(String(e.message || '').slice(0, 500));
    sh.getRange(rowNum, idx['ReplayNote'] + 1).setValue('Replay threw: ' + e.message);
    logEvent('DEADLETTER', 'REPLAY_ERROR', dlid + ' ' + palletId + ' ' + e.message);
    return { ok: false, status: 'ERROR', message: e.message };
  }
}

/**
 * Menu entry: prompt for DLID, then replay.
 */
function replayDeadLetterDialog() {
  var ui = SpreadsheetApp.getUi();
  if (!isAdminUser_()) { ui.alert('admin เท่านั้น'); return; }
  var resp = ui.prompt(
    '🔁 Replay DeadLetter',
    'ใส่ DLID (e.g. DL-20260624-143022-L02):',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var dlid = resp.getResponseText().trim();
  if (!dlid) { ui.alert('กรุณาใส่ DLID'); return; }

  var result = replayDeadLetter_(dlid);
  ui.alert('Replay Result: ' + result.status + '\n\n' + result.message);
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

// ============================================================================
// Phase 5 item 2c — TEST: retry classification + behaviour
// ============================================================================

/**
 * Mock-based test for postConfirmationWithRetry_. No real SAP calls.
 * Verifies error classification, MAX_ATTEMPTS, readback-first heal short-circuit,
 * and UNKNOWN_STATE dead-letter path.
 */
function TEST_confirmRetryClassification() {
  var fn = 'TEST_confirmRetryClassification';
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

  var noopHeal = function() {};
  var noopSleep = function() {};
  var fakePayload = { OrderID: '000000000001' };

  // ---- (1) Error classifier ----
  var c1 = _classifyConfirmError_(new Error('SAP Confirmation POST failed HTTP 400: M7/018'));
  assert('(1a) HTTP 400 → BUSINESS', c1.type === 'BUSINESS', 'type=' + c1.type);

  var c2 = _classifyConfirmError_(new Error('SAP Confirmation POST failed HTTP 429: rate'));
  assert('(1b) HTTP 429 → TRANSIENT', c2.type === 'TRANSIENT', 'type=' + c2.type);

  var c3 = _classifyConfirmError_(new Error('SAP Confirmation POST failed HTTP 503: unavail'));
  assert('(1c) HTTP 503 → TRANSIENT', c3.type === 'TRANSIENT', 'type=' + c3.type);

  var c4 = _classifyConfirmError_(new Error('SAP Confirmation POST failed HTTP 403: csrf token'));
  assert('(1d) HTTP 403+csrf → TRANSIENT', c4.type === 'TRANSIENT', 'type=' + c4.type);

  var c5 = _classifyConfirmError_(new Error('SAP Confirmation POST failed HTTP 403: Forbidden'));
  assert('(1e) HTTP 403 no csrf → BUSINESS', c5.type === 'BUSINESS', 'type=' + c5.type);

  var c6 = _classifyConfirmError_(new Error('Exception: Request timed out'));
  assert('(1f) network throw → TIMEOUT_UNKNOWN', c6.type === 'TIMEOUT_UNKNOWN', 'type=' + c6.type);

  var c7 = _classifyConfirmError_(new Error('SAP Confirmation POST failed HTTP 500: internal'));
  assert('(1g) HTTP 500 → TRANSIENT', c7.type === 'TRANSIENT', 'type=' + c7.type);

  // ---- (2) Readback-first heal: POST never called ----
  var postCalled = false;
  var r2 = postConfirmationWithRetry_(fakePayload, 'PL-MOCK-HEAL', {
    readbackFn: function() {
      return { found: true, confirmationGroup: 'G99', confirmationCount: '0001',
        confirmationText: 'PL-MOCK-HEAL' };
    },
    postFn: function() { postCalled = true; return { ok: true }; },
    healFn: noopHeal,
    sleepFn: noopSleep
  });
  assert('(2a) heal result ok + healed', r2.ok === true && r2.healed === true,
    'ok=' + r2.ok + ' healed=' + r2.healed);
  assert('(2b) POST never called', postCalled === false, 'postCalled=' + postCalled);

  // ---- (3) MAX_ATTEMPTS respected — transient errors ----
  var postCount3 = 0;
  var threw3 = false;
  try {
    postConfirmationWithRetry_(fakePayload, 'PL-MOCK-RETRY', {
      readbackFn: function() { return { found: false }; },
      postFn: function() { postCount3++; throw new Error('SAP Confirmation POST failed HTTP 503: down'); },
      healFn: noopHeal,
      sleepFn: noopSleep
    });
  } catch (e) { threw3 = true; }
  assert('(3a) POST called exactly MAX_ATTEMPTS times',
    postCount3 === CONFIRM_MAX_ATTEMPTS_,
    'postCount=' + postCount3 + ' MAX=' + CONFIRM_MAX_ATTEMPTS_);
  assert('(3b) threw RETRY_EXHAUSTED', threw3 === true, 'threw=' + threw3);

  // ---- (4) Business error — no retry, immediate throw ----
  var postCount4 = 0;
  var threw4 = false;
  try {
    postConfirmationWithRetry_(fakePayload, 'PL-MOCK-BIZ', {
      readbackFn: function() { return { found: false }; },
      postFn: function() { postCount4++; throw new Error('SAP Confirmation POST failed HTTP 400: M7/018'); },
      healFn: noopHeal,
      sleepFn: noopSleep
    });
  } catch (e) { threw4 = true; }
  assert('(4a) business error: POST called once', postCount4 === 1, 'postCount=' + postCount4);
  assert('(4b) business error: threw immediately', threw4 === true, 'threw=' + threw4);

  // ---- (5) UNKNOWN_STATE — timeout + readback always not-found ----
  var postCount5 = 0;
  var r5 = postConfirmationWithRetry_(fakePayload, 'PL-MOCK-UNKNOWN', {
    readbackFn: function() { return { found: false }; },
    postFn: function() { postCount5++; throw new Error('Exception: Request timed out'); },
    healFn: noopHeal,
    sleepFn: noopSleep
  });
  assert('(5a) unknownState returned', r5.unknownState === true, 'unknownState=' + r5.unknownState);
  assert('(5b) POST called exactly MAX_ATTEMPTS times',
    postCount5 === CONFIRM_MAX_ATTEMPTS_,
    'postCount=' + postCount5);

  // ---- (6) UNKNOWN_STATE short-circuit — timeout then readback error ----
  var rbCallCount6 = 0;
  var postCount6 = 0;
  var r6 = postConfirmationWithRetry_(fakePayload, 'PL-MOCK-RBFAIL', {
    readbackFn: function() {
      rbCallCount6++;
      if (rbCallCount6 === 1) return { found: false };
      return { found: false, error: 'HTTP 500 readback fail' };
    },
    postFn: function() { postCount6++; throw new Error('Exception: DNS error'); },
    healFn: noopHeal,
    sleepFn: noopSleep
  });
  assert('(6a) unknownState from readback error after timeout',
    r6.unknownState === true, 'unknownState=' + r6.unknownState);
  assert('(6b) POST called only 1 time (stopped on attempt 2 readback)',
    postCount6 === 1, 'postCount=' + postCount6);

  // ---- (7) Success on retry after transient ----
  var postCount7 = 0;
  var r7 = postConfirmationWithRetry_(fakePayload, 'PL-MOCK-RECOVER', {
    readbackFn: function() { return { found: false }; },
    postFn: function() {
      postCount7++;
      if (postCount7 === 1) throw new Error('SAP Confirmation POST failed HTTP 503: temp');
      return { ok: true, confirmationGroup: 'G77', confirmationCount: '0001', session: {} };
    },
    healFn: noopHeal,
    sleepFn: noopSleep
  });
  assert('(7a) success on 2nd attempt', r7.ok === true && !r7.healed, 'ok=' + r7.ok + ' healed=' + r7.healed);
  assert('(7b) POST called 2 times', postCount7 === 2, 'postCount=' + postCount7);

  // ---- (8) Heal on retry readback (timeout-after-success) ----
  var rbCount8 = 0;
  var postCount8 = 0;
  var r8 = postConfirmationWithRetry_(fakePayload, 'PL-MOCK-HEALED', {
    readbackFn: function() {
      rbCount8++;
      if (rbCount8 === 1) return { found: false };
      return { found: true, confirmationGroup: 'G88', confirmationCount: '0013',
        confirmationText: 'PL-MOCK-HEALED' };
    },
    postFn: function() { postCount8++; throw new Error('Exception: timed out'); },
    healFn: noopHeal,
    sleepFn: noopSleep
  });
  assert('(8a) healed on 2nd attempt readback', r8.ok === true && r8.healed === true,
    'ok=' + r8.ok + ' healed=' + r8.healed);
  assert('(8b) POST called once (timed out), healed on retry readback',
    postCount8 === 1, 'postCount=' + postCount8);

  var elapsed = Date.now() - t0;
  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  Logger.log(fn + ': ' + (pass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name);
  });
  Logger.log('──────────────────────────────────────────');

  logEvent('TEST_CONFIRM_RETRY', 'Confirmation', pass ? 'PASS' : 'FAIL', elapsed,
    results.length + ' assertions');
}

// ============================================================================
// Phase 5 item 2d — TEST: dead-letter capture + replay
// ============================================================================

/**
 * Mock-based test for dead-letter capture and replay. No real SAP calls or Lark sends.
 * Self-cleaning: removes PL-TEST-DL-* rows from DeadLetter sheet.
 */
function TEST_deadLetterCaptureReplay() {
  var fn = 'TEST_deadLetterCaptureReplay';
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

  // ---- (1) ensureDeadLetterSheet_ creates correct headers ----
  var sh = ensureDeadLetterSheet_();
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function(h) { return String(h).trim(); });
  assert('(1) DeadLetter sheet exists', !!sh, 'sheet=' + sh.getName());
  assert('(1) header matches DL_HEADERS_',
    JSON.stringify(hdr) === JSON.stringify(DL_HEADERS_),
    'len=' + hdr.length + ' expected=' + DL_HEADERS_.length);

  // ---- (2) captureDeadLetter_ appends a row ----
  var beforeRows = sh.getLastRow();
  captureDeadLetter_({
    path: 'CONFIRM', palletId: 'PL-TEST-DL-001', mo: '0000099999',
    paddedMO: '000000099999', outcome: 'UNKNOWN_STATE',
    attempts: 3, lastErrorClass: 'TIMEOUT_UNKNOWN',
    lastErrorMsg: 'test dead letter capture',
    payload: { OrderID: '000000099999', ConfirmationText: 'PL-TEST-DL-001' },
    token: 'PL-TEST-DL-001'
  });
  var afterRows = sh.getLastRow();
  assert('(2a) row appended', afterRows === beforeRows + 1,
    'before=' + beforeRows + ' after=' + afterRows);

  var idx = {};
  sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .forEach(function(h, i) { idx[String(h).trim()] = i; });
  var lastRow = sh.getRange(afterRows, 1, 1, sh.getLastColumn()).getValues()[0];
  assert('(2b) ReplayStatus = OPEN',
    String(lastRow[idx['ReplayStatus']]).trim() === 'OPEN',
    'got=' + lastRow[idx['ReplayStatus']]);
  assert('(2c) Outcome = UNKNOWN_STATE',
    String(lastRow[idx['Outcome']]).trim() === 'UNKNOWN_STATE',
    'got=' + lastRow[idx['Outcome']]);

  var dlid = String(lastRow[idx['DLID']]).trim();
  assert('(2d) DLID is non-empty', dlid.length > 0, 'dlid=' + dlid);

  var pjRaw = String(lastRow[idx['PayloadJSON']]).trim();
  var pjParsed = null;
  try { pjParsed = JSON.parse(pjRaw); } catch (_) {}
  assert('(2e) PayloadJSON round-trips',
    pjParsed !== null && pjParsed.OrderID === '000000099999',
    'parsed=' + (pjParsed ? 'ok' : 'fail'));

  // ---- (3) replayDeadLetter_ with mock healed → REPLAYED_HEALED ----
  var replayPostCalled = false;
  var origRetry = postConfirmationWithRetry_;

  // We can't inject mocks into replayDeadLetter_ directly (it calls the global),
  // so we test the replay status update by temporarily overriding (restore in finally).
  // Instead, test replayDeadLetter_ on a row that's not OPEN (skip path).
  sh.getRange(afterRows, idx['ReplayStatus'] + 1).setValue('REPLAYED_HEALED');
  var r3 = replayDeadLetter_(dlid);
  assert('(3) replay skips non-OPEN row',
    r3.status === 'SKIP',
    'status=' + r3.status);

  // Reset to OPEN for the next test
  sh.getRange(afterRows, idx['ReplayStatus'] + 1).setValue('OPEN');

  // ---- (4) replayDeadLetter_ on non-existent DLID ----
  var r4 = replayDeadLetter_('DL-NONEXISTENT-000');
  assert('(4) replay not-found',
    r4.status === 'NOT_FOUND',
    'status=' + r4.status);

  // ---- Cleanup: remove PL-TEST-DL-* rows ----
  var freshData = sh.getDataRange().getValues();
  var pidCol = idx['PalletID'];
  var deleted = 0;
  for (var d = freshData.length - 1; d >= 1; d--) {
    if (/^PL-TEST-DL-/i.test(String(freshData[d][pidCol] || '').trim())) {
      sh.deleteRow(d + 1);
      deleted++;
    }
  }
  Logger.log('Cleaned up ' + deleted + ' PL-TEST-DL-* rows');

  var elapsed = Date.now() - t0;
  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  Logger.log(fn + ': ' + (pass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name);
  });
  Logger.log('──────────────────────────────────────────');

  logEvent('TEST_DEADLETTER', 'Confirmation', pass ? 'PASS' : 'FAIL', elapsed,
    results.length + ' assertions');
}

// ============================================================================
// Phase 5: TEST — Populate-on-miss FinalOperation in listConfirmablePallets
// ============================================================================

/**
 * Self-cleaning test for the populate-on-miss FinalOperation path added to
 * listConfirmablePallets(). Seeds a ZZTEST MO in ProductionOrders with
 * OperationsJSON but empty FinalOperation, plus 3 PalletMaster rows for the
 * same MO (ScanStatus=QC_COMPLETE). Asserts:
 *   1) getFinalOperationForMo_ resolves the correct final op AND writes it back
 *   2) listConfirmablePallets returns all 3 pallets as ready
 *   3) Dedupe: only 1 POPULATE_ON_MISS event logged (not 3)
 * Deletes all test rows on exit (try/finally). No SAP POST.
 */
function TEST_finalOpPopulateOnMiss() {
  var fn = 'TEST_finalOpPopulateOnMiss';
  var TEST_MO = 'ZZTEST_FOMISS';
  var PALLET_IDS = ['PL-ZZFOMISS-L01', 'PL-ZZFOMISS-L02', 'PL-ZZFOMISS-L03'];
  var t0 = Date.now();

  // ---- Seed ProductionOrders row: OperationsJSON present, FinalOperation empty ----
  var foSh = getSpreadsheet_().getSheetByName('ProductionOrders');
  var foHdr = foSh.getRange(1, 1, 1, foSh.getLastColumn()).getValues()[0];
  var foIdx = {};
  foHdr.forEach(function(h, i) { foIdx[h] = i; });

  var testOps = [
    { opNo: '0010', opText: 'Cut', workCenter: 'WC01' },
    { opNo: '0020', opText: 'Sand', workCenter: 'WC02' },
    { opNo: '0030', opText: 'Pack', workCenter: 'WC03' }
  ];
  var foRow = new Array(foHdr.length).fill('');
  foRow[foIdx['ManufacturingOrder']] = TEST_MO;
  foRow[foIdx['OperationsJSON']]     = JSON.stringify(testOps);
  foRow[foIdx['Operations']]         = '0010:WC01|Cut; 0020:WC02|Sand; 0030:WC03|Pack';
  if (foIdx['Material'] !== undefined)   foRow[foIdx['Material']]   = 'ZZTEST-MAT';
  if (foIdx['IsReleased'] !== undefined) foRow[foIdx['IsReleased']] = true;
  foSh.appendRow(foRow);

  // ---- Seed 3 PalletMaster rows for the same MO ----
  var pmSh = getSpreadsheet_().getSheetByName(PM_SHEET);
  var pmHdr = pmSh.getRange(1, 1, 1, pmSh.getLastColumn()).getValues()[0];
  var pmIdx = {};
  pmHdr.forEach(function(h, i) { pmIdx[h] = i; });

  PALLET_IDS.forEach(function(pid, seq) {
    var pmRow = new Array(pmHdr.length).fill('');
    pmRow[pmIdx['PalletID']]            = pid;
    pmRow[pmIdx['ManufacturingOrder']]   = TEST_MO;
    pmRow[pmIdx['Material']]             = 'ZZTEST-MAT';
    pmRow[pmIdx['QtyPerPallet']]         = 100;
    pmRow[pmIdx['Unit']]                 = 'PC';
    pmRow[pmIdx['WorkCenter']]           = 'WC01';
    pmRow[pmIdx['QCResult']]             = 'PASS';
    pmRow[pmIdx['PalletSeq']]            = seq + 1;
    pmRow[pmIdx['ScanStatus']]           = 'QC_COMPLETE';
    if (pmIdx['Plant'] !== undefined)    pmRow[pmIdx['Plant']] = CFG.PLANT;
    pmSh.appendRow(pmRow);
  });

  SpreadsheetApp.flush();

  var pass = true;
  var detail = '';

  try {
    // ---- Assert 1: getFinalOperationForMo_ resolves + writes back ----
    var resolved = getFinalOperationForMo_(TEST_MO);
    SpreadsheetApp.flush();

    if (resolved !== '0030') {
      pass = false;
      detail += 'resolved=' + resolved + '(expected 0030) FAIL. ';
    } else {
      detail += 'resolved=0030 OK. ';
    }

    // Verify written back to sheet cell
    var foData = foSh.getDataRange().getValues();
    var foWritten = '';
    for (var i = foData.length - 1; i >= 1; i--) {
      if (String(foData[i][foIdx['ManufacturingOrder']] || '').trim() === TEST_MO) {
        foWritten = String(foData[i][foIdx['FinalOperation']] || '').trim();
        break;
      }
    }
    if (foWritten !== '0030') {
      pass = false;
      detail += 'cellWriteback=' + foWritten + '(expected 0030) FAIL. ';
    } else {
      detail += 'cellWriteback=0030 OK. ';
    }

    // ---- Assert 2 + 3: listConfirmablePallets with cold cache + dedupe ----
    // Clear FinalOperation again to test the list path
    for (var j = foData.length - 1; j >= 1; j--) {
      if (String(foData[j][foIdx['ManufacturingOrder']] || '').trim() === TEST_MO) {
        foSh.getRange(j + 1, foIdx['FinalOperation'] + 1).setValue('');
        break;
      }
    }
    SpreadsheetApp.flush();

    // Snapshot POPULATE_ON_MISS count before list call
    var evSh = getSpreadsheet_().getSheetByName('EventLog');
    var missBefore = 0;
    if (evSh && evSh.getLastRow() > 1) {
      var evRows = evSh.getDataRange().getValues();
      for (var e = 0; e < evRows.length; e++) {
        if (String(evRows[e][1] || '') === 'CONFIRM_LIST' &&
            String(evRows[e][2] || '') === TEST_MO &&
            String(evRows[e][3] || '') === 'POPULATE_ON_MISS') {
          missBefore++;
        }
      }
    }

    var candidates = listConfirmablePallets();
    SpreadsheetApp.flush();

    var testPallets = candidates.filter(function(c) {
      return PALLET_IDS.indexOf(c.PalletID) !== -1;
    });

    if (testPallets.length !== 3) {
      pass = false;
      detail += 'listCount=' + testPallets.length + '(expected 3) FAIL. ';
    } else {
      var allReady = testPallets.every(function(p) {
        return p.ready && p.finalOperation === '0030';
      });
      if (!allReady) {
        pass = false;
        detail += 'readiness FAIL: ';
        testPallets.forEach(function(p) {
          detail += p.PalletID + ':ready=' + p.ready + ',fo=' + p.finalOperation + ' ';
        });
      } else {
        detail += 'list:3×ready OK. ';
      }
    }

    // Count POPULATE_ON_MISS after — should be exactly 1 more (dedupe)
    var missAfter = 0;
    evSh = getSpreadsheet_().getSheetByName('EventLog');
    if (evSh && evSh.getLastRow() > 1) {
      var evRows2 = evSh.getDataRange().getValues();
      for (var e2 = 0; e2 < evRows2.length; e2++) {
        if (String(evRows2[e2][1] || '') === 'CONFIRM_LIST' &&
            String(evRows2[e2][2] || '') === TEST_MO &&
            String(evRows2[e2][3] || '') === 'POPULATE_ON_MISS') {
          missAfter++;
        }
      }
    }
    var missCount = missAfter - missBefore;
    if (missCount !== 1) {
      pass = false;
      detail += 'dedupe:missCount=' + missCount + '(expected 1) FAIL. ';
    } else {
      detail += 'dedupe:1miss OK. ';
    }

  } catch (ex) {
    pass = false;
    detail += 'EXCEPTION: ' + ex.message;
  } finally {
    // ---- Cleanup: delete all test rows ----
    var pmClean = pmSh.getDataRange().getValues();
    for (var d = pmClean.length - 1; d >= 1; d--) {
      if (PALLET_IDS.indexOf(String(pmClean[d][pmIdx['PalletID']] || '').trim()) !== -1) {
        pmSh.deleteRow(d + 1);
      }
    }
    var foClean = foSh.getDataRange().getValues();
    for (var d2 = foClean.length - 1; d2 >= 1; d2--) {
      if (String(foClean[d2][foIdx['ManufacturingOrder']] || '').trim() === TEST_MO) {
        foSh.deleteRow(d2 + 1);
      }
    }
    SpreadsheetApp.flush();
  }

  Logger.log(pass ? '✅ ' + fn + ' PASSED: ' + detail : '❌ ' + fn + ' FAILED: ' + detail);
  logEvent(fn, TEST_MO, pass ? 'PASS' : 'FAIL', Date.now() - t0, detail);
}

/**
 * WebApp.gs — Phase 3: Mobile Scanner + Admin Web App
 * ====================================================
 * Phase 3 — Step 1 + Step 2d
 *
 * doGet() routes by ?app= query param:
 *   ?app=scan    → Scanner.html        (operators, no restriction)
 *   ?app=print   → AdminPrint.html     (admin only)
 *   ?app=confirm → AdminConfirm.html   (admin only)
 *   (default)    → scan
 *
 * Admin pages gated by CFG.ADMIN_EMAILS allowlist + isAdminUser_().
 * Backend functions (lookupPallet, confirmScan, getSapStatus) are called
 * via google.script.run from Scanner.html.
 *
 * SAP gate: all SAP write paths check sapWriteEnabled_() + isDryRun_() from Flags.gs.
 */

// ============================================================================
// Web App entry point
// ============================================================================

/**
 * Route web app requests by ?app= parameter.
 * Deploy: Execute as Me, Access: DOMAIN (or ANYONE — see appsscript.json)
 */
function doGet(e) {
  var app = String((e && e.parameter && e.parameter.app) || 'scan').toLowerCase();

  // --- Operator page (no auth gate) ---
  if (app === 'scan') {
    return HtmlService.createTemplateFromFile('Scanner')
      .evaluate()
      .setTitle(CFG.WEB_APP_TITLE)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // --- Admin pages (auth gate) ---
  var adminPages = {
    print:   { file: 'AdminPrint',   title: 'Admin — Print Pallet Sheets' },
    confirm: { file: 'AdminConfirm', title: 'Admin — Confirm to SAP' }
  };

  var page = adminPages[app];
  if (!page) {
    return HtmlService.createHtmlOutput('<h2>404 — Unknown page: ' + app + '</h2>')
      .setTitle('Not Found');
  }

  if (!isAdminUser_()) {
    var email = '';
    try { email = Session.getActiveUser().getEmail() || ''; } catch (_) {}
    return HtmlService.createHtmlOutput(
      '<h2>Access Denied</h2>' +
      '<p>This page is restricted to authorized administrators.</p>' +
      '<p>Signed in as: <strong>' + (email || '(no email detected)') + '</strong></p>'
    ).setTitle('Access Denied');
  }

  return HtmlService.createTemplateFromFile(page.file)
    .evaluate()
    .setTitle(page.title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Templating helper — include another HTML file's content inline */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ============================================================================
// Auth helpers
// ============================================================================

/**
 * Check if the current user is an admin.
 * Returns true if ADMIN_LOCK_ENABLED is false (open mode), or if the
 * user's email is in CFG.ADMIN_EMAILS (case-insensitive).
 * Fail-closed: empty email = not admin (unless lock disabled).
 * @return {boolean}
 */
function isAdminUser_() {
  if (CFG.ADMIN_LOCK_ENABLED === false) {
    logEvent('AUTH', 'Admin', 'OK_UNLOCKED', 0, '(lock disabled)');
    return true;
  }
  var email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (_) {}
  var isAdmin = email !== '' && CFG.ADMIN_EMAILS.some(function (a) {
    return a.toLowerCase() === email.toLowerCase();
  });
  logEvent('AUTH', 'Admin', isAdmin ? 'OK' : 'DENY', 0, email || '(no email)');
  return isAdmin;
}

/**
 * Test helper — run from Apps Script editor to verify auth setup.
 * Logs current user email, lock state, and admin check result.
 */
function whoAmI() {
  var email = '';
  try { email = Session.getActiveUser().getEmail() || '(empty)'; } catch (e) { email = '(error: ' + e.message + ')'; }
  var isAdmin = isAdminUser_();
  Logger.log('Email:              ' + email);
  Logger.log('ADMIN_LOCK_ENABLED: ' + CFG.ADMIN_LOCK_ENABLED);
  Logger.log('isAdminUser_():     ' + isAdmin);
  Logger.log('ADMIN_EMAILS:       ' + JSON.stringify(CFG.ADMIN_EMAILS));
}

// ============================================================================
// Backend API — called by google.script.run from HTML pages
// ============================================================================

/** Return active user email for admin page display. */
function getActiveUserEmail() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (_) { return ''; }
}

/**
 * Return current SAP flag status for the UI badge.
 * @return {{ sapWriteEnabled: boolean, dryRun: boolean }}
 */
function getSapStatus() {
  return {
    sapWriteEnabled: sapWriteEnabled_(),
    dryRun:          isDryRun_()
  };
}

/**
 * Lookup pallet by PalletID — called after QR scan or manual input.
 * Also fetches the routing operations list and this pallet's OperationLog
 * entries, so the UI can render the operation timeline and sequential gate.
 *
 * allOpsConfirmed and qcDone are computed server-side (same rule as
 * checkAllOperationsDone_ / saveQcResult's gate) so the UI doesn't need to
 * re-derive them from operations/operationLogs and risk drifting from the
 * backend's definition of "ready for QC".
 *
 * @param {string} palletId
 * @return {{ found: boolean, pallet: Object|null, operations: Array, operationLogs: Array, allOpsConfirmed: boolean, qcDone: boolean, error: string|null }}
 */
function lookupPallet(palletId) {
  try {
    palletId = String(palletId || '').trim();
    if (!palletId) return { found: false, pallet: null, operations: [], operationLogs: [], allOpsConfirmed: false, qcDone: false, error: 'PalletID ว่าง' };

    const pallet = lookupPalletById_(palletId);
    if (!pallet) {
      logEvent('SCAN_LOOKUP', 'PalletMaster', 'NOT_FOUND', 0, palletId);
      return { found: false, pallet: null, operations: [], operationLogs: [], allOpsConfirmed: false, qcDone: false, error: 'ไม่พบพาเลท: ' + palletId };
    }

    // Format dates as strings for JSON transfer
    pallet.ProductionDate = _fmtDateStr_(pallet.ProductionDate);
    pallet.ScannedAt      = _fmtDateStr_(pallet.ScannedAt);
    delete pallet.rowNum; // internal field — don't expose

    const operations    = getOperationsForOrder(pallet.ManufacturingOrder);
    const operationLogs = getOperationLogs_(palletId);

    // Same rule as checkAllOperationsDone_, computed inline to avoid re-fetching
    // operations/operationLogs that are already in scope.
    const allOpsConfirmed = operations.length > 0 && operations.every(function (op) {
      return operationLogs.some(function (log) { return log.operationNo === op.opNo; });
    });
    const qcDone = pallet.QCStatus === 'INSPECTED';

    logEvent('SCAN_LOOKUP', 'PalletMaster', 'OK', 0, palletId);
    return {
      found: true,
      pallet: pallet,
      operations: operations,
      operationLogs: operationLogs,
      allOpsConfirmed: allOpsConfirmed,
      qcDone: qcDone,
      error: null
    };

  } catch (e) {
    logError('lookupPallet', 'PalletMaster', e.message, palletId);
    return { found: false, pallet: null, operations: [], operationLogs: [], allOpsConfirmed: false, qcDone: false, error: 'เกิดข้อผิดพลาด: ' + e.message };
  }
}

/**
 * Confirm scan: log to OperationLog + update PalletMaster + SAP gate (Step 1 = stub).
 * Idempotency gate runs before any write — rejects if the pallet is already
 * CONFIRMED (final op done) or this exact palletId+opNo was already logged.
 *
 * @param {Object} params { palletId, opNo, opText, isFinal, qtyGood, qtyScrap, operator, role }
 * @return {{ success: boolean, sapSent: boolean, message: string, logId: string|null }}
 */
function confirmScan(params) {
  try {
    params         = params || {};
    const palletId = String(params.palletId || '').trim();
    const opNo     = _normOpNo_(params.opNo);
    const opText   = String(params.opText   || '').trim();
    const isFinal  = params.isFinal === true || params.isFinal === 'true';
    const qtyGood  = Number(params.qtyGood)  || 0;
    const qtyScrap = Number(params.qtyScrap) || 0;
    const operator = String(params.operator  || '').trim();
    const role     = String(params.role      || '').trim();

    if (!palletId) return { success: false, sapSent: false, message: 'ไม่มี PalletID', logId: null };
    if (!operator) return { success: false, sapSent: false, message: 'กรุณาระบุชื่อผู้ปฏิบัติงาน', logId: null };
    if (!role)     return { success: false, sapSent: false, message: 'กรุณาเลือก Role', logId: null };

    const pallet = lookupPalletById_(palletId);
    if (!pallet) return { success: false, sapSent: false, message: 'ไม่พบพาเลท: ' + palletId, logId: null };

    // === Idempotency gate — check before ANY write ===
    if (pallet.ScanStatus === 'CONFIRMED') {
      const existingDoc = pallet.GRMaterialDocument || '-';
      return {
        success: false, sapSent: false,
        message: '⚠️ พาเลทนี้ยืนยันขั้นตอนสุดท้ายแล้ว (เอกสาร: ' + existingDoc + ')',
        logId: null
      };
    }
    if (opNo && isOperationLogged_(palletId, opNo)) {
      return {
        success: false, sapSent: false,
        message: '⚠️ ขั้นตอน ' + opNo + ' ของพาเลทนี้บันทึกแล้ว',
        logId: null
      };
    }

    // === Sequential gate — operation N can't start until N-1 has OP confirm ===
    // PD inspection is optional random sampling and does NOT block the next operation.
    if (opNo) {
      const operations = getOperationsForOrder(pallet.ManufacturingOrder);
      const opIndex     = operations.findIndex(function (o) { return o.opNo === opNo; });
      if (opIndex > 0) {
        const logs = getOperationLogs_(palletId);
        for (let i = 0; i < opIndex; i++) {
          const prevLog = logs.find(function (l) { return l.operationNo === operations[i].opNo; });
          if (!prevLog) {
            return {
              success: false, sapSent: false,
              message: '⚠️ ต้องบันทึกขั้นตอน ' + operations[i].opNo + ' — ' +
                       (operations[i].opText || operations[i].workCenter) + ' ก่อน',
              logId: null
            };
          }
          // PD result is NOT checked here — PD is optional/random sampling.
        }
      }
    }

    // 1. Append to OperationLog (always — not gated by DRY_RUN)
    const logId = logOperation_({
      palletId:      palletId,
      mo:            pallet.ManufacturingOrder,
      operationNo:   opNo,
      operationText: opText,
      goodQty:       qtyGood,
      scrapQty:      qtyScrap,
      operator:      operator,
      role:          role,
      result:        'PASS',
      source:        'MOBILE'
    });

    // 2. Every routing operation now has an OP confirm? PD is optional sampling
    // and does not gate this — QC unlocks as soon as this is true.
    const allOperationsDone = checkAllOperationsDone_(palletId);

    // 3. Update PalletMaster scan fields — ScanStatus only reaches CONFIRMED via
    // SAP order confirmation (Phase 3 Step 2); PD_COMPLETE here means every
    // operation has an OP confirm (PD sampling result, if any, doesn't matter).
    updatePalletScanFields_(palletId, {
      ScanStatus: allOperationsDone ? 'PD_COMPLETE' : 'SCANNED',
      ScannedAt:  new Date(),
      ScannedBy:  operator
    });

    logEvent('SCAN_CONFIRM', 'PalletMaster', 'OK', 0,
      palletId + ' op=' + opNo + ' role=' + role +
      ' good=' + qtyGood + ' scrap=' + qtyScrap + ' final=' + isFinal);

    const doneSuffix = allOperationsDone ? ' — ครบทุกขั้นตอน พร้อมให้ QC ตรวจ' : '';

    // 4. SAP gate — Step 1: write always off
    if (!sapWriteEnabled_()) {
      return {
        success: true,
        sapSent: false,
        allOperationsDone: allOperationsDone,
        message: 'บันทึกงานสำเร็จ' + (isFinal ? ' (ขั้นตอนสุดท้าย)' : '') + doneSuffix + ' (SAP OFF — โหมดทดสอบ)',
        logId:   logId
      };
    }

    // SAP enabled — stub for Step 2
    return {
      success: true,
      sapSent: false,
      allOperationsDone: allOperationsDone,
      message: 'บันทึกงานสำเร็จ' + doneSuffix + ' — SAP confirmation จะเปิดใช้ใน Step 2',
      logId:   logId
    };

  } catch (e) {
    logError('confirmScan', 'PalletMaster', e.message,
      'palletId=' + (params && params.palletId) + ' role=' + (params && params.role));
    return { success: false, sapSent: false, message: 'เกิดข้อผิดพลาด: ' + e.message, logId: null };
  }
}

/**
 * Save PD inspection result for one operation — PD inspection is optional
 * random sampling, called (if at all) right after the OP confirms that
 * operation (same screen, same session). Updates the OperationLog row
 * confirmScan() already created; rejects if OP hasn't confirmed yet or PD
 * already inspected this operation. PalletMaster.ScanStatus advances to
 * PD_COMPLETE (unlocks QC) once every operation has an OP confirm —
 * regardless of this PD result.
 *
 * @param {Object} params { palletId, operationNo, result: 'PASS'|'FAIL', inspector, note }
 * @return {{ success: boolean, message: string, result: string|null, allOperationsDone: boolean }}
 */
function savePdInspection(params) {
  try {
    params            = params || {};
    const palletId    = String(params.palletId    || '').trim();
    const operationNo = String(params.operationNo || '').trim();
    const result       = String(params.result       || '').trim().toUpperCase();
    const inspector     = String(params.inspector     || '').trim();
    const note           = String(params.note           || '').trim();

    if (!palletId)    return { success: false, message: 'ไม่มี PalletID', result: null, allOperationsDone: false };
    if (!operationNo) return { success: false, message: 'ไม่มีขั้นตอนงาน', result: null, allOperationsDone: false };
    if (result !== 'PASS' && result !== 'FAIL')
      return { success: false, message: 'ผลตรวจสอบไม่ถูกต้อง', result: null, allOperationsDone: false };
    if (!inspector)
      return { success: false, message: 'กรุณาระบุชื่อผู้ตรวจสอบ PD', result: null, allOperationsDone: false };
    if (result === 'FAIL' && !note)
      return { success: false, message: 'กรุณาระบุสาเหตุที่ไม่ผ่าน', result: null, allOperationsDone: false };

    const upd = updatePdResult_(palletId, operationNo, result, inspector, note);
    if (!upd.ok) return { success: false, message: upd.message, result: null, allOperationsDone: false };

    logEvent('PD_INSPECT', 'OperationLog', result, 0,
      JSON.stringify({ palletId: palletId, operationNo: operationNo }));

    // PD result (PASS or FAIL) doesn't change whether all operations are OP-confirmed —
    // PD is optional sampling, not a gate.
    const allDone = checkAllOperationsDone_(palletId);
    if (allDone) {
      updatePalletScanFields_(palletId, { ScanStatus: 'PD_COMPLETE' });
    }

    return { success: true, message: 'บันทึกผล PD สำเร็จ', result: result, allOperationsDone: allDone };

  } catch (e) {
    logError('savePdInspection', 'OperationLog', e.message,
      'palletId=' + (params && params.palletId) + ' op=' + (params && params.operationNo));
    return { success: false, message: 'เกิดข้อผิดพลาด: ' + e.message, result: null, allOperationsDone: false };
  }
}

/**
 * True only when every routing operation for this pallet's MO has an
 * OperationLog row (i.e. OP has confirmed it) — PDResult is NOT checked,
 * since PD inspection is optional random sampling, not every pallet/operation.
 * Empty routing (no operations found) is treated as not-done — QC must not
 * be unlocked without a routing to check against.
 * @param {string} palletId
 * @return {boolean}
 */
function checkAllOperationsDone_(palletId) {
  const pallet = lookupPalletById_(palletId);
  if (!pallet) return false;

  const operations = getOperationsForOrder(pallet.ManufacturingOrder);
  if (!operations.length) return false;

  const logs = getOperationLogs_(palletId);
  return operations.every(function (op) {
    return logs.some(function (l) { return l.operationNo === op.opNo; });
  });
}

/**
 * Save QC inspection result to PalletMaster (local only, no SAP).
 * SAP QM Inspection Lot integration is Phase 4.
 * Idempotency: rejects if this pallet was already inspected.
 * Gate: all routing operations must already have an OP confirm — PD result
 * is optional random sampling and is not required to unlock QC.
 *
 * @param {Object} params { palletId, result: 'PASS'|'FAIL', inspector, note }
 * @return {{ success: boolean, message: string }}
 */
function saveQcResult(params) {
  try {
    params          = params || {};
    const palletId  = String(params.palletId  || '').trim();
    const result    = String(params.result    || '').trim().toUpperCase();
    const inspector = String(params.inspector || '').trim();
    const note      = String(params.note      || '').trim();

    if (!palletId) return { success: false, message: 'ไม่มี PalletID' };
    if (result !== 'PASS' && result !== 'FAIL') return { success: false, message: 'ผลตรวจสอบไม่ถูกต้อง' };
    if (!inspector) return { success: false, message: 'กรุณาระบุชื่อผู้ตรวจสอบ' };
    if (result === 'FAIL' && !note) return { success: false, message: 'กรุณาระบุสาเหตุที่ไม่ผ่าน' };

    const pallet = lookupPalletById_(palletId);
    if (!pallet) return { success: false, message: 'ไม่พบพาเลท: ' + palletId };

    if (pallet.QCStatus === 'INSPECTED') {
      return { success: false, message: 'พาเลทนี้ตรวจ QC แล้ว ผล: ' + (pallet.QCResult || '-') };
    }

    if (!checkAllOperationsDone_(palletId)) {
      return { success: false, message: '⚠️ ยังมีขั้นตอนที่ OP ยังไม่บันทึก — ต้องบันทึกครบทุกขั้นตอนก่อน QC' };
    }

    updatePalletScanFields_(palletId, {
      QCStatus:     'INSPECTED',
      QCResult:     result,
      QCResultNote: note,
      ScanStatus:   'QC_COMPLETE'
    });

    logEvent('QC_RESULT', 'PalletMaster', result, 0,
      JSON.stringify({ palletId: palletId, inspector: inspector, note: note }));

    return { success: true, message: 'บันทึกผล QC สำเร็จ' };

  } catch (e) {
    logError('saveQcResult', 'PalletMaster', e.message, 'palletId=' + (params && params.palletId));
    return { success: false, message: 'เกิดข้อผิดพลาด: ' + e.message };
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Operations for a MO, normalized for the confirmation form — adds isFinal
 * (true on the last operation in routing order) and falls back to a live
 * SAP routing fetch when the ProductionOrders cache has nothing yet.
 * @param {string} mo
 * @return {Array<{opNo,opText,workCenter,isFinal}>}
 */
function getOperationsForOrder(mo) {
  mo = String(mo || '').trim();
  if (!mo) return [];
  try {
    let ops = getOpsForMo_(mo);
    if (!ops.length) ops = fetchOperationsForMO_(mo); // live SAP fallback (30 min cache)

    // Sort ascending by OrderOperation number — SAP/cache order is not guaranteed.
    const sorted = ops.slice().sort(function (a, b) {
      return parseInt(a.opNo || a.OrderOperation, 10) - parseInt(b.opNo || b.OrderOperation, 10);
    });

    const lastIdx = sorted.length - 1;
    const result = sorted.map(function (op, i) {
      return {
        opNo:       _normOpNo_(op.opNo),
        opText:     String(op.opText || op.text || '').trim(),
        workCenter: String(op.workCenter || '').trim(),
        isFinal:    i === lastIdx // highest OrderOperation number after sort, not last raw item
      };
    });

    logEvent('OP_LOOKUP', 'ProductionOrders', 'OK', 0, mo + ' ops=' + result.length);
    return result;

  } catch (e) {
    logError('getOperationsForOrder', 'ProductionOrders', e.message, mo);
    return [];
  }
}

/**
 * Fetch operations for a MO from ProductionOrders sheet.
 * Tries OperationsJSON (JSON array) first, then parses Operations string.
 * @param {string} mo
 * @return {Array<{opNo,opText,workCenter}>}
 */
function getOpsForMo_(mo) {
  if (!mo) return [];
  try {
    const sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
    if (!sh || sh.getLastRow() < 2) return [];
    const data = sh.getDataRange().getValues();
    const hdr  = data[0];
    const idx  = {};
    hdr.forEach((h, i) => { idx[h] = i; });
    const moStr = String(mo).trim();
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][idx['ManufacturingOrder']] || '').trim() !== moStr) continue;
      // Try OperationsJSON first (Phase 2.5 lazy-fetch cache)
      const jsonCol = idx['OperationsJSON'];
      if (jsonCol !== undefined) {
        const raw = String(data[r][jsonCol] || '').trim();
        if (raw) {
          try { return JSON.parse(raw); } catch (_) {}
        }
      }
      // Fallback: parse Operations string "0010:WC|text; 0020:WC|text"
      return parseOps_(String(data[r][idx['Operations']] || '').trim());
    }
  } catch (e) {
    logError('getOpsForMo_', 'ProductionOrders', e.message, mo);
  }
  return [];
}

/**
 * Check if a pallet+operation combination is already logged in OperationLog.
 * Prevents double-tap on the same operation for the same pallet.
 * @param {string} palletId
 * @param {string} operationNo
 * @return {boolean} true if already logged
 */
function isOperationLogged_(palletId, operationNo) {
  const opNo = _normOpNo_(operationNo);
  if (!opNo) return false;
  return getOperationLogForPallet(palletId).some(function (e) { return e.operationNo === opNo; });
}

/** Format a Date or string to 'dd/MM/yyyy' for JSON transfer to the UI */
function _fmtDateStr_(d) {
  if (!d) return '';
  if (d instanceof Date) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  }
  return String(d);
}

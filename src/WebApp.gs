/**
 * WebApp.gs — Phase 3: Mobile Scanner + Admin Web App
 * ====================================================
 * Phase 3 — Step 1 + Step 2d (slip web UI) + Phase 3.5 Override UI backend
 *
 * doGet() routes by ?app= query param:
 *   ?app=scan    → Scanner.html        (operators, no restriction)
 *   ?app=print   → AdminPrint.html     (admin only)
 *   ?app=confirm → AdminConfirm.html   (admin only)
 *   ?app=slip    → AdminSlip.html      (admin only)
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
    var olChk = assertOperationLogSchema_();
    if (!olChk.ok) {
      logEvent('WEBAPP', 'OL_SCHEMA_DESYNC_STARTUP', 'ERROR', 0, olChk.reason);
      return HtmlService.createHtmlOutput(renderSchemaErrorPage_(olChk))
        .setTitle('ระบบหยุดชั่วคราว');
    }
    return HtmlService.createTemplateFromFile('Scanner')
      .evaluate()
      .setTitle(CFG.WEB_APP_TITLE)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // --- Central Hub landing page (no auth gate — links only; each destination keeps its own gate) ---
  if (app === 'hub') {
    var tpl = HtmlService.createTemplateFromFile('Hub');
    tpl.baseUrl = ScriptApp.getService().getUrl();
    return tpl.evaluate()
      .setTitle('PJ Chonburi – Central Hub')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // --- Desktop Companion WebApp (Phase 6.1, admin only, READ-ONLY) ---
  if (app === 'desktop') {
    if (!isAdminUser_()) {
      var deskEmail = '';
      try { deskEmail = Session.getActiveUser().getEmail() || ''; } catch (_) {}
      return HtmlService.createHtmlOutput(
        '<h2>Access Denied</h2>' +
        '<p>This page is restricted to authorized administrators.</p>' +
        '<p>Signed in as: <strong>' + (deskEmail || '(no email detected)') + '</strong></p>'
      ).setTitle('Access Denied');
    }
    return HtmlService.createTemplateFromFile('Desktop')
      .evaluate()
      .setTitle('ติดตามพาเลท — Desktop')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // --- Admin pages (auth gate) ---
  // --- Slip page (admin-gated, uses createHtmlOutputFromFile — no templating needed) ---
  if (app === 'slip') {
    if (!isAdminUser_()) {
      var slipEmail = '';
      try { slipEmail = Session.getActiveUser().getEmail() || ''; } catch (_) {}
      return HtmlService.createHtmlOutput(
        '<h2>Access Denied</h2>' +
        '<p>This page is restricted to authorized administrators.</p>' +
        '<p>Signed in as: <strong>' + (slipEmail || '(no email detected)') + '</strong></p>'
      ).setTitle('Access Denied');
    }
    return HtmlService.createHtmlOutputFromFile('AdminSlip')
      .setTitle('ใบกำกับพาเลท')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

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

  // --- OL schema guard for confirm route (admin sees desync at load, not at write) ---
  if (app === 'confirm') {
    var confirmChk = assertOperationLogSchema_();
    if (!confirmChk.ok) {
      logEvent('WEBAPP', 'OL_SCHEMA_DESYNC_STARTUP', 'ERROR', 0, 'confirm:' + confirmChk.reason);
      return HtmlService.createHtmlOutput(renderSchemaErrorPage_(confirmChk, { audience: 'admin' }))
        .setTitle('ระบบหยุดชั่วคราว');
    }
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
 * Return current SAP flag status for the UI badge, plus the local
 * per-operation cumulative confirmation flag (Scanner.html/Desktop.html read
 * localOpCumulativeEnabled/maxRoundsPerOp to switch their bucket hint/guard
 * logic — see recalcYield/submitConfirm in Scanner.html and
 * recalcBucketHint_/submitConfirm in Desktop.html).
 * @return {{ sapWriteEnabled: boolean, dryRun: boolean,
 *   localOpCumulativeEnabled: boolean, maxRoundsPerOp: number }}
 */
function getSapStatus() {
  return {
    sapWriteEnabled: sapWriteEnabled_(),
    dryRun:          isDryRun_(),
    localOpCumulativeEnabled: isLocalOpCumulativeEnabled_(),
    maxRoundsPerOp:           CFG.MAX_ROUNDS_PER_OP
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
      return _isOpDoneForGate_(palletId, op.opNo, operationLogs);
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
 * Pure validation of one local per-operation cumulative confirmation round's
 * qty math (LOCAL_OP_CUMULATIVE_ENABLED) — no sheet read/write, no SAP call.
 * Used by confirmScan and exercised directly by TEST_ scenarios with fake
 * in-memory values, same pattern as Confirmation.gs's (out-of-scope, dormant)
 * _validateCumulativeRound_ — this is a separate, local-only implementation,
 * not a call into that file.
 *
 * Rule: no per-round minimum/proportion — any split across up to
 * CFG.MAX_ROUNDS_PER_OP rounds is allowed, as long as cumulative never
 * exceeds qtyPerPallet and the completing round brings cumulative to
 * exactly qtyPerPallet.
 *
 * @param {number} qtyPerPallet
 * @param {number} priorCumulative — qty logged so far (rounds 1..N-1)
 * @param {number} roundsUsed — rounds already completed (0 = none yet)
 * @param {number} bucketSum — qty this round is attempting to log
 * @return {{allowed:boolean, isFinalRound:boolean, newCumulative:number,
 *   roundNumber:number, message:string|null}}
 */
function _validateLocalOpRound_(qtyPerPallet, priorCumulative, roundsUsed, bucketSum) {
  const roundNumber   = Number(roundsUsed || 0) + 1;
  const newCumulative = Number(priorCumulative || 0) + Number(bucketSum || 0);
  const isFinalRound  = newCumulative === Number(qtyPerPallet);

  if (roundNumber > CFG.MAX_ROUNDS_PER_OP && !isFinalRound) {
    return {
      allowed: false, isFinalRound: false, newCumulative: newCumulative, roundNumber: roundNumber,
      message: '⛔ ใช้ครบ ' + CFG.MAX_ROUNDS_PER_OP + ' รอบแล้ว ยอดยังไม่ครบจำนวนต่อพาเลท (' +
        qtyPerPallet + ') — กรุณาติดต่อ Admin'
    };
  }
  if (newCumulative > Number(qtyPerPallet)) {
    return {
      allowed: false, isFinalRound: false, newCumulative: newCumulative, roundNumber: roundNumber,
      message: '⛔ ยอดรวมสะสมของขั้นตอนนี้เกินจำนวนต่อพาเลท (' + qtyPerPallet + ')'
    };
  }
  return {
    allowed: true, isFinalRound: isFinalRound, newCumulative: newCumulative,
    roundNumber: roundNumber, message: null
  };
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
    params            = params || {};
    const palletId    = String(params.palletId || '').trim();
    const opNo        = _normOpNo_(params.opNo);
    const opText      = String(params.opText   || '').trim();
    const isFinal     = params.isFinal === true || params.isFinal === 'true';
    const qtyGood     = Number(params.qtyGood)      || 0;
    const qtyScrap    = Number(params.qtyScrap)      || 0;
    const qtyRepair   = Number(params.qtyRepair)     || 0;
    const qtyAwaitConv = Number(params.qtyAwaitConv) || 0;
    const operator       = String(params.operator       || '').trim();
    const role           = String(params.role           || '').trim();
    const actualMachine  = String(params.actualMachine  || '').trim();

    if (!palletId) return { success: false, sapSent: false, message: 'ไม่มี PalletID', logId: null };
    if (!operator) return { success: false, sapSent: false, message: 'กรุณาระบุชื่อผู้ปฏิบัติงาน', logId: null };
    if (!role)     return { success: false, sapSent: false, message: 'กรุณาเลือก Role', logId: null };

    const pallet = lookupPalletById_(palletId);
    if (!pallet) return { success: false, sapSent: false, message: 'ไม่พบพาเลท: ' + palletId, logId: null };

    // === 4-bucket validation (server-side) — unchanged regardless of flag ===
    if ([qtyGood, qtyRepair, qtyScrap, qtyAwaitConv].some(function (v) { return v < 0 || !Number.isInteger(v); })) {
      logEvent('RECORD_OP_BUCKETS', 'OperationLog', 'REJECT', 0,
        palletId + ' op=' + opNo + ' invalid bucket values');
      return { success: false, sapSent: false, message: 'ค่าต้องเป็นจำนวนเต็ม >= 0', logId: null };
    }
    const bucketSum = qtyGood + qtyRepair + qtyScrap + qtyAwaitConv;
    if (!isLocalOpCumulativeEnabled_() && bucketSum !== Number(pallet.QtyPerPallet)) {
      logEvent('RECORD_OP_BUCKETS', 'OperationLog', 'REJECT', 0,
        palletId + ' op=' + opNo + ' sum=' + bucketSum + ' max=' + pallet.QtyPerPallet);
      return {
        success: false, sapSent: false,
        message: '⛔ ยอดรวมต้องเท่ากับจำนวนต่อพาเลท (' + pallet.QtyPerPallet + ') — ไม่อนุญาตให้ส่งน้อยกว่า',
        logId: null
      };
    }

    // === Idempotency gate — check before ANY write ===
    if (pallet.ScanStatus === 'CONFIRMED') {
      const existingDoc = pallet.GRMaterialDocument || '-';
      return {
        success: false, sapSent: false,
        message: '⚠️ พาเลทนี้ยืนยันขั้นตอนสุดท้ายแล้ว (เอกสาร: ' + existingDoc + ')',
        logId: null
      };
    }
    if (opNo && isLocalOpCumulativeEnabled_()) {
      if (isOperationFinallyLogged_(palletId, opNo)) {
        return {
          success: false, sapSent: false,
          message: '⚠️ ขั้นตอน ' + opNo + ' ของพาเลทนี้เสร็จสมบูรณ์แล้ว',
          logId: null
        };
      }
    } else if (opNo && isOperationLogged_(palletId, opNo)) {
      return {
        success: false, sapSent: false,
        message: '⚠️ ขั้นตอน ' + opNo + ' ของพาเลทนี้บันทึกแล้ว',
        logId: null
      };
    }

    // === Sequential gate — operation N can't start until N-1 has OP confirm ===
    if (opNo) {
      const operations = getOperationsForOrder(pallet.ManufacturingOrder);
      const opIndex     = operations.findIndex(function (o) { return o.opNo === opNo; });
      if (opIndex > 0) {
        const logs = getOperationLogs_(palletId);
        for (let i = 0; i < opIndex; i++) {
          if (!_isOpDoneForGate_(palletId, operations[i].opNo, logs)) {
            return {
              success: false, sapSent: false,
              message: '⚠️ ต้องบันทึกขั้นตอน ' + operations[i].opNo + ' — ' +
                       (operations[i].opText || operations[i].workCenter) + ' ก่อน',
              logId: null
            };
          }
        }
      }
    }

    // === Local per-operation cumulative round validation (ON path only) ===
    // Runs after the idempotency/sequential gates — no point computing round
    // math for a call the gates would reject anyway. OFF path never reaches
    // this block's body (isLocalOpCumulativeEnabled_() false short-circuits),
    // so roundNumber/isFinalRoundLocal stay at their single-complete-round
    // defaults and the write/message logic below is exactly as before.
    let roundNumber      = 1;
    let isFinalRoundLocal = true;
    let cumulativeMsg     = null;
    if (opNo && isLocalOpCumulativeEnabled_()) {
      const roundState = getCumulativeQtyForOp_(palletId, opNo);
      const v = _validateLocalOpRound_(pallet.QtyPerPallet, roundState.cumulativeQty, roundState.roundsUsed, bucketSum);
      if (!v.allowed) {
        logEvent('RECORD_OP_BUCKETS', 'OperationLog', 'REJECT', 0,
          palletId + ' op=' + opNo + ' round=' + v.roundNumber + ' newCum=' + v.newCumulative +
          ' max=' + pallet.QtyPerPallet);
        return { success: false, sapSent: false, message: v.message, logId: null };
      }
      roundNumber       = v.roundNumber;
      isFinalRoundLocal = v.isFinalRound;
      if (!isFinalRoundLocal) {
        cumulativeMsg = 'บันทึกรอบ ' + roundNumber + '/' + CFG.MAX_ROUNDS_PER_OP + ' แล้ว (' +
          v.newCumulative + '/' + pallet.QtyPerPallet + ')';
      }
    }

    // 1. Append to OperationLog with all 4 buckets (this round's raw values —
    //    cumulative is always computed on read, never stored as a running total)
    const logEntry = {
      palletId:      palletId,
      mo:            pallet.ManufacturingOrder,
      operationNo:   opNo,
      operationText: opText,
      goodQty:       qtyGood,
      scrapQty:      qtyScrap,
      repairQty:     qtyRepair,
      awaitConvQty:  qtyAwaitConv,
      operator:      operator,
      role:          role,
      result:        'PASS',
      source:        params.source || 'MOBILE',
      actualMachine: actualMachine
    };
    if (isLocalOpCumulativeEnabled_()) {
      logEntry.roundNumber  = roundNumber;
      logEntry.isFinalRound = isFinalRoundLocal;
    }
    const logId = logOperation_(logEntry);

    // 2. Determine if this is the final operation via routing
    const isFinalOp = _isFinalOperation_(pallet.ManufacturingOrder, opNo);

    // 3. If final op AND this round completes it, mirror buckets to PalletMaster.
    //    OFF path (and legacy free-form opNo-less calls) always completes in one
    //    round, so this is unchanged. ON path: mirror the CUMULATIVE per-bucket
    //    totals across all rounds (not just this round's raw values) so a final
    //    operation confirmed over multiple rounds still leaves PalletMaster with
    //    the pallet's real totals — this round's isolated numbers would otherwise
    //    silently overwrite whatever earlier rounds already contributed.
    if (isFinalOp && isFinalRoundLocal) {
      if (isLocalOpCumulativeEnabled_()) {
        const allRounds = getOperationLogRoundsForOp_(palletId, opNo);
        const totals = allRounds.reduce(function (t, r) {
          t.good += r.goodQty; t.repair += r.repairQty;
          t.scrap += r.scrapQty; t.awaitConv += r.awaitConvQty;
          return t;
        }, { good: 0, repair: 0, scrap: 0, awaitConv: 0 });
        updatePalletScanFields_(palletId, {
          GoodQty:      totals.good,
          RepairQty:    totals.repair,
          DefectQty:    totals.scrap,
          AwaitConvQty: totals.awaitConv
        });
      } else {
        updatePalletScanFields_(palletId, {
          GoodQty:      qtyGood,
          RepairQty:    qtyRepair,
          DefectQty:    qtyScrap,
          AwaitConvQty: qtyAwaitConv
        });
      }
    }

    const yieldQty = qtyGood + qtyRepair + qtyAwaitConv;
    const scrapQty = qtyScrap;
    logEvent('RECORD_OP_BUCKETS', 'OperationLog', 'OK', 0,
      JSON.stringify({ palletId: palletId, opNo: opNo, isFinalOp: isFinalOp,
        buckets: { G: qtyGood, R: qtyRepair, D: qtyScrap, A: qtyAwaitConv },
        yield: yieldQty, scrap: scrapQty }).slice(0, 500));

    // 4. Every routing operation now has an OP confirm?
    const allOperationsDone = checkAllOperationsDone_(palletId);

    // 5. Update PalletMaster scan fields
    updatePalletScanFields_(palletId, {
      ScanStatus: allOperationsDone ? 'PD_COMPLETE' : 'SCANNED',
      ScannedAt:  new Date(),
      ScannedBy:  operator
    });

    logEvent('SCAN_CONFIRM', 'PalletMaster', 'OK', 0,
      palletId + ' op=' + opNo + ' role=' + role +
      ' good=' + qtyGood + ' scrap=' + qtyScrap + ' final=' + isFinal);

    const doneSuffix = allOperationsDone ? ' — ครบทุกขั้นตอน พร้อมให้ QC ตรวจ' : '';

    // 6. SAP gate
    if (!sapWriteEnabled_()) {
      return {
        success: true,
        sapSent: false,
        allOperationsDone: allOperationsDone,
        message: cumulativeMsg ||
          ('บันทึกงานสำเร็จ' + (isFinal ? ' (ขั้นตอนสุดท้าย)' : '') + doneSuffix + ' (SAP OFF — โหมดทดสอบ)'),
        logId:   logId
      };
    }

    return {
      success: true,
      sapSent: false,
      allOperationsDone: allOperationsDone,
      message: cumulativeMsg || ('บันทึกงานสำเร็จ' + doneSuffix + ' — SAP confirmation จะเปิดใช้ใน Step 2'),
      logId:   logId
    };

  } catch (e) {
    logError('confirmScan', 'PalletMaster', e.message,
      'palletId=' + (params && params.palletId) + ' role=' + (params && params.role));
    return { success: false, sapSent: false, message: 'เกิดข้อผิดพลาด: ' + e.message, logId: null };
  }
}

/**
 * Check if the given operation is the final operation for a MO's routing.
 * Uses the same routing logic as getOperationsForOrder / the UI's isFinal flag.
 * @param {string} mo — ManufacturingOrder
 * @param {string} opNo — normalized operation number
 * @return {boolean}
 */
function _isFinalOperation_(mo, opNo) {
  if (!mo || !opNo) return false;
  var operations = getOperationsForOrder(mo);
  if (!operations.length) return false;
  return operations[operations.length - 1].opNo === opNo;
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
 * "Is this operation done?" for the sequential gate / checkAllOperationsDone_ /
 * lookupPallet's allOpsConfirmed — the ONE place all three call sites agree on
 * what "done" means, so they can't drift from each other.
 *
 * OFF (LOCAL_OP_CUMULATIVE_ENABLED=false): unchanged existence check against
 * the already-fetched getOperationLogs_() result — one row per op, same as
 * 6.2-REV.
 * ON: delegates to isOperationFinallyLogged_() (OperationLog.gs) — true only
 * once a row with IsFinalRound=true exists for this palletId+opNo.
 *
 * @param {string} palletId
 * @param {string} opNo
 * @param {Array} logs — getOperationLogs_(palletId) result (only used OFF-path)
 * @return {boolean}
 */
function _isOpDoneForGate_(palletId, opNo, logs) {
  if (isLocalOpCumulativeEnabled_()) return isOperationFinallyLogged_(palletId, opNo);
  return logs.some(function (l) { return l.operationNo === opNo; });
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
    return _isOpDoneForGate_(palletId, op.opNo, logs);
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
      QCInspector:  inspector,
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

// ============================================================================
// Phase 3.5 — Admin Override UI backend (google.script.run)
// ============================================================================

/**
 * List override candidates: pallets that have passed QC but are not yet
 * confirmed, for the admin override UI. Admin-gated.
 * Mirrors the exact allow-list that confirmPalletOverride enforces
 * (QCStatus=INSPECTED, QCResult=PASS, ScanStatus≠CONFIRMED, ConfirmationGroup empty)
 * so the UI never shows a pallet the backend will reject.
 * @return {{success:boolean, pallets:Array, message?:string}}
 */
function listOverrideCandidates() {
  if (!isAdminUser_()) {
    return { success: false, pallets: [], message: 'ไม่มีสิทธิ์' };
  }

  try {
    var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
    if (!sh || sh.getLastRow() < 2) return { success: true, pallets: [] };

    var data = sh.getDataRange().getValues();
    var hdr  = data[0];
    var idx  = {};
    hdr.forEach(function(h, i) { idx[h] = i; });

    var required = ['PalletID', 'ManufacturingOrder', 'Material', 'MaterialName',
                    'Batch', 'QtyPerPallet', 'Unit', 'WorkCenter',
                    'ScanStatus', 'QCStatus', 'QCResult', 'ConfirmationGroup'];
    for (var k = 0; k < required.length; k++) {
      if (idx[required[k]] === undefined) {
        logEvent('OVERRIDE_LIST', 'ERROR', 'Missing column: ' + required[k]);
        return { success: false, pallets: [], message: 'Missing column: ' + required[k] };
      }
    }

    // Build MO -> FinalOperation lookup from ProductionOrders (single read)
    var foMap = {};
    var poSh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
    if (poSh && poSh.getLastRow() >= 2) {
      var poData = poSh.getDataRange().getValues();
      var poHdr  = poData[0];
      var poMoCol = poHdr.indexOf('ManufacturingOrder');
      var poFoCol = poHdr.indexOf('FinalOperation');
      if (poMoCol !== -1 && poFoCol !== -1) {
        for (var p = 1; p < poData.length; p++) {
          var poMo = String(poData[p][poMoCol] || '').trim();
          var poFo = String(poData[p][poFoCol] || '').trim();
          if (poMo) foMap[poMo] = poFo;
        }
      }
    }

    var pallets = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (String(row[idx['ScanStatus']] || '').trim() === 'CONFIRMED') continue;
      if (String(row[idx['ConfirmationGroup']] || '').trim() !== '') continue;
      if (String(row[idx['QCStatus']] || '').trim() !== 'INSPECTED') continue;
      if (String(row[idx['QCResult']] || '').trim() !== 'PASS') continue;
      if (/^PL-TEST-/i.test(String(row[idx['PalletID']] || '').trim())) continue;

      var mo = String(row[idx['ManufacturingOrder']] || '').trim();

      // Skip if MO not in ProductionOrders or FinalOperation empty
      if (!foMap.hasOwnProperty(mo) || !foMap[mo]) continue;

      var wc = row[idx['WorkCenter']];

      pallets.push({
        PalletID:           String(row[idx['PalletID']] || '').trim(),
        ManufacturingOrder: mo,
        Material:           String(row[idx['Material']] || '').trim(),
        MaterialName:       String(row[idx['MaterialName']] || '').trim(),
        Batch:              String(row[idx['Batch']] || '').trim(),
        QtyPerPallet:       Number(row[idx['QtyPerPallet']]) || 0,
        Unit:               String(row[idx['Unit']] || '').trim(),
        WorkCenter:         (wc instanceof Date) ? dateToWorkCenter_(wc) : String(wc || '').trim(),
        ScanStatus:         String(row[idx['ScanStatus']] || '').trim(),
        FinalOperation:     foMap[mo],
        StorageLocation:    idx['StorageLocation'] !== undefined ? String(row[idx['StorageLocation']] || '').trim() : ''
      });

      if (pallets.length >= 50) break;
    }

    logEvent('OVERRIDE_LIST', 'OK', 'found ' + pallets.length + ' candidates');
    return { success: true, pallets: pallets };

  } catch (e) {
    logError('listOverrideCandidates', 'PalletMaster', e.message, '');
    return { success: false, pallets: [], message: 'เกิดข้อผิดพลาด: ' + e.message };
  }
}

/**
 * Batch override-confirm. Applies the SAME reason to every selected pallet.
 * Fail-soft: one pallet's failure does not abort the batch. Admin-gated.
 * Delegates each pallet to confirmPalletOverride (Confirmation.gs).
 * @param {Array<{palletId:string, qty:number|null}>} items
 * @param {string} reason  Mandatory, >= 5 chars.
 * @return {{success:boolean, results:Array, message?:string}}
 */
function batchOverrideConfirm(items, reason) {
  if (!isAdminUser_()) {
    return { success: false, results: [], message: 'ไม่มีสิทธิ์' };
  }

  if (!Array.isArray(items) || items.length === 0) {
    return { success: false, results: [], message: 'กรุณาเลือกพาเลทอย่างน้อย 1 รายการ' };
  }
  if (items.length > 15) {
    return { success: false, results: [], message: 'เลือกได้สูงสุด 15 พาเลทต่อครั้ง (เลือก ' + items.length + ')' };
  }

  reason = String(reason || '').trim();
  if (reason.length < 5) {
    return { success: false, results: [], message: 'ต้องระบุเหตุผล override (อย่างน้อย 5 ตัวอักษร)' };
  }

  for (var v = 0; v < items.length; v++) {
    if (!items[v] || !String(items[v].palletId || '').trim()) {
      return { success: false, results: [], message: 'รายการที่ ' + (v + 1) + ' ไม่มี PalletID' };
    }
  }

  var results = [];
  var okCount = 0;
  var failCount = 0;

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var pid = String(item.palletId).trim();
    var qty = (item.qty != null) ? Number(item.qty) : null;
    try {
      var res = confirmPalletOverride(pid, reason, qty);
      results.push({
        palletId:           pid,
        success:            res.success,
        message:            res.message || '',
        confirmationGroup:  res.confirmationGroup || '',
        materialDocument:   res.materialDocument || '',
        qtyConfirmed:       res.qtyConfirmed != null ? res.qtyConfirmed : null
      });
      if (res.success) { okCount++; } else { failCount++; }
    } catch (e) {
      results.push({
        palletId:           pid,
        success:            false,
        message:            e.message,
        confirmationGroup:  '',
        materialDocument:   '',
        qtyConfirmed:       null
      });
      failCount++;
    }
  }

  logEvent('BATCH_OVERRIDE', 'DONE', 'ok=' + okCount + ' fail=' + failCount + ' total=' + items.length);
  return { success: true, results: results };
}

/** Editor test — run with DRY_RUN ON first. */
function testListOverrideCandidates() {
  Logger.log(JSON.stringify(listOverrideCandidates(), null, 2));
}

// ============================================================================
// Step 2d — Slip Web UI backend (google.script.run from AdminSlip.html)
// ============================================================================

/**
 * Return distinct StorageLocations from CONFIRMED pallets in PalletMaster.
 * Admin-gated.
 * @return {{ok:boolean, slocs?:string[], error?:string}}
 */
function slipGetStorageLocations() {
  if (!isAdminUser_()) return { ok: false, error: 'ไม่มีสิทธิ์ (admin only)' };
  try {
    var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
    if (!sh || sh.getLastRow() < 2) return { ok: true, slocs: [] };

    var data = sh.getDataRange().getValues();
    var idx = {};
    data[0].forEach(function(h, i) { idx[h] = i; });

    var ssCol   = idx['ScanStatus'];
    var slocCol = idx['StorageLocation'];
    if (ssCol === undefined || slocCol === undefined) return { ok: true, slocs: [] };

    var set = {};
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][ssCol] || '').trim() !== 'CONFIRMED') continue;
      var sloc = String(data[r][slocCol] || '').trim();
      if (sloc) set[sloc] = true;
    }

    var slocs = Object.keys(set).sort();
    return { ok: true, slocs: slocs };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Return materials available for FIFO pick at a given StorageLocation.
 * Groups CONFIRMED pallets by Material, sums remaining qty (excluding 0).
 * Admin-gated.
 * @param {string} sloc — StorageLocation
 * @return {{ok:boolean, materials?:Array<{material:string, name:string, availQty:number}>, error?:string}}
 */
function slipGetMaterialsForSloc(sloc) {
  if (!isAdminUser_()) return { ok: false, error: 'ไม่มีสิทธิ์ (admin only)' };
  try {
    sloc = String(sloc || '').trim();
    if (!sloc) return { ok: true, materials: [] };

    var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
    if (!sh || sh.getLastRow() < 2) return { ok: true, materials: [] };

    var data = sh.getDataRange().getValues();
    var idx = {};
    data[0].forEach(function(h, i) { idx[h] = i; });

    var ssCol   = idx['ScanStatus'];
    var slocCol = idx['StorageLocation'];
    var matCol  = idx['Material'];
    var mnCol   = idx['MaterialName'];
    var qtyCol  = idx['QtyPerPallet'];
    var pidCol  = idx['PalletID'];
    if (ssCol === undefined || slocCol === undefined || matCol === undefined ||
        qtyCol === undefined || pidCol === undefined) {
      return { ok: true, materials: [] };
    }

    // Pre-load issued sums from TransferLog
    var issuedMap = {};
    var tlSh = getSpreadsheet_().getSheetByName(TL_SHEET);
    if (tlSh && tlSh.getLastRow() >= 2) {
      var tlData = tlSh.getDataRange().getValues();
      var tlIdx = {};
      tlData[0].forEach(function(h, i) { tlIdx[h] = i; });
      var ppCol = tlIdx['ParentPalletID'];
      var ttCol = tlIdx['TxnType'];
      var iqCol = tlIdx['IssueQty'];
      if (ppCol !== undefined && ttCol !== undefined && iqCol !== undefined) {
        for (var t = 1; t < tlData.length; t++) {
          if (String(tlData[t][ttCol] || '').trim() === 'SPLIT_ISSUE') {
            var pp = String(tlData[t][ppCol] || '').trim();
            issuedMap[pp] = (issuedMap[pp] || 0) + (Number(tlData[t][iqCol]) || 0);
          }
        }
      }
    }

    // Group by material
    var matMap = {};
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (String(row[ssCol] || '').trim() !== 'CONFIRMED') continue;
      if (String(row[slocCol] || '').trim() !== sloc) continue;

      var pid      = String(row[pidCol] || '').trim();
      var original = Number(row[qtyCol]) || 0;
      var issued   = issuedMap[pid] || 0;
      var remaining = original - issued;
      if (remaining <= 0) continue;

      var mat  = String(row[matCol] || '').trim();
      var name = mnCol !== undefined ? String(row[mnCol] || '').trim() : '';
      if (!matMap[mat]) matMap[mat] = { material: mat, name: name, availQty: 0 };
      matMap[mat].availQty += remaining;
    }

    var materials = Object.keys(matMap).sort().map(function(k) { return matMap[k]; });
    return { ok: true, materials: materials };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Stock-driven cascade for AdminSlip Card 2.
 * Groups in-stock materials at a SLoc by ProductGroup.
 * Admin-gated. JSON-safe return (no Date / Java array).
 * @param {string} sloc — StorageLocation
 * @return {{ok:boolean, productGroups?:string[], byGroup?:Object, error?:string}}
 */
function slipGetCascadeForSloc(sloc) {
  if (!isAdminUser_()) return { ok: false, error: 'ไม่มีสิทธิ์ (admin only)' };
  try {
    sloc = String(sloc || '').trim();
    if (!sloc) return { ok: true, productGroups: [], byGroup: {} };
    var result = slipGetCascadeForSloc_(sloc);
    return JSON.parse(JSON.stringify({ ok: true, productGroups: result.productGroups, byGroup: result.byGroup }));
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Build receive-slip HTML for matching CONFIRMED pallets.
 * Admin-gated. Reuses getSlipPalletsByFilter_ + buildSlipSheetsHtml.
 * @param {{mode:string, value:string}} query — filter spec
 * @return {{ok:boolean, html?:string, count?:number, error?:string}}
 */
function slipBuildReceiveHtml(query) {
  if (!isAdminUser_()) return { ok: false, error: 'ไม่มีสิทธิ์ (admin only)' };
  try {
    query = query || {};
    var pallets = getSlipPalletsByFilter_({
      mode:  String(query.mode || 'todayConfirmed'),
      value: String(query.value || '').trim()
    });
    if (!pallets.length) return { ok: false, error: 'ไม่พบพาเลท CONFIRMED' };

    var ids = pallets.map(function(p) { return p.PalletID; });
    var html = buildSlipSheetsHtml(ids, 'RECEIVE');
    return { ok: true, html: html, count: pallets.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Preview a FIFO pick plan (no write). Admin-gated.
 * @param {string} material
 * @param {string} sloc
 * @param {number} qty
 * @return {{ok:boolean, plan?:Object, error?:string}}
 */
function slipPlanPick(material, sloc, qty) {
  if (!isAdminUser_()) return { ok: false, error: 'ไม่มีสิทธิ์ (admin only)' };
  try {
    material = String(material || '').trim();
    sloc     = String(sloc || '').trim();
    qty      = Number(qty);
    if (!material || !sloc || !qty || qty <= 0) {
      return { ok: false, error: 'กรุณาระบุ Material, SLoc, และจำนวนที่ถูกต้อง' };
    }
    var plan = planFifoPick_(material, sloc, qty);
    return { ok: true, plan: plan };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Commit a FIFO pick and return printable slip HTML. Admin-gated.
 * @param {string} material
 * @param {string} sloc
 * @param {number} qty
 * @param {string} refDoc — optional reference document
 * @return {{ok:boolean, pickId?:string, html?:string, error?:string, shortfall?:number}}
 */
function slipCommitPick(material, sloc, qty, refDoc) {
  if (!isAdminUser_()) return { ok: false, error: 'ไม่มีสิทธิ์ (admin only)' };
  try {
    material = String(material || '').trim();
    sloc     = String(sloc || '').trim();
    qty      = Number(qty);
    refDoc   = String(refDoc || '').trim();
    if (!material || !sloc || !qty || qty <= 0) {
      return { ok: false, error: 'กรุณาระบุ Material, SLoc, และจำนวนที่ถูกต้อง' };
    }

    var result = commitFifoPick_(material, sloc, qty, {
      refDoc:         refDoc,
      idempotencyKey: Utilities.getUuid(),
      createdBy:      Session.getActiveUser().getEmail()
    });

    if (!result.ok) {
      return { ok: false, shortfall: result.shortfall, error: 'สต็อกไม่พอ: ขาด ' + result.shortfall };
    }

    logEvent('WEB_PICK', 'TransferLog', 'OK', 0, result.pickId);
    var html = buildPickSlipsHtml(result);
    return { ok: true, pickId: result.pickId, html: html };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ============================================================================
// Reprint — read-only pallet lookup + render (no status change, no creation)
// ============================================================================

/**
 * List PalletMaster rows for the reprint UI. READ-ONLY — no status change.
 * Admin-gated. Excludes PL-TEST-* pallets from operator-facing results.
 * @param {{mode:'mo'|'palletId', value:string}} filter
 * @return {{ok:boolean, pallets?:Array, error?:string}}
 */
function listPalletsForReprint(filter) {
  if (!isAdminUser_()) return { ok: false, pallets: [], error: 'ไม่มีสิทธิ์ (admin only)' };
  try {
    filter = filter || {};
    var mode  = String(filter.mode  || '').trim().toLowerCase();
    var value = String(filter.value || '').trim();
    if (!value) return { ok: false, pallets: [], error: 'กรุณาระบุค่าค้นหา' };
    if (mode !== 'mo' && mode !== 'palletid') {
      return { ok: false, pallets: [], error: 'mode ต้องเป็น mo หรือ palletId' };
    }

    var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
    if (!sh || sh.getLastRow() < 2) return { ok: true, pallets: [] };

    var data = sh.getDataRange().getValues();
    var hdr  = data[0];
    var idx  = {};
    hdr.forEach(function(h, i) { idx[h] = i; });

    var fields = ['PalletID', 'ManufacturingOrder', 'Material', 'MaterialName',
                  'Batch', 'QtyPerPallet', 'Unit', 'PalletSeq', 'TotalPallets',
                  'Status', 'PrintedAt', 'ScanStatus'];
    for (var k = 0; k < fields.length; k++) {
      if (idx[fields[k]] === undefined) {
        return { ok: false, pallets: [], error: 'Missing column: ' + fields[k] };
      }
    }

    var results = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var pid = String(row[idx['PalletID']] || '').trim();
      var mo  = String(row[idx['ManufacturingOrder']] || '').trim();

      if (/^PL-TEST-/i.test(pid)) continue;

      var match = (mode === 'mo')
        ? mo === value
        : pid === value;
      if (!match) continue;

      results.push({
        PalletID:           pid,
        ManufacturingOrder: mo,
        Material:           String(row[idx['Material']] || '').trim(),
        MaterialName:       String(row[idx['MaterialName']] || '').trim(),
        Batch:              String(row[idx['Batch']] || '').trim(),
        QtyPerPallet:       Number(row[idx['QtyPerPallet']]) || 0,
        Unit:               String(row[idx['Unit']] || '').trim(),
        PalletSeq:          Number(row[idx['PalletSeq']]) || 0,
        TotalPallets:       Number(row[idx['TotalPallets']]) || 0,
        Status:             String(row[idx['Status']] || '').trim(),
        PrintedAt:          _fmtDateStr_(row[idx['PrintedAt']]),
        ScanStatus:         String(row[idx['ScanStatus']] || '').trim()
      });
    }

    results.sort(function(a, b) { return a.PalletSeq - b.PalletSeq; });

    logEvent('REPRINT_LIST', 'PalletMaster', 'OK', 0,
      mode + '=' + value + ' found=' + results.length);
    return JSON.parse(JSON.stringify({ ok: true, pallets: results }));
  } catch (err) {
    logEvent('REPRINT_LIST', 'PalletMaster', 'ERROR', 0, String(err));
    return { ok: false, pallets: [], error: 'เกิดข้อผิดพลาด: ' + err.message };
  }
}

/**
 * Render A4 pallet sheets for reprint. READ-ONLY — no status change, no creation.
 * Admin-gated. Returns plain HTML string for google.script.run.
 * @param {string[]} palletIds
 * @return {{ok:boolean, html?:string, count?:number, error?:string}}
 */
function reprintPalletSheets(palletIds) {
  if (!isAdminUser_()) return { ok: false, error: 'ไม่มีสิทธิ์ (admin only)' };
  try {
    if (!Array.isArray(palletIds) || palletIds.length === 0) {
      return { ok: false, error: 'กรุณาเลือกพาเลทอย่างน้อย 1 รายการ' };
    }
    var ids = palletIds.map(function(id) { return String(id).trim(); })
                       .filter(function(id) { return id.length > 0; });
    if (!ids.length) return { ok: false, error: 'กรุณาเลือกพาเลทอย่างน้อย 1 รายการ' };

    var result = buildPalletSheetsHtml(ids, true);
    var html = (typeof result === 'string') ? result : result.getContent();
    return { ok: true, html: html, count: ids.length };
  } catch (err) {
    logEvent('REPRINT_RENDER', 'PalletSheet', 'ERROR', 0, String(err));
    return { ok: false, error: 'เกิดข้อผิดพลาด: ' + err.message };
  }
}

/** Format a Date or string to 'dd/MM/yyyy' for JSON transfer to the UI */
function _fmtDateStr_(d) {
  if (!d) return '';
  if (d instanceof Date) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  }
  return String(d);
}

// ============================================================================
// OL schema error page (startup guard)
// ============================================================================

/**
 * Render a readable Thai error page when OperationLog schema desync is
 * detected at web-app startup. Shows expected vs actual column order.
 *
 * @param {{ ok:boolean, expected:string[], actual:string[], reason:string }} chk
 * @param {{ audience?: 'operator'|'admin' }} [opts] — default 'operator'
 * @return {string} full HTML
 */
function renderSchemaErrorPage_(chk, opts) {
  var audience = (opts && opts.audience) || 'operator';
  var esc = function(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  var expectedList = chk.expected.map(function(h, i) {
    var match = chk.actual[i] === h;
    return '<tr style="background:' + (match ? '#fff' : '#ffeaea') + '">' +
      '<td style="padding:4px 8px;border:1px solid #ddd;text-align:center">' + (i + 1) + '</td>' +
      '<td style="padding:4px 8px;border:1px solid #ddd">' + esc(h) + '</td>' +
      '<td style="padding:4px 8px;border:1px solid #ddd">' + esc(chk.actual[i] != null ? chk.actual[i] : '—') + '</td>' +
      '</tr>';
  }).join('\n');

  var heading, intro, noteBox;
  if (audience === 'admin') {
    heading = 'ระบบหยุดชั่วคราว — OperationLog Schema Desync';
    intro = 'ไม่สามารถเปิดหน้า Confirm ได้ เนื่องจากโครงสร้างคอลัมน์ของ OperationLog ไม่ตรงกับที่ระบบคาดหวัง';
    noteBox = '<div class="note">กรุณาแก้ไขโดยเรียกใช้ฟังก์ชัน <strong>reorderOperationLogBuckets</strong> ' +
      'ผ่านเมนู Apps Script Editor แล้ว Redeploy Web App ใหม่</div>';
  } else {
    heading = 'ระบบสแกนหยุดชั่วคราว';
    intro = 'ไม่สามารถเปิดหน้าสแกนได้ เนื่องจากโครงสร้างคอลัมน์ของ OperationLog ไม่ตรงกับที่ระบบคาดหวัง';
    noteBox = '<div class="note">กรุณาแจ้งผู้ดูแลระบบ (Admin) เพื่อตรวจสอบและแก้ไข</div>';
  }

  return '<!DOCTYPE html><html lang="th"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>ระบบหยุดชั่วคราว</title>' +
    '<style>body{font-family:"Sarabun",sans-serif;max-width:700px;margin:40px auto;padding:0 20px;color:#333}' +
    'h1{color:#c0392b;font-size:1.5em}h2{font-size:1.1em;margin-top:24px}' +
    'table{border-collapse:collapse;width:100%;margin:12px 0;font-size:0.9em}' +
    '.note{background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:12px 16px;margin:16px 0;font-size:0.95em}' +
    '.fix{background:#e8f5e9;border:1px solid #4caf50;border-radius:6px;padding:12px 16px;margin:16px 0;font-size:0.9em;color:#2e7d32}</style>' +
    '</head><body>' +
    '<h1>' + esc(heading) + '</h1>' +
    '<p>' + esc(intro) + '</p>' +
    noteBox +
    '<h2>รายละเอียด</h2>' +
    '<p>สาเหตุ: <code>' + esc(chk.reason) + '</code></p>' +
    '<table><thead><tr>' +
    '<th style="padding:4px 8px;border:1px solid #ddd;background:#f8f9fa">#</th>' +
    '<th style="padding:4px 8px;border:1px solid #ddd;background:#f8f9fa">คาดหวัง (Expected)</th>' +
    '<th style="padding:4px 8px;border:1px solid #ddd;background:#f8f9fa">ปัจจุบัน (Actual)</th>' +
    '</tr></thead><tbody>' + expectedList + '</tbody></table>' +
    '<div class="fix">วิธีแก้ไข: เรียกใช้ฟังก์ชัน <strong>reorderOperationLogBuckets</strong> ผ่านเมนู Apps Script Editor เพื่อจัดเรียงคอลัมน์ใหม่</div>' +
    '</body></html>';
}

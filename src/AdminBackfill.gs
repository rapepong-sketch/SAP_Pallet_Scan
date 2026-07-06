/**
 * AdminBackfill.gs — Phase 3.5 Admin: Backfill Missing Operations
 * ================================================================================
 * High-authority admin tool: lets an admin attest that a pallet's missing OP
 * confirmations actually happened (e.g. legacy data gap, OP forgot to scan)
 * and force the pallet through to QC PASS without a real re-inspection.
 * Every write here is local Sheet bookkeeping (OperationLog + PalletMaster)
 * — no SAP call, so the project's DRY_RUN gate (which guards SAP POST/PATCH
 * calls) does not apply directly; logOperation() has its own DRY_RUN check.
 *
 * Guarded heavily because this bypasses real QC: admin-only, mandatory
 * reason, and every idempotency/state guard already used elsewhere
 * (CONFIRMED / EXCLUDED / already-INSPECTED / nothing-missing / Local Op
 * Cumulative not yet supported here).
 *
 * Reuses:
 *  - isAdminUser_()                                     (WebApp.gs)
 *  - lookupPalletById_() / updatePalletScanFields_()     (PalletSheet.gs)
 *  - getOperationsForOrder() / getOperationLogs_()       (WebApp.gs / OperationLog.gs)
 *  - logOperation()                                      (OperationLog.gs)
 *  - isLocalOpCumulativeEnabled_()                       (Flags.gs)
 *  - logEvent()                                          (SapClient.gs)
 */

/**
 * Read-only preview of what adminBackfillPallet_ would do, without writing
 * anything. Used by MENU_adminBackfillPallet() to show the admin the gap
 * before asking for a reason, and shares the same lookup/diff logic so the
 * preview can never drift from the real backfill.
 * @param {string} palletId
 * @return {{success:boolean, message?:string, palletId?:string, mo?:string,
 *   qcStatus?:string, missingOps?:string[]}}
 */
function previewBackfillGaps_(palletId) {
  var pid = String(palletId || '').trim();
  if (!pid) return { success: false, message: 'PalletID is required' };

  var pallet = lookupPalletById_(pid);
  if (!pallet) return { success: false, message: 'Pallet not found: ' + pid };

  if (String(pallet.ScanStatus || '').trim() === 'CONFIRMED') {
    return { success: false, message: 'พาเลทนี้ยืนยันเข้า SAP ไปแล้ว ไม่ต้อง backfill' };
  }
  if (String(pallet.ExclusionStatus || '').trim() === 'EXCLUDED') {
    return { success: false, message: 'พาเลทนี้ถูก exclude อยู่ — ต้อง Include ก่อน' };
  }
  if (String(pallet.QCStatus || '').trim() === 'INSPECTED') {
    return { success: false, message: 'พาเลทนี้ผ่าน QC ไปแล้ว ไม่ต้อง backfill ซ้ำ' };
  }

  var mo           = String(pallet.ManufacturingOrder || '').trim();
  var expectedOps  = getOperationsForOrder(mo);
  var existingLogs = getOperationLogs_(pid);
  var existingOpNos = {};
  existingLogs.forEach(function(l) { existingOpNos[l.operationNo] = true; });

  var missingOps = expectedOps
    .filter(function(o) { return !existingOpNos[o.opNo]; })
    .map(function(o) { return o.opNo; });

  if (missingOps.length === 0) {
    return { success: false, message: 'ไม่มี operation ที่ขาดหายไป — ไม่ต้อง backfill' };
  }

  return {
    success: true,
    palletId: pid,
    mo: mo,
    qcStatus: String(pallet.QCStatus || '').trim(),
    missingOps: missingOps
  };
}

/**
 * Admin-only: backfill OperationLog rows for every routing operation missing
 * on a pallet, then mark the pallet QC PASS / QC_COMPLETE via admin
 * attestation (no real re-inspection). See file header for guard rationale.
 *
 * @param {string} palletId
 * @param {string} reason — mandatory, >= 5 chars, free-text justification
 * @param {string} actor — email/name of the admin performing the backfill
 * @param {number} [actualQty] — optional reduce-only actual count; omitted/null/''
 *   uses the pallet's full QtyPerPallet (byte-identical to pre-existing behavior)
 * @return {{success:boolean, message?:string, palletId?:string,
 *   operationsBackfilled?:string[], qtyBackfilled?:number}}
 */
function adminBackfillPallet_(palletId, reason, actor, actualQty) {
  // Guard 1 — admin only (same gate as confirmPalletOverride)
  if (!isAdminUser_()) {
    return { success: false, message: 'ไม่มีสิทธิ์ backfill' };
  }

  // Guard 2 — mandatory reason
  var trimmedReason = String(reason || '').trim();
  if (trimmedReason.length < 5) {
    return { success: false, message: 'ต้องระบุเหตุผลอย่างน้อย 5 ตัวอักษร' };
  }

  // Guard 3 — pallet must exist
  var pid = String(palletId || '').trim();
  var pallet = lookupPalletById_(pid);
  if (!pallet) {
    return { success: false, message: 'Pallet not found: ' + pid };
  }

  // Guard 4 — already confirmed to SAP, nothing to backfill
  if (String(pallet.ScanStatus || '').trim() === 'CONFIRMED') {
    return { success: false, message: 'พาเลทนี้ยืนยันเข้า SAP ไปแล้ว ไม่ต้อง backfill' };
  }

  // Guard 5 — excluded pallets must be included first
  if (String(pallet.ExclusionStatus || '').trim() === 'EXCLUDED') {
    return { success: false, message: 'พาเลทนี้ถูก exclude อยู่ — ต้อง Include ก่อน' };
  }

  // Guard 6 — idempotency, mirrors saveQcResult_'s own re-inspection guard
  if (String(pallet.QCStatus || '').trim() === 'INSPECTED') {
    return { success: false, message: 'พาเลทนี้ผ่าน QC ไปแล้ว ไม่ต้อง backfill ซ้ำ' };
  }

  // Guard 7 — Local Op Cumulative interaction not covered by test yet, block it
  if (isLocalOpCumulativeEnabled_()) {
    return { success: false,
      message: 'Backfill ยังไม่รองรับตอน Local Op Cumulative เปิดอยู่ — ปิด flag นี้ก่อน' };
  }

  // Guard 8 — reduce-only actual quantity (optional). Omitted/null/'' keeps
  // finalQty === originalQty, so behavior below is byte-identical to the
  // pre-existing 3-arg call.
  var originalQty = Number(pallet.QtyPerPallet) || 0;
  var finalQty;
  if (actualQty == null || actualQty === '') {
    finalQty = originalQty;
  } else {
    var n = Number(actualQty);
    if (!isFinite(n) || n <= 0 || n > originalQty) {
      return { success: false,
        message: 'จำนวนจริงต้องมากกว่า 0 และไม่เกิน ' + originalQty };
    }
    finalQty = n;
  }

  var mo = String(pallet.ManufacturingOrder || '').trim();
  var expectedOps = getOperationsForOrder(mo);          // [{opNo, opText, workCenter, isFinal}, ...]
  var existingLogs = getOperationLogs_(pid);             // existing entries
  var existingOpNos = {};
  existingLogs.forEach(function(l) { existingOpNos[l.operationNo] = true; });

  var missingOps = expectedOps.filter(function(o) { return !existingOpNos[o.opNo]; });

  if (missingOps.length === 0) {
    return { success: false, message: 'ไม่มี operation ที่ขาดหายไป — ไม่ต้อง backfill' };
  }

  var backfilled = [];
  missingOps.forEach(function(op) {
    logOperation({
      palletId:      pid,
      mo:            mo,
      operationNo:   op.opNo,
      operationText: op.opText,
      goodQty:       finalQty,
      scrapQty:      0,
      repairQty:     0,
      awaitConvQty:  0,
      operator:      actor,
      role:          'ADMIN',
      result:        'PASS',
      source:        'ADMIN_BACKFILL'
      // actualMachine, roundNumber, isFinalRound intentionally omitted —
      // no real machine/round data exists for a backfilled entry.
      // PDResult/PDInspector/PDNote/PDTimestamp are hardcoded blank inside
      // logOperation() itself — never fabricate a secondary PD inspection
      // that did not happen.
    });
    backfilled.push(op.opNo);
  });

  var qcResultNote = 'Admin backfill: ' + trimmedReason +
    (finalQty !== originalQty ? ' | Qty backfill: original ' + originalQty + ' -> actual ' + finalQty : '');

  var scanFields = {
    QCStatus:     'INSPECTED',
    QCResult:     'PASS',
    QCInspector:  'ADMIN_BACKFILL:' + actor,
    QCResultNote: qcResultNote,
    ScanStatus:   'QC_COMPLETE'
  };
  if (finalQty !== originalQty) {
    scanFields.QtyPerPallet = finalQty;
  }
  updatePalletScanFields_(pid, scanFields);

  logEvent('PALLET_BACKFILL', 'OK', JSON.stringify({
    palletId: pid, actor: actor, reason: trimmedReason,
    operationsBackfilled: backfilled, qtyBackfilled: finalQty
  }));

  return { success: true, palletId: pid, operationsBackfilled: backfilled, qtyBackfilled: finalQty };
}

// ============================================================================
// Tests
// ============================================================================

/**
 * TEST_adminBackfillPallet_ — self-cleaning fixture, prefix 'PL-ZZBACKFILL-'.
 * Stubs getOperationsForOrder (5-op fixed routing) and isAdminUser_ (admin
 * gate) via plain reassignment, same technique already used for excludePallet_
 * in TEST_autoExcludeOnOrderDeleted_ (Confirmation.gs) — GAS top-level
 * function declarations are reassignable globals.
 * @return {boolean} pass
 */
function TEST_adminBackfillPallet_() {
  var fn = 'TEST_adminBackfillPallet_';
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
    return ok;
  }

  var pmSh = getSpreadsheet_().getSheetByName(PM_SHEET);
  var olSh = getSpreadsheet_().getSheetByName(OL_SHEET);

  var MO = '0000098001'; // all-digit — avoids leading-zero coercion gotcha
  var flagKey = CFG.FLAG_KEYS.LOCAL_OP_CUMULATIVE;
  var props = PropertiesService.getScriptProperties();

  var origGetOperationsForOrder = getOperationsForOrder;
  var origIsAdminUser = isAdminUser_;

  var FIVE_OPS = [
    { opNo: '0010', opText: 'Op10', workCenter: 'WC1', isFinal: false },
    { opNo: '0020', opText: 'Op20', workCenter: 'WC1', isFinal: false },
    { opNo: '0030', opText: 'Op30', workCenter: 'WC1', isFinal: false },
    { opNo: '0040', opText: 'Op40', workCenter: 'WC1', isFinal: false },
    { opNo: '0050', opText: 'Op50', workCenter: 'WC1', isFinal: true }
  ];

  getOperationsForOrder = function(mo) { return _normMo_(mo) === _normMo_(MO) ? FIVE_OPS : []; };
  isAdminUser_ = function() { return true; }; // default ON for the business-logic assertions below

  function seedPallet(pid, overrides) {
    var vals = {
      PalletID: pid, ManufacturingOrder: MO, Material: 'ZZTEST-MAT',
      QtyPerPallet: 10, Unit: 'PC',
      ScanStatus: '', ExclusionStatus: '', QCStatus: ''
    };
    Object.keys(overrides || {}).forEach(function(k) { vals[k] = overrides[k]; });
    pmSh.appendRow(buildPalletRow_(vals));
    SpreadsheetApp.flush();
  }

  function seedOp(pid, opNo, opText) {
    logOperation({
      palletId: pid, mo: MO, operationNo: opNo, operationText: opText,
      goodQty: 10, scrapQty: 0, repairQty: 0, awaitConvQty: 0,
      operator: 'TEST', role: 'OP', result: 'PASS', source: 'TEST'
    });
  }

  function rawPmRow(pid) {
    var data = pmSh.getDataRange().getValues();
    var hdr = data[0];
    var idx = {};
    hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][idx['PalletID']] || '').trim() === pid) {
        var row = {};
        hdr.forEach(function(h, i) { row[h] = data[r][i]; });
        return row;
      }
    }
    return null;
  }

  function olRowsFor(pid) {
    var data = olSh.getDataRange().getValues();
    var hdr = data[0];
    var idx = {};
    hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });
    var rows = [];
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][idx['PalletID']] || '').trim() === pid) {
        rows.push({
          operationNo: _normOpNo_(data[r][idx['OperationNo']]),
          role:        String(data[r][idx['Role']]        || '').trim(),
          source:      String(data[r][idx['Source']]      || '').trim(),
          goodQty:     Number(data[r][idx['GoodQty']]) || 0
        });
      }
    }
    return rows;
  }

  try {
    // ---- (a) 5 expected ops, only 2 logged (0010, 0020) — success, backfills 3 ----
    var PID_A = 'PL-ZZBACKFILL-A01';
    seedPallet(PID_A);
    seedOp(PID_A, '0010', 'Op10');
    seedOp(PID_A, '0020', 'Op20');
    SpreadsheetApp.flush();

    // DIAG — read-only, mirrors adminBackfillPallet_'s own diff computation
    // exactly (does not call any guard/logic, just re-derives the same values
    // from the same functions it uses internally).
    var diagExpectedOpsA  = getOperationsForOrder(MO);
    var diagExistingLogsA = getOperationLogs_(PID_A);
    var diagExistingOpNosA = {};
    diagExistingLogsA.forEach(function(l) { diagExistingOpNosA[l.operationNo] = true; });
    var diagMissingOpsA = diagExpectedOpsA.filter(function(o) { return !diagExistingOpNosA[o.opNo]; });
    Logger.log('DIAG expectedOps=' + JSON.stringify(diagExpectedOpsA));
    Logger.log('DIAG existingLogs=' + JSON.stringify(diagExistingLogsA));
    Logger.log('DIAG existingOpNos keys=' + JSON.stringify(Object.keys(diagExistingOpNosA)));
    Logger.log('DIAG missingOps=' + JSON.stringify(diagMissingOpsA));
    Logger.log('DIAG fixture MO=' + MO + ' — NOTE: getOperationsForOrder is stubbed via reassignment ' +
      'in this test (returns FIVE_OPS for MO=' + MO + '), so no ProductionOrders/OperationsJSON row ' +
      'is written or read for this fixture at all.');

    var resA = adminBackfillPallet_(PID_A, 'valid backfill reason', 'tester@test.com');
    assert('(a1) success:true', resA && resA.success === true, JSON.stringify(resA));
    assert('(a2) operationsBackfilled contains 0030,0040,0050',
      resA && resA.success && ['0030', '0040', '0050'].every(function(o) {
        return resA.operationsBackfilled.indexOf(o) !== -1;
      }) && resA.operationsBackfilled.length === 3,
      JSON.stringify(resA && resA.operationsBackfilled));

    // DIAG round 3 — read-only, no guard/write logic touched.
    var freshLogsA = getOperationLogs_(PID_A);
    Logger.log('DIAG freshLogs after backfill=' + JSON.stringify(freshLogsA));

    var olRawDataA = olSh.getDataRange().getValues();
    var olRawHdrA = olRawDataA[0];
    var olRawRow0030 = null;
    for (var rrA = 1; rrA < olRawDataA.length; rrA++) {
      if (String(olRawDataA[rrA][olRawHdrA.indexOf('PalletID')] || '').trim() === PID_A &&
          _normOpNo_(olRawDataA[rrA][olRawHdrA.indexOf('OperationNo')]) === '0030') {
        olRawRow0030 = olRawDataA[rrA];
        break;
      }
    }
    if (olRawRow0030) {
      var olRawDump0030 = {};
      olRawHdrA.forEach(function(h, i) { olRawDump0030[h] = olRawRow0030[i]; });
      Logger.log('DIAG raw OperationLog row for opNo=0030: ' + JSON.stringify(olRawDump0030));
    } else {
      Logger.log('DIAG raw OperationLog row for opNo=0030: NOT FOUND');
    }

    var olRowsA = olRowsFor(PID_A);
    ['0030', '0040', '0050'].forEach(function(opNo) {
      var row = olRowsA.filter(function(r) { return r.operationNo === opNo; })[0];
      assert('(a3) OperationLog has ' + opNo + ' with Source=ADMIN_BACKFILL, Role=ADMIN',
        row && row.source === 'ADMIN_BACKFILL' && row.role === 'ADMIN', JSON.stringify(row));
    });

    var pmA = lookupPalletById_(PID_A);
    assert('(a4) QCStatus=INSPECTED', pmA && pmA.QCStatus === 'INSPECTED', pmA && pmA.QCStatus);
    assert('(a5) QCResult=PASS', pmA && pmA.QCResult === 'PASS', pmA && pmA.QCResult);

    // DIAG round 4 — raw PalletMaster read, bypasses lookupPalletById_ (which
    // does not expose QCInspector — confirmed by reading its return object).
    var rawPmA = rawPmRow(PID_A);
    Logger.log('DIAG raw PalletMaster QCInspector=' + JSON.stringify(rawPmA && rawPmA.QCInspector));
    Logger.log('DIAG actor variable used in this test call=' + JSON.stringify('tester@test.com'));

    assert('(a6) QCInspector starts with ADMIN_BACKFILL:',
      rawPmA && /^ADMIN_BACKFILL:/.test(rawPmA.QCInspector || ''), rawPmA && rawPmA.QCInspector);
    assert('(a7) ScanStatus=QC_COMPLETE', pmA && pmA.ScanStatus === 'QC_COMPLETE', pmA && pmA.ScanStatus);

    // ---- (b) reason < 5 chars — rejected, no writes ----
    var PID_B = 'PL-ZZBACKFILL-B01';
    seedPallet(PID_B);
    seedOp(PID_B, '0010', 'Op10');
    seedOp(PID_B, '0020', 'Op20');
    SpreadsheetApp.flush();
    var olCountBBefore = olRowsFor(PID_B).length;

    var resB = adminBackfillPallet_(PID_B, 'ab', 'tester@test.com');
    assert('(b1) rejected (reason too short)', resB && resB.success === false, JSON.stringify(resB));
    assert('(b2) no OperationLog rows added', olRowsFor(PID_B).length === olCountBBefore,
      'before=' + olCountBBefore + ' after=' + olRowsFor(PID_B).length);
    var pmB = lookupPalletById_(PID_B);
    assert('(b3) PalletMaster fields unchanged',
      pmB && pmB.QCStatus === '' && pmB.ScanStatus === '', JSON.stringify(pmB && { QCStatus: pmB.QCStatus, ScanStatus: pmB.ScanStatus }));

    // ---- (c) ScanStatus=CONFIRMED — rejected, no writes ----
    var PID_C = 'PL-ZZBACKFILL-C01';
    seedPallet(PID_C, { ScanStatus: 'CONFIRMED' });
    SpreadsheetApp.flush();

    var resC = adminBackfillPallet_(PID_C, 'valid backfill reason', 'tester@test.com');
    assert('(c1) rejected (already CONFIRMED)', resC && resC.success === false, JSON.stringify(resC));
    assert('(c2) no OperationLog rows written', olRowsFor(PID_C).length === 0);
    var pmC = lookupPalletById_(PID_C);
    assert('(c3) PalletMaster fields unchanged', pmC && pmC.QCStatus === '' && pmC.ScanStatus === 'CONFIRMED');

    // ---- (d) ExclusionStatus=EXCLUDED — rejected, no writes ----
    var PID_D = 'PL-ZZBACKFILL-D01';
    seedPallet(PID_D, { ExclusionStatus: 'EXCLUDED' });
    SpreadsheetApp.flush();

    var resD = adminBackfillPallet_(PID_D, 'valid backfill reason', 'tester@test.com');
    assert('(d1) rejected (EXCLUDED)', resD && resD.success === false, JSON.stringify(resD));
    assert('(d2) no OperationLog rows written', olRowsFor(PID_D).length === 0);
    var pmD = lookupPalletById_(PID_D);
    assert('(d3) PalletMaster fields unchanged', pmD && pmD.QCStatus === '' && pmD.ExclusionStatus === 'EXCLUDED');

    // ---- (e) QCStatus already INSPECTED — rejected, no writes (idempotency) ----
    var PID_E = 'PL-ZZBACKFILL-E01';
    seedPallet(PID_E, { QCStatus: 'INSPECTED', QCResult: 'PASS' });
    SpreadsheetApp.flush();

    var resE = adminBackfillPallet_(PID_E, 'valid backfill reason', 'tester@test.com');
    assert('(e1) rejected (already INSPECTED)', resE && resE.success === false, JSON.stringify(resE));
    assert('(e2) no OperationLog rows written', olRowsFor(PID_E).length === 0);
    var pmE = lookupPalletById_(PID_E);
    assert('(e3) PalletMaster fields unchanged',
      pmE && pmE.QCStatus === 'INSPECTED' && pmE.ScanStatus === '', JSON.stringify(pmE && { QCStatus: pmE.QCStatus, ScanStatus: pmE.ScanStatus }));

    // ---- (f) zero missing operations (all 5 already logged) — rejected, no writes ----
    var PID_F = 'PL-ZZBACKFILL-F01';
    seedPallet(PID_F);
    FIVE_OPS.forEach(function(op) { seedOp(PID_F, op.opNo, op.opText); });
    SpreadsheetApp.flush();
    var olCountFBefore = olRowsFor(PID_F).length;

    var resF = adminBackfillPallet_(PID_F, 'valid backfill reason', 'tester@test.com');
    assert('(f1) rejected (nothing missing)', resF && resF.success === false, JSON.stringify(resF));
    assert('(f2) no OperationLog rows added', olRowsFor(PID_F).length === olCountFBefore);
    var pmF = lookupPalletById_(PID_F);
    assert('(f3) PalletMaster fields unchanged',
      pmF && pmF.QCStatus === '' && pmF.ScanStatus === '', JSON.stringify(pmF && { QCStatus: pmF.QCStatus, ScanStatus: pmF.ScanStatus }));

    // ---- (g) Local Op Cumulative forced ON — rejected, no writes ----
    var PID_G = 'PL-ZZBACKFILL-G01';
    seedPallet(PID_G);
    seedOp(PID_G, '0010', 'Op10');
    seedOp(PID_G, '0020', 'Op20');
    SpreadsheetApp.flush();
    var olCountGBefore = olRowsFor(PID_G).length;

    props.setProperty(flagKey, 'true');
    var resG = adminBackfillPallet_(PID_G, 'valid backfill reason', 'tester@test.com');
    props.setProperty(flagKey, 'false'); // reset regardless of outcome (also reset in finally)

    assert('(g1) rejected (Local Op Cumulative ON)', resG && resG.success === false, JSON.stringify(resG));
    assert('(g2) no OperationLog rows added', olRowsFor(PID_G).length === olCountGBefore);
    var pmG = lookupPalletById_(PID_G);
    assert('(g3) PalletMaster fields unchanged',
      pmG && pmG.QCStatus === '' && pmG.ScanStatus === '', JSON.stringify(pmG && { QCStatus: pmG.QCStatus, ScanStatus: pmG.ScanStatus }));

    // ---- (h) admin gate — non-admin caller is rejected, no writes ----
    var PID_H = 'PL-ZZBACKFILL-H01';
    seedPallet(PID_H);
    seedOp(PID_H, '0010', 'Op10');
    seedOp(PID_H, '0020', 'Op20');
    SpreadsheetApp.flush();
    var olCountHBefore = olRowsFor(PID_H).length;

    isAdminUser_ = function() { return false; };
    var resH = adminBackfillPallet_(PID_H, 'valid backfill reason', 'tester@test.com');
    isAdminUser_ = function() { return true; }; // back to stubbed-admin for any tests after this one

    assert('(h1) rejected (not admin)', resH && resH.success === false, JSON.stringify(resH));
    assert('(h2) no OperationLog rows added', olRowsFor(PID_H).length === olCountHBefore);
    var pmH = lookupPalletById_(PID_H);
    assert('(h3) PalletMaster fields unchanged',
      pmH && pmH.QCStatus === '' && pmH.ScanStatus === '', JSON.stringify(pmH && { QCStatus: pmH.QCStatus, ScanStatus: pmH.ScanStatus }));

    // ---- (i) production admin-gate documentation — real isAdminUser_(), no stub ----
    // Not asserted against a specific true/false (depends on the running session's
    // email vs CFG.ADMIN_EMAILS / CFG.ADMIN_LOCK_ENABLED) — just confirms the real
    // implementation still returns a boolean without throwing, so adminBackfillPallet_'s
    // Guard 1 has something well-formed to gate on in production.
    isAdminUser_ = origIsAdminUser;
    var realAdminResult;
    var threwRealAdmin = false;
    try { realAdminResult = isAdminUser_(); } catch (eAdmin) { threwRealAdmin = true; }
    assert('(i1) real isAdminUser_() returns a boolean without throwing',
      !threwRealAdmin && typeof realAdminResult === 'boolean', 'got=' + realAdminResult);
    isAdminUser_ = function() { return true; }; // restore stub for any remaining assertions

    // ---- (l) actualQty valid reduction (10 -> 6) — success, GoodQty=6, QtyPerPallet=6, note suffix ----
    var PID_L = 'PL-ZZBACKFILL-L01';
    seedPallet(PID_L);
    seedOp(PID_L, '0010', 'Op10');
    seedOp(PID_L, '0020', 'Op20');
    SpreadsheetApp.flush();

    var resL = adminBackfillPallet_(PID_L, 'valid backfill reason', 'tester@test.com', 6);
    assert('(l1) success:true', resL && resL.success === true, JSON.stringify(resL));
    assert('(l2) qtyBackfilled===6', resL && resL.qtyBackfilled === 6, JSON.stringify(resL));
    var olRowsL = olRowsFor(PID_L);
    ['0030', '0040', '0050'].forEach(function(opNo) {
      var row = olRowsL.filter(function(r) { return r.operationNo === opNo; })[0];
      assert('(l3) OperationLog ' + opNo + ' has GoodQty=6', row && row.goodQty === 6, JSON.stringify(row));
    });
    var pmL = lookupPalletById_(PID_L);
    assert('(l4) PalletMaster.QtyPerPallet=6', pmL && pmL.QtyPerPallet === 6, pmL && pmL.QtyPerPallet);
    var rawPmL = rawPmRow(PID_L);
    assert('(l5) QCResultNote contains original 10 -> actual 6',
      rawPmL && /original 10 -> actual 6/.test(rawPmL.QCResultNote || ''), rawPmL && rawPmL.QCResultNote);

    // ---- (m) actualQty === original (10) — success, no note suffix, QtyPerPallet unchanged ----
    var PID_M = 'PL-ZZBACKFILL-M01';
    seedPallet(PID_M);
    seedOp(PID_M, '0010', 'Op10');
    seedOp(PID_M, '0020', 'Op20');
    SpreadsheetApp.flush();

    var resM = adminBackfillPallet_(PID_M, 'valid backfill reason', 'tester@test.com', 10);
    assert('(m1) success:true', resM && resM.success === true, JSON.stringify(resM));
    var pmM = lookupPalletById_(PID_M);
    assert('(m2) PalletMaster.QtyPerPallet unchanged at 10', pmM && pmM.QtyPerPallet === 10, pmM && pmM.QtyPerPallet);
    var rawPmM = rawPmRow(PID_M);
    assert('(m3) QCResultNote does NOT contain Qty backfill suffix',
      rawPmM && !/Qty backfill/.test(rawPmM.QCResultNote || ''), rawPmM && rawPmM.QCResultNote);

    // ---- (n) actualQty > original — rejected, cap mentioned, zero writes ----
    var PID_N = 'PL-ZZBACKFILL-N01';
    seedPallet(PID_N);
    seedOp(PID_N, '0010', 'Op10');
    seedOp(PID_N, '0020', 'Op20');
    SpreadsheetApp.flush();
    var olCountNBefore = olRowsFor(PID_N).length;

    var resN = adminBackfillPallet_(PID_N, 'valid backfill reason', 'tester@test.com', 15);
    assert('(n1) rejected (actualQty > original)', resN && resN.success === false, JSON.stringify(resN));
    assert('(n2) message mentions cap (10)', resN && /10/.test(resN.message || ''), resN && resN.message);
    assert('(n3) no OperationLog rows added', olRowsFor(PID_N).length === olCountNBefore);
    var pmN = lookupPalletById_(PID_N);
    assert('(n4) PalletMaster fields unchanged',
      pmN && pmN.QCStatus === '' && pmN.ScanStatus === '', JSON.stringify(pmN && { QCStatus: pmN.QCStatus, ScanStatus: pmN.ScanStatus }));

    // ---- (o) actualQty <= 0 — rejected, zero writes ----
    var PID_O = 'PL-ZZBACKFILL-O01';
    seedPallet(PID_O);
    seedOp(PID_O, '0010', 'Op10');
    seedOp(PID_O, '0020', 'Op20');
    SpreadsheetApp.flush();
    var olCountOBefore = olRowsFor(PID_O).length;

    var resO = adminBackfillPallet_(PID_O, 'valid backfill reason', 'tester@test.com', 0);
    assert('(o1) rejected (actualQty <= 0)', resO && resO.success === false, JSON.stringify(resO));
    assert('(o2) no OperationLog rows added', olRowsFor(PID_O).length === olCountOBefore);
    var pmO = lookupPalletById_(PID_O);
    assert('(o3) PalletMaster fields unchanged',
      pmO && pmO.QCStatus === '' && pmO.ScanStatus === '', JSON.stringify(pmO && { QCStatus: pmO.QCStatus, ScanStatus: pmO.ScanStatus }));

    // ---- (p) actualQty omitted — byte-identical to existing 3-arg behavior (already covered by (a); re-confirm here) ----
    var PID_P = 'PL-ZZBACKFILL-P01';
    seedPallet(PID_P);
    seedOp(PID_P, '0010', 'Op10');
    seedOp(PID_P, '0020', 'Op20');
    SpreadsheetApp.flush();

    var resP = adminBackfillPallet_(PID_P, 'valid backfill reason', 'tester@test.com');
    assert('(p1) success:true', resP && resP.success === true, JSON.stringify(resP));
    var pmP = lookupPalletById_(PID_P);
    assert('(p2) PalletMaster.QtyPerPallet untouched at 10', pmP && pmP.QtyPerPallet === 10, pmP && pmP.QtyPerPallet);
    var olRowsP = olRowsFor(PID_P);
    ['0030', '0040', '0050'].forEach(function(opNo) {
      var row = olRowsP.filter(function(r) { return r.operationNo === opNo; })[0];
      assert('(p3) OperationLog ' + opNo + ' has GoodQty=10 (full QtyPerPallet)', row && row.goodQty === 10, JSON.stringify(row));
    });

  } catch (ex) {
    pass = false;
    Logger.log('❌ EXCEPTION: ' + ex.message);
  } finally {
    getOperationsForOrder = origGetOperationsForOrder;
    isAdminUser_ = origIsAdminUser;
    props.setProperty(flagKey, 'false'); // never leak ON into other tests/production

    var pmCleanup = pmSh.getDataRange().getValues();
    var pmHdrCleanup = pmCleanup[0];
    var pidColCleanup = pmHdrCleanup.indexOf('PalletID');
    for (var pr = pmCleanup.length - 1; pr >= 1; pr--) {
      if (/^PL-ZZBACKFILL-/i.test(String(pmCleanup[pr][pidColCleanup] || '').trim())) {
        pmSh.deleteRow(pr + 1);
      }
    }

    var olCleanup = olSh.getDataRange().getValues();
    var olHdrCleanup = olCleanup[0];
    var olPidColCleanup = olHdrCleanup.indexOf('PalletID');
    for (var olr = olCleanup.length - 1; olr >= 1; olr--) {
      if (/^PL-ZZBACKFILL-/i.test(String(olCleanup[olr][olPidColCleanup] || '').trim())) {
        olSh.deleteRow(olr + 1);
      }
    }

    SpreadsheetApp.flush();
  }

  var elapsed = Date.now() - t0;
  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  Logger.log(fn + ': ' + (pass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name);
  });
  Logger.log('──────────────────────────────────────────');

  logEvent(fn, 'AdminBackfillPallet', pass ? 'PASS' : 'FAIL', elapsed,
    results.length + ' assertions');

  return pass;
}

/**
 * TEST_listBackfillCandidates_ — self-cleaning fixture, prefix 'PL-ZZBFLIST-'.
 * Stubs getOperationsForOrder (5-op fixed routing) and isAdminUser_ (admin
 * gate) via plain reassignment, same technique as TEST_adminBackfillPallet_.
 * Exercises listBackfillCandidates() (WebApp.gs) against the exact same
 * gap-diff logic used by adminBackfillPallet_.
 * @return {boolean} pass
 */
function TEST_listBackfillCandidates_() {
  var fn = 'TEST_listBackfillCandidates_';
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
    return ok;
  }

  var pmSh = getSpreadsheet_().getSheetByName(PM_SHEET);
  var olSh = getSpreadsheet_().getSheetByName(OL_SHEET);

  var MO = '0000098011'; // all-digit — avoids leading-zero coercion gotcha
  var origGetOperationsForOrder = getOperationsForOrder;
  var origIsAdminUser = isAdminUser_;

  var FIVE_OPS = [
    { opNo: '0010', opText: 'Op10', workCenter: 'WC1', isFinal: false },
    { opNo: '0020', opText: 'Op20', workCenter: 'WC1', isFinal: false },
    { opNo: '0030', opText: 'Op30', workCenter: 'WC1', isFinal: false },
    { opNo: '0040', opText: 'Op40', workCenter: 'WC1', isFinal: false },
    { opNo: '0050', opText: 'Op50', workCenter: 'WC1', isFinal: true }
  ];

  getOperationsForOrder = function(mo) { return _normMo_(mo) === _normMo_(MO) ? FIVE_OPS : []; };
  isAdminUser_ = function() { return true; }; // default ON for the business-logic assertions below

  function seedPallet(pid, overrides) {
    var vals = {
      PalletID: pid, ManufacturingOrder: MO, Material: 'ZZTEST-MAT', MaterialName: 'Test Material',
      QtyPerPallet: 10, Unit: 'PC',
      ScanStatus: '', ExclusionStatus: '', QCStatus: ''
    };
    Object.keys(overrides || {}).forEach(function(k) { vals[k] = overrides[k]; });
    pmSh.appendRow(buildPalletRow_(vals));
    SpreadsheetApp.flush();
  }

  function seedOp(pid, opNo, opText) {
    logOperation({
      palletId: pid, mo: MO, operationNo: opNo, operationText: opText,
      goodQty: 10, scrapQty: 0, repairQty: 0, awaitConvQty: 0,
      operator: 'TEST', role: 'OP', result: 'PASS', source: 'TEST'
    });
  }

  function findPid(resp, pid) {
    return (resp && resp.pallets || []).filter(function(p) { return p.PalletID === pid; })[0];
  }

  // ---- ProductGroup join fixture: seed MaterialMaster for 'ZZTEST-MAT' only if
  // it doesn't already exist (preserve-on-sync rule — never touch a real row).
  var mmSh = getSpreadsheet_().getSheetByName('MaterialMaster');
  var MM_TEST_PG = 'ZZTEST-BFLIST-PG';
  var addedMmRow = false;
  var expectedPg = null;
  if (mmSh && mmSh.getLastRow() > 1) {
    var mmData = mmSh.getDataRange().getValues();
    var mmHdr = mmData[0];
    var mmIdx = {};
    mmHdr.forEach(function(h, i) { mmIdx[h] = i; });
    for (var mr = 1; mr < mmData.length; mr++) {
      if (String(mmData[mr][mmIdx['Material']] || '').trim() === 'ZZTEST-MAT') {
        expectedPg = String(mmData[mr][mmIdx['ProductGroup']] || '').trim();
        break;
      }
    }
  }
  if (expectedPg === null && mmSh) {
    var mmRow = MM_HEADERS.map(function(h) {
      if (h === 'Material')     return 'ZZTEST-MAT';
      if (h === 'ProductGroup') return MM_TEST_PG;
      return '';
    });
    mmSh.appendRow(mmRow);
    SpreadsheetApp.flush();
    addedMmRow = true;
    expectedPg = MM_TEST_PG;
  }

  try {
    // ---- (a) missing ops, QCStatus not INSPECTED -> appears, correct MissingOps ----
    var PID_A = 'PL-ZZBFLIST-A01';
    seedPallet(PID_A);
    seedOp(PID_A, '0010', 'Op10');
    seedOp(PID_A, '0020', 'Op20');
    SpreadsheetApp.flush();

    var resA = listBackfillCandidates();
    assert('(a1) success:true', resA && resA.success === true, JSON.stringify(resA));
    var foundA = findPid(resA, PID_A);
    assert('(a2) PID_A appears in list', !!foundA, JSON.stringify(foundA));
    assert('(a3) MissingOps = [0030,0040,0050]',
      foundA && JSON.stringify(foundA.MissingOps) === JSON.stringify(['0030', '0040', '0050']),
      foundA && JSON.stringify(foundA.MissingOps));
    assert('(a4) ProductGroup matches MaterialMaster join',
      foundA && foundA.ProductGroup === expectedPg,
      'got=' + (foundA && foundA.ProductGroup) + ' expected=' + expectedPg);

    // ---- (b) QCStatus=INSPECTED -> does NOT appear ----
    var PID_B = 'PL-ZZBFLIST-B01';
    seedPallet(PID_B, { QCStatus: 'INSPECTED' });
    seedOp(PID_B, '0010', 'Op10');
    SpreadsheetApp.flush();

    var resB = listBackfillCandidates();
    assert('(b1) PID_B does NOT appear (QCStatus INSPECTED)', !findPid(resB, PID_B));

    // ---- (c) ScanStatus=CONFIRMED -> does NOT appear ----
    var PID_C = 'PL-ZZBFLIST-C01';
    seedPallet(PID_C, { ScanStatus: 'CONFIRMED' });
    SpreadsheetApp.flush();

    var resC = listBackfillCandidates();
    assert('(c1) PID_C does NOT appear (ScanStatus CONFIRMED)', !findPid(resC, PID_C));

    // ---- (d) ExclusionStatus=EXCLUDED -> does NOT appear ----
    var PID_D = 'PL-ZZBFLIST-D01';
    seedPallet(PID_D, { ExclusionStatus: 'EXCLUDED' });
    SpreadsheetApp.flush();

    var resD = listBackfillCandidates();
    assert('(d1) PID_D does NOT appear (EXCLUDED)', !findPid(resD, PID_D));

    // ---- (e) zero missing ops (fully logged) -> does NOT appear ----
    var PID_E = 'PL-ZZBFLIST-E01';
    seedPallet(PID_E);
    FIVE_OPS.forEach(function(op) { seedOp(PID_E, op.opNo, op.opText); });
    SpreadsheetApp.flush();

    var resE = listBackfillCandidates();
    assert('(e1) PID_E does NOT appear (nothing missing)', !findPid(resE, PID_E));

    // ---- (f) non-admin caller -> {success:false, pallets:[]} ----
    isAdminUser_ = function() { return false; };
    var resF = listBackfillCandidates();
    isAdminUser_ = function() { return true; }; // restore stub for any remaining assertions

    assert('(f1) rejected (not admin)', resF && resF.success === false, JSON.stringify(resF));
    assert('(f2) pallets:[] for non-admin', resF && Array.isArray(resF.pallets) && resF.pallets.length === 0,
      JSON.stringify(resF && resF.pallets));

  } catch (ex) {
    pass = false;
    Logger.log('❌ EXCEPTION: ' + ex.message);
  } finally {
    getOperationsForOrder = origGetOperationsForOrder;
    isAdminUser_ = origIsAdminUser;

    var pmCleanup = pmSh.getDataRange().getValues();
    var pmHdrCleanup = pmCleanup[0];
    var pidColCleanup = pmHdrCleanup.indexOf('PalletID');
    for (var pr = pmCleanup.length - 1; pr >= 1; pr--) {
      if (/^PL-ZZBFLIST-/i.test(String(pmCleanup[pr][pidColCleanup] || '').trim())) {
        pmSh.deleteRow(pr + 1);
      }
    }

    var olCleanup = olSh.getDataRange().getValues();
    var olHdrCleanup = olCleanup[0];
    var olPidColCleanup = olHdrCleanup.indexOf('PalletID');
    for (var olr = olCleanup.length - 1; olr >= 1; olr--) {
      if (/^PL-ZZBFLIST-/i.test(String(olCleanup[olr][olPidColCleanup] || '').trim())) {
        olSh.deleteRow(olr + 1);
      }
    }

    if (addedMmRow && mmSh) {
      var mmCleanup = mmSh.getDataRange().getValues();
      var mmHdrCleanup = mmCleanup[0];
      var mmMatColCleanup = mmHdrCleanup.indexOf('Material');
      for (var mmr = mmCleanup.length - 1; mmr >= 1; mmr--) {
        if (String(mmCleanup[mmr][mmMatColCleanup] || '').trim() === 'ZZTEST-MAT') {
          mmSh.deleteRow(mmr + 1);
        }
      }
    }

    SpreadsheetApp.flush();
  }

  var elapsed = Date.now() - t0;
  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  Logger.log(fn + ': ' + (pass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name);
  });
  Logger.log('──────────────────────────────────────────');

  logEvent(fn, 'ListBackfillCandidates', pass ? 'PASS' : 'FAIL', elapsed,
    results.length + ' assertions');

  return pass;
}

/**
 * TEST_batchAdminBackfill_ — self-cleaning fixture, prefix 'PL-ZZBFBATCH-'.
 * Stubs getOperationsForOrder (5-op fixed routing) and isAdminUser_ (admin
 * gate) via plain reassignment, same technique as TEST_adminBackfillPallet_.
 * Exercises batchAdminBackfill() (WebApp.gs), which fans out to
 * adminBackfillPallet_ per item with fail-soft try/catch, same pattern as
 * batchOverrideConfirm.
 * @return {boolean} pass
 */
function TEST_batchAdminBackfill_() {
  var fn = 'TEST_batchAdminBackfill_';
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
    return ok;
  }

  var pmSh = getSpreadsheet_().getSheetByName(PM_SHEET);
  var olSh = getSpreadsheet_().getSheetByName(OL_SHEET);

  var MO = '0000098012'; // all-digit — avoids leading-zero coercion gotcha
  var origGetOperationsForOrder = getOperationsForOrder;
  var origIsAdminUser = isAdminUser_;

  var FIVE_OPS = [
    { opNo: '0010', opText: 'Op10', workCenter: 'WC1', isFinal: false },
    { opNo: '0020', opText: 'Op20', workCenter: 'WC1', isFinal: false },
    { opNo: '0030', opText: 'Op30', workCenter: 'WC1', isFinal: false },
    { opNo: '0040', opText: 'Op40', workCenter: 'WC1', isFinal: false },
    { opNo: '0050', opText: 'Op50', workCenter: 'WC1', isFinal: true }
  ];

  getOperationsForOrder = function(mo) { return _normMo_(mo) === _normMo_(MO) ? FIVE_OPS : []; };
  isAdminUser_ = function() { return true; }; // default ON for the business-logic assertions below

  function seedPallet(pid, overrides) {
    var vals = {
      PalletID: pid, ManufacturingOrder: MO, Material: 'ZZTEST-MAT', MaterialName: 'Test Material',
      QtyPerPallet: 10, Unit: 'PC',
      ScanStatus: '', ExclusionStatus: '', QCStatus: ''
    };
    Object.keys(overrides || {}).forEach(function(k) { vals[k] = overrides[k]; });
    pmSh.appendRow(buildPalletRow_(vals));
    SpreadsheetApp.flush();
  }

  function seedOp(pid, opNo, opText) {
    logOperation({
      palletId: pid, mo: MO, operationNo: opNo, operationText: opText,
      goodQty: 10, scrapQty: 0, repairQty: 0, awaitConvQty: 0,
      operator: 'TEST', role: 'OP', result: 'PASS', source: 'TEST'
    });
  }

  function olRowsFor(pid) {
    var data = olSh.getDataRange().getValues();
    var hdr = data[0];
    var idx = {};
    hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });
    var rows = [];
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][idx['PalletID']] || '').trim() === pid) rows.push(data[r]);
    }
    return rows;
  }

  function findResult(resp, pid) {
    return (resp && resp.results || []).filter(function(r) { return r.palletId === pid; })[0];
  }

  try {
    // ---- (g) 2 valid fixtures, valid reason -> both succeed ----
    var PID_G1 = 'PL-ZZBFBATCH-G01';
    var PID_G2 = 'PL-ZZBFBATCH-G02';
    seedPallet(PID_G1);
    seedOp(PID_G1, '0010', 'Op10');
    seedOp(PID_G1, '0020', 'Op20');
    seedPallet(PID_G2);
    seedOp(PID_G2, '0010', 'Op10');
    SpreadsheetApp.flush();

    var resG = batchAdminBackfill(
      [{ palletId: PID_G1 }, { palletId: PID_G2 }], 'valid backfill reason');
    assert('(g1) success:true', resG && resG.success === true, JSON.stringify(resG));
    assert('(g2) results has 2 entries', resG && resG.results && resG.results.length === 2,
      JSON.stringify(resG && resG.results));

    var rG1 = findResult(resG, PID_G1);
    var rG2 = findResult(resG, PID_G2);
    assert('(g3) PID_G1 succeeds, operationsBackfilled=[0030,0040,0050]',
      rG1 && rG1.success === true &&
      JSON.stringify(rG1.operationsBackfilled) === JSON.stringify(['0030', '0040', '0050']),
      JSON.stringify(rG1));
    assert('(g4) PID_G2 succeeds, operationsBackfilled=[0020,0030,0040,0050]',
      rG2 && rG2.success === true &&
      JSON.stringify(rG2.operationsBackfilled) === JSON.stringify(['0020', '0030', '0040', '0050']),
      JSON.stringify(rG2));

    // ---- (h) 6 items (over cap 5) -> rejected, zero writes ----
    var PID_H = [];
    for (var hIdx = 1; hIdx <= 6; hIdx++) {
      var pidH = 'PL-ZZBFBATCH-H0' + hIdx;
      PID_H.push(pidH);
      seedPallet(pidH);
      seedOp(pidH, '0010', 'Op10');
    }
    SpreadsheetApp.flush();

    var itemsH = PID_H.map(function(pid) { return { palletId: pid }; });
    var beforeCountsH = PID_H.map(function(pid) { return olRowsFor(pid).length; });
    var resH = batchAdminBackfill(itemsH, 'valid backfill reason');
    assert('(h1) rejected (over cap)', resH && resH.success === false, JSON.stringify(resH));
    assert('(h2) message mentions cap', resH && /5/.test(resH.message || ''), resH && resH.message);
    var afterCountsH = PID_H.map(function(pid) { return olRowsFor(pid).length; });
    var writesH = beforeCountsH.some(function(before, i) { return afterCountsH[i] !== before; });
    assert('(h3) zero NEW writes to any of the 6 fixtures (before/after row counts match)',
      !writesH, 'before=' + JSON.stringify(beforeCountsH) + ' after=' + JSON.stringify(afterCountsH));

    // ---- (i) reason < 5 chars -> rejected, zero writes ----
    var PID_I = 'PL-ZZBFBATCH-I01';
    seedPallet(PID_I);
    seedOp(PID_I, '0010', 'Op10');
    SpreadsheetApp.flush();
    var olCountIBefore = olRowsFor(PID_I).length;

    var resI = batchAdminBackfill([{ palletId: PID_I }], 'ab');
    assert('(i1) rejected (reason too short)', resI && resI.success === false, JSON.stringify(resI));
    assert('(i2) no OperationLog rows added', olRowsFor(PID_I).length === olCountIBefore);

    // ---- (j) one already-INSPECTED fixture mixed into otherwise-valid batch: fail-soft ----
    var PID_J1 = 'PL-ZZBFBATCH-J01';
    var PID_J2 = 'PL-ZZBFBATCH-J02'; // already INSPECTED — should fail individually
    var PID_J3 = 'PL-ZZBFBATCH-J03';
    seedPallet(PID_J1);
    seedOp(PID_J1, '0010', 'Op10');
    seedPallet(PID_J2, { QCStatus: 'INSPECTED', QCResult: 'PASS' });
    seedPallet(PID_J3);
    seedOp(PID_J3, '0010', 'Op10');
    SpreadsheetApp.flush();

    var resJ = batchAdminBackfill(
      [{ palletId: PID_J1 }, { palletId: PID_J2 }, { palletId: PID_J3 }], 'valid backfill reason');
    assert('(j1) batch call succeeds overall', resJ && resJ.success === true, JSON.stringify(resJ));
    var rJ1 = findResult(resJ, PID_J1);
    var rJ2 = findResult(resJ, PID_J2);
    var rJ3 = findResult(resJ, PID_J3);
    assert('(j2) PID_J1 succeeds', rJ1 && rJ1.success === true, JSON.stringify(rJ1));
    assert('(j3) PID_J2 fails individually (already INSPECTED)', rJ2 && rJ2.success === false, JSON.stringify(rJ2));
    assert('(j4) PID_J3 still succeeds despite PID_J2 failing', rJ3 && rJ3.success === true, JSON.stringify(rJ3));

    // ---- (k) non-admin caller -> rejected, zero writes ----
    var PID_K = 'PL-ZZBFBATCH-K01';
    seedPallet(PID_K);
    seedOp(PID_K, '0010', 'Op10');
    SpreadsheetApp.flush();
    var olCountKBefore = olRowsFor(PID_K).length;

    isAdminUser_ = function() { return false; };
    var resK = batchAdminBackfill([{ palletId: PID_K }], 'valid backfill reason');
    isAdminUser_ = function() { return true; }; // restore stub for any remaining assertions

    assert('(k1) rejected (not admin)', resK && resK.success === false, JSON.stringify(resK));
    assert('(k2) no OperationLog rows added', olRowsFor(PID_K).length === olCountKBefore);

    // ---- (l) 2 items, one qty-reduced (10 -> 7) + one full-qty -> both succeed, qtyBackfilled correct ----
    var PID_L1 = 'PL-ZZBFBATCH-L01'; // reduced
    var PID_L2 = 'PL-ZZBFBATCH-L02'; // no qty field — full QtyPerPallet
    seedPallet(PID_L1);
    seedOp(PID_L1, '0010', 'Op10');
    seedPallet(PID_L2);
    seedOp(PID_L2, '0010', 'Op10');
    SpreadsheetApp.flush();

    var resL = batchAdminBackfill(
      [{ palletId: PID_L1, qty: 7 }, { palletId: PID_L2 }], 'valid backfill reason');
    assert('(l1) success:true', resL && resL.success === true, JSON.stringify(resL));
    var rL1 = findResult(resL, PID_L1);
    var rL2 = findResult(resL, PID_L2);
    assert('(l2) PID_L1 succeeds with qtyBackfilled===7',
      rL1 && rL1.success === true && rL1.qtyBackfilled === 7, JSON.stringify(rL1));
    assert('(l3) PID_L2 succeeds with qtyBackfilled===10 (full QtyPerPallet)',
      rL2 && rL2.success === true && rL2.qtyBackfilled === 10, JSON.stringify(rL2));

  } catch (ex) {
    pass = false;
    Logger.log('❌ EXCEPTION: ' + ex.message);
  } finally {
    getOperationsForOrder = origGetOperationsForOrder;
    isAdminUser_ = origIsAdminUser;

    var pmCleanup = pmSh.getDataRange().getValues();
    var pmHdrCleanup = pmCleanup[0];
    var pidColCleanup = pmHdrCleanup.indexOf('PalletID');
    for (var pr = pmCleanup.length - 1; pr >= 1; pr--) {
      if (/^PL-ZZBFBATCH-/i.test(String(pmCleanup[pr][pidColCleanup] || '').trim())) {
        pmSh.deleteRow(pr + 1);
      }
    }

    var olCleanup = olSh.getDataRange().getValues();
    var olHdrCleanup = olCleanup[0];
    var olPidColCleanup = olHdrCleanup.indexOf('PalletID');
    for (var olr = olCleanup.length - 1; olr >= 1; olr--) {
      if (/^PL-ZZBFBATCH-/i.test(String(olCleanup[olr][olPidColCleanup] || '').trim())) {
        olSh.deleteRow(olr + 1);
      }
    }

    SpreadsheetApp.flush();
  }

  var elapsed = Date.now() - t0;
  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  Logger.log(fn + ': ' + (pass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name);
  });
  Logger.log('──────────────────────────────────────────');

  logEvent(fn, 'BatchAdminBackfill', pass ? 'PASS' : 'FAIL', elapsed,
    results.length + ' assertions');

  return pass;
}

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
 * @return {{success:boolean, message?:string, palletId?:string, operationsBackfilled?:string[]}}
 */
function adminBackfillPallet_(palletId, reason, actor) {
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
      goodQty:       pallet.QtyPerPallet,
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

  updatePalletScanFields_(pid, {
    QCStatus:     'INSPECTED',
    QCResult:     'PASS',
    QCInspector:  'ADMIN_BACKFILL:' + actor,
    QCResultNote: 'Admin backfill: ' + trimmedReason,
    ScanStatus:   'QC_COMPLETE'
  });

  logEvent('PALLET_BACKFILL', 'OK', JSON.stringify({
    palletId: pid, actor: actor, reason: trimmedReason,
    operationsBackfilled: backfilled
  }));

  return { success: true, palletId: pid, operationsBackfilled: backfilled };
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
          source:      String(data[r][idx['Source']]      || '').trim()
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

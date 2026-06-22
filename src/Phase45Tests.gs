/**
 * Phase45Tests.gs — Phase 4.5 Gate 3d
 * =====================================
 * Automated QC/PD/sequential gate test suite.
 * Run from menu: 🧪 Diagnostic / Test → 🧪 Phase 4.5: Run all tests
 *
 * All tests self-cleaning: fake data (PL-TEST-QC-*) is removed in finally blocks.
 * Fake MOs use TEST-QC-MO-* prefix (never collides with real SAP orders).
 * No mutation of real (non-PL-TEST-) rows.
 */

// ============================================================================
// Constants
// ============================================================================

var TEST_QC_PREFIX_     = 'PL-TEST-QC-';
var TEST_QC_MO_         = 'TEST-QC-MO-001';
var TEST_QC_MO_MULTI_   = 'TEST-QC-MO-002';
var TEST_QC_OPS_SINGLE_ = [{ opNo: '0010', opText: 'TestOp1', workCenter: 'TC01' }];
var TEST_QC_OPS_MULTI_  = [
  { opNo: '0010', opText: 'TestOp1', workCenter: 'TC01' },
  { opNo: '0020', opText: 'TestOp2', workCenter: 'TC02' }
];

// ============================================================================
// Seed / cleanup helpers
// ============================================================================

/**
 * Remove all test data seeded by Phase 4.5 tests.
 * Deletes PalletMaster rows (PL-TEST-QC-*), OperationLog rows (PL-TEST-QC-*),
 * and ProductionOrders rows (TEST-QC-MO-*). Safe to run repeatedly.
 * @return {{ pm: number, ol: number, po: number }}
 */
function cleanupTestQcData_() {
  var ss = getSpreadsheet_();

  function deleteMatchingRows_(sheetName, columnName, prefix) {
    var sh = ss.getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return 0;
    var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var colIdx = hdr.indexOf(columnName);
    if (colIdx < 0) return 0;
    var data = sh.getRange(2, colIdx + 1, sh.getLastRow() - 1, 1).getValues();
    var toDelete = [];
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0] || '').trim().indexOf(prefix) === 0) toDelete.push(i + 2);
    }
    for (var d = toDelete.length - 1; d >= 0; d--) sh.deleteRow(toDelete[d]);
    return toDelete.length;
  }

  var pmDel = deleteMatchingRows_(CFG.SHEETS.PALLET_MASTER,    'PalletID',           TEST_QC_PREFIX_);
  var olDel = deleteMatchingRows_(CFG.SHEETS.OPERATION_LOG,     'PalletID',           TEST_QC_PREFIX_);
  var poDel = deleteMatchingRows_(CFG.SHEETS.PRODUCTION_ORDERS, 'ManufacturingOrder', 'TEST-QC-MO-');
  return { pm: pmDel, ol: olDel, po: poDel };
}

/**
 * Insert a fake PalletMaster row by header map.
 * @param {string} palletId
 * @param {Object} [overrides] — field overrides (column name → value)
 */
function seedTestQcPmRow_(palletId, overrides) {
  var sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PALLET_MASTER);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var defaults = {
    PalletID:           palletId,
    ManufacturingOrder: TEST_QC_MO_,
    Material:           'TESTMAT-QC',
    MaterialName:       'Test QC Material',
    Batch:              'TESTBATCH',
    QtyPerPallet:       10,
    Unit:               'PC',
    PalletSeq:          1,
    TotalPallets:       1,
    WorkCenter:         'TC01',
    TotalQuantity:      10,
    Plant:              '1100',
    StorageLocation:    'ST39',
    Status:             'CREATED',
    ScanStatus:         'SCANNED',
    CreatedAt:          new Date()
  };
  var vals = {};
  for (var k in defaults) vals[k] = defaults[k];
  if (overrides) { for (var o in overrides) vals[o] = overrides[o]; }
  sh.appendRow(hdr.map(function(h) { return vals.hasOwnProperty(h) ? vals[h] : ''; }));
}

/**
 * Insert a fake ProductionOrders row with OperationsJSON.
 * @param {string} mo
 * @param {Array<{opNo,opText,workCenter}>} ops
 * @param {string} [finalOp] — defaults to last op number
 */
function seedTestQcPoRow_(mo, ops, finalOp) {
  var sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var lastOpNo = ops.length > 0 ? ops[ops.length - 1].opNo : '';
  var vals = {
    ManufacturingOrder: mo,
    Material:           'TESTMAT-QC',
    TotalQuantity:      100,
    Plant:              '1100',
    IsReleased:         true,
    OperationsJSON:     JSON.stringify(ops),
    FinalOperation:     finalOp || _normOpNo_(lastOpNo)
  };
  sh.appendRow(hdr.map(function(h) { return vals.hasOwnProperty(h) ? vals[h] : ''; }));
}

/**
 * Insert a fake OperationLog row directly (bypasses DRY_RUN).
 * @param {string} palletId
 * @param {string} mo
 * @param {string} opNo
 * @param {string} [opText]
 * @param {number} [goodQty] — defaults to 10
 */
function seedTestQcOlRow_(palletId, mo, opNo, opText, goodQty) {
  var sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.OPERATION_LOG);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var now = new Date();
  var vals = {
    LogID:              palletId + '-' + opNo + '-OP-' + now.getTime(),
    PalletID:           palletId,
    ManufacturingOrder: mo,
    OperationNo:        _normOpNo_(opNo),
    OperationText:      opText || 'TestOp',
    GoodQty:            goodQty != null ? goodQty : 10,
    ScrapQty:           0,
    RepairQty:          0,
    AwaitConvQty:       0,
    Operator:           'TEST_OPERATOR',
    Role:               'OP',
    Result:             'PASS',
    LoggedAt:           now,
    Source:              'TEST'
  };
  sh.appendRow(hdr.map(function(h) { return vals.hasOwnProperty(h) ? vals[h] : ''; }));
}

/**
 * Read a PalletMaster row by PalletID — returns ALL columns by header name.
 * Used for assertion: reads QCInspector, QCResult, QCStatus, etc. directly
 * from the sheet (lookupPalletById_ omits QCInspector from its return object).
 * @param {string} palletId
 * @return {Object|null} column name → value map
 */
function readTestQcPmRow_(palletId) {
  var sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!sh || sh.getLastRow() < 2) return null;
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var idx = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['PalletID']] || '').trim() === palletId) {
      var result = {};
      hdr.forEach(function(h, i) { result[h] = data[r][i]; });
      return result;
    }
  }
  return null;
}

// ============================================================================
// Test 1: QCInspector field persistence (Gate 3b.1 definitive check)
// ============================================================================

/**
 * PRIMARY TEST — verifies Gate 3b.1 (saveQcResult persists QCInspector).
 *
 * Setup: fake PalletMaster row + ProductionOrders routing + OperationLog entries
 * so checkAllOperationsDone_ returns true. Then calls saveQcResult with
 * inspector='TESTQC_INSPECTOR' and asserts the PalletMaster row has:
 *   QCInspector === 'TESTQC_INSPECTOR'
 *   QCResult    === 'PASS'
 *   QCStatus    === 'INSPECTED'
 *
 * @return {{ name: string, pass: boolean, detail: string }}
 */
function TEST_qcInspectorWrite_() {
  var name = 'TEST_qcInspectorWrite_';
  var palletId = TEST_QC_PREFIX_ + 'W1';

  cleanupTestQcData_();

  try {
    seedTestQcPoRow_(TEST_QC_MO_, TEST_QC_OPS_SINGLE_, '0010');
    seedTestQcPmRow_(palletId, { ScanStatus: 'SCANNED' });
    seedTestQcOlRow_(palletId, TEST_QC_MO_, '0010', 'TestOp1', 10);
    SpreadsheetApp.flush();

    var gateOpen = checkAllOperationsDone_(palletId);
    if (!gateOpen) {
      return { name: name, pass: false, detail: 'PRECONDITION FAILED: checkAllOperationsDone_ returned false' };
    }

    var result = saveQcResult({
      palletId:  palletId,
      result:    'PASS',
      inspector: 'TESTQC_INSPECTOR',
      note:      'Phase 4.5 gate 3d test'
    });

    if (!result.success) {
      return { name: name, pass: false, detail: 'saveQcResult failed: ' + result.message };
    }

    SpreadsheetApp.flush();
    var row = readTestQcPmRow_(palletId);
    if (!row) {
      return { name: name, pass: false, detail: 'PalletMaster row not found after saveQcResult' };
    }

    var checks = [
      { field: 'QCInspector', expected: 'TESTQC_INSPECTOR', actual: String(row.QCInspector || '').trim() },
      { field: 'QCResult',    expected: 'PASS',              actual: String(row.QCResult    || '').trim() },
      { field: 'QCStatus',    expected: 'INSPECTED',         actual: String(row.QCStatus    || '').trim() }
    ];

    var failures = checks.filter(function(c) { return c.actual !== c.expected; });

    if (failures.length > 0) {
      var detail = failures.map(function(f) {
        return f.field + ': expected "' + f.expected + '", got "' + f.actual + '"';
      }).join('; ');
      return { name: name, pass: false, detail: detail };
    }

    return {
      name: name, pass: true,
      detail: 'QCInspector="TESTQC_INSPECTOR", QCResult="PASS", QCStatus="INSPECTED" — all persisted correctly'
    };

  } finally {
    cleanupTestQcData_();
  }
}

// ============================================================================
// Test 2: QC gate blocks when operations are incomplete
// ============================================================================

/**
 * Fake pallet whose ops are NOT all logged. saveQcResult must be rejected
 * by checkAllOperationsDone_ gate. No QCResult should be written.
 *
 * @return {{ name: string, pass: boolean, detail: string }}
 */
function TEST_qcGateBlocksIncomplete_() {
  var name = 'TEST_qcGateBlocksIncomplete_';
  var palletId = TEST_QC_PREFIX_ + 'B1';

  cleanupTestQcData_();

  try {
    seedTestQcPoRow_(TEST_QC_MO_, TEST_QC_OPS_SINGLE_, '0010');
    seedTestQcPmRow_(palletId, { ScanStatus: 'SCANNED' });
    // NO OperationLog rows seeded — operations incomplete
    SpreadsheetApp.flush();

    var result = saveQcResult({
      palletId:  palletId,
      result:    'PASS',
      inspector: 'TESTQC_INSPECTOR',
      note:      ''
    });

    if (result.success) {
      return { name: name, pass: false, detail: 'saveQcResult should have been rejected but succeeded' };
    }

    SpreadsheetApp.flush();
    var row = readTestQcPmRow_(palletId);
    var qcResult = String(row && row.QCResult || '').trim();
    var qcInspector = String(row && row.QCInspector || '').trim();

    if (qcResult !== '') {
      return { name: name, pass: false, detail: 'QCResult should be empty but is "' + qcResult + '"' };
    }
    if (qcInspector !== '') {
      return { name: name, pass: false, detail: 'QCInspector should be empty but is "' + qcInspector + '"' };
    }

    return {
      name: name, pass: true,
      detail: 'saveQcResult correctly rejected (ops incomplete), no QC fields written'
    };

  } finally {
    cleanupTestQcData_();
  }
}

// ============================================================================
// Test 3: QC passes without PD inspection
// ============================================================================

/**
 * Fake pallet, all ops logged, NO PD inspection done. saveQcResult PASS must
 * succeed — PD is independent random sampling, not a QC gate prerequisite.
 *
 * @return {{ name: string, pass: boolean, detail: string }}
 */
function TEST_qcPassesWithoutPd_() {
  var name = 'TEST_qcPassesWithoutPd_';
  var palletId = TEST_QC_PREFIX_ + 'P1';

  cleanupTestQcData_();

  try {
    seedTestQcPoRow_(TEST_QC_MO_, TEST_QC_OPS_SINGLE_, '0010');
    seedTestQcPmRow_(palletId, { ScanStatus: 'SCANNED' });
    seedTestQcOlRow_(palletId, TEST_QC_MO_, '0010', 'TestOp1', 10);
    // NO savePdInspection call — PD not done
    SpreadsheetApp.flush();

    var result = saveQcResult({
      palletId:  palletId,
      result:    'PASS',
      inspector: 'TESTQC_NoPD',
      note:      'QC without PD'
    });

    if (!result.success) {
      return { name: name, pass: false, detail: 'saveQcResult should succeed without PD but failed: ' + result.message };
    }

    SpreadsheetApp.flush();
    var row = readTestQcPmRow_(palletId);
    var qcResult = String(row && row.QCResult || '').trim();

    if (qcResult !== 'PASS') {
      return { name: name, pass: false, detail: 'QCResult should be "PASS" but is "' + qcResult + '"' };
    }

    return {
      name: name, pass: true,
      detail: 'QC PASS succeeded without PD inspection — PD is independent of QC gate'
    };

  } finally {
    cleanupTestQcData_();
  }
}

// ============================================================================
// Test 4: Sequential lock rejects out-of-order operation
// ============================================================================

/**
 * Regression test: sequential gate must still reject out-of-order confirmations
 * after Phase 4.5 changes. Fake pallet with MO routing of 2 ops (0010, 0020).
 * Attempt confirmScan for op 0020 without op 0010 logged — must be rejected.
 *
 * @return {{ name: string, pass: boolean, detail: string }}
 */
function TEST_sequentialLockKept_() {
  var name = 'TEST_sequentialLockKept_';
  var palletId = TEST_QC_PREFIX_ + 'S1';

  cleanupTestQcData_();

  try {
    seedTestQcPoRow_(TEST_QC_MO_MULTI_, TEST_QC_OPS_MULTI_, '0020');
    seedTestQcPmRow_(palletId, {
      ManufacturingOrder: TEST_QC_MO_MULTI_,
      ScanStatus:         ''
    });
    // NO op 0010 logged — attempt op 0020 directly
    SpreadsheetApp.flush();

    var result = confirmScan({
      palletId:     palletId,
      opNo:         '0020',
      opText:       'TestOp2',
      isFinal:      true,
      qtyGood:      10,
      qtyScrap:     0,
      qtyRepair:    0,
      qtyAwaitConv: 0,
      operator:     'TEST_OPERATOR',
      role:         'OP'
    });

    if (result.success) {
      return { name: name, pass: false, detail: 'confirmScan should have been rejected for out-of-order op but succeeded' };
    }

    var mentionsMissing = result.message && result.message.indexOf('0010') !== -1;

    return {
      name: name, pass: true,
      detail: 'confirmScan correctly rejected op 0020 (op 0010 not logged)' +
              (mentionsMissing ? ' — message references missing op 0010' : '')
    };

  } finally {
    cleanupTestQcData_();
  }
}

// ============================================================================
// Test 5: QC mode server functions exist
// ============================================================================

/**
 * Lightweight server-side check: verify that doGet serves the scanner and that
 * the server functions QC mode relies on exist and are callable.
 *
 * @return {{ name: string, pass: boolean, detail: string }}
 */
function TEST_qcModeRouteExists_() {
  var name = 'TEST_qcModeRouteExists_';
  var missing = [];

  var requiredFns = [
    { name: 'doGet',            fn: typeof doGet },
    { name: 'lookupPallet',     fn: typeof lookupPallet },
    { name: 'savePdInspection', fn: typeof savePdInspection },
    { name: 'saveQcResult',     fn: typeof saveQcResult }
  ];

  requiredFns.forEach(function(entry) {
    if (entry.fn !== 'function') missing.push(entry.name + ' (typeof=' + entry.fn + ')');
  });

  if (missing.length > 0) {
    return { name: name, pass: false, detail: 'Missing functions: ' + missing.join(', ') };
  }

  try {
    var output = doGet({ parameter: { app: 'scan' } });
    var hasContent = output && typeof output.getContent === 'function';
    if (!hasContent) {
      return { name: name, pass: false, detail: 'doGet({app:"scan"}) did not return HtmlOutput' };
    }
  } catch (e) {
    return { name: name, pass: false, detail: 'doGet({app:"scan"}) threw: ' + e.message };
  }

  return {
    name: name, pass: true,
    detail: 'doGet(scan) OK, lookupPallet/savePdInspection/saveQcResult all present'
  };
}

// ============================================================================
// Master runner
// ============================================================================

/**
 * Run all Phase 4.5 tests. Each returns {name, pass, detail}.
 * Aggregates results, logs to EventLog, and shows a UI alert if run from menu.
 * @return {Array<{name: string, pass: boolean, detail: string}>}
 */
function TEST_phase45_all_() {
  var t0 = Date.now();
  logEvent('TEST_RUN', 'Phase45Tests', 'START', 0, 'Phase 4.5 test suite starting');

  var tests = [
    TEST_qcInspectorWrite_,
    TEST_qcGateBlocksIncomplete_,
    TEST_qcPassesWithoutPd_,
    TEST_sequentialLockKept_,
    TEST_qcModeRouteExists_
  ];

  var results = [];

  for (var i = 0; i < tests.length; i++) {
    try {
      var r = tests[i]();
      results.push(r);
      Logger.log((r.pass ? '  ✅' : '  ❌') + ' ' + r.name + ': ' + r.detail);
    } catch (e) {
      var errResult = { name: tests[i].name || ('test_' + i), pass: false, detail: 'EXCEPTION: ' + e.message };
      results.push(errResult);
      Logger.log('  ❌ ' + errResult.name + ': ' + errResult.detail);
    }
  }

  var passCount = results.filter(function(r) { return r.pass; }).length;
  var failCount = results.length - passCount;
  var elapsed   = Date.now() - t0;
  var summary   = passCount + '/' + results.length + ' passed, ' + failCount + ' failed, ' + elapsed + 'ms';

  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(failCount === 0 ? '✅ ALL TESTS PASSED' : '❌ ' + failCount + ' TEST(S) FAILED');
  Logger.log(summary);
  Logger.log('══════════════════════════════════════════');

  logEvent('TEST_RUN', 'Phase45Tests', failCount === 0 ? 'ALL_PASS' : 'SOME_FAIL', elapsed, summary);

  try {
    var ui = SpreadsheetApp.getUi();
    var icon = failCount === 0 ? '✅' : '❌';
    var lines = results.map(function(r) { return (r.pass ? '✅' : '❌') + ' ' + r.name; });
    ui.alert(icon + ' Phase 4.5 Test Results',
      lines.join('\n') + '\n\n' + summary,
      ui.ButtonSet.OK);
  } catch (_) {
    // Not running from UI context
  }

  return JSON.parse(JSON.stringify(results));
}

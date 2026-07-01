/**
 * EdgeCaseFixture.gs — Self-cleaning fixture for Local Op Cumulative edge cases
 * ==============================================================================
 * Not a phase-numbered deliverable — companion fixture for the
 * LOCAL_OP_CUMULATIVE_ENABLED feature (exceed-qty, round-limit-exceeded,
 * 3-round exact completion). Replaces the earlier PL-MANUALTEST-001 fixture
 * (FixtureSetupTemp.gs), which used a fake OrderID absent from SAP and fell
 * through getOperationsForOrder → fetchOperationsForMO_ (live SAP routing
 * fetch), returning zero ops ("ไม่พบ Operation ใน SAP").
 *
 * This fixture instead pre-populates the ProductionOrders sheet's
 * OperationsJSON cache column directly (see getOpsForMo_, WebApp.gs) with
 * 3 fake operations. getOperationsForOrder only calls fetchOperationsForMO_
 * when getOpsForMo_ returns an empty array — since the cache row below is
 * non-empty, the live SAP fallback never runs for this OrderID.
 *
 * OrderID/PalletID/Material are all obviously-fake and cannot collide with
 * real SAP objects or real sheet rows:
 *   FIXTURE_ORDER_ID  = '000000099999' (12-digit MO format, out of any real range)
 *   FIXTURE_PALLET_ID = 'PL-ZZTEST-EDGECASE-001'
 *   FIXTURE_MATERIAL  = 'ZZMANUALTEST'
 *
 * Run from menu: 🧪 Edge Case Fixture → ➕ Create / 🗑️ Delete (cleanup)
 */

var FIXTURE_ORDER_ID  = '000000099999';
var FIXTURE_PALLET_ID = 'PL-ZZTEST-EDGECASE-001';
var FIXTURE_MATERIAL  = 'ZZMANUALTEST';
var FIXTURE_BATCH     = '0000098888';

// ============================================================================
// Menu
// ============================================================================

function addEdgeCaseFixtureMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('🧪 Edge Case Fixture')
    .addItem('➕ Create Edge Case Fixture', 'TEST_createEdgeCaseFixture')
    .addItem('🗑️ Delete Edge Case Fixture (cleanup)', 'TEST_deleteEdgeCaseFixture')
    .addToUi();
}

// ============================================================================
// Create
// ============================================================================

/**
 * Menu-callable: creates the ProductionOrders cache row (3 fake ops) and
 * the PalletMaster row for the edge-case fixture. Re-runnable — deletes any
 * existing fixture rows first (idempotency key = ManufacturingOrder / PalletID).
 */
function TEST_createEdgeCaseFixture() {
  var ss = getSpreadsheet_();

  // ---- 1. ProductionOrders cache row: OperationsJSON = 3 fake ops -------
  var poSheet = ss.getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  if (!poSheet) throw new Error('EdgeCaseFixture: sheet not found: ' + CFG.SHEETS.PRODUCTION_ORDERS);
  var poHeaders = CFG.HEADERS.PRODUCTION_ORDERS;

  _deleteRowsByKey_(poSheet, poHeaders, 'ManufacturingOrder', FIXTURE_ORDER_ID, 'ProductionOrders');

  var fakeOps = [
    { opNo: '0010', opText: 'TEST OP A - 3 rounds exact', workCenter: 'WC-TEST' },
    { opNo: '0020', opText: 'TEST OP B - round limit',    workCenter: 'WC-TEST' },
    { opNo: '0030', opText: 'TEST OP C - exceed qty',     workCenter: 'WC-TEST' }
  ];

  var poValues = {
    ManufacturingOrder: FIXTURE_ORDER_ID,
    Material:           FIXTURE_MATERIAL,
    OperationsJSON:     JSON.stringify(fakeOps)
  };
  poSheet.appendRow(poHeaders.map(function (h) {
    return poValues.hasOwnProperty(h) ? poValues[h] : '';
  }));
  SpreadsheetApp.flush();
  Logger.log('EdgeCaseFixture: ProductionOrders row created for ' + FIXTURE_ORDER_ID +
    ' with ' + fakeOps.length + ' fake ops (OperationsJSON cache)');

  // ---- 2. PalletMaster row ------------------------------------------------
  var pmSheet = ss.getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!pmSheet) throw new Error('EdgeCaseFixture: sheet not found: ' + CFG.SHEETS.PALLET_MASTER);
  var pmHeaders = CFG.HEADERS.PALLET_MASTER;

  _deleteRowsByKey_(pmSheet, pmHeaders, 'PalletID', FIXTURE_PALLET_ID, 'PalletMaster');

  var pmValues = {
    PalletID:           FIXTURE_PALLET_ID,
    ManufacturingOrder: FIXTURE_ORDER_ID,
    Material:           FIXTURE_MATERIAL,
    MaterialName:       'EDGE CASE TEST FIXTURE - DO NOT USE FOR REAL WORK',
    QtyPerPallet:       30,
    Unit:               'PC',
    ScanStatus:         'PRINTED',
    Plant:              '1100',
    StorageLocation:    'PW10'
  };
  pmSheet.appendRow(pmHeaders.map(function (h) {
    return pmValues.hasOwnProperty(h) ? pmValues[h] : '';
  }));
  SpreadsheetApp.flush();

  // ---- Leading-zero-safe Batch write (setNumberFormat before setValue) --
  var pmIdCol = pmHeaders.indexOf('PalletID');
  var lastRow = pmSheet.getLastRow();
  var pmCheck = pmSheet.getRange(2, 1, lastRow - 1, pmSheet.getLastColumn()).getValues();
  var rowNum = -1;
  for (var i = 0; i < pmCheck.length; i++) {
    if (String(pmCheck[i][pmIdCol] || '').trim() === FIXTURE_PALLET_ID) { rowNum = i + 2; break; }
  }
  if (rowNum === -1) throw new Error('EdgeCaseFixture: could not find PalletMaster row just inserted');

  var batchCol = pmHeaders.indexOf('Batch');
  if (batchCol === -1) throw new Error('EdgeCaseFixture: Batch column not found in headers');
  var batchCell = pmSheet.getRange(rowNum, batchCol + 1);
  batchCell.setNumberFormat('@');
  batchCell.setValue(FIXTURE_BATCH);
  SpreadsheetApp.flush();

  var batchCheck = String(batchCell.getValue());
  if (batchCheck !== FIXTURE_BATCH) {
    throw new Error('EdgeCaseFixture: Batch cell mismatch — expected ' + FIXTURE_BATCH + ', got ' + batchCheck);
  }
  Logger.log('EdgeCaseFixture: PalletMaster row created for ' + FIXTURE_PALLET_ID +
    ' at row ' + rowNum + ', Batch=\'' + batchCheck + '\'');

  // ---- 3. Confirm cache-hit shape (real call — no live SAP call happens,
  //         since getOpsForMo_ already returned a non-empty array) --------
  var ops = getOperationsForOrder(FIXTURE_ORDER_ID);
  Logger.log('EdgeCaseFixture: getOperationsForOrder(' + FIXTURE_ORDER_ID + ') returned ' +
    ops.length + ' ops: ' + JSON.stringify(ops));
  if (ops.length !== fakeOps.length) {
    throw new Error('EdgeCaseFixture: expected ' + fakeOps.length + ' ops back, got ' + ops.length +
      ' — OperationsJSON cache read did not work as expected');
  }
  Logger.log('EdgeCaseFixture: cache-hit confirmed — getOpsForMo_ (WebApp.gs) returned a non-empty ' +
    'array from OperationsJSON, so getOperationsForOrder never called fetchOperationsForMO_ ' +
    '(that live-SAP fallback only runs when getOpsForMo_ returns []). No SAP call was made.');

  logEvent('TEST_createEdgeCaseFixture', 'EdgeCaseFixture', 'OK', 0,
    'order=' + FIXTURE_ORDER_ID + ' pallet=' + FIXTURE_PALLET_ID + ' ops=' + ops.length);

  Logger.log('EdgeCaseFixture: fixture ready. OrderID=' + FIXTURE_ORDER_ID +
    ' PalletID=' + FIXTURE_PALLET_ID);
}

// ============================================================================
// Delete (cleanup)
// ============================================================================

/**
 * Menu-callable: deletes the ProductionOrders cache row, the PalletMaster
 * row, and every OperationLog row for the fixture (there will be several
 * after testing — one per round/op). try/finally so a partial failure logs
 * clearly which step failed instead of leaving silent orphans.
 */
function TEST_deleteEdgeCaseFixture() {
  var ss = getSpreadsheet_();
  var deletedCounts = { productionOrders: 0, palletMaster: 0, operationLog: 0 };
  var step = 'init';
  try {
    step = 'ProductionOrders';
    var poSheet = ss.getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
    if (poSheet) {
      deletedCounts.productionOrders = _deleteRowsByKey_(
        poSheet, CFG.HEADERS.PRODUCTION_ORDERS, 'ManufacturingOrder', FIXTURE_ORDER_ID, 'ProductionOrders');
    }

    step = 'PalletMaster';
    var pmSheet = ss.getSheetByName(CFG.SHEETS.PALLET_MASTER);
    if (pmSheet) {
      deletedCounts.palletMaster = _deleteRowsByKey_(
        pmSheet, CFG.HEADERS.PALLET_MASTER, 'PalletID', FIXTURE_PALLET_ID, 'PalletMaster');
    }

    step = 'OperationLog';
    var olSheet = ss.getSheetByName(CFG.SHEETS.OPERATION_LOG);
    if (olSheet) {
      deletedCounts.operationLog = _deleteRowsByKey_(
        olSheet, CFG.HEADERS.OPERATION_LOG, 'PalletID', FIXTURE_PALLET_ID, 'OperationLog');
    }

    var total = deletedCounts.productionOrders + deletedCounts.palletMaster + deletedCounts.operationLog;
    Logger.log('EdgeCaseFixture cleanup complete: ProductionOrders=' + deletedCounts.productionOrders +
      ', PalletMaster=' + deletedCounts.palletMaster + ', OperationLog=' + deletedCounts.operationLog +
      ', total=' + total);
    logEvent('TEST_deleteEdgeCaseFixture', 'EdgeCaseFixture', 'OK', 0,
      'po=' + deletedCounts.productionOrders + ' pm=' + deletedCounts.palletMaster +
      ' ol=' + deletedCounts.operationLog);

  } catch (e) {
    Logger.log('EdgeCaseFixture cleanup FAILED at step "' + step + '": ' + e.message +
      ' — rows deleted before failure: ' + JSON.stringify(deletedCounts) +
      ' — Kor must manually check for remaining rows keyed on OrderID=' + FIXTURE_ORDER_ID +
      ' / PalletID=' + FIXTURE_PALLET_ID + ' in the "' + step + '" sheet (and any steps after it).');
    logEvent('TEST_deleteEdgeCaseFixture', 'EdgeCaseFixture', 'ERROR', 0,
      'failed at step ' + step + ': ' + e.message);
    throw e;
  }
}

// ============================================================================
// Shared helper
// ============================================================================

/**
 * Deletes every row in `sheet` whose `keyName` column equals `keyValue`.
 * Iterates bottom-up so deleteRow()'s row-shift never skips a match —
 * needed because OperationLog can have several fixture rows (one per
 * round/op) after a test run.
 * @return {number} rows deleted
 */
function _deleteRowsByKey_(sheet, headers, keyName, keyValue, label) {
  if (sheet.getLastRow() < 2) return 0;
  var keyCol = headers.indexOf(keyName);
  if (keyCol === -1) throw new Error('_deleteRowsByKey_: column "' + keyName + '" not found in ' + label + ' headers');

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var deleted = 0;
  for (var r = data.length - 1; r >= 0; r--) {
    if (String(data[r][keyCol] || '').trim() === keyValue) {
      sheet.deleteRow(r + 2); // +2: 1-indexed + header row
      deleted++;
      Logger.log('EdgeCaseFixture: deleted ' + label + ' row ' + (r + 2) + ' (' + keyName + '=' + keyValue + ')');
    }
  }
  return deleted;
}

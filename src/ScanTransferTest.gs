/**
 * ScanTransferTest.gs — Phase 3.5 Scan-Transfer unit tests
 * ==========================================================
 * Self-contained, self-cleaning tests for scanTransferLookup and
 * scanTransferConfirm (ScanTransfer.gs).
 *
 * All tests:
 *   - Use PL-TEST-ST* / ZZTEST-* fixtures with realistic all-digit batch strings.
 *   - Inject stockFn so no real SAP call is made.
 *   - Force FEATURE_SCAN_TRANSFER to the needed value; restore in finally.
 *   - Self-clean PalletMaster and TransferLog rows in finally.
 *   - Return boolean; runner treats (verdict !== false) as pass.
 *
 * Run: TEST_scanTransfer_runAll() from the Apps Script editor or sheet menu.
 *
 * Reuses globals: PM_SHEET, PM_HEADERS (PalletGen.gs), TL_SHEET (TransferLog.gs),
 *   tlHeaderIdx_, ensureTransferLogSheet_ (TransferLog.gs),
 *   scanTransferLookup, scanTransferConfirm (ScanTransfer.gs),
 *   logEvent (SapClient.gs), getSpreadsheet_ (SheetSetup.gs).
 */

// ============================================================================
// Private test helpers
// ============================================================================

/**
 * Append a PalletMaster fixture row. Batch cell uses text format to preserve
 * leading zeros (appendRow blank → setNumberFormat('@') → setValue).
 * @param {string} palletId
 * @param {string} batch
 * @param {Object} [overrides] optional column-name → value overrides
 * @private
 */
function _seedConfirmedPallet_(palletId, batch, overrides) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(PM_SHEET);
  if (!sh) throw new Error('_seedConfirmedPallet_: PalletMaster sheet missing');

  var base = {
    PalletID:           palletId,
    ManufacturingOrder: 'ZZTEST-MO',
    Material:           'ZZTEST-MAT',
    Batch:              '',
    QtyPerPallet:       5,
    Unit:               'PC',
    WorkCenter:         'WC01',
    StorageLocation:    'PW30',
    ScanStatus:         'CONFIRMED'
  };
  if (overrides) {
    for (var k in overrides) {
      if (overrides.hasOwnProperty(k)) base[k] = overrides[k];
    }
  }

  var row = PM_HEADERS.map(function(h) {
    return base.hasOwnProperty(h) ? base[h] : '';
  });

  sh.appendRow(row);
  var newRowNum = sh.getLastRow();
  var batchIdx  = PM_HEADERS.indexOf('Batch');
  if (batchIdx >= 0) {
    sh.getRange(newRowNum, batchIdx + 1)
      .setNumberFormat('@')
      .setValue(String(batch));
  }
  SpreadsheetApp.flush();
}

/**
 * Delete all PalletMaster rows matching palletId (scan bottom-up).
 * @param {string} palletId
 * @private
 */
function _cleanupPM_(palletId) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  var data = sh.getDataRange().getValues();
  var idx  = tlHeaderIdx_(data[0]);
  var col  = idx['PalletID'];
  if (col === undefined) return;
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][col] || '').trim() === palletId) sh.deleteRow(r + 1);
  }
}

/**
 * Delete all TransferLog rows where ParentPalletID === palletId (scan bottom-up).
 * @param {string} palletId
 * @private
 */
function _cleanupTL_(palletId) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(TL_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  var data = sh.getDataRange().getValues();
  var idx  = tlHeaderIdx_(data[0]);
  var col  = idx['ParentPalletID'];
  if (col === undefined) return;
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][col] || '').trim() === palletId) sh.deleteRow(r + 1);
  }
}

/**
 * Count TransferLog rows where ParentPalletID === palletId AND TxnType === txnType.
 * @param {string} palletId
 * @param {string} txnType
 * @return {number}
 * @private
 */
function _countTLRows_(palletId, txnType) {
  var ss      = getSpreadsheet_();
  var sh      = ss.getSheetByName(TL_SHEET);
  if (!sh || sh.getLastRow() < 2) return 0;
  var data    = sh.getDataRange().getValues();
  var idx     = tlHeaderIdx_(data[0]);
  var ppidCol = idx['ParentPalletID'];
  var typeCol = idx['TxnType'];
  if (ppidCol === undefined) return 0;
  var count = 0;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][ppidCol] || '').trim() === palletId &&
        String(data[r][typeCol] || '').trim() === txnType) {
      count++;
    }
  }
  return count;
}

// ============================================================================
// T1 — feature flag OFF blocks confirm; no TransferLog row created
// ============================================================================

/**
 * Set FEATURE_SCAN_TRANSFER='OFF'. scanTransferConfirm must return ok===false
 * with error that includes 'OFF', and must write zero SCAN_ISSUE rows.
 * @return {boolean}
 */
function TEST_scanTransfer_flagOff() {
  var palletId  = 'PL-TEST-ST1';
  var savedFlag = PropertiesService.getScriptProperties()
                    .getProperty('FEATURE_SCAN_TRANSFER');
  try {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', 'OFF');

    var r    = scanTransferConfirm(palletId, 'PW40');
    var pass = true;

    if (r.ok !== false)
      { pass = false; Logger.log('T1: expected ok===false, got ' + r.ok); }
    if (String(r.error || '').indexOf('OFF') < 0)
      { pass = false; Logger.log('T1: error "' + r.error + '" does not include "OFF"'); }
    if (_countTLRows_(palletId, 'SCAN_ISSUE') !== 0)
      { pass = false; Logger.log('T1: TL row count must be 0, found ' +
          _countTLRows_(palletId, 'SCAN_ISSUE')); }

    return pass;
  } finally {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', savedFlag || 'OFF');
    _cleanupTL_(palletId);
  }
}

// ============================================================================
// T2 — pallet with PRINTED status is rejected by lookup
// ============================================================================

/**
 * Seed a pallet with ScanStatus='PRINTED'. scanTransferLookup must return
 * ok===false with error that mentions 'confirmed' or 'ไม่พบ'.
 * @return {boolean}
 */
function TEST_scanTransfer_notConfirmed() {
  var palletId  = 'PL-TEST-ST2';
  var savedFlag = PropertiesService.getScriptProperties()
                    .getProperty('FEATURE_SCAN_TRANSFER');
  try {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', 'DRY_RUN');
    _seedConfirmedPallet_(palletId, '', { ScanStatus: 'PRINTED' });

    var r      = scanTransferLookup(palletId);
    var pass   = true;
    var errStr = String(r.error || '');

    if (r.ok !== false)
      { pass = false; Logger.log('T2: expected ok===false, got ' + r.ok); }
    if (errStr.indexOf('confirmed') < 0 && errStr.indexOf('ไม่พบ') < 0)
      { pass = false; Logger.log('T2: error "' + errStr + '" does not mention confirmed/ไม่พบ'); }

    return pass;
  } finally {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', savedFlag || 'OFF');
    _cleanupPM_(palletId);
  }
}

// ============================================================================
// T3 — lookup succeeds; batch string with leading zeros is preserved
// ============================================================================

/**
 * Seed a CONFIRMED pallet with all-digit batch. Inject stockFn returning qty 5.
 * scanTransferLookup must return ok===true, batch as string '0000094815',
 * qty===5, sapStock===5, sourceSLoc==='PW30'.
 * @return {boolean}
 */
function TEST_scanTransfer_lookupOk() {
  var palletId  = 'PL-TEST-ST3';
  var batch     = '0000094815';
  var stockFn   = function(mat, plant, sloc, batches) {
    var m = {}; m[batch] = 5; return m;
  };
  var savedFlag = PropertiesService.getScriptProperties()
                    .getProperty('FEATURE_SCAN_TRANSFER');
  try {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', 'DRY_RUN');
    _seedConfirmedPallet_(palletId, batch);

    var r    = scanTransferLookup(palletId, { stockFn: stockFn });
    var pass = true;

    if (r.ok !== true)
      { pass = false; Logger.log('T3: expected ok===true, got ' + r.ok + ' err=' + r.error); }
    if (r.batch !== batch)
      { pass = false; Logger.log('T3: batch "' + r.batch + '" !== "' + batch + '"'); }
    if (typeof r.batch !== 'string')
      { pass = false; Logger.log('T3: batch must be string, got ' + typeof r.batch); }
    if (r.qty !== 5)
      { pass = false; Logger.log('T3: qty ' + r.qty + ' !== 5'); }
    if (r.sapStock !== 5)
      { pass = false; Logger.log('T3: sapStock ' + r.sapStock + ' !== 5'); }
    if (r.sourceSLoc !== 'PW30')
      { pass = false; Logger.log('T3: sourceSLoc "' + r.sourceSLoc + '" !== "PW30"'); }

    return pass;
  } finally {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', savedFlag || 'OFF');
    _cleanupPM_(palletId);
  }
}

// ============================================================================
// T4 — zero SAP stock blocks confirm before row creation
// ============================================================================

/**
 * Inject stockFn returning {} (→ 0). scanTransferConfirm must return
 * ok===false with error including 'stock', and must write zero SCAN_ISSUE rows
 * (the guard fires before row creation).
 * @return {boolean}
 */
function TEST_scanTransfer_stockZeroBlocks() {
  var palletId  = 'PL-TEST-ST4';
  var batch     = '0000094815';
  var stockFn   = function() { return {}; };
  var savedFlag = PropertiesService.getScriptProperties()
                    .getProperty('FEATURE_SCAN_TRANSFER');
  try {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', 'DRY_RUN');
    _seedConfirmedPallet_(palletId, batch);

    var r    = scanTransferConfirm(palletId, 'PW40', { stockFn: stockFn });
    var pass = true;

    if (r.ok !== false)
      { pass = false; Logger.log('T4: expected ok===false, got ' + r.ok); }
    if (String(r.error || '').toLowerCase().indexOf('stock') < 0)
      { pass = false; Logger.log('T4: error "' + r.error + '" does not include "stock"'); }

    var tlCount = _countTLRows_(palletId, 'SCAN_ISSUE');
    if (tlCount !== 0)
      { pass = false; Logger.log('T4: expected 0 TL rows (guard fires pre-create), found ' + tlCount); }

    return pass;
  } finally {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', savedFlag || 'OFF');
    _cleanupPM_(palletId);
    _cleanupTL_(palletId);
  }
}

// ============================================================================
// T5 — DRY_RUN mirrors payload fields; self-cleans seeded TL row
// ============================================================================

/**
 * Seed CONFIRMED pallet, inject stockFn→5. scanTransferConfirm in DRY_RUN must
 * return ok===true, dryRun===true, payloadPreview with correct item-level fields
 * (GoodsMovementType, QuantityInEntryUnit, Batch, StorageLocation,
 * IssuingOrReceivingStorageLoc). After the call, zero SCAN_ISSUE rows must remain
 * (DRY_RUN self-clean).
 * @return {boolean}
 */
function TEST_scanTransfer_dryRunRowMirror() {
  var palletId  = 'PL-TEST-ST5';
  var batch     = '0000094815';
  var stockFn   = function(mat, plant, sloc, batches) {
    var m = {}; m[batch] = 5; return m;
  };
  var savedFlag = PropertiesService.getScriptProperties()
                    .getProperty('FEATURE_SCAN_TRANSFER');
  try {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', 'DRY_RUN');
    _seedConfirmedPallet_(palletId, batch);

    var r    = scanTransferConfirm(palletId, 'PW40', { stockFn: stockFn });
    var pass = true;

    if (r.ok !== true)
      { pass = false; Logger.log('T5: ok !== true, got ' + r.ok + ' err=' + r.error); }
    if (r.dryRun !== true)
      { pass = false; Logger.log('T5: dryRun !== true'); }
    if (!r.payloadPreview)
      { pass = false; Logger.log('T5: payloadPreview missing'); }

    var item = r.payloadPreview &&
               r.payloadPreview.to_MaterialDocumentItem &&
               r.payloadPreview.to_MaterialDocumentItem[0];
    if (!item) {
      pass = false; Logger.log('T5: payloadPreview.to_MaterialDocumentItem[0] missing');
    } else {
      if (item.GoodsMovementType !== '311')
        { pass = false; Logger.log('T5: GoodsMovementType "' + item.GoodsMovementType + '" !== "311"'); }
      if (item.QuantityInEntryUnit !== '5')
        { pass = false; Logger.log('T5: QuantityInEntryUnit "' + item.QuantityInEntryUnit + '" !== "5"'); }
      if (item.Batch !== batch)
        { pass = false; Logger.log('T5: Batch "' + item.Batch + '" !== "' + batch + '"'); }
      if (item.StorageLocation !== 'PW30')
        { pass = false; Logger.log('T5: StorageLocation "' + item.StorageLocation + '" !== "PW30"'); }
      if (item.IssuingOrReceivingStorageLoc !== 'PW40')
        { pass = false; Logger.log('T5: IssuingOrReceivingStorageLoc "' +
            item.IssuingOrReceivingStorageLoc + '" !== "PW40"'); }
    }

    var tlCount = _countTLRows_(palletId, 'SCAN_ISSUE');
    if (tlCount !== 0)
      { pass = false; Logger.log('T5: expected 0 TL rows after DRY_RUN self-clean, found ' + tlCount); }

    return pass;
  } finally {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', savedFlag || 'OFF');
    _cleanupPM_(palletId);
    _cleanupTL_(palletId);
  }
}

// ============================================================================
// T6 — build failure (invalid destSloc) triggers orphan cleanup
// ============================================================================

/**
 * Pass destSloc='PWZZ' (not in CFG.DEST_SLOCS whitelist). buildTransfer311Payload_
 * throws → buildErr path. In DRY_RUN: ok===false, dryRun===true, error mentions
 * build failure. CRITICAL: zero SCAN_ISSUE rows remain (orphan cleaned even on
 * build failure).
 * @return {boolean}
 */
function TEST_scanTransfer_orphanCleanupOnBuildFail() {
  var palletId  = 'PL-TEST-ST6';
  var batch     = '0000094815';
  var stockFn   = function(mat, plant, sloc, batches) {
    var m = {}; m[batch] = 5; return m;
  };
  var savedFlag = PropertiesService.getScriptProperties()
                    .getProperty('FEATURE_SCAN_TRANSFER');
  try {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', 'DRY_RUN');
    _seedConfirmedPallet_(palletId, batch);

    // 'PWZZ' is not in CFG.DEST_SLOCS → buildTransfer311Payload_ throws
    var r    = scanTransferConfirm(palletId, 'PWZZ', { stockFn: stockFn });
    var pass = true;

    if (r.ok !== false)
      { pass = false; Logger.log('T6: expected ok===false, got ' + r.ok); }
    if (r.dryRun !== true)
      { pass = false; Logger.log('T6: expected dryRun===true'); }

    var errStr = String(r.error || '');
    if (errStr.indexOf('build') < 0 && errStr.indexOf('fail') < 0 &&
        errStr.indexOf('PWZZ') < 0)
      { pass = false; Logger.log('T6: error "' + errStr + '" does not mention build failure or PWZZ'); }

    var tlCount = _countTLRows_(palletId, 'SCAN_ISSUE');
    if (tlCount !== 0)
      { pass = false; Logger.log('T6: expected 0 TL rows after orphan cleanup, found ' + tlCount); }

    return pass;
  } finally {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', savedFlag || 'OFF');
    _cleanupPM_(palletId);
    _cleanupTL_(palletId);
  }
}

// ============================================================================
// T7 — double-tap reuses existing SCAN_ISSUE TxnID; DRY_RUN does NOT delete it
// ============================================================================

/**
 * Pre-insert a SCAN_ISSUE TransferLog row with a known TxnID. scanTransferConfirm
 * must reuse that TxnID (not create a new UUID) and must NOT delete the pre-existing
 * row (newRowCreated=false → DRY_RUN self-clean is skipped).
 * @return {boolean}
 */
function TEST_scanTransfer_doubleTapReuse() {
  var palletId       = 'PL-TEST-ST7';
  var batch          = '0000094815';
  var preInsertedId  = 'ZZTEST-DT-REUSE-001';
  var stockFn = function(mat, plant, sloc, batches) {
    var m = {}; m[batch] = 5; return m;
  };
  var savedFlag = PropertiesService.getScriptProperties()
                    .getProperty('FEATURE_SCAN_TRANSFER');
  try {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', 'DRY_RUN');
    _seedConfirmedPallet_(palletId, batch);

    // Pre-insert the SCAN_ISSUE row that double-tap guard will find
    var ss   = getSpreadsheet_();
    var tlSh = ss.getSheetByName(TL_SHEET) || ensureTransferLogSheet_();
    var tlHdr = tlSh.getRange(1, 1, 1, tlSh.getLastColumn()).getValues()[0];
    var tlIdx = tlHeaderIdx_(tlHdr);
    var tlRow = tlHdr.map(function() { return ''; });
    tlRow[tlIdx['TxnID']]          = preInsertedId;
    tlRow[tlIdx['TxnType']]        = 'SCAN_ISSUE';
    tlRow[tlIdx['Status']]         = 'ISSUED';
    tlRow[tlIdx['ParentPalletID']] = palletId;
    tlRow[tlIdx['Material']]       = 'ZZTEST-MAT';
    tlRow[tlIdx['IssueQty']]       = 5;
    tlRow[tlIdx['Unit']]           = 'PC';
    tlRow[tlIdx['SourceSLoc']]     = 'PW30';
    tlSh.appendRow(tlRow);
    SpreadsheetApp.flush();

    var r    = scanTransferConfirm(palletId, 'PW40', { stockFn: stockFn });
    var pass = true;

    // Reuse path: buildTransfer311Payload_ accepts SCAN_ISSUE + valid destSloc → ok===true
    if (r.ok !== true)
      { pass = false; Logger.log('T7: expected ok===true (reuse path), got ' + r.ok + ' err=' + r.error); }

    // Returned txnId must match pre-inserted row (reuse, not a new UUID)
    if (r.txnId !== preInsertedId)
      { pass = false; Logger.log('T7: txnId "' + r.txnId + '" !== preInsertedId "' + preInsertedId + '"'); }

    // DRY_RUN must NOT delete the reused row (newRowCreated=false skips cleanup)
    var afterData    = tlSh.getDataRange().getValues();
    var afterIdx     = tlHeaderIdx_(afterData[0]);
    var txnIdCol     = afterIdx['TxnID'];
    var rowStillExists = false;
    for (var i = 1; i < afterData.length; i++) {
      if (String(afterData[i][txnIdCol] || '').trim() === preInsertedId) {
        rowStillExists = true;
        break;
      }
    }
    if (!rowStillExists)
      { pass = false; Logger.log('T7: pre-inserted row must still exist after DRY_RUN reuse'); }

    return pass;
  } finally {
    PropertiesService.getScriptProperties()
      .setProperty('FEATURE_SCAN_TRANSFER', savedFlag || 'OFF');
    _cleanupPM_(palletId);
    _cleanupTL_(palletId);
  }
}

// ============================================================================
// Runner — TEST_scanTransfer_runAll
// ============================================================================

/**
 * Run all 7 ScanTransfer tests. Logs a summary, shows an alert in the Sheet UI,
 * and logs to EventLog. Returns true if all pass.
 * @return {boolean}
 */
function TEST_scanTransfer_runAll() {
  var tests = [
    { name: 'T1_flagOff',         fn: TEST_scanTransfer_flagOff },
    { name: 'T2_notConfirmed',    fn: TEST_scanTransfer_notConfirmed },
    { name: 'T3_lookupOk',        fn: TEST_scanTransfer_lookupOk },
    { name: 'T4_stockZeroBlocks', fn: TEST_scanTransfer_stockZeroBlocks },
    { name: 'T5_dryRunRowMirror', fn: TEST_scanTransfer_dryRunRowMirror },
    { name: 'T6_orphanCleanup',   fn: TEST_scanTransfer_orphanCleanupOnBuildFail },
    { name: 'T7_doubleTapReuse',  fn: TEST_scanTransfer_doubleTapReuse }
  ];

  var allPass = true;
  var lines   = [];

  tests.forEach(function(t) {
    var verdict;
    try {
      verdict = t.fn();
    } catch (e) {
      verdict = false;
      Logger.log(t.name + ' EXCEPTION: ' + e.message);
    }
    var pass = (verdict !== false);
    if (!pass) allPass = false;
    lines.push((pass ? 'PASS' : 'FAIL') + '  ' + t.name);
  });

  var summary = lines.join('\n');
  var footer  = allPass ? '✓ ALL PASS' : '✗ FAILURES DETECTED';
  Logger.log('=== ScanTransfer Tests ===\n' + summary + '\n' + footer);
  logEvent('TEST', 'TEST_scanTransfer_runAll', allPass ? 'ALL_PASS' : 'FAILURES', 0, summary);

  try {
    SpreadsheetApp.getUi().alert('ScanTransfer Tests\n\n' + summary + '\n\n' + footer);
  } catch (uiErr) { /* headless run — no UI available */ }

  return allPass;
}

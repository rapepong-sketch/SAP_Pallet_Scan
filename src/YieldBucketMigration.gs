/**
 * YieldBucketMigration.gs — Phase 3.5 Gate 2: SCHEMA MIGRATION ONLY
 * ===================================================================
 * Appends 4 yield-bucket columns (GoodQty, RepairQty, DefectQty, AwaitConvQty)
 * to PalletMaster at positions 37-40. Creates a timestamped backup first.
 * Does NOT touch the confirmation builder, SAP payload, or any scan UI.
 */

/** @const {string[]} The 4 new headers, in exact append order. */
var YIELD_COLS_ = ['GoodQty', 'RepairQty', 'DefectQty', 'AwaitConvQty'];

/**
 * Menu-callable wrapper: runs the migration and shows the result in a dialog.
 */
function runYieldBucketMigration() {
  var result = migrateYieldBuckets();
  var json = JSON.stringify(result, null, 2);
  Logger.log(json);
  var escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  var html = HtmlService.createHtmlOutput(
    '<pre style="font-size:12px;white-space:pre-wrap;max-width:100%">' + escaped + '</pre>'
  ).setWidth(800).setHeight(500).setTitle('Yield Bucket Migration');
  SpreadsheetApp.getUi().showModelessDialog(html, 'Yield Bucket Migration — Gate 2');
}

/**
 * Migrate PalletMaster schema: append 4 yield-bucket header columns at positions 37-40.
 * Idempotent — safe to re-run (returns ALREADY_MIGRATED if all 4 exist).
 * @return {Object} JSON-safe result with status, backupSheet, columnsAdded, finalHeaderCount, headerMapSnapshot
 */
function migrateYieldBuckets() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!sh) {
    return logAndReturn_('PRECONDITION_FAILED', { detail: 'PalletMaster sheet not found' });
  }

  // ---- Step 1: Precondition check ----
  var headers = readHeaderRow_(sh);
  var idx = buildHeaderMap_(headers);

  var allExist = YIELD_COLS_.every(function (c) { return idx[c] !== undefined; });
  if (allExist) {
    return logAndReturn_('ALREADY_MIGRATED', {
      detail: 'All 4 yield-bucket columns already present',
      finalHeaderCount: headers.length,
      headerMapSnapshot: idx
    });
  }

  if (headers.length !== 36) {
    return logAndReturn_('PRECONDITION_FAILED', {
      detail: 'Expected 36 headers, found ' + headers.length,
      headerMapSnapshot: idx
    });
  }

  if (headers[35] !== 'OverrideAt') {
    return logAndReturn_('PRECONDITION_FAILED', {
      detail: 'Expected last header "OverrideAt", found "' + headers[35] + '"',
      headerMapSnapshot: idx
    });
  }

  var partial = YIELD_COLS_.filter(function (c) { return idx[c] !== undefined; });
  if (partial.length > 0) {
    return logAndReturn_('PRECONDITION_FAILED', {
      detail: 'Partial migration detected — some yield columns exist but not all: ' + partial.join(', '),
      headerMapSnapshot: idx
    });
  }

  // ---- Step 2: Backup ----
  var tz = 'Asia/Bangkok';
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss');
  var backupName = 'PalletMaster_bak_' + stamp;
  var backupSh = sh.copyTo(ss);
  backupSh.setName(backupName);

  // ---- Step 3: Append 4 header cells at columns 37-40 ----
  sh.getRange(1, 37, 1, 4).setValues([YIELD_COLS_]);

  // ---- Step 4: Postcondition verify ----
  var newHeaders = readHeaderRow_(sh);
  var newIdx = buildHeaderMap_(newHeaders);

  var verified = true;
  var verifyErrors = [];

  if (newHeaders.length !== 40) {
    verified = false;
    verifyErrors.push('Expected 40 headers, found ' + newHeaders.length);
  }

  YIELD_COLS_.forEach(function (col, i) {
    var expectedPos = 36 + i;
    if (newHeaders[expectedPos] !== col) {
      verified = false;
      verifyErrors.push('Position ' + (expectedPos + 1) + ': expected "' + col + '", found "' + (newHeaders[expectedPos] || '(empty)') + '"');
    }
  });

  if (!verified) {
    return logAndReturn_('VERIFY_FAILED', {
      detail: verifyErrors.join('; '),
      backupSheet: backupName,
      finalHeaderCount: newHeaders.length,
      headerMapSnapshot: newIdx
    });
  }

  return logAndReturn_('OK', {
    backupSheet: backupName,
    columnsAdded: YIELD_COLS_,
    finalHeaderCount: 40,
    headerMapSnapshot: newIdx
  });
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read the header row (row 1) from a sheet as trimmed strings.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sh
 * @return {string[]}
 */
function readHeaderRow_(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol === 0) return [];
  return sh.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });
}

/**
 * Build a header-name → 0-based-index map.
 * @param {string[]} headers
 * @return {Object<string,number>}
 */
function buildHeaderMap_(headers) {
  var m = {};
  headers.forEach(function (h, i) { if (h) m[h] = i; });
  return m;
}

/**
 * Log the migration event and return a JSON-safe result object.
 * @param {string} status
 * @param {Object} extra — merged into the returned result
 * @return {Object}
 */
function logAndReturn_(status, extra) {
  var result = Object.assign({ status: status }, extra || {});
  var detail = JSON.stringify({
    status: status,
    backup: extra.backupSheet || null,
    cols: extra.columnsAdded || null,
    hdrCount: extra.finalHeaderCount || null
  });
  logEvent('MIGRATE_YIELD_BUCKETS', 'PalletMaster', status, 0, detail);
  return JSON.parse(JSON.stringify(result));
}

// ============================================================================
// OperationLog schema migration — append RepairQty + AwaitConvQty
// ============================================================================

/** @const {string[]} New columns to append to OperationLog. */
var OL_NEW_COLS_ = ['RepairQty', 'AwaitConvQty'];

/**
 * Menu-callable wrapper for OperationLog migration.
 */
function runOperationLogMigration() {
  var result = migrateOperationLogBuckets();
  var json = JSON.stringify(result, null, 2);
  Logger.log(json);
  var escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  var html = HtmlService.createHtmlOutput(
    '<pre style="font-size:12px;white-space:pre-wrap;max-width:100%">' + escaped + '</pre>'
  ).setWidth(800).setHeight(500).setTitle('OperationLog Migration');
  SpreadsheetApp.getUi().showModelessDialog(html, 'OperationLog Migration — Gate 3');
}

/**
 * Append RepairQty + AwaitConvQty headers to OperationLog.
 * Idempotent — returns ALREADY_MIGRATED if both exist.
 * Backs up OperationLog first.
 * @return {Object} JSON-safe result
 */
function migrateOperationLogBuckets() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(CFG.SHEETS.OPERATION_LOG);
  if (!sh) {
    return olLogAndReturn_('PRECONDITION_FAILED', { detail: 'OperationLog sheet not found' });
  }

  var headers = readHeaderRow_(sh);
  var idx = buildHeaderMap_(headers);

  var allExist = OL_NEW_COLS_.every(function (c) { return idx[c] !== undefined; });
  if (allExist) {
    return olLogAndReturn_('ALREADY_MIGRATED', {
      detail: 'RepairQty + AwaitConvQty already present',
      finalHeaderCount: headers.length,
      headerMapSnapshot: idx
    });
  }

  if (headers[headers.length - 1] !== 'PDTimestamp') {
    return olLogAndReturn_('PRECONDITION_FAILED', {
      detail: 'Expected last header "PDTimestamp", found "' + headers[headers.length - 1] + '"',
      headerMapSnapshot: idx
    });
  }

  var tz = 'Asia/Bangkok';
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss');
  var backupName = 'OperationLog_bak_' + stamp;
  var backupSh = sh.copyTo(ss);
  backupSh.setName(backupName);

  var nextCol = headers.length + 1;
  sh.getRange(1, nextCol, 1, OL_NEW_COLS_.length).setValues([OL_NEW_COLS_]);

  var newHeaders = readHeaderRow_(sh);
  var newIdx = buildHeaderMap_(newHeaders);
  var verified = OL_NEW_COLS_.every(function (c) { return newIdx[c] !== undefined; });

  if (!verified) {
    return olLogAndReturn_('VERIFY_FAILED', {
      detail: 'Post-migration verify failed',
      backupSheet: backupName,
      finalHeaderCount: newHeaders.length,
      headerMapSnapshot: newIdx
    });
  }

  return olLogAndReturn_('OK', {
    backupSheet: backupName,
    columnsAdded: OL_NEW_COLS_,
    finalHeaderCount: newHeaders.length,
    headerMapSnapshot: newIdx
  });
}

/**
 * Log OperationLog migration event and return a JSON-safe result.
 * @param {string} status
 * @param {Object} extra
 * @return {Object}
 */
function olLogAndReturn_(status, extra) {
  var result = Object.assign({ status: status }, extra || {});
  var detail = JSON.stringify({
    status: status,
    backup: extra.backupSheet || null,
    cols: extra.columnsAdded || null,
    hdrCount: extra.finalHeaderCount || null
  });
  logEvent('MIGRATE_OL_BUCKETS', 'OperationLog', status, 0, detail);
  return JSON.parse(JSON.stringify(result));
}

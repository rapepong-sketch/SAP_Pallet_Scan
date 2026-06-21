/**
 * QCInspectorMigration.gs — Phase 4.5 Gate 3a: SCHEMA MIGRATION ONLY
 * ===================================================================
 * Appends QCInspector column to PalletMaster after AwaitConvQty.
 * Backup-first, idempotent, postcondition-verified.
 * Does NOT write QCInspector values — that belongs to Gate 3b.
 *
 * Reuses: CFG (Config.gs), PM_HEADERS (PalletGen.gs),
 *         readHeaderRow_/buildHeaderMap_ (YieldBucketMigration.gs),
 *         logEvent (SapClient.gs)
 */

/**
 * Menu-callable wrapper: runs the migration and shows the result in a dialog.
 */
function runQCInspectorMigration() {
  var result = migrateAddQCInspectorColumn_();
  var json = JSON.stringify(result, null, 2);
  Logger.log(json);
  var escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  var html = HtmlService.createHtmlOutput(
    '<pre style="font-size:12px;white-space:pre-wrap;max-width:100%">' + escaped + '</pre>'
  ).setWidth(800).setHeight(500).setTitle('QCInspector Migration');
  SpreadsheetApp.getUi().showModelessDialog(html, 'QCInspector Migration — Gate 3a');
}

/**
 * Append QCInspector header column to PalletMaster.
 * Idempotent — returns {skipped:true} if already present.
 * Backup-first, backfills data rows, postcondition-verified.
 * @return {Object} JSON-safe {ok, oldCount, newCount, rowsBackfilled} or error
 */
function migrateAddQCInspectorColumn_() {
  var COL_NAME = 'QCInspector';
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!sh) {
    return qciLogAndReturn_('PRECONDITION_FAILED', {
      detail: 'PalletMaster sheet not found'
    });
  }

  logEvent('MIGRATE_QCINSPECTOR', 'PalletMaster', 'START', 0,
    'Beginning QCInspector column migration');

  // ---- Idempotency guard ----
  var headers = readHeaderRow_(sh);
  var idx = buildHeaderMap_(headers);
  var oldCount = headers.length;

  if (idx[COL_NAME] !== undefined) {
    logEvent('MIGRATE_QCINSPECTOR', 'PalletMaster', 'SKIPPED', 0,
      COL_NAME + ' already at index ' + idx[COL_NAME]);
    return JSON.parse(JSON.stringify({
      skipped: true, status: 'ALREADY_MIGRATED',
      detail: COL_NAME + ' already present at index ' + idx[COL_NAME],
      headerCount: oldCount
    }));
  }

  // ---- Precondition: sheet = code - 1 (code already includes QCInspector) ----
  if (oldCount + 1 !== PM_HEADERS.length) {
    return qciLogAndReturn_('PRECONDITION_FAILED', {
      detail: 'Expected sheet to have ' + (PM_HEADERS.length - 1) +
        ' headers (code PM_HEADERS=' + PM_HEADERS.length + '), found ' + oldCount,
      oldCount: oldCount, codeCount: PM_HEADERS.length
    });
  }

  if (headers[oldCount - 1] !== 'AwaitConvQty') {
    return qciLogAndReturn_('PRECONDITION_FAILED', {
      detail: 'Expected last header "AwaitConvQty", found "' + headers[oldCount - 1] + '"'
    });
  }

  // ---- Backup ----
  var tz = 'Asia/Bangkok';
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss');
  var backupName = 'PalletMaster_bak_' + stamp;
  var backupSh = sh.copyTo(ss);
  backupSh.setName(backupName);

  logEvent('MIGRATE_QCINSPECTOR', 'PalletMaster', 'BACKUP', 0,
    JSON.stringify({ backupSheet: backupName, headerSnapshot: headers }));

  // ---- Write header into next empty cell (position derived from sheet) ----
  var newColPos = oldCount + 1;
  sh.getRange(1, newColPos).setValue(COL_NAME);

  // ---- Backfill: set '' for every existing data row ----
  var lastRow = sh.getLastRow();
  var rowsBackfilled = 0;
  if (lastRow >= 2) {
    rowsBackfilled = lastRow - 1;
    var blanks = [];
    for (var r = 0; r < rowsBackfilled; r++) blanks.push(['']);
    sh.getRange(2, newColPos, rowsBackfilled, 1).setValues(blanks);
  }

  // ---- Postcondition verify ----
  var newHeaders = readHeaderRow_(sh);
  var newCount = newHeaders.length;
  var verified = true;
  var verifyErrors = [];

  if (newCount !== oldCount + 1) {
    verified = false;
    verifyErrors.push('Expected ' + (oldCount + 1) + ' headers, found ' + newCount);
  }

  if (newCount !== PM_HEADERS.length) {
    verified = false;
    verifyErrors.push('Header count ' + newCount + ' !== PM_HEADERS count ' + PM_HEADERS.length);
  }

  if (newHeaders[newCount - 1] !== COL_NAME) {
    verified = false;
    verifyErrors.push('Last header is "' + newHeaders[newCount - 1] +
      '", expected "' + COL_NAME + '"');
  }

  var dataRowCount = sh.getLastRow() - 1;
  if (dataRowCount > 0) {
    var newColData = sh.getRange(2, newColPos, dataRowCount, 1).getValues();
    if (newColData.length !== dataRowCount) {
      verified = false;
      verifyErrors.push('Data row check: expected ' + dataRowCount +
        ' rows, got ' + newColData.length);
    }
  }

  if (!verified) {
    return qciLogAndReturn_('VERIFY_FAILED', {
      ok: false, oldCount: oldCount, newCount: newCount,
      rowsBackfilled: rowsBackfilled, errors: verifyErrors,
      backupSheet: backupName
    });
  }

  return qciLogAndReturn_('OK', {
    ok: true, oldCount: oldCount, newCount: newCount,
    rowsBackfilled: rowsBackfilled, backupSheet: backupName,
    columnAdded: COL_NAME
  });
}

/**
 * Log the QCInspector migration event and return a JSON-safe result.
 * @param {string} status
 * @param {Object} extra
 * @return {Object}
 */
function qciLogAndReturn_(status, extra) {
  var result = Object.assign({ status: status }, extra || {});
  var detail = JSON.stringify({
    status: status,
    backup: extra.backupSheet || null,
    col: extra.columnAdded || null,
    hdrCount: extra.newCount || extra.headerCount || null
  });
  logEvent('MIGRATE_QCINSPECTOR', 'PalletMaster', status, 0, detail);
  return JSON.parse(JSON.stringify(result));
}

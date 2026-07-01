/**
 * CumulativeConfirmMigration.gs — Phase 6.5 Gate 2 Part 1: SCHEMA MIGRATION ONLY
 * ==================================================================================
 * Appends CumulativeConfirmedQty + ConfirmRound columns to PalletMaster after
 * QCInspector. Backup-first, idempotent, postcondition-verified — same pattern
 * as QCInspectorMigration.gs.
 *
 * Does NOT populate values for existing rows — see backfillCumulativeColumns_()
 * below for the separate, manually-triggered value backfill. Both steps are
 * menu-only; neither runs automatically.
 *
 * Reuses: CFG (Config.gs), PM_HEADERS (PalletGen.gs),
 *         readHeaderRow_/buildHeaderMap_ (YieldBucketMigration.gs),
 *         logEvent (SapClient.gs)
 */

// ============================================================================
// Column migration — adds the two new headers (no value writes to data rows
// beyond blanking the new cells, same as every prior PalletMaster migration)
// ============================================================================

/** Menu-callable wrapper: runs the column migration and shows the result. */
function runCumulativeColumnsMigration() {
  var result = migrateAddCumulativeColumns_();
  var json = JSON.stringify(result, null, 2);
  Logger.log(json);
  var escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  var html = HtmlService.createHtmlOutput(
    '<pre style="font-size:12px;white-space:pre-wrap;max-width:100%">' + escaped + '</pre>'
  ).setWidth(800).setHeight(500).setTitle('Cumulative Confirm Columns Migration');
  SpreadsheetApp.getUi().showModelessDialog(html, 'Cumulative Confirm Columns Migration — Gate 2 Part 1');
}

/**
 * Append CumulativeConfirmedQty + ConfirmRound header columns to PalletMaster.
 * Idempotent — returns {skipped:true} if already present.
 * Backup-first, blanks new cells for existing rows, postcondition-verified.
 * @return {Object} JSON-safe {ok, oldCount, newCount, rowsBackfilled} or error
 */
function migrateAddCumulativeColumns_() {
  var NEW_COLS = ['CumulativeConfirmedQty', 'ConfirmRound'];
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!sh) {
    return ccmLogAndReturn_('PRECONDITION_FAILED', { detail: 'PalletMaster sheet not found' });
  }

  logEvent('MIGRATE_CUMULATIVE_CONFIRM', 'PalletMaster', 'START', 0,
    'Beginning CumulativeConfirmedQty/ConfirmRound column migration');

  // ---- Idempotency guard ----
  var headers = readHeaderRow_(sh);
  var idx = buildHeaderMap_(headers);
  var oldCount = headers.length;

  var missing = NEW_COLS.filter(function (c) { return idx[c] === undefined; });
  if (missing.length === 0) {
    logEvent('MIGRATE_CUMULATIVE_CONFIRM', 'PalletMaster', 'SKIPPED', 0,
      NEW_COLS.join(',') + ' already present');
    return JSON.parse(JSON.stringify({
      skipped: true, status: 'ALREADY_MIGRATED',
      detail: NEW_COLS.join(', ') + ' already present',
      headerCount: oldCount
    }));
  }
  if (missing.length !== NEW_COLS.length) {
    return ccmLogAndReturn_('PRECONDITION_FAILED', {
      detail: 'Partial migration state — only some columns present: missing=[' +
        missing.join(',') + '] found=[' + NEW_COLS.filter(function (c) { return idx[c] !== undefined; }).join(',') + ']'
    });
  }

  // ---- Precondition: sheet = code - 2 (code already includes both new cols) ----
  if (oldCount + NEW_COLS.length !== PM_HEADERS.length) {
    return ccmLogAndReturn_('PRECONDITION_FAILED', {
      detail: 'Expected sheet to have ' + (PM_HEADERS.length - NEW_COLS.length) +
        ' headers (code PM_HEADERS=' + PM_HEADERS.length + '), found ' + oldCount,
      oldCount: oldCount, codeCount: PM_HEADERS.length
    });
  }

  if (headers[oldCount - 1] !== 'QCInspector') {
    return ccmLogAndReturn_('PRECONDITION_FAILED', {
      detail: 'Expected last header "QCInspector", found "' + headers[oldCount - 1] + '"'
    });
  }

  // ---- Backup ----
  var tz = 'Asia/Bangkok';
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss');
  var backupName = 'PalletMaster_bak_' + stamp;
  var backupSh = sh.copyTo(ss);
  backupSh.setName(backupName);

  logEvent('MIGRATE_CUMULATIVE_CONFIRM', 'PalletMaster', 'BACKUP', 0,
    JSON.stringify({ backupSheet: backupName, headerSnapshot: headers }));

  // ---- Write headers into next empty cells ----
  sh.getRange(1, oldCount + 1, 1, NEW_COLS.length).setValues([NEW_COLS]);

  // ---- Blank new cells for every existing data row ----
  var lastRow = sh.getLastRow();
  var rowsBackfilled = 0;
  if (lastRow >= 2) {
    rowsBackfilled = lastRow - 1;
    var blanks = [];
    for (var r = 0; r < rowsBackfilled; r++) blanks.push(['', '']);
    sh.getRange(2, oldCount + 1, rowsBackfilled, NEW_COLS.length).setValues(blanks);
  }

  // ---- Postcondition verify ----
  var newHeaders = readHeaderRow_(sh);
  var newCount = newHeaders.length;
  var verified = true;
  var verifyErrors = [];

  if (newCount !== oldCount + NEW_COLS.length) {
    verified = false;
    verifyErrors.push('Expected ' + (oldCount + NEW_COLS.length) + ' headers, found ' + newCount);
  }
  if (newCount !== PM_HEADERS.length) {
    verified = false;
    verifyErrors.push('Header count ' + newCount + ' !== PM_HEADERS count ' + PM_HEADERS.length);
  }
  NEW_COLS.forEach(function (c, i) {
    if (newHeaders[oldCount + i] !== c) {
      verified = false;
      verifyErrors.push('Header at index ' + (oldCount + i) + ' is "' + newHeaders[oldCount + i] +
        '", expected "' + c + '"');
    }
  });

  if (!verified) {
    return ccmLogAndReturn_('VERIFY_FAILED', {
      ok: false, oldCount: oldCount, newCount: newCount,
      rowsBackfilled: rowsBackfilled, errors: verifyErrors,
      backupSheet: backupName
    });
  }

  return ccmLogAndReturn_('OK', {
    ok: true, oldCount: oldCount, newCount: newCount,
    rowsBackfilled: rowsBackfilled, backupSheet: backupName,
    columnsAdded: NEW_COLS
  });
}

function ccmLogAndReturn_(status, extra) {
  var result = Object.assign({ status: status }, extra || {});
  var detail = JSON.stringify({
    status: status,
    backup: extra.backupSheet || null,
    cols: extra.columnsAdded || null,
    hdrCount: extra.newCount || extra.headerCount || null
  });
  logEvent('MIGRATE_CUMULATIVE_CONFIRM', 'PalletMaster', status, 0, detail);
  return JSON.parse(JSON.stringify(result));
}

// ============================================================================
// Value backfill — treats pre-existing single-shot confirmations as
// "round 1, done". Manual menu item only — never runs automatically.
// ============================================================================

/** Menu-callable wrapper: runs the backfill and shows the result. */
function runBackfillCumulativeColumns() {
  var result = backfillCumulativeColumns_();
  var json = JSON.stringify(result, null, 2);
  Logger.log(json);
  var escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  var html = HtmlService.createHtmlOutput(
    '<pre style="font-size:12px;white-space:pre-wrap;max-width:100%">' + escaped + '</pre>'
  ).setWidth(800).setHeight(500).setTitle('Backfill Cumulative Columns');
  SpreadsheetApp.getUi().showModelessDialog(html, 'Backfill Cumulative Columns — Gate 2 Part 1');
}

/**
 * One-time value backfill for CumulativeConfirmedQty/ConfirmRound.
 * For every PalletMaster row with ScanStatus='CONFIRMED' and a blank
 * CumulativeConfirmedQty: sets CumulativeConfirmedQty=QtyPerPallet,
 * ConfirmRound=1 (treats the pre-existing single-shot confirmation as
 * "round 1, done"). Rows that are not CONFIRMED are left blank (0 rounds
 * so far) — untouched. Logs every row touched.
 * Requires migrateAddCumulativeColumns_() to have already run (columns
 * must exist) — returns PRECONDITION_FAILED otherwise.
 * @return {Object} JSON-safe {status, rowsTouched, rowsSkipped, touched: string[]}
 */
function backfillCumulativeColumns_() {
  var sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!sh || sh.getLastRow() < 2) {
    return bccLogAndReturn_('PRECONDITION_FAILED', { detail: 'PalletMaster empty or missing' });
  }

  var headers = readHeaderRow_(sh);
  var idx = buildHeaderMap_(headers);
  if (idx['CumulativeConfirmedQty'] === undefined || idx['ConfirmRound'] === undefined) {
    return bccLogAndReturn_('PRECONDITION_FAILED', {
      detail: 'CumulativeConfirmedQty/ConfirmRound columns not found — ' +
        'run "Migrate: Add Cumulative Confirm Columns" first'
    });
  }

  var data = sh.getDataRange().getValues();
  var touched = [];
  var skipped = 0;

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var palletId  = String(row[idx['PalletID']] || '').trim();
    var scanStatus = String(row[idx['ScanStatus']] || '').trim();
    var existingCum = row[idx['CumulativeConfirmedQty']];
    var isBlank = existingCum === '' || existingCum === null || existingCum === undefined;

    if (scanStatus === 'CONFIRMED' && isBlank) {
      var qty = Number(row[idx['QtyPerPallet']]) || 0;
      var rowNum = r + 1;
      sh.getRange(rowNum, idx['CumulativeConfirmedQty'] + 1).setValue(qty);
      sh.getRange(rowNum, idx['ConfirmRound'] + 1).setValue(1);
      touched.push(palletId + ' (qty=' + qty + ')');
      logEvent('BACKFILL_CUMULATIVE_CONFIRM', 'PalletMaster', 'ROW_TOUCHED', 0,
        palletId + ' CumulativeConfirmedQty=' + qty + ' ConfirmRound=1');
    } else {
      skipped++;
    }
  }

  return bccLogAndReturn_('OK', {
    ok: true, rowsTouched: touched.length, rowsSkipped: skipped, touched: touched
  });
}

function bccLogAndReturn_(status, extra) {
  var result = Object.assign({ status: status }, extra || {});
  var detail = JSON.stringify({
    status: status,
    touched: extra.rowsTouched || 0,
    skipped: extra.rowsSkipped || 0
  });
  logEvent('BACKFILL_CUMULATIVE_CONFIRM', 'PalletMaster', status, 0, detail);
  return JSON.parse(JSON.stringify(result));
}

/**
 * Cleanup20260704.gs — One-time manual-run utility (no phase, not part of
 * the phased rollout)
 * ============================================================================
 * Removes a fixed list of stale backup sheets (PalletMaster, OperationLog,
 * ProductionOrders, and MachineMaster snapshots named with a "_bak_" or
 * "_BACKUP_" suffix) and two leftover ZZTEST-UNKNOWN-001 DeadLetter test
 * rows. Verifies every target exists and the DeadLetter row count matches
 * exactly 2 before deleting anything; aborts with no writes if either check
 * fails.
 *
 * Not wired into any menu — run manually from the Apps Script editor.
 */

function ONE_TIME_cleanup20260704_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var targetSheets = [
    'PalletMaster_BACKUP_20260617_1156',
    'PalletMaster_BACKUP_20260617_1212',
    'PalletMaster_bak_20260619_125137',
    'PalletMaster_bak_20260621_093347',
    'OperationLog_bak_20260621_102254',
    'OperationLog_bak_20260621_112055',
    'PalletMaster_bak_20260621_152631',
    'PalletMaster_bak_20260621_152651',
    'ProductionOrders_bak_20260621_160123',
    'PalletMaster_bak_20260621_205646',
    'MachineMaster_bak_20260623_095946',
    'OperationLog_bak_20260623_141015'
  ];

  Logger.log('=== VERIFY PHASE (no writes yet) ===');
  var found = [], missing = [];
  targetSheets.forEach(function(name) {
    var sh = ss.getSheetByName(name);
    if (sh) found.push(name + ' (' + sh.getLastRow() + ' rows)');
    else missing.push(name);
  });
  Logger.log('Found sheets (' + found.length + '/12): ' + JSON.stringify(found));
  Logger.log('Missing sheets: ' + JSON.stringify(missing));

  var dlSh = ss.getSheetByName('DeadLetter');
  var dlData = dlSh.getDataRange().getValues();
  var dlHdr = dlData[0];
  var dlIdx = {};
  dlHdr.forEach(function(h, i) { dlIdx[String(h).trim()] = i; });
  var dlRowsToDelete = [];
  for (var r = 1; r < dlData.length; r++) {
    var pid = String(dlData[r][dlIdx['PalletID']] || '').trim();
    if (pid === 'ZZTEST-UNKNOWN-001') {
      dlRowsToDelete.push({ rowNum: r + 1, dlid: dlData[r][dlIdx['DLID']] });
    }
  }
  Logger.log('DeadLetter test rows found: ' + JSON.stringify(dlRowsToDelete));

  if (missing.length > 0) {
    Logger.log('⚠️ ABORTING — ' + missing.length + ' target sheet(s) not found live. ' +
      'Not deleting anything. Review missing list above before re-running.');
    return;
  }
  if (dlRowsToDelete.length !== 2) {
    Logger.log('⚠️ ABORTING — expected exactly 2 DeadLetter test rows, found ' +
      dlRowsToDelete.length + '. Not deleting anything. Review before re-running.');
    return;
  }

  Logger.log('=== All checks passed. Proceeding to delete. ===');

  targetSheets.forEach(function(name) {
    ss.deleteSheet(ss.getSheetByName(name));
    Logger.log('Deleted sheet: ' + name);
  });

  // delete DeadLetter rows bottom-up so row numbers stay valid
  dlRowsToDelete.sort(function(a, b) { return b.rowNum - a.rowNum; });
  dlRowsToDelete.forEach(function(row) {
    dlSh.deleteRow(row.rowNum);
    Logger.log('Deleted DeadLetter row ' + row.rowNum + ' (DLID=' + row.dlid + ')');
  });

  Logger.log('=== Cleanup complete: ' + targetSheets.length + ' sheets + ' +
    dlRowsToDelete.length + ' DeadLetter rows removed. ===');
}

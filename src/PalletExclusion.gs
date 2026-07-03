/**
 * PalletExclusion.gs — Phase 3.5 Gate 6: Admin Pallet Exclusion
 * ================================================================================
 * Lets an admin flag a PalletMaster row as EXCLUDED so it no longer surfaces
 * in listConfirmablePallets() / listOverrideCandidates(), and closes out any
 * OPEN DeadLetter rows for that PalletID as RESOLVED_EXCLUDED so they stop
 * being actionable retries. Re-including a pallet clears the PalletMaster
 * flag but deliberately leaves DeadLetter history untouched — RESOLVED_EXCLUDED
 * rows are a permanent audit trail, never reopened.
 *
 * No SAP call is made anywhere in this file — every write here is local Sheet
 * bookkeeping, so the project's DRY_RUN gate (which guards SAP POST/PATCH
 * calls) does not apply.
 *
 * All PalletMaster writes go through updatePalletScanFields_() — never a raw
 * setValue on an arbitrary column. DeadLetter writes use direct Range access,
 * mirroring the pattern already used by replayDeadLetter_() (Confirmation.gs),
 * since there is no shared updateDeadLetterFields_ helper in this codebase.
 *
 * Reuses:
 *  - lookupPalletById_() / updatePalletScanFields_()  (PalletSheet.gs)
 *  - PM_SHEET                                          (PalletGen.gs)
 *  - DL_SHEET_ / DL_HEADERS_                            (Confirmation.gs)
 *  - getSpreadsheet_()                                  (SheetSetup.gs)
 *  - logEvent()                                         (SapClient.gs)
 *
 * NOT wired up yet (deliberately out of scope for this TEST-ONLY phase):
 *  - No google.script.run-facing wrapper / web UI.
 *  - No isAdminUser_() gate inside excludePallet_/includePallet_ themselves —
 *    the menu wrappers (SheetSetup.gs) are the only current entry points and
 *    rely on Sheet-level sharing permissions for access control.
 */

/**
 * Find all OPEN DeadLetter rows for a given PalletID. Read-only helper —
 * never writes. Handles a missing/empty DeadLetter sheet or missing columns
 * gracefully by returning an empty array.
 * @param {string} palletId
 * @return {number[]} 1-based sheet row numbers (header row never included)
 */
function findOpenDeadLetterRowsByPalletId_(palletId) {
  var pid = String(palletId || '').trim();
  if (!pid) return [];

  var sh = getSpreadsheet_().getSheetByName(DL_SHEET_);
  if (!sh || sh.getLastRow() < 2) return [];

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  if (idx['PalletID'] === undefined || idx['ReplayStatus'] === undefined) return [];

  var rows = [];
  for (var r = 1; r < data.length; r++) {
    var rowPid    = String(data[r][idx['PalletID']] || '').trim();
    var rowStatus = String(data[r][idx['ReplayStatus']] || '').trim();
    if (rowPid === pid && rowStatus === 'OPEN') {
      rows.push(r + 1); // 1-based sheet row number
    }
  }
  return rows;
}

/**
 * Mark a pallet EXCLUDED: stamps ExclusionStatus/ExclusionReason/ExcludedAt/
 * ExcludedBy on its PalletMaster row, then resolves any OPEN DeadLetter rows
 * for the same PalletID as RESOLVED_EXCLUDED (appending a ReplayNote rather
 * than overwriting any existing note). DeadLetter resolution is best-effort:
 * a failure there is logged but does NOT fail the overall exclusion — the
 * PalletMaster flag is the source of truth that listConfirmablePallets() /
 * listOverrideCandidates() filter on.
 *
 * @param {string} palletId
 * @param {string} reason — free-text exclusion justification
 * @param {string} actor — email/name of the excluding admin
 * @return {{success:boolean, message?:string, palletId?:string,
 *   deadLetterRowsResolved?:number}} plain JSON-serializable object only
 */
function excludePallet_(palletId, reason, actor) {
  var pid = String(palletId || '').trim();
  if (!pid) {
    return { success: false, message: 'PalletID is required' };
  }

  var pallet = lookupPalletById_(pid);
  if (!pallet) {
    return { success: false, message: 'Pallet not found: ' + pid };
  }

  updatePalletScanFields_(pid, {
    ExclusionStatus: 'EXCLUDED',
    ExclusionReason: String(reason || ''),
    ExcludedAt:      new Date().toISOString(),
    ExcludedBy:      String(actor || '')
  });

  var deadLetterRowsResolved = 0;
  try {
    var dlSh = getSpreadsheet_().getSheetByName(DL_SHEET_);
    if (dlSh && dlSh.getLastRow() >= 2) {
      var dlHdr = dlSh.getRange(1, 1, 1, dlSh.getLastColumn()).getValues()[0];
      var dlIdx = {};
      dlHdr.forEach(function(h, i) { dlIdx[String(h).trim()] = i; });

      if (dlIdx['ReplayStatus'] !== undefined && dlIdx['ReplayNote'] !== undefined) {
        var rowNums = findOpenDeadLetterRowsByPalletId_(pid);
        for (var i = 0; i < rowNums.length; i++) {
          var rowNum = rowNums[i];
          dlSh.getRange(rowNum, dlIdx['ReplayStatus'] + 1).setValue('RESOLVED_EXCLUDED');

          var noteCell     = dlSh.getRange(rowNum, dlIdx['ReplayNote'] + 1);
          var existingNote = String(noteCell.getValue() || '').trim();
          var newNote      = 'Excluded: ' + String(reason || '');
          noteCell.setValue(existingNote ? existingNote + ' | ' + newNote : newNote);

          deadLetterRowsResolved++;
        }
      }
    }
  } catch (e) {
    logEvent('PALLET_EXCLUDE', 'DEADLETTER_RESOLVE_ERR', pid + ' ' + e.message);
  }

  logEvent('PALLET_EXCLUDE', 'OK', JSON.stringify({
    palletId: pid, reason: reason, actor: actor,
    deadLetterRowsResolved: deadLetterRowsResolved
  }));

  return { success: true, palletId: pid, deadLetterRowsResolved: deadLetterRowsResolved };
}

/**
 * READ-ONLY diagnostic: re-runs the exact filter listOverrideCandidates()
 * (WebApp.gs) applies to PalletMaster — ScanStatus/ConfirmationGroup/
 * QCStatus/QCResult/PL-TEST- prefix/ExclusionStatus/FinalOperation-cache —
 * but WITHOUT its `if (pallets.length >= 50) break;` cap, so it can answer
 * "how many rows actually qualify, uncapped, and would the 50-row cap ever
 * cut off a specific PalletID?" Does not call listOverrideCandidates()
 * itself (kept as a hand-maintained parallel copy, not a shared helper, so
 * this diagnostic can never accidentally change production behavior) and
 * performs no writes anywhere — only Logger.log + a summary ui.alert().
 * @return {void}
 */
function MENU_diagOverrideCandidateCap() {
  var ui = SpreadsheetApp.getUi();
  var TARGET_PID = 'PL-ZZEXCL-B1-L01';

  Logger.log('══════════════════════════════════════════════════════');
  Logger.log('MENU_diagOverrideCandidateCap — READ-ONLY, mirrors listOverrideCandidates() filter, no 50-row cap');
  Logger.log('══════════════════════════════════════════════════════');

  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    Logger.log('PalletMaster empty or missing.');
    ui.alert('MENU_diagOverrideCandidateCap\n\nPalletMaster sheet empty or missing.');
    return;
  }

  var lastRow = sh.getLastRow();
  Logger.log('PalletMaster getLastRow(): ' + lastRow + ' (data rows = ' + (lastRow - 1) + ')');

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var required = ['PalletID', 'ManufacturingOrder', 'Material', 'MaterialName',
                  'Batch', 'QtyPerPallet', 'Unit', 'WorkCenter',
                  'ScanStatus', 'QCStatus', 'QCResult', 'ConfirmationGroup'];
  for (var k = 0; k < required.length; k++) {
    if (idx[required[k]] === undefined) {
      Logger.log('ABORT: missing column ' + required[k]);
      ui.alert('MENU_diagOverrideCandidateCap\n\n❌ Missing column: ' + required[k]);
      return;
    }
  }

  // MO -> FinalOperation lookup — identical to listOverrideCandidates()
  var foMap = {};
  var poSh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  if (poSh && poSh.getLastRow() >= 2) {
    var poData = poSh.getDataRange().getValues();
    var poHdr  = poData[0];
    var poMoCol = poHdr.indexOf('ManufacturingOrder');
    var poFoCol = poHdr.indexOf('FinalOperation');
    if (poMoCol !== -1 && poFoCol !== -1) {
      for (var p = 1; p < poData.length; p++) {
        var poMoKey = _normMo_(poData[p][poMoCol]);
        var poFo = String(poData[p][poFoCol] || '').trim();
        if (poMoKey) foMap[poMoKey] = poFo;
      }
    }
  }

  var qualifyingCount        = 0;
  var targetFound            = false;
  var targetRowIndex         = null; // 1-based sheet row number
  var qualifyingBeforeTarget = 0;

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (String(row[idx['ScanStatus']] || '').trim() === 'CONFIRMED') continue;
    if (String(row[idx['ConfirmationGroup']] || '').trim() !== '') continue;
    if (String(row[idx['QCStatus']] || '').trim() !== 'INSPECTED') continue;
    if (String(row[idx['QCResult']] || '').trim() !== 'PASS') continue;
    var pid = String(row[idx['PalletID']] || '').trim();
    if (/^PL-TEST-/i.test(pid)) continue;
    if (idx['ExclusionStatus'] !== undefined &&
      String(row[idx['ExclusionStatus']] || '').trim() === 'EXCLUDED') continue;

    var mo = _normMo_(row[idx['ManufacturingOrder']]);
    if (!foMap.hasOwnProperty(mo) || !foMap[mo]) continue;

    // Row qualifies as an override candidate — no `>= 50 break` here, so every
    // qualifying row in the sheet is counted, not just the first 50.
    qualifyingCount++;

    if (pid === TARGET_PID) {
      targetFound            = true;
      targetRowIndex          = r + 1; // 1-based sheet row number
      qualifyingBeforeTarget  = qualifyingCount - 1; // rank excludes itself
    }
  }

  Logger.log('');
  Logger.log('Total qualifying override-candidate rows (uncapped): ' + qualifyingCount);
  Logger.log('listOverrideCandidates() 50-row cap would actually return: ' + Math.min(qualifyingCount, 50));
  Logger.log('');
  if (targetFound) {
    Logger.log(TARGET_PID + ' found at sheet row ' + targetRowIndex +
      ' — qualifying rows before it: ' + qualifyingBeforeTarget);
    Logger.log(TARGET_PID + ' would be ' +
      (qualifyingBeforeTarget < 50 ? 'INCLUDED in' : 'CUT OFF by') + ' the 50-row cap.');
  } else {
    Logger.log(TARGET_PID + ' NOT FOUND among qualifying rows (absent from sheet, or present but filtered out by one of the checks above).');
  }
  Logger.log('══════════════════════════════════════════════════════');

  var alertLines = [
    'MENU_diagOverrideCandidateCap (READ-ONLY)',
    '',
    'PalletMaster getLastRow(): ' + lastRow + '  (data rows: ' + (lastRow - 1) + ')',
    'Qualifying override candidates (uncapped): ' + qualifyingCount,
    '50-row cap would actually return: ' + Math.min(qualifyingCount, 50),
    '',
    targetFound
      ? (TARGET_PID + ': sheet row ' + targetRowIndex + ', ' + qualifyingBeforeTarget +
         ' qualifying row(s) before it — ' +
         (qualifyingBeforeTarget < 50 ? '✅ within cap' : '❌ CUT OFF by cap'))
      : (TARGET_PID + ': not found among qualifying rows'),
    '',
    'Full detail in Executions log (View → Executions, or Apps Script editor).'
  ];
  ui.alert(alertLines.join('\n'));
}

/**
 * Clear a pallet's exclusion flag. Does NOT touch DeadLetter rows — any
 * RESOLVED_EXCLUDED rows remain as permanent audit history.
 *
 * @param {string} palletId
 * @param {string} actor — email/name of the including admin
 * @return {{success:boolean, message?:string, palletId?:string}} plain
 *   JSON-serializable object only
 */
function includePallet_(palletId, actor) {
  var pid = String(palletId || '').trim();
  if (!pid) {
    return { success: false, message: 'PalletID is required' };
  }

  var pallet = lookupPalletById_(pid);
  if (!pallet) {
    return { success: false, message: 'Pallet not found: ' + pid };
  }

  updatePalletScanFields_(pid, {
    ExclusionStatus: '',
    ExclusionReason: '',
    ExcludedAt:      '',
    ExcludedBy:      ''
  });

  logEvent('PALLET_INCLUDE', 'OK', JSON.stringify({ palletId: pid, actor: actor }));

  return { success: true, palletId: pid };
}

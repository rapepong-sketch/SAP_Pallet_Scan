/**
 * Phase 3.5 — One-time manual cleanup utility (2026-07-05)
 * Purpose: exclude the 4 pallets tied to orphaned MOs 1000034813 and
 * 1000035032 (never synced / no longer exist in ProductionOrders),
 * matching the exact verify-then-write pattern of Cleanup20260704.gs.
 * Manual-run only — not wired into any menu.
 */

function ONE_TIME_excludeOrphanedMoPallets20260705_() {
  var TARGET_PALLETS = [
    'PL-1000034813-L01',
    'PL-1000034813-L02',
    'PL-1000035032-L01',
    'PL-1000035032-L02'
  ];
  var EXPECTED_ORPHANED_MOS = ['1000034813', '1000035032'];

  Logger.log('=== VERIFY PHASE (no writes yet) ===');

  // ---- 1. Confirm each target pallet exists, capture current state ----
  var pmSh = getSpreadsheet_().getSheetByName(PM_SHEET);
  var pmData = pmSh.getDataRange().getValues();
  var pmHdr = pmData[0];
  var pmIdx = {};
  pmHdr.forEach(function(h, i) { pmIdx[String(h).trim()] = i; });

  var found = {};
  var missing = [];
  TARGET_PALLETS.forEach(function(pid) {
    var row = null;
    for (var r = 1; r < pmData.length; r++) {
      if (String(pmData[r][pmIdx['PalletID']] || '').trim() === pid) {
        row = pmData[r];
        break;
      }
    }
    if (!row) { missing.push(pid); return; }
    found[pid] = {
      mo: String(row[pmIdx['ManufacturingOrder']] || '').trim(),
      scanStatus: String(row[pmIdx['ScanStatus']] || '').trim(),
      exclusionStatus: pmIdx['ExclusionStatus'] !== undefined
        ? String(row[pmIdx['ExclusionStatus']] || '').trim() : '',
      batch: String(row[pmIdx['Batch']] || '').trim(),
      grDoc: String(row[pmIdx['GRMaterialDocument']] || '').trim()
    };
  });

  Logger.log('Found: ' + JSON.stringify(found));
  Logger.log('Missing: ' + JSON.stringify(missing));

  if (missing.length > 0) {
    Logger.log('⚠️ ABORTING — ' + missing.length + ' target pallet(s) not found live. ' +
      'Not excluding anything. Review missing list above before re-running.');
    return;
  }

  // ---- 2. Re-verify each pallet's MO is still NOT in ProductionOrders ----
  var poSh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  var poData = poSh.getDataRange().getValues();
  var poHdr = poData[0];
  var poMoCol = poHdr.indexOf('ManufacturingOrder');
  var poMoSet = {};
  for (var p = 1; p < poData.length; p++) {
    var poMoKey = _normMo_(poData[p][poMoCol]);
    if (poMoKey) poMoSet[poMoKey] = true;
  }

  var unexpectedlyFound = [];
  TARGET_PALLETS.forEach(function(pid) {
    var moKey = _normMo_(found[pid].mo);
    if (poMoSet[moKey]) unexpectedlyFound.push(pid + ' (MO ' + found[pid].mo + ')');
  });

  if (unexpectedlyFound.length > 0) {
    Logger.log('⚠️ ABORTING — these pallets\' MOs now EXIST in ProductionOrders ' +
      '(no longer orphaned, may have been synced since the last check): ' +
      JSON.stringify(unexpectedlyFound) + '. Not excluding anything.');
    return;
  }

  // ---- 3. Re-verify none are already EXCLUDED, CONFIRMED, or otherwise unexpected ----
  var badState = [];
  TARGET_PALLETS.forEach(function(pid) {
    var f = found[pid];
    if (f.exclusionStatus === 'EXCLUDED') badState.push(pid + ' already EXCLUDED');
    if (f.scanStatus === 'CONFIRMED') badState.push(pid + ' already CONFIRMED');
    if (f.batch) badState.push(pid + ' has a Batch value (' + f.batch + ') — unexpected');
    if (f.grDoc) badState.push(pid + ' has a GRMaterialDocument (' + f.grDoc + ') — unexpected');
  });

  if (badState.length > 0) {
    Logger.log('⚠️ ABORTING — unexpected state found: ' + JSON.stringify(badState) +
      '. Not excluding anything. Review before re-running.');
    return;
  }

  Logger.log('=== All checks passed. Proceeding to exclude. ===');

  // ---- 4. Exclude each pallet via the existing mechanism (audit trail) ----
  var actor = getActiveUserSafe_();
  var results = [];
  TARGET_PALLETS.forEach(function(pid) {
    var mo = found[pid].mo;
    var reason = 'MO ' + mo + ' not found in ProductionOrders (orphaned, ' +
      'never synced/no longer exists in SAP) — early testing-period pallet, ' +
      'cannot ever be confirmed. Verified via probeExclusionCriteria/' +
      'probeCreationBurst diagnostics 2026-07-05.';
    var res = excludePallet_(pid, reason, actor);
    results.push({ palletId: pid, result: res });
    Logger.log('Excluded ' + pid + ': ' + JSON.stringify(res));
  });

  Logger.log('=== Exclusion complete: ' + results.length + ' pallets processed. ===');
  Logger.log('Summary: ' + JSON.stringify(results));
}

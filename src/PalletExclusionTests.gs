/**
 * PalletExclusionTests.gs — Phase 3.5 Gate 6: self-cleaning test suite for
 * PalletExclusion.gs (excludePallet_, includePallet_,
 * findOpenDeadLetterRowsByPalletId_) plus the additive ExclusionStatus
 * filters in listConfirmablePallets() (Confirmation.gs) and
 * listOverrideCandidates() (WebApp.gs).
 * ================================================================================
 * Fixture PalletIDs use the 'PL-ZZEXCL-' prefix, NOT 'PL-TEST-' — both
 * listConfirmablePallets() and listOverrideCandidates() hard-skip any
 * PL-TEST-* row (see Confirmation.gs:674 / WebApp.gs:868), which would make
 * every "appears in listing" assertion below unconditionally fail regardless
 * of the exclusion feature. 'PL-ZZEXCL-' mirrors the same escape-hatch
 * convention already used by TEST_replayDeadLetterWriteback_'s 'PL-ZZDLWB-'
 * fixtures.
 *
 * Run from the Apps Script editor:
 *   TEST_palletExclusion_()          — this suite alone
 *   TEST_palletExclusion_runAll()    — this suite + TEST_replayDeadLetterWriteback_
 *                                       regression, reported side by side
 */

/**
 * Self-cleaning test for the Phase 3.5 Gate 6 pallet-exclusion feature.
 * Each sub-assertion returns its own pass/fail boolean (hardened false-green
 * pattern) — a thrown exception is caught and also counted as FAIL, but no
 * assertion relies on "didn't throw" alone as a pass signal.
 * @return {boolean} true only if every assertion passed
 */
function TEST_palletExclusion_() {
  var fn = 'TEST_palletExclusion_';
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
  var pmHdr = pmSh.getRange(1, 1, 1, pmSh.getLastColumn()).getValues()[0];
  var pmIdx = {};
  pmHdr.forEach(function(h, i) { pmIdx[String(h).trim()] = i; });

  var dlSh = ensureDeadLetterSheet_();
  var dlIdx = {};
  dlSh.getRange(1, 1, 1, dlSh.getLastColumn()).getValues()[0]
    .forEach(function(h, i) { dlIdx[String(h).trim()] = i; });

  var poSh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  var poHdr = poSh.getRange(1, 1, 1, poSh.getLastColumn()).getValues()[0];
  var poIdx = {};
  poHdr.forEach(function(h, i) { poIdx[String(h).trim()] = i; });

  var PID_A  = 'PL-ZZEXCL-A1-L01'; // listConfirmablePallets() + DeadLetter fixture
  var PID_B  = 'PL-ZZEXCL-B1-L01'; // listOverrideCandidates() fixture
  var MO_A   = '0000098001';       // all-digit — avoids leading-zero coercion gotcha
  var MO_B   = '0000098002';
  var BATCH  = '0000012345';

  // ---- fixture builders ----
  function setDigitCell_(sh, row, col, value) {
    var range = sh.getRange(row, col);
    range.setNumberFormat('@');
    SpreadsheetApp.flush();
    range.setValue(String(value));
  }

  function seedConfirmableRow(pid, mo) {
    var row = new Array(pmHdr.length).fill('');
    row[pmIdx['PalletID']]           = pid;
    row[pmIdx['Material']]           = 'ZZTEST-MAT';
    row[pmIdx['QtyPerPallet']]       = 50;
    row[pmIdx['Unit']]               = 'PC';
    row[pmIdx['WorkCenter']]         = '0100-01';
    row[pmIdx['PalletSeq']]          = 1;
    row[pmIdx['ScanStatus']]         = 'QC_COMPLETE';
    pmSh.appendRow(row);
    SpreadsheetApp.flush();
    var newRow = pmSh.getLastRow();
    setDigitCell_(pmSh, newRow, pmIdx['ManufacturingOrder'] + 1, mo);
    setDigitCell_(pmSh, newRow, pmIdx['Batch'] + 1, BATCH);
  }

  function seedOverrideCandidateRow(pid, mo) {
    var row = new Array(pmHdr.length).fill('');
    row[pmIdx['PalletID']]          = pid;
    row[pmIdx['Material']]          = 'ZZTEST-MAT';
    row[pmIdx['MaterialName']]      = 'ZZ Test Material';
    row[pmIdx['QtyPerPallet']]      = 50;
    row[pmIdx['Unit']]              = 'PC';
    row[pmIdx['WorkCenter']]        = '0100-01';
    row[pmIdx['ScanStatus']]        = 'SCANNED';
    row[pmIdx['QCStatus']]          = 'INSPECTED';
    row[pmIdx['QCResult']]          = 'PASS';
    row[pmIdx['ConfirmationGroup']] = '';
    pmSh.appendRow(row);
    SpreadsheetApp.flush();
    var newRow = pmSh.getLastRow();
    setDigitCell_(pmSh, newRow, pmIdx['ManufacturingOrder'] + 1, mo);
    setDigitCell_(pmSh, newRow, pmIdx['Batch'] + 1, BATCH);
  }

  function seedProductionOrderFinalOp(mo, finalOp) {
    var row = new Array(poHdr.length).fill('');
    poSh.appendRow(row);
    SpreadsheetApp.flush();
    var newRow = poSh.getLastRow();
    setDigitCell_(poSh, newRow, poIdx['ManufacturingOrder'] + 1, mo);
    setDigitCell_(poSh, newRow, poIdx['FinalOperation'] + 1, finalOp);
  }

  function seedDlRow(pid, mo) {
    captureDeadLetter_({
      path: 'CONFIRM', palletId: pid, mo: mo, paddedMO: mo,
      outcome: 'UNKNOWN_STATE', attempts: 3, lastErrorClass: 'TIMEOUT_UNKNOWN',
      lastErrorMsg: 'TEST_palletExclusion_ fixture',
      payload: { OrderID: mo, ConfirmationText: pid }, token: pid
    });
    SpreadsheetApp.flush();
  }

  function findsInListConfirmable(pid) {
    return listConfirmablePallets().some(function(p) { return p.PalletID === pid; });
  }

  function findsInOverrideCandidates(pid) {
    var res = listOverrideCandidates();
    if (!res.success) return false;
    return res.pallets.some(function(p) { return p.PalletID === pid; });
  }

  function readDlStatuses(pid) {
    var data = dlSh.getDataRange().getValues();
    var out = [];
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][dlIdx['PalletID']] || '').trim() === pid) {
        out.push(String(data[r][dlIdx['ReplayStatus']] || '').trim());
      }
    }
    return out;
  }

  try {
    // ---- (b)(c) fixture A — filter-shape matches listConfirmablePallets() ----
    seedConfirmableRow(PID_A, MO_A);
    assert('(c) fixture A appears in listConfirmablePallets() before exclusion',
      findsInListConfirmable(PID_A));

    // ---- (d) exclude fixture A ----
    var exResultA1 = excludePallet_(PID_A, 'TEST reason A', 'TEST_runner');
    assert('(d) excludePallet_ on fixture A returns success:true',
      exResultA1 && exResultA1.success === true, JSON.stringify(exResultA1));

    // ---- (e) fixture A disappears ----
    assert('(e) fixture A absent from listConfirmablePallets() after exclusion',
      !findsInListConfirmable(PID_A));

    // ---- (f) fixture B — filter-shape matches listOverrideCandidates() ----
    seedProductionOrderFinalOp(MO_B, '0040');
    seedOverrideCandidateRow(PID_B, MO_B);

    assert('(f-before) fixture B appears in listOverrideCandidates() before exclusion',
      findsInOverrideCandidates(PID_B));

    var exResultB = excludePallet_(PID_B, 'TEST reason B', 'TEST_runner');
    assert('(f) excludePallet_ on fixture B returns success:true',
      exResultB && exResultB.success === true, JSON.stringify(exResultB));

    assert('(f-after) fixture B absent from listOverrideCandidates() after exclusion',
      !findsInOverrideCandidates(PID_B));

    // ---- (g) 2 OPEN DeadLetter rows for fixture A, resolved by a second exclude call ----
    seedDlRow(PID_A, MO_A);
    seedDlRow(PID_A, MO_A);
    var preStatusesA = readDlStatuses(PID_A);
    assert('(g-pre) 2 OPEN DeadLetter rows seeded for fixture A',
      preStatusesA.length === 2 && preStatusesA.every(function(s) { return s === 'OPEN'; }),
      JSON.stringify(preStatusesA));

    var exResultA2 = excludePallet_(PID_A, 'TEST reason A retry', 'TEST_runner');
    assert('(g) excludePallet_ returns deadLetterRowsResolved === 2',
      exResultA2 && exResultA2.deadLetterRowsResolved === 2, JSON.stringify(exResultA2));

    var postStatusesA = readDlStatuses(PID_A);
    assert('(g) both DeadLetter rows now RESOLVED_EXCLUDED',
      postStatusesA.length === 2 && postStatusesA.every(function(s) { return s === 'RESOLVED_EXCLUDED'; }),
      JSON.stringify(postStatusesA));

    // ---- (h) include fixture A ----
    var inResultA = includePallet_(PID_A, 'TEST_runner');
    assert('(h) includePallet_ returns success:true',
      inResultA && inResultA.success === true, JSON.stringify(inResultA));

    assert('(h) fixture A reappears in listConfirmablePallets() after include',
      findsInListConfirmable(PID_A));

    // ---- (i) DeadLetter history for fixture A untouched by includePallet_ ----
    var finalStatusesA = readDlStatuses(PID_A);
    assert('(i) fixture A DeadLetter rows remain RESOLVED_EXCLUDED after includePallet_',
      finalStatusesA.length === 2 && finalStatusesA.every(function(s) { return s === 'RESOLVED_EXCLUDED'; }),
      JSON.stringify(finalStatusesA));

  } catch (ex) {
    pass = false;
    Logger.log('❌ EXCEPTION: ' + ex.message);
  } finally {
    // ---- (k) cleanup: remove all fixture rows regardless of pass/fail ----
    var pmCleanup = pmSh.getDataRange().getValues();
    for (var pr = pmCleanup.length - 1; pr >= 1; pr--) {
      if (/^PL-ZZEXCL-/i.test(String(pmCleanup[pr][pmIdx['PalletID']] || '').trim())) {
        pmSh.deleteRow(pr + 1);
      }
    }
    var dlCleanup = dlSh.getDataRange().getValues();
    for (var dr = dlCleanup.length - 1; dr >= 1; dr--) {
      if (/^PL-ZZEXCL-/i.test(String(dlCleanup[dr][dlIdx['PalletID']] || '').trim())) {
        dlSh.deleteRow(dr + 1);
      }
    }
    var poCleanup = poSh.getDataRange().getValues();
    for (var por = poCleanup.length - 1; por >= 1; por--) {
      if (String(poCleanup[por][poIdx['ManufacturingOrder']] || '').trim() === MO_B) {
        poSh.deleteRow(por + 1);
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

  logEvent(fn, 'PalletExclusion', pass ? 'PASS' : 'FAIL', elapsed, results.length + ' assertions');

  return pass;
}

/**
 * (l) Runner: executes the new pallet-exclusion suite plus the existing
 * DeadLetter replay-writeback regression suite (Confirmation.gs) side by
 * side, to confirm the new RESOLVED_EXCLUDED ReplayStatus value does not
 * interfere with the existing replay path — which only ever reads/writes
 * OPEN / REPLAYED_HEALED / REPLAYED_OK and is otherwise unmodified.
 * @return {boolean} true only if BOTH suites pass
 */
function TEST_palletExclusion_runAll() {
  Logger.log('');
  Logger.log('════════════════════════════════════════════════════');
  Logger.log(' TEST_palletExclusion_runAll — combined regression run');
  Logger.log('════════════════════════════════════════════════════');

  var exclusionPass = TEST_palletExclusion_();
  var replayPass     = TEST_replayDeadLetterWriteback_();

  Logger.log('');
  Logger.log('════════════════════════════════════════════════════');
  Logger.log(' SUMMARY');
  Logger.log('  TEST_palletExclusion_():           ' + (exclusionPass ? '✅ PASS' : '❌ FAIL'));
  Logger.log('  TEST_replayDeadLetterWriteback_(): ' + (replayPass ? '✅ PASS (33 assertions)' : '❌ FAIL'));
  Logger.log('════════════════════════════════════════════════════');

  return exclusionPass && replayPass;
}

/**
 * READ-ONLY diagnostic: prints the PalletMaster exclusion fields for a
 * given PalletID verbatim, plus every EventLog row whose Function is
 * PALLET_EXCLUDE/PALLET_INCLUDE AND whose row text mentions that PalletID
 * (most recent first). Scans the full row rather than one fixed column,
 * since excludePallet_()/includePallet_() call logEvent(fn, endpoint, ...)
 * with only 3 args against its 5-arg signature (fn, endpoint, status,
 * responseTimeMs, note) — the JSON payload containing the PalletID lands
 * in the sheet's Status column, not a dedicated "detail" column, so a
 * fixed-column search would be fragile. No writes anywhere.
 * @param {string} palletId — defaults to 'PL-1000036127-L02' if omitted
 * @return {void}
 */
function TEST_readExclusionAudit_(palletId) {
  var pid = String(palletId || 'PL-1000036127-L02').trim();

  Logger.log('══════════════════════════════════════════════════════');
  Logger.log('TEST_readExclusionAudit_ — READ-ONLY, PalletID = ' + pid);
  Logger.log('══════════════════════════════════════════════════════');

  // ---- PalletMaster row ----
  var pmSh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!pmSh || pmSh.getLastRow() < 2) {
    Logger.log('PalletMaster sheet empty or missing.');
  } else {
    var pmData = pmSh.getDataRange().getValues();
    var pmHdr  = pmData[0];
    var pmIdx  = {};
    pmHdr.forEach(function(h, i) { pmIdx[String(h).trim()] = i; });

    var found = null;
    for (var r = 1; r < pmData.length; r++) {
      if (String(pmData[r][pmIdx['PalletID']] || '').trim() === pid) {
        found = pmData[r];
        break;
      }
    }

    if (!found) {
      Logger.log('PalletMaster: PalletID not found: ' + pid);
    } else {
      ['ExclusionStatus', 'ExclusionReason', 'ExcludedAt', 'ExcludedBy'].forEach(function(col) {
        var present = pmIdx[col] !== undefined;
        Logger.log(col + ' = ' + (present ? JSON.stringify(found[pmIdx[col]]) : '(column not found)'));
      });
    }
  }

  // ---- EventLog rows ----
  Logger.log('');
  Logger.log('EventLog matches (PALLET_EXCLUDE / PALLET_INCLUDE mentioning ' + pid + '), most recent first:');
  var elSh = getSpreadsheet_().getSheetByName(CFG.SHEETS.EVENT_LOG);
  if (!elSh || elSh.getLastRow() < 2) {
    Logger.log('EventLog sheet empty or missing.');
  } else {
    var elData = elSh.getDataRange().getValues();
    var elHdr  = elData[0];
    var fnIdx  = elHdr.indexOf('Function');
    var matches = [];
    for (var er = 1; er < elData.length; er++) {
      var row = elData[er];
      var fnVal = fnIdx !== -1 ? String(row[fnIdx] || '').trim() : '';
      if (fnVal !== 'PALLET_EXCLUDE' && fnVal !== 'PALLET_INCLUDE') continue;
      var rowText = row.join(' | ');
      if (rowText.indexOf(pid) === -1) continue;
      matches.push({ rowNum: er + 1, row: row });
    }
    matches.reverse(); // most recent first
    if (matches.length === 0) {
      Logger.log('(none found)');
    } else {
      matches.forEach(function(m) {
        Logger.log('Row ' + m.rowNum + ': ' + JSON.stringify(elHdr) + ' = ' + JSON.stringify(m.row));
      });
    }
  }

  Logger.log('══════════════════════════════════════════════════════');
}

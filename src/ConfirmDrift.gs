/**
 * ConfirmDrift.gs — Phase 5 Sprint 1 item 4: daily confirm-drift check
 * ======================================================================
 * READ-ONLY against SAP (GET only). No POST. No SAP writes.
 * Detects PalletMaster↔SAP divergence for recently CONFIRMED pallets.
 *
 * Reuses: sapReadbackConfirmation_(palletId) (Confirmation.gs),
 *         sendLarkText_ (LarkNotify.gs), getSpreadsheet_ (SheetSetup.gs),
 *         logEvent (SapClient.gs)
 */

var CD_SHEET_ = 'ConfirmDrift';
var CD_WINDOW_DAYS_ = 3;

var CD_HEADERS_ = [
  'RanAt', 'Scanned', 'OK', 'DriftACount', 'IndeterminateCount',
  'DriftAPalletIDs', 'Note'
];

// ============================================================================
// Core scan
// ============================================================================

/**
 * Scan recently CONFIRMED pallets (last 3 days) and verify each exists in SAP
 * via sapReadbackConfirmation_. Returns a JSON-safe summary.
 *
 * @param {Object} [testOverrides] — { readbackFn, larkFn } for mocking
 * @return {{ scanned:number, ok:number,
 *   driftA:Array<{palletId:string, mo:string, confirmedAt:string}>,
 *   indeterminate:Array<{palletId:string, mo:string, error:string}>,
 *   ranAt:string }}
 */
function runConfirmDriftDaily(testOverrides) {
  var _readback = (testOverrides && testOverrides.readbackFn) || sapReadbackConfirmation_;
  var _lark     = (testOverrides && testOverrides.larkFn)     || _driftSendLark_;
  var _snapshot = (testOverrides && testOverrides.snapshotFn) || _driftWriteSnapshot_;

  var ranAt = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - CD_WINDOW_DAYS_);

  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    var empty = { scanned: 0, ok: 0, driftA: [], indeterminate: [], ranAt: ranAt };
    logEvent('CONFIRM_DRIFT', 'RUN', 'OK', 0, 'scanned=0 (PM empty)');
    return empty;
  }

  var data = sh.getDataRange().getValues();
  var idx = {};
  data[0].forEach(function(h, i) { idx[String(h).trim()] = i; });

  var candidates = [];
  for (var r = 1; r < data.length; r++) {
    var ss_ = String(data[r][idx['ScanStatus']] || '').trim();
    if (ss_ !== 'CONFIRMED') continue;
    var pid = String(data[r][idx['PalletID']] || '').trim();
    if (/^PL-TEST-/i.test(pid)) continue;

    var ca = data[r][idx['ConfirmedAt']];
    var caDate = (ca instanceof Date) ? ca : null;
    if (!caDate) {
      try { caDate = new Date(ca); } catch (_) {}
      if (!caDate || isNaN(caDate.getTime())) caDate = null;
    }
    if (caDate && caDate.getTime() < cutoff.getTime()) continue;

    candidates.push({
      palletId: pid,
      mo: String(data[r][idx['ManufacturingOrder']] || '').trim(),
      confirmedAt: caDate
        ? Utilities.formatDate(caDate, 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss')
        : String(ca || '')
    });
  }

  var okCount = 0;
  var driftA = [];
  var indeterminate = [];

  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    var rb = _readback(c.palletId);

    if (rb.found) {
      okCount++;
    } else if (rb.error) {
      indeterminate.push({ palletId: c.palletId, mo: c.mo, error: rb.error });
    } else {
      driftA.push({ palletId: c.palletId, mo: c.mo, confirmedAt: c.confirmedAt });
    }
  }

  var summary = {
    scanned: candidates.length,
    ok: okCount,
    driftA: driftA,
    indeterminate: indeterminate,
    ranAt: ranAt
  };

  logEvent('CONFIRM_DRIFT', 'RUN', 'OK', 0,
    'scanned=' + summary.scanned + ' ok=' + okCount +
    ' driftA=' + driftA.length + ' indet=' + indeterminate.length);

  _snapshot(summary);

  if (driftA.length > 0) {
    _lark(summary);
  }

  return JSON.parse(JSON.stringify(summary));
}

// ============================================================================
// Snapshot sheet
// ============================================================================

function _ensureConfirmDriftSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(CD_SHEET_);
  if (sh) return sh;
  sh = ss.insertSheet(CD_SHEET_);
  sh.getRange(1, 1, 1, CD_HEADERS_.length)
    .setValues([CD_HEADERS_])
    .setFontWeight('bold')
    .setBackground('#0b5394')
    .setFontColor('#ffffff');
  sh.setFrozenRows(1);
  return sh;
}

function _driftWriteSnapshot_(summary) {
  try {
    var sh = _ensureConfirmDriftSheet_();
    var palletIds = summary.driftA.map(function(d) { return d.palletId; });
    var note = summary.indeterminate.length > 0
      ? 'indeterminate: ' + summary.indeterminate.map(function(d) { return d.palletId; }).join(',')
      : '';
    var row = CD_HEADERS_.map(function(h) {
      switch (h) {
        case 'RanAt':               return summary.ranAt;
        case 'Scanned':             return summary.scanned;
        case 'OK':                  return summary.ok;
        case 'DriftACount':         return summary.driftA.length;
        case 'IndeterminateCount':  return summary.indeterminate.length;
        case 'DriftAPalletIDs':     return palletIds.join(', ');
        case 'Note':               return note.slice(0, 500);
        default: return '';
      }
    });
    sh.appendRow(row);
  } catch (e) {
    logEvent('CONFIRM_DRIFT', 'SNAPSHOT_ERROR', e.message);
  }
}

// ============================================================================
// Lark alert
// ============================================================================

function _driftSendLark_(summary) {
  try {
    var lines = [];
    lines.push('⚠ Confirm Drift — ' + summary.driftA.length + ' พาเลท CONFIRMED แต่ไม่พบใน SAP');
    lines.push('RanAt: ' + summary.ranAt);
    lines.push('Scanned: ' + summary.scanned + '  OK: ' + summary.ok + '  Drift: ' + summary.driftA.length);
    lines.push('');

    var show = summary.driftA.slice(0, 15);
    show.forEach(function(d) {
      lines.push('  ' + d.palletId + '  MO=' + d.mo + '  ConfAt=' + d.confirmedAt);
    });
    if (summary.driftA.length > 15) {
      lines.push('  ... และอีก ' + (summary.driftA.length - 15) + ' รายการ');
    }

    if (summary.indeterminate.length > 0) {
      lines.push('');
      lines.push('(Indeterminate: ' + summary.indeterminate.length + ' — readback error, ไม่ใช่ drift)');
    }

    lines.push('');
    lines.push('ตรวจ SAP ว่า confirmation หาย/ถูก reverse หรือ post ไม่ติด — อาจต้อง re-confirm หรือเช็ค DeadLetter');

    sendLarkText_(lines.join('\n'));
  } catch (e) {
    logEvent('CONFIRM_DRIFT', 'LARK_FAIL', e.message);
  }
}

// ============================================================================
// Daily trigger
// ============================================================================

function installConfirmDriftTrigger() {
  var ui = SpreadsheetApp.getUi();
  if (!isAdminUser_()) { ui.alert('admin เท่านั้น'); return; }

  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'confirmDriftTriggerHandler_') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('confirmDriftTriggerHandler_')
    .timeBased()
    .atHour(18)
    .nearMinute(30)
    .everyDays(1)
    .inTimezone('Asia/Bangkok')
    .create();

  ui.alert('ตั้ง Confirm Drift trigger 18:30 ทุกวันแล้ว');
  logEvent('CONFIRM_DRIFT', 'TRIGGER', 'INSTALLED', 0, '18:30 daily');
}

function uninstallConfirmDriftTrigger() {
  var ui = SpreadsheetApp.getUi();
  if (!isAdminUser_()) { ui.alert('admin เท่านั้น'); return; }

  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'confirmDriftTriggerHandler_') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }

  ui.alert(removed ? 'ลบ trigger แล้ว (' + removed + ')' : 'ไม่พบ trigger');
  logEvent('CONFIRM_DRIFT', 'TRIGGER', 'REMOVED', 0, 'removed=' + removed);
}

function confirmDriftTriggerHandler_() {
  try {
    runConfirmDriftDaily();
    logEvent('CONFIRM_DRIFT', 'TRIGGER_RUN', 'OK', 0, 'auto');
  } catch (e) {
    logEvent('CONFIRM_DRIFT', 'TRIGGER_RUN', 'ERROR', 0, String(e));
  }
}

// ============================================================================
// TEST
// ============================================================================

/**
 * Mock-based test for runConfirmDriftDaily. No real SAP calls or Lark sends.
 * Seeds CONFIRMED test pallets, mocks readback, checks classification + snapshot.
 */
function TEST_confirmDriftDaily() {
  var fn = 'TEST_confirmDriftDaily';
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
  }

  // ---- Seed test pallets ----
  var sh = getSheet_(PM_SHEET);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var now = new Date();
  var fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

  var seeds = [
    { PalletID: 'PL-TEST-DRIFT-OK',   ScanStatus: 'CONFIRMED', ConfirmedAt: now, ManufacturingOrder: 'ZZTEST-001' },
    { PalletID: 'PL-TEST-DRIFT-MISS', ScanStatus: 'CONFIRMED', ConfirmedAt: now, ManufacturingOrder: 'ZZTEST-002' },
    { PalletID: 'PL-TEST-DRIFT-ERR',  ScanStatus: 'CONFIRMED', ConfirmedAt: now, ManufacturingOrder: 'ZZTEST-003' },
    { PalletID: 'PL-TEST-DRIFT-OLD',  ScanStatus: 'CONFIRMED', ConfirmedAt: fiveDaysAgo, ManufacturingOrder: 'ZZTEST-004' }
  ];

  var seedRows = seeds.map(function(s) {
    return hdr.map(function(h) {
      return s.hasOwnProperty(h) ? s[h] : '';
    });
  });
  sh.getRange(sh.getLastRow() + 1, 1, seedRows.length, hdr.length).setValues(seedRows);
  SpreadsheetApp.flush();
  Logger.log('Seeded ' + seeds.length + ' test pallets');

  var larkCalls = 0;
  var snapshotCalls = 0;
  var lastSnapshot = null;

  try {
    var summary = runConfirmDriftDaily({
      readbackFn: function(pid) {
        if (pid === 'PL-TEST-DRIFT-OK')   return { found: true, confirmationGroup: 'G1', confirmationCount: '1', confirmationText: pid };
        if (pid === 'PL-TEST-DRIFT-MISS') return { found: false };
        if (pid === 'PL-TEST-DRIFT-ERR')  return { found: false, error: 'HTTP 500 test' };
        return sapReadbackConfirmation_(pid);
      },
      larkFn: function() { larkCalls++; },
      snapshotFn: function(s) { snapshotCalls++; lastSnapshot = s; }
    });

    // ---- Assertions ----
    assert('(1) driftA has exactly the missing pallet',
      summary.driftA.length === 1 && summary.driftA[0].palletId === 'PL-TEST-DRIFT-MISS',
      'driftA=' + JSON.stringify(summary.driftA));

    assert('(2) indeterminate has exactly the error pallet',
      summary.indeterminate.length === 1 && summary.indeterminate[0].palletId === 'PL-TEST-DRIFT-ERR',
      'indet=' + JSON.stringify(summary.indeterminate));

    assert('(3) indeterminate NOT in driftA',
      summary.driftA.every(function(d) { return d.palletId !== 'PL-TEST-DRIFT-ERR'; }),
      'checked');

    assert('(4) old pallet excluded from scan',
      !summary.driftA.some(function(d) { return d.palletId === 'PL-TEST-DRIFT-OLD'; }) &&
      !summary.indeterminate.some(function(d) { return d.palletId === 'PL-TEST-DRIFT-OLD'; }),
      'scanned=' + summary.scanned);

    assert('(5) Lark called (driftA > 0)',
      larkCalls === 1,
      'larkCalls=' + larkCalls);

    assert('(6) snapshot written',
      snapshotCalls === 1,
      'snapshotCalls=' + snapshotCalls);

    assert('(7) summary JSON-safe (no Date objects)',
      typeof summary.ranAt === 'string' &&
      summary.driftA.every(function(d) { return typeof d.confirmedAt === 'string'; }),
      'ranAt type=' + typeof summary.ranAt);

    // ---- (8) Test all-OK → no Lark ----
    var larkCalls2 = 0;
    runConfirmDriftDaily({
      readbackFn: function() { return { found: true, confirmationGroup: 'G', confirmationCount: '1', confirmationText: 'x' }; },
      larkFn: function() { larkCalls2++; },
      snapshotFn: function() {}
    });
    assert('(8) no Lark when driftA=0',
      larkCalls2 === 0,
      'larkCalls=' + larkCalls2);

  } finally {
    // ---- Cleanup ----
    var freshData = sh.getDataRange().getValues();
    var pidCol = idx['PalletID'];
    for (var d = freshData.length - 1; d >= 1; d--) {
      if (/^PL-TEST-DRIFT-/i.test(String(freshData[d][pidCol] || '').trim())) {
        sh.deleteRow(d + 1);
      }
    }
    Logger.log('Cleaned up PL-TEST-DRIFT-* rows');
  }

  var elapsed = Date.now() - t0;
  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  Logger.log(fn + ': ' + (pass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name);
  });
  Logger.log('──────────────────────────────────────────');

  logEvent('TEST_CONFIRM_DRIFT', 'ConfirmDrift', pass ? 'PASS' : 'FAIL', elapsed,
    results.length + ' assertions');
}

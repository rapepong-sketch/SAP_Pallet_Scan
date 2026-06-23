/**
 * MachineMaster.gs — Machine Capture Gate M1 (read-only helper)
 * ==============================================================
 * Phase Machine Capture — read-only helper for the MachineMaster sheet.
 * Sheet pre-imported: MachineCode | MachineName | SAPWorkCenter | Department | Active | Notes
 *
 * NOT wired into any scanner/report path yet — pure read for M2+.
 * Reuses: getSpreadsheet_ (SheetSetup.gs), logEvent (SapClient.gs)
 */

var MCH_SHEET = 'MachineMaster';
var _machineMasterCache_ = null;

// ============================================================================
// SAPWorkCenter normalizer — Sheets coerces 'NNNN-NN' to Date on import
// ============================================================================

function _normSapWc_(val) {
  if (val instanceof Date) {
    var y = val.getFullYear();
    var m = val.getMonth() + 1;
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0');
  }
  if (typeof val === 'number') {
    return String(val);
  }
  return String(val == null ? '' : val).trim();
}

// ============================================================================
// Sheet format fix — convert SAPWorkCenter column from Date back to text
// ============================================================================

/**
 * One-time idempotent fix: set SAPWorkCenter column to plain-text format '@',
 * rewrite Date/number values as their display-value strings.
 * Creates a timestamped backup before any change. Run from Editor.
 */
function fixMachineMasterSapWcFormat_() {
  var sh = getSpreadsheet_().getSheetByName(MCH_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    Logger.log('MachineMaster sheet not found or empty');
    return { status: 'SKIP', detail: 'no data' };
  }

  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var wcCol = idx['SAPWorkCenter'];
  if (wcCol === undefined) {
    Logger.log('SAPWorkCenter column not found');
    return { status: 'ERROR', detail: 'SAPWorkCenter column missing' };
  }

  // ── Backup ──
  var ss = getSpreadsheet_();
  var stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss');
  var backupName = 'MachineMaster_bak_' + stamp;
  sh.copyTo(ss).setName(backupName);
  Logger.log('Backup: ' + backupName);

  // ── Probe: log raw vs display BEFORE format change ──
  var dataRange = sh.getRange(2, wcCol + 1, lastRow - 1, 1);
  var rawVals  = dataRange.getValues();
  var dispVals = dataRange.getDisplayValues();

  Logger.log('');
  Logger.log('PROBE — SAPWorkCenter (first 10 rows):');
  var probeCount = Math.min(10, rawVals.length);
  var dateCount = 0;
  for (var p = 0; p < probeCount; p++) {
    var raw  = rawVals[p][0];
    var disp = dispVals[p][0];
    var isDate = raw instanceof Date;
    if (isDate) dateCount++;
    Logger.log('  row ' + (p + 2) +
      ': raw=' + JSON.stringify(String(raw)) +
      ' typeof=' + typeof raw +
      ' isDate=' + isDate +
      ' display="' + disp + '"' +
      ' norm="' + _normSapWc_(raw) + '"');
  }
  Logger.log('Date cells in probe: ' + dateCount + '/' + probeCount);

  // ── Set number format to plain text ──
  dataRange.setNumberFormat('@');

  // ── Rewrite cells: use display value for Date/number, else keep string ──
  var newVals = [];
  var fixCount = 0;
  for (var i = 0; i < rawVals.length; i++) {
    var raw  = rawVals[i][0];
    var disp = String(dispVals[i][0] || '').trim();

    if (raw instanceof Date || typeof raw === 'number') {
      var resolved = /^\d{4}-\d{2}/.test(disp) ? disp : _normSapWc_(raw);
      newVals.push([resolved]);
      fixCount++;
    } else {
      newVals.push([String(raw == null ? '' : raw).trim()]);
    }
  }
  dataRange.setValues(newVals);
  SpreadsheetApp.flush();

  // ── Postcondition: every cell is now typeof string ──
  var verifyVals = dataRange.getValues();
  var failRows = [];
  for (var v = 0; v < verifyVals.length; v++) {
    if (typeof verifyVals[v][0] !== 'string') {
      failRows.push(v + 2);
    }
  }

  var result = {
    status:    failRows.length === 0 ? 'OK' : 'PARTIAL',
    backup:    backupName,
    fixed:     fixCount,
    total:     rawVals.length,
    allString: failRows.length === 0,
    failRows:  failRows
  };
  Logger.log('');
  Logger.log('Result: ' + JSON.stringify(result));
  logEvent('MCH_WC_FORMAT_FIX', MCH_SHEET, result.status, 0,
    'fixed=' + fixCount + '/' + rawVals.length + ' backup=' + backupName);
  return result;
}

// ============================================================================
// Read API
// ============================================================================

/**
 * Returns a map keyed by MachineCode (UPPERCASED for lookup; stored code
 * preserved as 'APS001' etc.) → { name, sapWorkCenter, department, active }.
 * Skips rows where Active is false/'FALSE'. Built via header-name map.
 * Cached for the execution scope.
 * SAPWorkCenter is normalized via _normSapWc_ to guarantee a string.
 * @return {Object.<string, {name:string, sapWorkCenter:string, department:string, active:boolean}>}
 */
function getMachineMaster_() {
  if (_machineMasterCache_) return _machineMasterCache_;

  var sh = getSpreadsheet_().getSheetByName(MCH_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    _machineMasterCache_ = {};
    return _machineMasterCache_;
  }

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var map = {};
  for (var r = 1; r < data.length; r++) {
    var code = String(data[r][idx['MachineCode']] == null ? '' : data[r][idx['MachineCode']]).trim();
    if (!code) continue;

    var activeRaw = data[r][idx['Active']];
    if (activeRaw === false ||
        String(activeRaw || '').trim().toUpperCase() === 'FALSE') continue;

    map[code.toUpperCase()] = {
      name:          String(data[r][idx['MachineName']] == null ? '' : data[r][idx['MachineName']]).trim(),
      sapWorkCenter: _normSapWc_(data[r][idx['SAPWorkCenter']]),
      department:    String(data[r][idx['Department']] == null ? '' : data[r][idx['Department']]).trim(),
      active:        true
    };
  }

  _machineMasterCache_ = map;
  return map;
}

/**
 * Lookup a single machine by code. Normalizes input (trim, uppercase)
 * to match stored codes. Returns the entry or null.
 * @param {string} code — e.g. 'APS001' or '  aps001 '
 * @return {{name:string, sapWorkCenter:string, department:string, active:boolean}|null}
 */
function lookupMachine_(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return null;
  var map = getMachineMaster_();
  return map[code] || null;
}

// ============================================================================
// Server API for Scanner.html — google.script.run
// ============================================================================

/**
 * Validate a machine code for the scanner UI. Called via google.script.run.
 * Returns a plain JSON object (no Date/Object — safe for JSON.parse(JSON.stringify())).
 * @param {string} code — e.g. 'APS005'
 * @return {{ok:boolean, code:string, name:string, sapWorkCenter:string}}
 */
function lookupMachineForScan(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return { ok: false, code: '', name: '', sapWorkCenter: '' };
  var entry = lookupMachine_(code);
  if (!entry) return { ok: false, code: code, name: '', sapWorkCenter: '' };
  return { ok: true, code: code, name: entry.name, sapWorkCenter: entry.sapWorkCenter };
}

// ============================================================================
// Diagnostic — D6 WC ↔ MachineMaster cross-check (read-only)
// ============================================================================

/**
 * D6: Cross-check SAP WorkCenters from routing (ProductionOrders.OperationsJSON)
 * against MachineMaster.SAPWorkCenter. Reports match rate + unmatched WCs.
 * Confirms comparison is string-vs-string (no Date).
 * Run from Apps Script Editor → select diagMachineWcCrossCheck_ → Run.
 * READ-ONLY — no writes, no SAP calls.
 */
function diagMachineWcCrossCheck() {
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' D6: WorkCenter ↔ MachineMaster cross-check');
  Logger.log('══════════════════════════════════════════');

  // ── Routing WCs from ProductionOrders.OperationsJSON ──
  var routeWcSet = {};
  var poSh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  if (poSh && poSh.getLastRow() >= 2) {
    var poData = poSh.getDataRange().getValues();
    var poHdr  = poData[0];
    var poIdx  = {};
    poHdr.forEach(function(h, i) { poIdx[String(h).trim()] = i; });
    var opsJsonCol = poIdx['OperationsJSON'];
    if (opsJsonCol !== undefined) {
      for (var p = 1; p < poData.length; p++) {
        var raw = String(poData[p][opsJsonCol] || '').trim();
        if (!raw) continue;
        try {
          var ops = JSON.parse(raw);
          for (var o = 0; o < ops.length; o++) {
            var rwc = String(ops[o].workCenter || '').trim();
            if (rwc) routeWcSet[rwc] = (routeWcSet[rwc] || 0) + 1;
          }
        } catch (_) {}
      }
    }
  }

  var allWcList = Object.keys(routeWcSet).sort();
  Logger.log('Distinct WCs from routing: ' + allWcList.length);
  allWcList.forEach(function(wc) {
    Logger.log('  ' + wc + ' (' + routeWcSet[wc] + ' occurrences)');
  });

  // ── MachineMaster SAPWorkCenter set ──
  _machineMasterCache_ = null;
  var machMap  = getMachineMaster_();
  var mchWcSet = {};
  var mchEntries = Object.keys(machMap);
  Logger.log('');
  Logger.log('MachineMaster: ' + mchEntries.length + ' active machines');

  mchEntries.forEach(function(code) {
    var swc = machMap[code].sapWorkCenter;
    Logger.log('  ' + code + ' → sapWC="' + swc + '" typeof=' + typeof swc);
    if (swc) {
      var parts = swc.split(';');
      parts.forEach(function(p) {
        var trimmed = p.trim();
        if (trimmed) mchWcSet[trimmed] = true;
      });
    }
  });
  Logger.log('Distinct SAPWorkCenters in MachineMaster: ' + Object.keys(mchWcSet).length);

  // ── Cross-check ──
  var matched   = [];
  var unmatched = [];
  allWcList.forEach(function(wc) {
    if (mchWcSet[wc]) matched.push(wc);
    else              unmatched.push(wc);
  });

  var pct = allWcList.length > 0
    ? (matched.length / allWcList.length * 100).toFixed(1) : '-';

  Logger.log('');
  Logger.log('Match rate: ' + matched.length + '/' + allWcList.length + ' (' + pct + '%)');
  Logger.log('Matched:   ' + (matched.length   ? matched.join(', ')   : '(none)'));
  Logger.log('Unmatched (up to 10): ' +
    (unmatched.length ? unmatched.slice(0, 10).join(', ') +
      (unmatched.length > 10 ? ' (+' + (unmatched.length - 10) + ' more)' : '')
    : '(none)'));
  Logger.log('');
  Logger.log('All comparisons are string-vs-string: typeof routing WC = string, typeof mchWc = string');
  Logger.log('══════════════════════════════════════════');
}

// ============================================================================
// TEST
// ============================================================================

/**
 * TEST_machineMasterReader: run from Apps Script Editor.
 * (a)  map size = unique non-FALSE rows in MachineMaster
 * (b)  lookupMachine_('APS001') returns entry with name + sapWorkCenter
 * (b2) sapWorkCenter is typeof string matching /^\d{4}-\d{2}/ (catches Date bug)
 * (c)  lookupMachine_('  aps001 ') normalizes and matches (b)
 * (d)  unknown code → null
 */
function TEST_machineMasterReader() {
  var results = [];
  var pass    = true;

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  _machineMasterCache_ = null;

  var sh = getSpreadsheet_().getSheetByName(MCH_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    Logger.log('MachineMaster sheet not found or empty — cannot test');
    return;
  }

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var uniqueCodes = {};
  for (var r = 1; r < data.length; r++) {
    var code = String(data[r][idx['MachineCode']] == null ? '' : data[r][idx['MachineCode']]).trim();
    if (!code) continue;
    var activeRaw = data[r][idx['Active']];
    var isInactive = activeRaw === false ||
      String(activeRaw || '').trim().toUpperCase() === 'FALSE';
    if (!isInactive) uniqueCodes[code.toUpperCase()] = true;
  }
  var expectedCount = Object.keys(uniqueCodes).length;

  // (a) map size = unique active machine count
  var map     = getMachineMaster_();
  var mapSize = Object.keys(map).length;
  assert('(a) map size = active machines', mapSize === expectedCount,
    'map=' + mapSize + ' expected=' + expectedCount);

  // (b) lookupMachine_('APS001') returns entry
  var aps = lookupMachine_('APS001');
  assert('(b) APS001 found', aps !== null);
  if (aps) {
    assert('(b) APS001 has name', aps.name.length > 0, 'name=' + aps.name);
    assert('(b) APS001 has sapWorkCenter', aps.sapWorkCenter.length > 0,
      'wc=' + aps.sapWorkCenter);

    // (b2) sapWorkCenter must be a string matching NNNN-NN pattern (Date bug catch)
    assert('(b2) sapWorkCenter typeof=string',
      typeof aps.sapWorkCenter === 'string',
      'typeof=' + typeof aps.sapWorkCenter + ' val=' + aps.sapWorkCenter);
    assert('(b2) sapWorkCenter matches /^\\d{4}-\\d{2}/',
      /^\d{4}-\d{2}(;\d{4}-\d{2})*$/.test(aps.sapWorkCenter),
      'val="' + aps.sapWorkCenter + '"');
  }

  // (c) normalized '  aps001 ' matches (b)
  var apsNorm = lookupMachine_('  aps001 ');
  assert('(c) "  aps001 " found', apsNorm !== null);
  if (aps && apsNorm) {
    assert('(c) same entry as APS001', apsNorm.name === aps.name &&
      apsNorm.sapWorkCenter === aps.sapWorkCenter);
  }

  // (d) unknown code → null
  var unk = lookupMachine_('ZZZZZ_NOPE_999');
  assert('(d) unknown code → null', unk === null);

  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_machineMasterReader: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name +
      (results[si].detail ? ' (' + results[si].detail + ')' : ''));
  }
}

// ============================================================================
// TEST — Machine Capture M2 (schema + logOperation + lookupMachineForScan)
// ============================================================================

function TEST_machineCaptureM2_() {
  var results = [];
  var pass    = true;
  var ss      = getSpreadsheet_();

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  // (a) Schema: OperationLog has ActualMachine at idx14; other names unmoved
  var olSh  = ss.getSheetByName(OL_SHEET);
  var olHdr = olSh.getRange(1, 1, 1, olSh.getLastColumn()).getValues()[0];
  var olIdx = {};
  olHdr.forEach(function(h, i) { olIdx[String(h).trim()] = i; });

  assert('(a) ActualMachine exists', olIdx['ActualMachine'] !== undefined,
    'idx=' + olIdx['ActualMachine']);
  assert('(a) ActualMachine at idx14', olIdx['ActualMachine'] === 14,
    'idx=' + olIdx['ActualMachine']);
  assert('(a) GoodQty still idx5', olIdx['GoodQty'] === 5,
    'idx=' + olIdx['GoodQty']);
  assert('(a) Source still idx13', olIdx['Source'] === 13,
    'idx=' + olIdx['Source']);
  assert('(a) PDResult after ActualMachine', olIdx['PDResult'] === 15,
    'idx=' + olIdx['PDResult']);

  var TEST_PID = 'PL-TEST-M2-MACH-L01';

  // (b) logOperation with actualMachine='APS005' → stores 'APS005'
  var logIdB = logOperation({
    palletId: TEST_PID, mo: '9999999997', operationNo: '0010',
    operationText: 'M2 Test', goodQty: 10, scrapQty: 0,
    repairQty: 0, awaitConvQty: 0, operator: 'TEST',
    role: 'OP', result: 'PASS', source: 'TEST',
    actualMachine: 'APS005'
  });
  SpreadsheetApp.flush();

  var olData = olSh.getDataRange().getValues();
  var olHdrLive = olData[0];
  var olIdxLive = {};
  olHdrLive.forEach(function(h, i) { olIdxLive[String(h).trim()] = i; });

  var foundRow = null;
  for (var r = 1; r < olData.length; r++) {
    if (String(olData[r][olIdxLive['LogID']] || '').trim() === logIdB) {
      foundRow = olData[r];
      break;
    }
  }
  assert('(b) test row found', foundRow !== null, 'logId=' + logIdB);
  if (foundRow) {
    var machVal = foundRow[olIdxLive['ActualMachine']];
    assert('(b) ActualMachine=APS005', String(machVal).trim() === 'APS005',
      'got=' + String(machVal) + ' typeof=' + typeof machVal);
  }

  // (c) logOperation WITHOUT actualMachine → stores '' (no crash)
  var logIdC = logOperation({
    palletId: TEST_PID, mo: '9999999997', operationNo: '0020',
    operationText: 'M2 No Machine', goodQty: 10, scrapQty: 0,
    repairQty: 0, awaitConvQty: 0, operator: 'TEST',
    role: 'OP', result: 'PASS', source: 'TEST'
  });
  SpreadsheetApp.flush();

  olData = olSh.getDataRange().getValues();
  var foundRowC = null;
  for (var r2 = 1; r2 < olData.length; r2++) {
    if (String(olData[r2][olIdxLive['LogID']] || '').trim() === logIdC) {
      foundRowC = olData[r2];
      break;
    }
  }
  assert('(c) no-machine row found', foundRowC !== null);
  if (foundRowC) {
    var machValC = foundRowC[olIdxLive['ActualMachine']];
    assert('(c) ActualMachine is empty string', String(machValC).trim() === '',
      'got="' + String(machValC) + '"');
  }

  // (d) lookupMachineForScan
  _machineMasterCache_ = null;
  var lkOk  = lookupMachineForScan('aps001');
  assert('(d) lookupMachineForScan aps001 ok', lkOk.ok === true, JSON.stringify(lkOk));
  assert('(d) name non-empty', lkOk.name && lkOk.name.length > 0, 'name=' + lkOk.name);
  assert('(d) sapWorkCenter string', typeof lkOk.sapWorkCenter === 'string',
    'typeof=' + typeof lkOk.sapWorkCenter + ' val=' + lkOk.sapWorkCenter);

  var lkBad = lookupMachineForScan('ZZZ');
  assert('(d) lookupMachineForScan ZZZ → ok:false', lkBad.ok === false);

  // (e) returns are plain JSON (no Date/Object[])
  var serialized = JSON.parse(JSON.stringify(lkOk));
  assert('(e) lkOk survives JSON round-trip', serialized.ok === true &&
    serialized.code === lkOk.code && serialized.name === lkOk.name);

  // ── Cleanup: delete PL-TEST-M2 rows ──
  try {
    olData = olSh.getDataRange().getValues();
    for (var cr = olData.length - 1; cr >= 1; cr--) {
      if (/^PL-TEST-M2/i.test(String(olData[cr][olIdxLive['PalletID']] || '').trim())) {
        olSh.deleteRow(cr + 1);
      }
    }
    Logger.log('Cleanup: PL-TEST-M2 rows deleted');
  } catch (cleanErr) {
    Logger.log('Cleanup error: ' + cleanErr.message);
  }

  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_machineCaptureM2_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name +
      (results[si].detail ? ' (' + results[si].detail + ')' : ''));
  }
}

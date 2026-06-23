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
// QR Sticker — printable A4 sheets for all active machines
// ============================================================================

/**
 * Return active machines for QR sticker generation.
 * @param {string} dept — filter by Department; '' or 'ALL' = all departments
 * @return {{machines: Array<{code,name,sapWC,dept}>, count: number, dept: string}}
 */
function getMachinesForSticker_(dept) {
  dept = String(dept || '').trim().toUpperCase();
  if (dept === 'ALL') dept = '';

  var sh = getSpreadsheet_().getSheetByName(MCH_SHEET);
  if (!sh || sh.getLastRow() < 2) return { machines: [], count: 0, dept: dept };

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var machines = [];
  for (var r = 1; r < data.length; r++) {
    var code = String(data[r][idx['MachineCode']] == null ? '' : data[r][idx['MachineCode']]).trim();
    if (!code) continue;

    var activeRaw = data[r][idx['Active']];
    if (activeRaw === false || String(activeRaw || '').trim().toUpperCase() === 'FALSE') continue;

    var rowDept = String(data[r][idx['Department']] == null ? '' : data[r][idx['Department']]).trim();
    if (dept && rowDept.toUpperCase() !== dept) continue;

    machines.push({
      code:  code,
      name:  String(data[r][idx['MachineName']] == null ? '' : data[r][idx['MachineName']]).trim(),
      sapWC: _normSapWc_(data[r][idx['SAPWorkCenter']]),
      dept:  rowDept
    });
  }

  machines.sort(function(a, b) {
    if (a.dept < b.dept) return -1;
    if (a.dept > b.dept) return 1;
    if (a.code < b.code) return -1;
    if (a.code > b.code) return 1;
    return 0;
  });

  return JSON.parse(JSON.stringify({ machines: machines, count: machines.length, dept: dept }));
}

/**
 * Menu handler: prompt for dept, then open printable QR sticker dialog.
 */
function generateMachineQrStickers() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('🏷️ QR เครื่องจักร',
    'พิมพ์ทั้งหมด = ALL (หรือเว้นว่าง)\nหรือใส่รหัสแผนก เช่น 1CC, 4PF:',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var deptInput = resp.getResponseText().trim();
  var result = getMachinesForSticker_(deptInput);

  if (result.count === 0) {
    ui.alert('ไม่พบเครื่องจักร' + (result.dept ? ' ในแผนก ' + result.dept : ''));
    return;
  }

  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm');

  var tpl = HtmlService.createTemplateFromFile('MachineQrSticker');
  var htmlOut = tpl.evaluate()
    .setWidth(794)
    .setHeight(1123)
    .setTitle('QR เครื่องจักร – พร้อมพิมพ์');

  var initScript = '<script>init(' +
    JSON.stringify(result.machines) + ',' +
    JSON.stringify(result.dept) + ',' +
    JSON.stringify(now) + ');</script>';
  htmlOut.append(initScript);

  ui.showModelessDialog(htmlOut, 'QR เครื่องจักร – ' + result.count + ' เครื่อง');

  logEvent('MACHINE_QR_STICKER', MCH_SHEET, 'OK', 0,
    'count=' + result.count + ' dept=' + (result.dept || 'ALL'));
}

// ============================================================================
// Diagnostic: verify ActualMachine not leaking into PDResult
// ============================================================================

function diagVerifyActualMachineColumn() {
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' DIAG: Verify ActualMachine column integrity');
  Logger.log('══════════════════════════════════════════');

  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(OL_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    Logger.log('OperationLog empty');
    return;
  }

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  // ── Header dump ──
  Logger.log('');
  Logger.log('Header (' + hdr.length + ' cols):');
  for (var c = 0; c < hdr.length; c++) {
    Logger.log('  [' + c + '] ' + String(hdr[c]).trim());
  }

  // ── Specific row: PL-1000036325-L01 ──
  Logger.log('');
  Logger.log('── PL-1000036325-L01 field dump ──');
  var targetPid = 'PL-1000036325-L01';
  var targetFound = false;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['PalletID']] || '').trim() !== targetPid) continue;
    targetFound = true;
    var fields = ['PalletID', 'ManufacturingOrder', 'OperationNo',
      'GoodQty', 'ScrapQty', 'RepairQty', 'AwaitConvQty',
      'Operator', 'Role', 'Result', 'Source',
      'ActualMachine', 'PDResult', 'PDInspector', 'PDNote', 'PDTimestamp'];
    fields.forEach(function(f) {
      var val = idx[f] !== undefined ? data[r][idx[f]] : '(COLUMN MISSING)';
      Logger.log('  ' + f + ' (col ' + idx[f] + '): ' +
        JSON.stringify(val) + '  typeof=' + typeof val);
    });
    break;
  }
  if (!targetFound) Logger.log('  ROW NOT FOUND: ' + targetPid);

  // ── Full scan: APS leak check ──
  Logger.log('');
  Logger.log('── Full scan: APS leak check ──');
  var apsInPD = 0;
  var apsInAM = 0;
  var pdAnomalies = [];
  var apsInPDRows = [];

  for (var r2 = 1; r2 < data.length; r2++) {
    var pid = String(data[r2][idx['PalletID']] || '').trim();

    var pdVal = idx['PDResult'] !== undefined
      ? String(data[r2][idx['PDResult']] == null ? '' : data[r2][idx['PDResult']]).trim() : '';
    var amVal = idx['ActualMachine'] !== undefined
      ? String(data[r2][idx['ActualMachine']] == null ? '' : data[r2][idx['ActualMachine']]).trim() : '';

    if (/^APS\d+$/i.test(pdVal)) {
      apsInPD++;
      if (apsInPDRows.length < 10) apsInPDRows.push({ row: r2 + 1, pid: pid, pdVal: pdVal });
    }
    if (/^APS\d+$/i.test(amVal)) apsInAM++;
    if (pdVal && pdVal !== 'PASS' && pdVal !== 'FAIL') {
      if (pdAnomalies.length < 10)
        pdAnomalies.push({ row: r2 + 1, pid: pid, pdVal: pdVal });
    }
  }

  Logger.log('Total data rows: ' + (data.length - 1));
  Logger.log('PDResult matches /^APS\\d+$/ (BUG — leaked machine code): ' + apsInPD);
  Logger.log('ActualMachine matches /^APS\\d+$/ (correct): ' + apsInAM);
  Logger.log('PDResult anomalies (non-empty, not PASS/FAIL): ' + pdAnomalies.length);

  if (apsInPDRows.length > 0) {
    Logger.log('');
    Logger.log('⚠️ APS codes in PDResult (first 10):');
    apsInPDRows.forEach(function(e) {
      Logger.log('  row ' + e.row + ' ' + e.pid + ' PDResult=' + e.pdVal);
    });
  }
  if (pdAnomalies.length > 0) {
    Logger.log('');
    Logger.log('PDResult anomalies (first 10):');
    pdAnomalies.forEach(function(e) {
      Logger.log('  row ' + e.row + ' ' + e.pid + ' PDResult="' + e.pdVal + '"');
    });
  }

  Logger.log('');
  if (apsInPD === 0) {
    Logger.log('✅ VERDICT: ActualMachine column OK — zero APS codes in PDResult');
  } else {
    Logger.log('❌ VERDICT: BUG — ' + apsInPD + ' rows have APS codes leaked into PDResult');
  }
  Logger.log('══════════════════════════════════════════');
}

// ============================================================================
// BUGFIX: repair rows where APS code leaked from ActualMachine into PDResult
// ============================================================================

/**
 * Step 0+1+2: probe schema, backup, fix leaked APS codes in PDResult.
 * Run from Apps Script Editor.
 */
function fixActualMachineLeak() {
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' BUGFIX: ActualMachine → PDResult leak repair');
  Logger.log('══════════════════════════════════════════');

  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(OL_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('OperationLog empty'); return; }

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  // ── Step 0a: header dump ──
  Logger.log('');
  Logger.log('STEP 0a — Sheet header (' + hdr.length + ' cols):');
  for (var c = 0; c < hdr.length; c++) {
    Logger.log('  [' + c + '] ' + String(hdr[c]).trim());
  }

  Logger.log('');
  Logger.log('STEP 0b — OL_HEADERS constant (' + OL_HEADERS.length + ' cols):');
  for (var c2 = 0; c2 < OL_HEADERS.length; c2++) {
    Logger.log('  [' + c2 + '] ' + OL_HEADERS[c2]);
  }

  // ── Step 0c: assert identical ──
  var sheetHdr = hdr.map(function(h) { return String(h).trim(); });
  var match = sheetHdr.length === OL_HEADERS.length &&
    sheetHdr.every(function(h, i) { return h === OL_HEADERS[i]; });
  Logger.log('');
  Logger.log('STEP 0c — OL_HEADERS === sheet header: ' + match);
  if (!match) {
    Logger.log('  ⚠️ MISMATCH — sheet=[' + sheetHdr.join(',') + ']');
    Logger.log('  ⚠️ MISMATCH — code =[' + OL_HEADERS.join(',') + ']');
  }

  // ── Step 0d: PL-1000036325-L01 raw dump ──
  Logger.log('');
  Logger.log('STEP 0d — PL-1000036325-L01 raw dump:');
  for (var r0 = 1; r0 < data.length; r0++) {
    if (String(data[r0][idx['PalletID']] || '').trim() !== 'PL-1000036325-L01') continue;
    for (var ci = 0; ci < hdr.length; ci++) {
      var val = data[r0][ci];
      Logger.log('  [' + ci + '] ' + String(hdr[ci]).trim() + ' = ' +
        JSON.stringify(val == null ? '' : String(val)) + '  typeof=' + typeof val);
    }
    break;
  }

  // ── Step 1: backup ──
  var stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss');
  var backupName = 'OperationLog_bak_' + stamp;
  sh.copyTo(ss).setName(backupName);
  Logger.log('');
  Logger.log('STEP 1 — Backup: ' + backupName);

  // ── Step 2: fix leaked rows ──
  Logger.log('');
  Logger.log('STEP 2 — Fix leaked APS codes in PDResult:');
  var pdCol = idx['PDResult'];
  var amCol = idx['ActualMachine'];
  if (pdCol === undefined || amCol === undefined) {
    Logger.log('  ABORT: PDResult or ActualMachine column missing');
    return;
  }

  var fixCount = 0;
  for (var r = 1; r < data.length; r++) {
    var pdVal = String(data[r][pdCol] == null ? '' : data[r][pdCol]).trim();
    if (!/^APS\d+$/i.test(pdVal)) continue;

    var amVal = String(data[r][amCol] == null ? '' : data[r][amCol]).trim();
    var pid   = String(data[r][idx['PalletID']] || '').trim();
    var rowNum = r + 1;

    if (!amVal) {
      sh.getRange(rowNum, amCol + 1).setValue(pdVal);
    }
    sh.getRange(rowNum, pdCol + 1).setValue('');
    fixCount++;
    Logger.log('  FIXED row ' + rowNum + ' ' + pid +
      ': PDResult=' + pdVal + ' → ActualMachine=' + (amVal || pdVal) + ", PDResult=''");
  }

  Logger.log('');
  Logger.log('Total fixed: ' + fixCount);
  logEvent('BUGFIX_AM_LEAK', OL_SHEET, 'OK', 0,
    'fixed=' + fixCount + ' backup=' + backupName);

  // ── Postcondition: verify no APS in PDResult ──
  SpreadsheetApp.flush();
  var verify = sh.getDataRange().getValues();
  var remaining = 0;
  for (var v = 1; v < verify.length; v++) {
    var vpd = String(verify[v][pdCol] == null ? '' : verify[v][pdCol]).trim();
    if (/^APS\d+$/i.test(vpd)) remaining++;
  }
  Logger.log('Postcondition: APS codes remaining in PDResult = ' + remaining);
  Logger.log(remaining === 0 ? '✅ All clear' : '❌ Still has leaks');
  Logger.log('══════════════════════════════════════════');
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
// TEST — Machine QR Sticker
// ============================================================================

function TEST_machineQrSticker_() {
  var results = [];
  var pass    = true;

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  // (a) all active machines
  var all = getMachinesForSticker_('');
  assert('(a) returns array', Array.isArray(all.machines), 'type=' + typeof all.machines);
  assert('(a) count matches length', all.count === all.machines.length,
    'count=' + all.count + ' len=' + all.machines.length);
  assert('(a) count > 0', all.count > 0, 'count=' + all.count);

  if (all.machines.length > 0) {
    var m0 = all.machines[0];
    assert('(a) has code', typeof m0.code === 'string' && m0.code.length > 0, 'code=' + m0.code);
    assert('(a) has name', typeof m0.name === 'string', 'name=' + m0.name);
    assert('(a) has sapWC', typeof m0.sapWC === 'string', 'sapWC=' + m0.sapWC);
    assert('(a) has dept', typeof m0.dept === 'string', 'dept=' + m0.dept);
    assert('(a) code matches /^[A-Z]/', /^[A-Z]/.test(m0.code), 'code=' + m0.code);
  }

  var serialized = JSON.parse(JSON.stringify(all));
  assert('(a) JSON serializable', serialized.count === all.count);

  // (b) filter by dept '1CC'
  var cc = getMachinesForSticker_('1CC');
  assert('(b) 1CC returns array', Array.isArray(cc.machines));
  assert('(b) 1CC count > 0', cc.count > 0, 'count=' + cc.count);
  var allCc = cc.machines.every(function(m) { return m.dept === '1CC'; });
  assert('(b) all dept=1CC', allCc, 'first dept=' + (cc.machines[0] ? cc.machines[0].dept : ''));

  // (c) unknown dept → empty
  var zz = getMachinesForSticker_('ZZZ');
  assert('(c) ZZZ returns empty', zz.count === 0, 'count=' + zz.count);

  // (d) QR URL for APS001
  var expectedUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=M%3AAPS001';
  var builtUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=' + encodeURIComponent('M:APS001');
  assert('(d) QR URL correct', builtUrl === expectedUrl, 'got=' + builtUrl);

  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_machineQrSticker_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name +
      (results[si].detail ? ' (' + results[si].detail + ')' : ''));
  }
}

// ============================================================================
// TEST — Machine Capture M2 (schema + logOperation + lookupMachineForScan)
// ============================================================================

function TEST_machineCaptureM2() {
  var results = [];
  var pass    = true;
  var ss      = getSpreadsheet_();

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  // (a) Schema: OL_HEADERS constant must match actual sheet header row
  var olSh  = ss.getSheetByName(OL_SHEET);
  var olHdr = olSh.getRange(1, 1, 1, olSh.getLastColumn()).getValues()[0]
    .map(function(h) { return String(h).trim(); });
  var olIdx = {};
  olHdr.forEach(function(h, i) { olIdx[h] = i; });

  assert('(a) ActualMachine exists in sheet', olIdx['ActualMachine'] !== undefined,
    'idx=' + olIdx['ActualMachine']);
  assert('(a) sheet has ' + OL_HEADERS.length + ' columns',
    olHdr.length === OL_HEADERS.length,
    'sheet=' + olHdr.length + ' OL_HEADERS=' + OL_HEADERS.length);

  var headerMatch = olHdr.length === OL_HEADERS.length &&
    olHdr.every(function(h, i) { return h === OL_HEADERS[i]; });
  assert('(a) OL_HEADERS order === sheet header order', headerMatch,
    headerMatch ? 'identical' :
    'OL_HEADERS=[' + OL_HEADERS.join(',') + '] sheet=[' + olHdr.join(',') + ']');

  var allPresent = OL_HEADERS.every(function(h) { return olIdx[h] !== undefined; });
  assert('(a) every OL_HEADERS column present in sheet', allPresent);

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

// ============================================================================
// TEST — Machine Capture M3 (resolver ACTUAL/PLANNED/RAW)
// ============================================================================

function TEST_machineResolveM3() {
  var results = [];
  var pass    = true;
  var ss      = getSpreadsheet_();

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  // Reset caches
  _wcCache_ = {};
  _mmCache_ = null;
  _mmByWC_  = null;

  // Seed 3 PL-TEST-M3 rows in OperationLog
  var olSh  = ss.getSheetByName(OL_SHEET);
  var olHdr = olSh.getRange(1, 1, 1, olSh.getLastColumn()).getValues()[0];
  var olIdx = {};
  olHdr.forEach(function(h, i) { olIdx[String(h).trim()] = i; });

  function seedOl(pid, mo, opNo, aps) {
    var row = new Array(olHdr.length).fill('');
    row[olIdx['LogID']]              = pid + '-' + opNo + '-OP-' + Date.now();
    row[olIdx['PalletID']]           = pid;
    row[olIdx['ManufacturingOrder']] = mo;
    row[olIdx['OperationNo']]        = opNo;
    row[olIdx['OperationText']]      = 'M3 Test';
    row[olIdx['GoodQty']]            = 10;
    row[olIdx['ScrapQty']]           = 0;
    row[olIdx['RepairQty']]          = 0;
    row[olIdx['AwaitConvQty']]       = 0;
    row[olIdx['Operator']]           = 'TEST';
    row[olIdx['Role']]               = 'OP';
    row[olIdx['Result']]             = 'PASS';
    row[olIdx['LoggedAt']]           = new Date();
    row[olIdx['Source']]             = 'TEST';
    if (olIdx['ActualMachine'] !== undefined) row[olIdx['ActualMachine']] = aps || '';
    olSh.appendRow(row);
  }

  seedOl('PL-TEST-M3-ACTUAL',  '9999999990', '0010', 'APS001');
  seedOl('PL-TEST-M3-PLANNED', '1000036346', '0010', '');
  seedOl('PL-TEST-M3-RAW',     '9999999990', '0099', '');
  SpreadsheetApp.flush();

  try {
    // Re-read to resolve
    _wcCache_ = {};
    _mmCache_ = null;
    _mmByWC_  = null;

    var data = olSh.getDataRange().getValues();
    var hdr2 = data[0];
    var idx2 = {};
    hdr2.forEach(function(h, i) { idx2[String(h).trim()] = i; });

    function findRow(pid) {
      for (var r = 1; r < data.length; r++) {
        if (String(data[r][idx2['PalletID']] || '').trim() === pid) return data[r];
      }
      return null;
    }

    // (a) ACTUAL: APS001 → source=ACTUAL, name from MachineMaster, sapWC='0101-01'
    var rowA = findRow('PL-TEST-M3-ACTUAL');
    assert('(a) ACTUAL row found', rowA !== null);
    if (rowA) {
      var resA = resolveWorkCenter_(idx2, rowA, '9999999990', '0010');
      assert('(a) source=ACTUAL', resA.source === 'ACTUAL', 'source=' + resA.source);
      assert('(a) machineCode=APS001', resA.machineCode === 'APS001', 'code=' + resA.machineCode);
      assert('(a) machineName non-empty', resA.machineName.length > 0, 'name=' + resA.machineName);
      assert('(a) sapWC=0101-01', resA.sapWC === '0101-01', 'sapWC=' + resA.sapWC);
    }

    // (b) PLANNED: mo=1000036346 opNo=0010 → planned WC from routing → PLANNED or RAW
    var rowB = findRow('PL-TEST-M3-PLANNED');
    assert('(b) PLANNED row found', rowB !== null);
    if (rowB) {
      var resB = resolveWorkCenter_(idx2, rowB, '1000036346', '0010');
      assert('(b) source != ACTUAL', resB.source !== 'ACTUAL', 'source=' + resB.source);
      assert('(b) sapWC non-empty', resB.sapWC.length > 0, 'sapWC=' + resB.sapWC);
      Logger.log('  (b) detail: source=' + resB.source + ' machineName=' + resB.machineName +
        ' sapWC=' + resB.sapWC);
    }

    // (c) RAW: unknown MO+opNo, no ActualMachine → source=RAW
    var rowC = findRow('PL-TEST-M3-RAW');
    assert('(c) RAW row found', rowC !== null);
    if (rowC) {
      var resC = resolveWorkCenter_(idx2, rowC, '9999999990', '0099');
      assert('(c) source=RAW', resC.source === 'RAW', 'source=' + resC.source);
      assert('(c) machineName empty', resC.machineName === '', 'name=' + resC.machineName);
    }

    // Run full report and check the By WC section
    var report = buildYieldQCReport_();
    assert('full report runs', !!report);
    assert('byWorkCenter has entries', report.byWorkCenter.length > 0,
      'len=' + report.byWorkCenter.length);

    var hasActual = report.byWorkCenter.some(function(bw) { return bw.source === 'ACTUAL'; });
    if (hasActual) {
      var actualRow = report.byWorkCenter.find(function(bw) { return bw.source === 'ACTUAL'; });
      assert('ACTUAL row has machineName', actualRow.machineName.length > 0);
      assert('ACTUAL row Yield% not NaN', actualRow.yieldPct !== 'NaN%',
        'yieldPct=' + actualRow.yieldPct);
    }
    assert('machineCoverage present', report.machineCoverage !== undefined);

  } catch (e) {
    assert('test execution', false, e.message + '\n' + (e.stack || ''));
  }

  // ── Cleanup: delete PL-TEST-M3 rows ──
  try {
    var olAll = olSh.getDataRange().getValues();
    for (var cr = olAll.length - 1; cr >= 1; cr--) {
      if (/^PL-TEST-M3/i.test(String(olAll[cr][idx2['PalletID']] || '').trim())) {
        olSh.deleteRow(cr + 1);
      }
    }
    Logger.log('Cleanup: PL-TEST-M3 rows deleted');
  } catch (cleanErr) {
    Logger.log('Cleanup error: ' + cleanErr.message);
  }

  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_machineResolveM3_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name +
      (results[si].detail ? ' (' + results[si].detail + ')' : ''));
  }
}

// ============================================================================
// TEST — ActualMachine integrity (post-bugfix)
// ============================================================================

function TEST_actualMachineIntegrity() {
  var results = [];
  var pass    = true;
  var ss      = getSpreadsheet_();

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  var olSh  = ss.getSheetByName(OL_SHEET);
  var olHdr = olSh.getRange(1, 1, 1, olSh.getLastColumn()).getValues()[0];
  var olIdx = {};
  olHdr.forEach(function(h, i) { olIdx[String(h).trim()] = i; });

  // (a) Write with actualMachine='APS099' → lands in correct column
  var logIdA = logOperation({
    palletId: 'PL-TEST-AM-A', mo: '9999999996', operationNo: '0010',
    operationText: 'AM test', goodQty: 10, scrapQty: 0,
    repairQty: 0, awaitConvQty: 0, operator: 'TEST',
    role: 'OP', result: 'PASS', source: 'TEST',
    actualMachine: 'APS099'
  });
  SpreadsheetApp.flush();

  var dataA = olSh.getDataRange().getValues();
  var idxA = {};
  dataA[0].forEach(function(h, i) { idxA[String(h).trim()] = i; });
  var rowA = null;
  for (var ra = 1; ra < dataA.length; ra++) {
    if (String(dataA[ra][idxA['LogID']] || '').trim() === logIdA) { rowA = dataA[ra]; break; }
  }
  assert('(a) test row found', rowA !== null);
  if (rowA) {
    var amA = String(rowA[idxA['ActualMachine']] || '').trim();
    var pdA = String(rowA[idxA['PDResult']] || '').trim();
    assert('(a) ActualMachine=APS099', amA === 'APS099', 'got=' + amA);
    assert('(a) PDResult is empty (not APS099)', pdA === '', 'got=' + pdA);
  }

  // (b) Write without actualMachine → both empty
  var logIdB = logOperation({
    palletId: 'PL-TEST-AM-B', mo: '9999999996', operationNo: '0020',
    operationText: 'AM none', goodQty: 10, scrapQty: 0,
    repairQty: 0, awaitConvQty: 0, operator: 'TEST',
    role: 'OP', result: 'PASS', source: 'TEST'
  });
  SpreadsheetApp.flush();

  var dataB = olSh.getDataRange().getValues();
  var rowB = null;
  for (var rb = 1; rb < dataB.length; rb++) {
    if (String(dataB[rb][idxA['LogID']] || '').trim() === logIdB) { rowB = dataB[rb]; break; }
  }
  assert('(b) no-machine row found', rowB !== null);
  if (rowB) {
    var amB = String(rowB[idxA['ActualMachine']] || '').trim();
    var pdB = String(rowB[idxA['PDResult']] || '').trim();
    assert('(b) ActualMachine empty', amB === '', 'got=' + amB);
    assert('(b) PDResult empty', pdB === '', 'got=' + pdB);
  }

  // (c) Full scan: zero APS codes in PDResult
  var pdCol = idxA['PDResult'];
  var apsLeakCount = 0;
  for (var rc = 1; rc < dataB.length; rc++) {
    var pdV = String(dataB[rc][pdCol] == null ? '' : dataB[rc][pdCol]).trim();
    if (/^APS\d+$/i.test(pdV)) apsLeakCount++;
  }
  assert('(c) zero APS codes in PDResult', apsLeakCount === 0, 'leaks=' + apsLeakCount);

  // ── Cleanup ──
  try {
    var cleanData = olSh.getDataRange().getValues();
    for (var cr = cleanData.length - 1; cr >= 1; cr--) {
      if (/^PL-TEST-AM/i.test(String(cleanData[cr][idxA['PalletID']] || '').trim())) {
        olSh.deleteRow(cr + 1);
      }
    }
    Logger.log('Cleanup: PL-TEST-AM rows deleted');
  } catch (cleanErr) {
    Logger.log('Cleanup error: ' + cleanErr.message);
  }

  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_actualMachineIntegrity_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name +
      (results[si].detail ? ' (' + results[si].detail + ')' : ''));
  }
}

// ============================================================================
// TEST — Lark machine coverage line
// ============================================================================

function TEST_larkMachineCoverage_() {
  var results = [];
  var pass    = true;

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  // (a) Real report has machineCoverage with at least 1 actual (APS003 row)
  var report = buildYieldQCReport_();
  assert('(a) report has machineCoverage', report.machineCoverage !== undefined);
  var mc = report.machineCoverage;
  assert('(a) actual >= 1', mc.actual >= 1, 'actual=' + mc.actual);
  assert('(a) total > 0', mc.total > 0, 'total=' + mc.total);

  // (b) Lark card contains เครื่องจริง when actual > 0
  var card = buildYieldQcLarkCard_(report);
  assert('(b) Lark card contains เครื่องจริง', card.indexOf('เครื่องจริง') !== -1);
  Logger.log('  (b) coverage line: ' +
    card.split('\n').filter(function(l) { return l.indexOf('เครื่องจริง') !== -1; }).join(''));

  // (c) Fake report with 0 actual → line absent
  var fakeReport = JSON.parse(JSON.stringify(report));
  fakeReport.machineCoverage = { actual: 0, total: 100 };
  var fakeCard = buildYieldQcLarkCard_(fakeReport);
  assert('(c) no เครื่องจริง when actual=0', fakeCard.indexOf('เครื่องจริง') === -1);

  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_larkMachineCoverage_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name +
      (results[si].detail ? ' (' + results[si].detail + ')' : ''));
  }
}

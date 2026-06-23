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
// Read API
// ============================================================================

/**
 * Returns a map keyed by MachineCode (UPPERCASED for lookup; stored code
 * preserved as 'APS001' etc.) → { name, sapWorkCenter, department, active }.
 * Skips rows where Active is false/'FALSE'. Built via header-name map.
 * Cached for the execution scope.
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
    var code = String(data[r][idx['MachineCode']] || '').trim();
    if (!code) continue;

    var activeRaw = data[r][idx['Active']];
    if (activeRaw === false ||
        String(activeRaw || '').trim().toUpperCase() === 'FALSE') continue;

    map[code.toUpperCase()] = {
      name:          String(data[r][idx['MachineName']]  || '').trim(),
      sapWorkCenter: String(data[r][idx['SAPWorkCenter']] || '').trim(),
      department:    String(data[r][idx['Department']]    || '').trim(),
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
// Diagnostic — D6 WC ↔ MachineMaster cross-check (read-only)
// ============================================================================

/**
 * D6: Cross-check SAP WorkCenters from routing (ProductionOrders.OperationsJSON)
 * against MachineMaster.SAPWorkCenter. Reports match rate + unmatched WCs.
 * Run from Apps Script Editor → select diagMachineWcCrossCheck_ → Run.
 * READ-ONLY — no writes, no SAP calls.
 */
function diagMachineWcCrossCheck_() {
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' D6: WorkCenter ↔ MachineMaster cross-check');
  Logger.log('══════════════════════════════════════════');

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

  _machineMasterCache_ = null;
  var machMap  = getMachineMaster_();
  var mchWcSet = {};
  Object.keys(machMap).forEach(function(code) {
    var swc = machMap[code].sapWorkCenter;
    if (swc) mchWcSet[swc] = true;
  });
  Logger.log('Distinct SAPWorkCenters in MachineMaster: ' + Object.keys(mchWcSet).length);

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
  Logger.log('Unmatched: ' + (unmatched.length ? unmatched.join(', ') : '(none)'));
  Logger.log('');
  Logger.log('Implication: unmatched WCs currently fall back to planned-WC text.');
  Logger.log('M3 can map matched WCs to Thai machine names via MachineMaster.');
  Logger.log('══════════════════════════════════════════');
}

// ============================================================================
// TEST
// ============================================================================

/**
 * TEST_machineMasterReader_: run from Apps Script Editor.
 * (a) map size = unique non-FALSE rows in MachineMaster
 * (b) lookupMachine_('APS001') returns entry with name + sapWorkCenter
 * (c) lookupMachine_('  aps001 ') normalizes and matches (b)
 * (d) unknown code → null
 */
function TEST_machineMasterReader_() {
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
    var code = String(data[r][idx['MachineCode']] || '').trim();
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
  Logger.log('TEST_machineMasterReader_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name +
      (results[si].detail ? ' (' + results[si].detail + ')' : ''));
  }
}

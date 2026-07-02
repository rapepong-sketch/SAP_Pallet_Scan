/**
 * DesktopSearch.gs — Phase 6.1 / 6.2c: Desktop Companion WebApp Search Backend
 * ==============================================================================
 * Phase 6.1  — READ-ONLY pallet search for Desktop Companion WebApp.
 * Phase 6.2c — getMachinesForStepWorkCenter: department-based machine dropdown for Desktop confirm modal.
 * ZERO SAP writes. No feature flag.
 *
 * Public API (called via google.script.run from Desktop.html):
 *   searchPallets({mode, value})                — admin-gated full-text search on PalletMaster.
 *   getMachinesForStepWorkCenter(workCenter)     — admin-gated dept-based machine list for confirm modal.
 *   getMachinesForWorkCenter(workCenter)         — backward-compat wrapper → getMachinesForStepWorkCenter.
 *
 * Test suite:
 *   TEST_searchPallets_runAll()                  — self-cleaning hermetic 9-test runner.
 *   TEST_getMachinesForStepWorkCenter()          — read-only assertions against live MachineMaster.
 *
 * Reuses: PM_SHEET, PM_HEADERS (PalletGen.gs), isAdminUser_() (WebApp.gs),
 *   getSpreadsheet_() (SheetSetup.gs), logEvent / logError (SapClient.gs),
 *   dateToWorkCenter_() (PalletGen.gs), MM_HEADERS (MaterialMaster.gs),
 *   MCH_SHEET, _normSapWc_(), lookupMachine_() (MachineMaster.gs).
 */

// ============================================================================
// Shared helper — MaterialMaster ProductGroup join
// ============================================================================

/**
 * Build a Material → ProductGroup lookup map from the MaterialMaster sheet,
 * by header name (never by index). Shared by searchPallets() and getQcWorklist_()
 * so the join logic lives in exactly one place.
 * @return {Object.<string,string>} materialCode → productGroup ('' when no MaterialMaster row)
 * @private
 */
function _buildProductGroupMap_() {
  var pgMap = {};
  var pgSh  = getSpreadsheet_().getSheetByName('MaterialMaster');
  if (pgSh && pgSh.getLastRow() > 1) {
    var pgData = pgSh.getDataRange().getValues();
    var pgHdr  = pgData[0];
    var pgIdx  = {};
    pgHdr.forEach(function(h, i) { pgIdx[h] = i; });
    for (var pr = 1; pr < pgData.length; pr++) {
      var pgMat = String(pgData[pr][pgIdx['Material']] || '').trim();
      if (!pgMat) continue;
      pgMap[pgMat] = String(pgData[pr][pgIdx['ProductGroup']] || '').trim();
    }
  }
  return pgMap;
}

// ============================================================================
// searchPallets — READ-ONLY, admin-gated, called via google.script.run
// ============================================================================

/**
 * Search PalletMaster for rows matching mode+value. READ-ONLY — no sheet writes.
 * Admin-gated (defense-in-depth; doGet is already gated, but this fn is callable
 * independently via google.script.run).
 *
 * @param {{ mode: 'mo'|'material'|'palletId', value: string }} params
 * @return {{ ok: boolean, capped: boolean, rows: Array, error?: string }}
 */
function searchPallets(params) {
  if (!isAdminUser_()) {
    return { ok: false, error: 'NOT_ADMIN', rows: [] };
  }

  try {
    params   = params || {};
    var mode = String(params.mode  || '').trim().toLowerCase();
    var value = String(params.value || '').trim();

    if (!value) return { ok: true, capped: false, rows: [] };

    if (mode !== 'mo' && mode !== 'material' && mode !== 'palletid') {
      return { ok: false, error: 'INVALID_MODE: ' + mode, rows: [] };
    }

    var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
    if (!sh || sh.getLastRow() < 2) return { ok: true, capped: false, rows: [] };

    var data = sh.getDataRange().getValues();
    var hdr  = data[0];
    var idx  = {};
    hdr.forEach(function(h, i) { idx[h] = i; });

    var valLower = value.toLowerCase();
    var CAP      = 200;
    var rows     = [];
    var capped   = false;

    // Fields returned to the UI — subset only, access every column BY NAME.
    // StorageLocation added (Phase 6.1b) to support client-side SLoc filter.
    var OUTPUT_FIELDS = [
      'PalletID', 'ManufacturingOrder', 'Material', 'MaterialName',
      'Batch', 'QtyPerPallet', 'Unit', 'PalletSeq', 'TotalPallets',
      'WorkCenter', 'ProductionDate', 'Status', 'ScanStatus', 'QCStatus',
      'StorageLocation'
    ];

    // ProductGroup lookup map: materialCode → productGroup string.
    var pgMap = _buildProductGroupMap_();

    for (var r = 1; r < data.length; r++) {
      var row = data[r];

      var mo       = String(row[idx['ManufacturingOrder']] || '');
      var mat      = String(row[idx['Material']]           || '');
      var matName  = String(row[idx['MaterialName']]       || '');
      var palletId = String(row[idx['PalletID']]           || '');

      var match = false;
      if (mode === 'mo') {
        match = mo.toLowerCase().indexOf(valLower) >= 0;
      } else if (mode === 'material') {
        match = mat.toLowerCase().indexOf(valLower) >= 0 ||
                matName.toLowerCase().indexOf(valLower) >= 0;
      } else { // palletid
        match = palletId.toLowerCase().indexOf(valLower) >= 0;
      }

      if (!match) continue;
      if (rows.length >= CAP) { capped = true; break; }

      var obj = {};
      OUTPUT_FIELDS.forEach(function(f) {
        var raw = idx[f] !== undefined ? row[idx[f]] : '';

        if (f === 'ProductionDate') {
          // SERIALIZATION GUARD: never return a raw Date object
          obj[f] = (raw instanceof Date)
            ? Utilities.formatDate(raw, Session.getScriptTimeZone(), 'yyyy-MM-dd')
            : String(raw || '');

        } else if (f === 'Batch') {
          // SERIALIZATION GUARD: preserve leading zeros
          obj[f] = String(raw || '');

        } else if (f === 'WorkCenter') {
          // Sheets auto-parses "0408-02" style WC codes as Date objects
          obj[f] = (raw instanceof Date)
            ? dateToWorkCenter_(raw)
            : String(raw || '').trim();

        } else if (f === 'QtyPerPallet' || f === 'PalletSeq' || f === 'TotalPallets') {
          obj[f] = Number(raw) || 0;

        } else {
          obj[f] = String(raw || '');
        }
      });

      // ProductGroup join: look up by Material code; empty string when no entry.
      obj.productGroup = pgMap[obj.Material] || '';

      rows.push(obj);
    }

    logEvent('DESKTOP_SEARCH', 'PalletMaster', 'OK', 0,
      'mode=' + mode + ' val=' + value + ' rows=' + rows.length + (capped ? ' CAPPED' : ''));

    var result = { ok: true, capped: capped, rows: rows };
    // SERIALIZATION GUARD: JSON round-trip strips any residual non-serializable values
    return JSON.parse(JSON.stringify(result));

  } catch (e) {
    logError('searchPallets', 'PalletMaster', e.message, JSON.stringify(params || {}));
    return { ok: false, error: e.message, rows: [] };
  }
}

// ============================================================================
// Test fixture constants
// ============================================================================

var SP_MO      = 'ZZTEST-MO-1';
var SP_MAT_A   = 'ZZTEST-MAT-A';
var SP_MAT_B   = 'ZZTEST-MAT-B';
var SP_BATCH   = '0000094815';
var SP_PID_01  = 'PL-TEST-DESK-01';
var SP_PID_02  = 'PL-TEST-DESK-02';

// T8/T9 fixtures — ProductGroup join test
var SP_MO_PG       = 'ZZTEST-MO-PG';
var SP_MAT_PG      = 'ZZTEST-MAT-001';
var SP_PID_PG      = 'PL-TEST-PM-001';
var SP_MAT_PG_GROUP = 'ZZTEST-GRP';

// ============================================================================
// Test helpers — private
// ============================================================================

/**
 * Seed 3 PalletMaster fixture rows.
 * Rows 01/02: existing T1–T7 fixtures (MO=ZZTEST-MO-1, Materials A/B).
 * Row PG: T8 fixture (MO=ZZTEST-MO-PG, Material=ZZTEST-MAT-001) — separate MO
 *   so T1 row-count assertion (exactly 2 rows for SP_MO) is not disturbed.
 * Batch uses format-then-value pattern to preserve leading zeros.
 * Row 01 has a real Date object in ProductionDate (proves serialization guard).
 * @private
 */
function _seedSearchFixtures_() {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh) throw new Error('_seedSearchFixtures_: PalletMaster sheet missing');

  var batchColIdx = PM_HEADERS.indexOf('Batch');

  var fixtures = [
    {
      PalletID:           SP_PID_01,
      ManufacturingOrder: SP_MO,
      Material:           SP_MAT_A,
      MaterialName:       'Test Material A',
      QtyPerPallet:       100,
      Unit:               'PC',
      PalletSeq:          1,
      TotalPallets:       2,
      WorkCenter:         'WC-TEST',
      ProductionDate:     new Date(2026, 5, 15),   // real Date object
      Status:             'CREATED',
      ScanStatus:         'PRINTED',
      QCStatus:           ''
    },
    {
      PalletID:           SP_PID_02,
      ManufacturingOrder: SP_MO,
      Material:           SP_MAT_B,
      MaterialName:       'Test Material B',
      QtyPerPallet:       200,
      Unit:               'PC',
      PalletSeq:          2,
      TotalPallets:       2,
      WorkCenter:         'WC-TEST',
      ProductionDate:     '',
      Status:             'PRINTED',
      ScanStatus:         'SCANNED',
      QCStatus:           'INSPECTED'
    },
    {
      PalletID:           SP_PID_PG,
      ManufacturingOrder: SP_MO_PG,
      Material:           SP_MAT_PG,
      MaterialName:       'Test Material PG',
      QtyPerPallet:       50,
      Unit:               'PC',
      PalletSeq:          1,
      TotalPallets:       1,
      WorkCenter:         'WC-TEST',
      ProductionDate:     '',
      Status:             'CREATED',
      ScanStatus:         '',
      QCStatus:           ''
    }
  ];

  fixtures.forEach(function(f) {
    var row = PM_HEADERS.map(function(h) {
      return f.hasOwnProperty(h) ? f[h] : '';
    });
    sh.appendRow(row);
    var newRow = sh.getLastRow();
    // Format-then-value: setNumberFormat BEFORE setValue preserves leading zeros
    if (batchColIdx >= 0) {
      sh.getRange(newRow, batchColIdx + 1)
        .setNumberFormat('@')
        .setValue(String(SP_BATCH));
    }
  });

  SpreadsheetApp.flush();
}

/**
 * Seed one MaterialMaster row for T8: Material=ZZTEST-MAT-001, ProductGroup=ZZTEST-GRP.
 * Uses MM_HEADERS from MaterialMaster.gs to build the row array by name.
 * @private
 */
function _seedMmFixture_() {
  var mmSh = getSpreadsheet_().getSheetByName('MaterialMaster');
  if (!mmSh) throw new Error('_seedMmFixture_: MaterialMaster sheet missing');
  var row = MM_HEADERS.map(function(h) {
    if (h === 'Material')     return SP_MAT_PG;
    if (h === 'ProductGroup') return SP_MAT_PG_GROUP;
    return '';
  });
  mmSh.appendRow(row);
  SpreadsheetApp.flush();
}

/**
 * Delete all PalletMaster rows whose PalletID starts with 'PL-TEST-'.
 * Also delete the ZZTEST-MAT-001 row from MaterialMaster (T8 fixture).
 * Scans bottom-up so row-number shifts don't affect earlier deletes.
 * @private
 */
function _cleanSearchFixtures_() {
  // ---- PalletMaster cleanup --------------------------------------------------
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (sh && sh.getLastRow() >= 2) {
    var data   = sh.getDataRange().getValues();
    var pidCol = data[0].indexOf('PalletID');
    if (pidCol >= 0) {
      for (var r = data.length - 1; r >= 1; r--) {
        if (String(data[r][pidCol] || '').indexOf('PL-TEST-') === 0) {
          sh.deleteRow(r + 1);
        }
      }
    }
  }

  // ---- MaterialMaster cleanup (T8 fixture row) --------------------------------
  var mmSh = getSpreadsheet_().getSheetByName('MaterialMaster');
  if (mmSh && mmSh.getLastRow() >= 2) {
    var mmData = mmSh.getDataRange().getValues();
    var matCol = mmData[0].indexOf('Material');
    if (matCol >= 0) {
      for (var mr = mmData.length - 1; mr >= 1; mr--) {
        if (String(mmData[mr][matCol] || '').trim() === SP_MAT_PG) {
          mmSh.deleteRow(mr + 1);
        }
      }
    }
  }

  SpreadsheetApp.flush();
}

// ============================================================================
// Individual test functions — each RETURNS boolean
// ============================================================================

/** T1: mode=mo, exact MO 'ZZTEST-MO-1' returns both fixtures. @return {boolean} */
function TEST_searchPallets_T1_moSearch() {
  var r = searchPallets({ mode: 'mo', value: SP_MO });
  var pass = true;
  if (!r.ok) { pass = false; Logger.log('T1: ok===false err=' + r.error); return pass; }
  var has01 = r.rows.some(function(row) { return row.PalletID === SP_PID_01; });
  var has02 = r.rows.some(function(row) { return row.PalletID === SP_PID_02; });
  if (!has01) { pass = false; Logger.log('T1: ' + SP_PID_01 + ' missing from results'); }
  if (!has02) { pass = false; Logger.log('T1: ' + SP_PID_02 + ' missing from results'); }
  if (r.rows.length !== 2)
    { pass = false; Logger.log('T1: expected 2 rows, got ' + r.rows.length); }
  return pass;
}

/** T2: mode=material, substring 'ZZTEST' matches both Material fixtures. @return {boolean} */
function TEST_searchPallets_T2_materialSearch() {
  var r = searchPallets({ mode: 'material', value: 'ZZTEST' });
  var pass = true;
  if (!r.ok) { pass = false; Logger.log('T2: ok===false err=' + r.error); return pass; }
  var has01 = r.rows.some(function(row) { return row.PalletID === SP_PID_01; });
  var has02 = r.rows.some(function(row) { return row.PalletID === SP_PID_02; });
  if (!has01) { pass = false; Logger.log('T2: ' + SP_PID_01 + ' missing from results'); }
  if (!has02) { pass = false; Logger.log('T2: ' + SP_PID_02 + ' missing from results'); }
  if (r.rows.length < 2)
    { pass = false; Logger.log('T2: expected >=2 rows, got ' + r.rows.length); }
  return pass;
}

/** T3: mode=palletId, substring 'PL-TEST' matches fixtures. @return {boolean} */
function TEST_searchPallets_T3_palletIdSearch() {
  var r = searchPallets({ mode: 'palletId', value: 'PL-TEST' });
  var pass = true;
  if (!r.ok) { pass = false; Logger.log('T3: ok===false err=' + r.error); return pass; }
  var has01 = r.rows.some(function(row) { return row.PalletID === SP_PID_01; });
  var has02 = r.rows.some(function(row) { return row.PalletID === SP_PID_02; });
  if (!has01) { pass = false; Logger.log('T3: ' + SP_PID_01 + ' missing from results'); }
  if (!has02) { pass = false; Logger.log('T3: ' + SP_PID_02 + ' missing from results'); }
  if (r.rows.length < 2)
    { pass = false; Logger.log('T3: expected >=2 rows, got ' + r.rows.length); }
  return pass;
}

/** T4: no-match value returns ok:true, rows empty, must NOT throw. @return {boolean} */
function TEST_searchPallets_T4_noMatch() {
  var r = searchPallets({ mode: 'palletId', value: 'ZZNO-MATCH-XYZ-999999' });
  var pass = true;
  if (!r.ok) { pass = false; Logger.log('T4: ok===false err=' + r.error); }
  if (r.rows.length !== 0)
    { pass = false; Logger.log('T4: expected 0 rows, got ' + r.rows.length); }
  return pass;
}

/** T5: ProductionDate in returned row is typeof 'string' (no raw Date leaked). @return {boolean} */
function TEST_searchPallets_T5_dateIsString() {
  var r = searchPallets({ mode: 'mo', value: SP_MO });
  var pass = true;
  if (!r.ok) { pass = false; Logger.log('T5: ok===false'); return pass; }
  // Find PL-TEST-DESK-01 — it was seeded with a real Date object
  var row01 = null;
  r.rows.forEach(function(row) { if (row.PalletID === SP_PID_01) row01 = row; });
  if (!row01) { pass = false; Logger.log('T5: ' + SP_PID_01 + ' not found'); return pass; }
  if (typeof row01.ProductionDate !== 'string')
    { pass = false; Logger.log('T5: ProductionDate typeof=' + typeof row01.ProductionDate + ' expected string'); }
  return pass;
}

/** T6: Batch === '0000094815' exactly (leading zeros preserved). @return {boolean} */
function TEST_searchPallets_T6_batchLeadingZeros() {
  var r = searchPallets({ mode: 'mo', value: SP_MO });
  var pass = true;
  if (!r.ok) { pass = false; Logger.log('T6: ok===false'); return pass; }
  r.rows.forEach(function(row) {
    if (row.PalletID !== SP_PID_01 && row.PalletID !== SP_PID_02) return;
    if (row.Batch !== SP_BATCH)
      { pass = false; Logger.log('T6: ' + row.PalletID + ' Batch="' + row.Batch + '" expected "' + SP_BATCH + '"'); }
  });
  return pass;
}

/** T7: JSON.stringify(result) round-trips without throwing (JSON-safe guard). @return {boolean} */
function TEST_searchPallets_T7_jsonSafe() {
  var r = searchPallets({ mode: 'mo', value: SP_MO });
  var pass = true;
  try {
    var str = JSON.stringify(r);
    var rt  = JSON.parse(str);
    if (!rt || rt.rows.length !== r.rows.length)
      { pass = false; Logger.log('T7: round-trip row count mismatch'); }
  } catch (e) {
    pass = false;
    Logger.log('T7: JSON.stringify threw: ' + e.message);
  }
  return pass;
}

/**
 * T8: Material with a matching MaterialMaster row returns productGroup from that row.
 * Requires _seedMmFixture_() to have inserted ZZTEST-MAT-001 / ZZTEST-GRP.
 * @return {boolean}
 */
function TEST_searchPallets_T8_productGroupJoin() {
  var r = searchPallets({ mode: 'material', value: SP_MAT_PG });
  var pass = true;
  if (!r.ok) { pass = false; Logger.log('T8: ok===false err=' + r.error); return pass; }
  var matched = null;
  r.rows.forEach(function(row) { if (row.PalletID === SP_PID_PG) matched = row; });
  if (!matched) { pass = false; Logger.log('T8: no row with PalletID=' + SP_PID_PG); return pass; }
  if (matched.productGroup !== SP_MAT_PG_GROUP)
    { pass = false; Logger.log('T8: productGroup="' + matched.productGroup + '" expected "' + SP_MAT_PG_GROUP + '"'); }
  return pass;
}

/**
 * T9: Material with NO MaterialMaster entry returns productGroup === '' exactly
 *     (not undefined, not null, not a thrown exception).
 * Uses SP_PID_01 (Material=ZZTEST-MAT-A) which has no MaterialMaster row.
 * @return {boolean}
 */
function TEST_searchPallets_T9_noProductGroup() {
  var r = searchPallets({ mode: 'mo', value: SP_MO });
  var pass = true;
  if (!r.ok) { pass = false; Logger.log('T9: ok===false'); return pass; }
  var matched = null;
  r.rows.forEach(function(row) { if (row.PalletID === SP_PID_01) matched = row; });
  if (!matched) { pass = false; Logger.log('T9: ' + SP_PID_01 + ' not found'); return pass; }
  if (matched.productGroup === undefined || matched.productGroup === null)
    { pass = false; Logger.log('T9: productGroup is undefined/null, expected empty string'); }
  if (matched.productGroup !== '')
    { pass = false; Logger.log('T9: productGroup="' + matched.productGroup + '" expected ""'); }
  return pass;
}

// ============================================================================
// Runner
// ============================================================================

/**
 * Run all 9 searchPallets tests. Fixtures seeded once; self-cleaned in finally.
 * Runner pre-cleans any PL-TEST-* leftover from prior interrupted runs,
 * and any stale ZZTEST-MAT-001 row in MaterialMaster.
 * @return {boolean} true only when all tests pass
 */
function TEST_searchPallets_runAll() {
  var tests = [
    { name: 'T1_moSearch',          fn: TEST_searchPallets_T1_moSearch },
    { name: 'T2_materialSearch',    fn: TEST_searchPallets_T2_materialSearch },
    { name: 'T3_palletIdSearch',    fn: TEST_searchPallets_T3_palletIdSearch },
    { name: 'T4_noMatch',           fn: TEST_searchPallets_T4_noMatch },
    { name: 'T5_dateIsString',      fn: TEST_searchPallets_T5_dateIsString },
    { name: 'T6_batchLeadingZeros', fn: TEST_searchPallets_T6_batchLeadingZeros },
    { name: 'T7_jsonSafe',          fn: TEST_searchPallets_T7_jsonSafe },
    { name: 'T8_productGroupJoin',  fn: TEST_searchPallets_T8_productGroupJoin },
    { name: 'T9_noProductGroup',    fn: TEST_searchPallets_T9_noProductGroup }
  ];

  _cleanSearchFixtures_(); // pre-clean any stale rows from a prior interrupted run

  try {
    _seedSearchFixtures_();
    _seedMmFixture_();

    var allPass = true;
    var lines   = [];

    tests.forEach(function(t) {
      var verdict;
      try {
        verdict = t.fn();
      } catch (e) {
        verdict = false;
        Logger.log(t.name + ' EXCEPTION: ' + e.message);
      }
      var pass = (verdict !== false);
      if (!pass) {
        allPass = false;
        Logger.log('❌ ' + t.name + ' FAILED');
      }
      lines.push((pass ? 'PASS' : 'FAIL') + '  ' + t.name);
    });

    var summary = lines.join('\n');
    var footer  = allPass ? '✓ ALL PASS' : '✗ FAILURES DETECTED';
    Logger.log('=== searchPallets Tests ===\n' + summary + '\n' + footer);
    logEvent('TEST', 'TEST_searchPallets_runAll', allPass ? 'ALL_PASS' : 'FAILURES', 0, summary);

    try {
      SpreadsheetApp.getUi().alert('searchPallets Tests\n\n' + summary + '\n\n' + footer);
    } catch (uiErr) { /* headless run — no UI */ }

    return allPass;

  } finally {
    _cleanSearchFixtures_();
  }
}

// ============================================================================
// getMachinesForStepWorkCenter — READ-ONLY, admin-gated (Phase 6.2c)
// ============================================================================

/**
 * Return all active machines in the Department that owns a given SAP work center.
 * Two-pass logic: Pass 1 resolves WC → Department; Pass 2 collects all active
 * machines in that Department — so the operator can pick the actual machine used
 * when multiple machines of the same type share a department/WC group.
 *
 * SAPWorkCenter supports semicolon-separated multi-WC entries.
 * Pass 1 scans ALL rows (active or not) to find the WC→Dept mapping.
 * If >1 distinct Department maps to the same WC, logs a warning and uses the first.
 * Returns machines:[] + department:null (not an error) when WC not found.
 * Admin-gated (same guard as searchPallets).
 *
 * @param {string} workCenter — SAP WC code e.g. '0101-02'; '' = no filter (all active)
 * @return {{ ok:boolean, machines:Array<{code:string,name:string}>, department:string|null, error?:string }}
 */
function getMachinesForStepWorkCenter(workCenter) {
  if (!isAdminUser_()) return { ok: false, error: 'NOT_ADMIN', machines: [], department: null };
  try {
    workCenter = String(workCenter || '').trim();

    var sh = getSpreadsheet_().getSheetByName(MCH_SHEET);
    if (!sh || sh.getLastRow() < 2) return { ok: true, machines: [], department: null };

    var data = sh.getDataRange().getValues();
    var hdr  = data[0];
    var idx  = {};
    hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

    // ── PASS 1: resolve WC → Department (scan all rows, active or not) ──────
    var dept      = null;
    var deptExtra = [];

    if (workCenter) {
      for (var r1 = 1; r1 < data.length; r1++) {
        var code1 = String(data[r1][idx['MachineCode']] == null ? '' : data[r1][idx['MachineCode']]).trim();
        if (!code1) continue;

        var wcRaw   = _normSapWc_(data[r1][idx['SAPWorkCenter']]);
        var wcParts = wcRaw.split(';').map(function(p) { return p.trim(); }).filter(Boolean);
        if (wcParts.indexOf(workCenter) === -1) continue;

        var rowDept = String(data[r1][idx['Department']] == null ? '' : data[r1][idx['Department']]).trim();
        if (dept === null) {
          dept = rowDept;
        } else if (rowDept !== dept && deptExtra.indexOf(rowDept) === -1) {
          deptExtra.push(rowDept);
        }
      }

      if (deptExtra.length > 0) {
        logEvent('WARN_WC_DEPT_AMBIGUOUS', MCH_SHEET, 'WARN', 0,
          'wc=' + workCenter + ' dept=' + dept + ' also=' + deptExtra.join(';') +
          ' — using first match');
      }

      // WC not found in any row → return empty (no machines for this WC)
      if (dept === null) {
        return JSON.parse(JSON.stringify({ ok: true, machines: [], department: null }));
      }
    }

    // ── PASS 2: collect all active machines in that Department ───────────────
    var machines = [];
    for (var r2 = 1; r2 < data.length; r2++) {
      var code2 = String(data[r2][idx['MachineCode']] == null ? '' : data[r2][idx['MachineCode']]).trim();
      if (!code2) continue;

      var activeRaw = data[r2][idx['Active']];
      if (activeRaw === false || String(activeRaw || '').trim().toUpperCase() === 'FALSE') continue;

      if (dept !== null) {
        var rowDept2 = String(data[r2][idx['Department']] == null ? '' : data[r2][idx['Department']]).trim();
        if (rowDept2 !== dept) continue;
      }

      machines.push({
        code: code2,
        name: String(data[r2][idx['MachineName']] == null ? '' : data[r2][idx['MachineName']]).trim()
      });
    }

    machines.sort(function(a, b) {
      if (a.code < b.code) return -1;
      if (a.code > b.code) return 1;
      return 0;
    });

    return JSON.parse(JSON.stringify({ ok: true, machines: machines, department: dept }));

  } catch (e) {
    logError('getMachinesForStepWorkCenter', MCH_SHEET, e.message, 'wc=' + workCenter);
    return { ok: false, error: e.message, machines: [], department: null };
  }
}

// Backward-compat wrapper — Tests.gs and any other caller can keep using this name.
function getMachinesForWorkCenter(workCenter) {
  return getMachinesForStepWorkCenter(workCenter);
}

// ============================================================================
// TEST — getMachinesForStepWorkCenter (Phase 6.2c)
// ============================================================================

/**
 * TEST_getMachinesForStepWorkCenter: run from Apps Script Editor.
 * READ-ONLY — no fixture inserts; asserts against live MachineMaster data.
 * (a) empty WC → all active machines returned, count > 0, department=null
 * (b) '0101-02' → department non-null, machines.length > 1 (dept-wide list),
 *     prints actual codes for Kor to eyeball-verify against MachineMaster sheet
 * (c) unknown WC 'ZZZZZ-99' → ok:true, empty array, department=null
 * (d) JSON round-trip safe (no Date/Object[] leaks)
 * (e) result sorted by code ascending
 * (f) Step 0 #3 ambiguity check — no WC maps to >1 distinct Department
 */
function TEST_getMachinesForStepWorkCenter() {
  var results = [];
  var pass    = true;

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  _machineMasterCache_ = null;

  // (a) empty WC → all active machines, department=null
  var rAll = getMachinesForStepWorkCenter('');
  assert('(a) ok=true', rAll.ok === true, JSON.stringify({ ok: rAll.ok, error: rAll.error }));
  assert('(a) machines is array', Array.isArray(rAll.machines), 'type=' + typeof rAll.machines);
  assert('(a) count > 0', rAll.machines.length > 0, 'count=' + rAll.machines.length);
  assert('(a) department=null for empty WC', rAll.department === null, 'dept=' + rAll.department);

  // (b) '0101-02' → dept-wide list (multiple machines expected)
  Logger.log('');
  Logger.log('── (b) getMachinesForStepWorkCenter("0101-02") ──');
  var r02 = getMachinesForStepWorkCenter('0101-02');
  assert('(b) ok=true', r02.ok === true, JSON.stringify({ ok: r02.ok, error: r02.error }));
  assert('(b) department non-null', r02.department !== null, 'dept=' + r02.department);
  assert('(b) machines.length > 1 (dept-wide, not 1:1 WC)', r02.machines.length > 1,
    'count=' + r02.machines.length);
  assert('(b) each entry has code+name', r02.machines.every(function(m) {
    return typeof m.code === 'string' && m.code.length > 0 && typeof m.name === 'string';
  }), r02.machines.length > 0 ? 'sample=' + JSON.stringify(r02.machines[0]) : 'empty');
  Logger.log('  department : "' + r02.department + '"');
  Logger.log('  count      : ' + r02.machines.length);
  Logger.log('  machines   : ' + r02.machines.map(function(m) { return m.code; }).join(', '));
  Logger.log('  ← Kor: eyeball-verify this list against MachineMaster sheet for dept "' +
    r02.department + '"');

  // (c) unknown WC → ok:true, empty array, department=null
  var rBad = getMachinesForStepWorkCenter('ZZZZZ-99');
  assert('(c) ok=true for unknown WC', rBad.ok === true);
  assert('(c) empty array for unknown WC',
    Array.isArray(rBad.machines) && rBad.machines.length === 0,
    'count=' + (rBad.machines ? rBad.machines.length : 'n/a'));
  assert('(c) department=null for unknown WC', rBad.department === null,
    'dept=' + rBad.department);

  // (d) JSON round-trip
  var serialized = JSON.parse(JSON.stringify(r02));
  assert('(d) JSON safe', serialized.ok === true &&
    serialized.machines.length === r02.machines.length &&
    serialized.department === r02.department);

  // (e) sorted by code ascending
  if (r02.machines.length >= 2) {
    var isSorted = true;
    for (var i = 0; i + 1 < r02.machines.length; i++) {
      if (r02.machines[i].code > r02.machines[i + 1].code) { isSorted = false; break; }
    }
    assert('(e) sorted by code',  isSorted,
      'first=' + r02.machines[0].code + ' second=' + r02.machines[1].code);
  }

  // (f) Step 0 #3: confirm no WC maps to >1 distinct Department in MachineMaster
  Logger.log('');
  Logger.log('── (f) WC→Department ambiguity check ──');
  var sh = getSpreadsheet_().getSheetByName(MCH_SHEET);
  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var hi   = {};
  hdr.forEach(function(h, i) { hi[String(h).trim()] = i; });
  var wcDeptMap = {};
  for (var r = 1; r < data.length; r++) {
    var wcRaw = _normSapWc_(data[r][hi['SAPWorkCenter']]);
    var dept  = String(data[r][hi['Department']] == null ? '' : data[r][hi['Department']]).trim();
    wcRaw.split(';').map(function(p) { return p.trim(); }).filter(Boolean).forEach(function(w) {
      if (!wcDeptMap[w]) wcDeptMap[w] = {};
      wcDeptMap[w][dept] = true;
    });
  }
  var ambiguous = Object.keys(wcDeptMap).filter(function(w) {
    return Object.keys(wcDeptMap[w]).length > 1;
  });
  assert('(f) no WC maps to >1 Department', ambiguous.length === 0,
    ambiguous.length > 0 ? 'ambiguous: ' + ambiguous.map(function(w) {
      return w + '→[' + Object.keys(wcDeptMap[w]).join(',') + ']';
    }).join('; ') : 'clean');
  if (ambiguous.length === 0) Logger.log('  All WC→Department mappings are 1:1 — no tie-break needed');

  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_getMachinesForStepWorkCenter: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name +
      (results[si].detail ? ' (' + results[si].detail + ')' : ''));
  }
}

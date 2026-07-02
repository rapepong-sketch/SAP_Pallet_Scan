/**
 * DesktopSearch.gs — Phase 6.1 / 6.2c / 6.6: Desktop Companion WebApp Search Backend
 * ==============================================================================
 * Phase 6.1  — READ-ONLY pallet search for Desktop Companion WebApp.
 * Phase 6.2c — getMachinesForStepWorkCenter: department-based machine dropdown for Desktop confirm modal.
 * Phase 6.6  — getQcWorklist: READ-ONLY QC worklist (pallets ready for inspection) by StorageLocation.
 * ZERO SAP writes. No feature flag.
 *
 * Public API (called via google.script.run from Desktop.html):
 *   searchPallets({mode, value})                — admin-gated full-text search on PalletMaster.
 *   getMachinesForStepWorkCenter(workCenter)     — admin-gated dept-based machine list for confirm modal.
 *   getMachinesForWorkCenter(workCenter)         — backward-compat wrapper → getMachinesForStepWorkCenter.
 *   getQcWorklist(storageLocation, productGroup, material) — admin-gated wrapper → getQcWorklist_.
 *
 * Test suite:
 *   TEST_searchPallets_runAll()                  — self-cleaning hermetic 9-test runner.
 *   TEST_getMachinesForStepWorkCenter()          — read-only assertions against live MachineMaster.
 *   TEST_getQcWorklist_()                        — self-cleaning hermetic test, returns true/false.
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

// ============================================================================
// getQcWorklist — READ-ONLY, admin-gated (Phase 6.6)
// ============================================================================

/**
 * List PalletMaster rows ready for QC inspection (ScanStatus === 'PD_COMPLETE')
 * in a given StorageLocation, optionally narrowed by ProductGroup and/or Material.
 * READ-ONLY — no sheet writes. Internal — not admin-gated itself (see getQcWorklist()
 * public wrapper); callable directly by tests.
 *
 * @param {string} storageLocation — required; exact match. Empty → no rows.
 * @param {string} [productGroup]  — optional; exact match, joined via MaterialMaster.
 * @param {string} [material]      — optional; exact match against Material.
 * @return {Array<{PalletID:string, Material:string, MaterialName:string, Batch:string,
 *   ProductGroup:string, WorkCenter:string, QtyPerPallet:number, ProductionDate:string,
 *   StorageLocation:string}>} sorted by ProductGroup asc, then PalletID asc.
 */
function getQcWorklist_(storageLocation, productGroup, material) {
  storageLocation = String(storageLocation || '').trim();
  productGroup    = String(productGroup    || '').trim();
  material        = String(material        || '').trim();

  if (!storageLocation) return [];

  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  var pgMap = _buildProductGroupMap_();

  var OUTPUT_FIELDS = [
    'PalletID', 'Material', 'MaterialName', 'Batch', 'ProductGroup',
    'WorkCenter', 'QtyPerPallet', 'ProductionDate', 'StorageLocation'
  ];

  var rows = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];

    var sloc       = String(row[idx['StorageLocation']] || '').trim();
    var scanStatus = String(row[idx['ScanStatus']]       || '').trim();
    var mat        = String(row[idx['Material']]         || '').trim();

    if (sloc !== storageLocation) continue;
    if (scanStatus !== 'PD_COMPLETE') continue;

    var pg = pgMap[mat] || '';
    if (productGroup && pg !== productGroup) continue;
    if (material && mat !== material) continue;

    var obj = {};
    OUTPUT_FIELDS.forEach(function(f) {
      if (f === 'ProductGroup')    { obj[f] = pg;   return; }
      if (f === 'Material')        { obj[f] = mat;  return; }
      if (f === 'StorageLocation') { obj[f] = sloc; return; }

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

      } else if (f === 'QtyPerPallet') {
        obj[f] = Number(raw) || 0;

      } else {
        obj[f] = String(raw || '');
      }
    });

    rows.push(obj);
  }

  rows.sort(function(a, b) {
    if (a.ProductGroup !== b.ProductGroup) return a.ProductGroup < b.ProductGroup ? -1 : 1;
    if (a.PalletID     !== b.PalletID)     return a.PalletID     < b.PalletID     ? -1 : 1;
    return 0;
  });

  // SERIALIZATION GUARD: JSON round-trip strips any residual non-serializable values
  return JSON.parse(JSON.stringify(rows));
}

/**
 * Public google.script.run wrapper for getQcWorklist_ — admin-gated (same guard
 * as searchPallets / getMachinesForStepWorkCenter).
 *
 * @param {string} storageLocation
 * @param {string} [productGroup]
 * @param {string} [material]
 * @return {{ ok:boolean, rows:Array, error?:string }}
 */
function getQcWorklist(storageLocation, productGroup, material) {
  if (!isAdminUser_()) return { ok: false, error: 'NOT_ADMIN', rows: [] };
  try {
    var rows = getQcWorklist_(storageLocation, productGroup, material);
    logEvent('QC_WORKLIST', 'PalletMaster', 'OK', 0,
      'sloc=' + storageLocation + ' pg=' + (productGroup || '') +
      ' mat=' + (material || '') + ' rows=' + rows.length);
    return { ok: true, rows: rows };
  } catch (e) {
    logError('getQcWorklist', 'PalletMaster', e.message,
      JSON.stringify({ storageLocation: storageLocation, productGroup: productGroup, material: material }));
    return { ok: false, error: e.message, rows: [] };
  }
}

// ============================================================================
// TEST — getQcWorklist_ (Phase 6.6) — self-cleaning, hermetic, returns boolean
// ============================================================================

var QW_SLOC       = 'ZZTEST-QCWL-SLOC';
var QW_SLOC_OTHER = 'ZZTEST-QCWL-SLOC-OTHER';
var QW_PG_A       = 'ZZTEST-QCWL-GRP-A';
var QW_PG_B       = 'ZZTEST-QCWL-GRP-B';
var QW_MAT_A      = 'ZZTEST-QCWL-MAT-A';
var QW_MAT_B      = 'ZZTEST-QCWL-MAT-B';
var QW_BATCH      = '0000512345';

var QW_PID_A0 = 'PL-TEST-QCWL-A0'; // PD_COMPLETE, target SLOC, MAT_A/GRP_A
var QW_PID_A1 = 'PL-TEST-QCWL-A1'; // PD_COMPLETE, target SLOC, MAT_A/GRP_A (Date ProductionDate)
var QW_PID_B1 = 'PL-TEST-QCWL-B1'; // PD_COMPLETE, target SLOC, MAT_B/GRP_B
var QW_PID_C1 = 'PL-TEST-QCWL-C1'; // QC_COMPLETE, target SLOC — already inspected, must NOT appear
var QW_PID_D1 = 'PL-TEST-QCWL-D1'; // SCANNED, target SLOC — not yet all-ops-done, must NOT appear
var QW_PID_E1 = 'PL-TEST-QCWL-E1'; // PD_COMPLETE, OTHER SLOC — wrong location, must NOT appear

/**
 * Seed 6 PalletMaster fixture rows + 2 MaterialMaster fixture rows for getQcWorklist_ tests.
 * @private
 */
function _seedQcWorklistFixtures_() {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh) throw new Error('_seedQcWorklistFixtures_: PalletMaster sheet missing');

  var batchColIdx = PM_HEADERS.indexOf('Batch');

  var fixtures = [
    { PalletID: QW_PID_A0, Material: QW_MAT_A, MaterialName: 'QCWL Test A',
      QtyPerPallet: 10, Unit: 'PC', WorkCenter: 'WC-TEST', ProductionDate: '',
      StorageLocation: QW_SLOC, Status: 'PRINTED', ScanStatus: 'PD_COMPLETE', QCStatus: '' },
    { PalletID: QW_PID_A1, Material: QW_MAT_A, MaterialName: 'QCWL Test A',
      QtyPerPallet: 20, Unit: 'PC', WorkCenter: 'WC-TEST', ProductionDate: new Date(2026, 5, 20),
      StorageLocation: QW_SLOC, Status: 'PRINTED', ScanStatus: 'PD_COMPLETE', QCStatus: '' },
    { PalletID: QW_PID_B1, Material: QW_MAT_B, MaterialName: 'QCWL Test B',
      QtyPerPallet: 30, Unit: 'PC', WorkCenter: 'WC-TEST', ProductionDate: '',
      StorageLocation: QW_SLOC, Status: 'PRINTED', ScanStatus: 'PD_COMPLETE', QCStatus: '' },
    { PalletID: QW_PID_C1, Material: QW_MAT_A, MaterialName: 'QCWL Test A',
      QtyPerPallet: 40, Unit: 'PC', WorkCenter: 'WC-TEST', ProductionDate: '',
      StorageLocation: QW_SLOC, Status: 'PRINTED', ScanStatus: 'QC_COMPLETE', QCStatus: 'INSPECTED' },
    { PalletID: QW_PID_D1, Material: QW_MAT_A, MaterialName: 'QCWL Test A',
      QtyPerPallet: 50, Unit: 'PC', WorkCenter: 'WC-TEST', ProductionDate: '',
      StorageLocation: QW_SLOC, Status: 'PRINTED', ScanStatus: 'SCANNED', QCStatus: '' },
    { PalletID: QW_PID_E1, Material: QW_MAT_A, MaterialName: 'QCWL Test A',
      QtyPerPallet: 60, Unit: 'PC', WorkCenter: 'WC-TEST', ProductionDate: '',
      StorageLocation: QW_SLOC_OTHER, Status: 'PRINTED', ScanStatus: 'PD_COMPLETE', QCStatus: '' }
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
        .setValue(String(QW_BATCH));
    }
  });

  var mmSh = getSpreadsheet_().getSheetByName('MaterialMaster');
  if (!mmSh) throw new Error('_seedQcWorklistFixtures_: MaterialMaster sheet missing');
  [[QW_MAT_A, QW_PG_A], [QW_MAT_B, QW_PG_B]].forEach(function(pair) {
    var row = MM_HEADERS.map(function(h) {
      if (h === 'Material')     return pair[0];
      if (h === 'ProductGroup') return pair[1];
      return '';
    });
    mmSh.appendRow(row);
  });

  SpreadsheetApp.flush();
}

/**
 * Delete all PalletMaster rows whose PalletID starts with 'PL-TEST-QCWL-',
 * and the QW_MAT_A / QW_MAT_B rows from MaterialMaster. Scans bottom-up.
 * @private
 */
function _cleanQcWorklistFixtures_() {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (sh && sh.getLastRow() >= 2) {
    var data   = sh.getDataRange().getValues();
    var pidCol = data[0].indexOf('PalletID');
    if (pidCol >= 0) {
      for (var r = data.length - 1; r >= 1; r--) {
        if (String(data[r][pidCol] || '').indexOf('PL-TEST-QCWL-') === 0) {
          sh.deleteRow(r + 1);
        }
      }
    }
  }

  var mmSh = getSpreadsheet_().getSheetByName('MaterialMaster');
  if (mmSh && mmSh.getLastRow() >= 2) {
    var mmData = mmSh.getDataRange().getValues();
    var matCol = mmData[0].indexOf('Material');
    if (matCol >= 0) {
      for (var mr = mmData.length - 1; mr >= 1; mr--) {
        var m = String(mmData[mr][matCol] || '').trim();
        if (m === QW_MAT_A || m === QW_MAT_B) mmSh.deleteRow(mr + 1);
      }
    }
  }

  SpreadsheetApp.flush();
}

/**
 * TEST_getQcWorklist_: self-cleaning, hermetic. Returns true only if every
 * assertion passes; returns false (never throws past this point) otherwise.
 * @return {boolean}
 */
function TEST_getQcWorklist_() {
  var pass = true;

  function assertEq(name, actual, expected) {
    var ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
      pass = false;
      Logger.log('❌ ' + name + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
    } else {
      Logger.log('PASS  ' + name);
    }
    return ok;
  }

  function pids(rows) { return rows.map(function(r) { return r.PalletID; }); }

  _cleanQcWorklistFixtures_(); // pre-clean any stale rows from a prior interrupted run

  try {
    _seedQcWorklistFixtures_();

    try {
      // (1) No filters — target SLOC only: A0, A1, B1 in ProductGroup-then-PalletID order.
      //     C1 (QC_COMPLETE), D1 (SCANNED), E1 (other SLOC) must all be excluded.
      var r1 = getQcWorklist_(QW_SLOC);
      assertEq('T1 no-filter row set/order', pids(r1), [QW_PID_A0, QW_PID_A1, QW_PID_B1]);

      // (2) productGroup=GRP_A — only A0, A1.
      var r2 = getQcWorklist_(QW_SLOC, QW_PG_A);
      assertEq('T2 productGroup=GRP_A', pids(r2), [QW_PID_A0, QW_PID_A1]);

      // (3) productGroup=GRP_B — only B1.
      var r3 = getQcWorklist_(QW_SLOC, QW_PG_B);
      assertEq('T3 productGroup=GRP_B', pids(r3), [QW_PID_B1]);

      // (4) material=MAT_B — only B1.
      var r4 = getQcWorklist_(QW_SLOC, '', QW_MAT_B);
      assertEq('T4 material=MAT_B', pids(r4), [QW_PID_B1]);

      // (5) Contradictory filters (GRP_A + MAT_B) — empty (AND, not OR).
      var r5 = getQcWorklist_(QW_SLOC, QW_PG_A, QW_MAT_B);
      assertEq('T5 contradictory filters', pids(r5), []);

      // (6) Different StorageLocation — only E1.
      var r6 = getQcWorklist_(QW_SLOC_OTHER);
      assertEq('T6 other StorageLocation', pids(r6), [QW_PID_E1]);

      // (7) Missing storageLocation — empty, no throw.
      var r7 = getQcWorklist_('');
      assertEq('T7 missing storageLocation', pids(r7), []);

      // (8) Field shape: exactly the 9 documented fields, no extras.
      var expectedFields = ['PalletID', 'Material', 'MaterialName', 'Batch', 'ProductGroup',
        'WorkCenter', 'QtyPerPallet', 'ProductionDate', 'StorageLocation'];
      if (r1.length > 0) {
        var actualFields = Object.keys(r1[0]).sort();
        assertEq('T8 field shape', actualFields, expectedFields.slice().sort());
      } else {
        pass = false;
        Logger.log('❌ T8 field shape: r1 unexpectedly empty, cannot check shape');
      }

      // (9) ProductGroup values correct per row.
      var byId = {};
      r1.forEach(function(row) { byId[row.PalletID] = row; });
      assertEq('T9 A0 ProductGroup', byId[QW_PID_A0] ? byId[QW_PID_A0].ProductGroup : null, QW_PG_A);
      assertEq('T9 A1 ProductGroup', byId[QW_PID_A1] ? byId[QW_PID_A1].ProductGroup : null, QW_PG_A);
      assertEq('T9 B1 ProductGroup', byId[QW_PID_B1] ? byId[QW_PID_B1].ProductGroup : null, QW_PG_B);

      // (10) Batch leading zeros preserved.
      assertEq('T10 Batch leading zeros', byId[QW_PID_A0] ? byId[QW_PID_A0].Batch : null, QW_BATCH);

      // (11) ProductionDate never a raw Date — A1 was seeded with a real Date object.
      if (byId[QW_PID_A1]) {
        var dtOk = typeof byId[QW_PID_A1].ProductionDate === 'string';
        if (!dtOk) { pass = false; Logger.log('❌ T11 ProductionDate typeof=' + typeof byId[QW_PID_A1].ProductionDate); }
        else Logger.log('PASS  T11 ProductionDate is string');
      } else {
        pass = false;
        Logger.log('❌ T11: ' + QW_PID_A1 + ' not found in results');
      }

      // (12) JSON round-trip safe.
      try {
        var rt = JSON.parse(JSON.stringify(r1));
        assertEq('T12 JSON round-trip row count', rt.length, r1.length);
      } catch (jsonErr) {
        pass = false;
        Logger.log('❌ T12 JSON.stringify threw: ' + jsonErr.message);
      }

    } catch (innerErr) {
      pass = false;
      Logger.log('❌ TEST_getQcWorklist_ EXCEPTION during assertions: ' + innerErr.message);
    }

  } catch (seedErr) {
    pass = false;
    Logger.log('❌ TEST_getQcWorklist_ EXCEPTION during seeding: ' + seedErr.message);
  } finally {
    _cleanQcWorklistFixtures_();
  }

  Logger.log('========================================');
  Logger.log('TEST_getQcWorklist_: ' + (pass ? '✓ ALL PASS' : '✗ FAILURES DETECTED'));
  Logger.log('========================================');
  logEvent('TEST', 'TEST_getQcWorklist_', pass ? 'ALL_PASS' : 'FAILURES', 0, '');

  return pass;
}

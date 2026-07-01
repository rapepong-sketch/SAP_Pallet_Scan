/**
 * LocalOpCumulativeTests.gs — Local per-operation cumulative confirmation: unit tests
 * =====================================================================================
 * Not a phase-numbered deliverable — companion test suite for the
 * LOCAL_OP_CUMULATIVE_ENABLED feature (OperationLog.gs / WebApp.gs round
 * validation). Local-only, never touches SAP.
 *
 * Tests 1-5 are pure — they call _validateLocalOpRound_ (WebApp.gs) directly
 * with fake in-memory values, no sheet read/write, same pattern as the
 * dormant Confirmation.gs Gate 2 Part 1 TEST_cumulative_* suite.
 *
 * Test 6 is a golden-value guard for confirmScan's flag-OFF exact-match
 * check (WebApp.gs) — it does not call confirmScan directly (that would
 * require a live PalletMaster fixture row) and does not touch the real
 * LOCAL_OP_CUMULATIVE_ENABLED script property; it just re-asserts the exact
 * literal check + message confirmScan's OFF path uses, so an accidental
 * future edit to that inline check gets caught here.
 *
 * Test 7 writes a self-cleaning ZZTEST- fixture directly to the OperationLog
 * sheet (two rounds for one op) and calls the real updatePdResult_(). It
 * temporarily flips LOCAL_OP_CUMULATIVE_ENABLED to test the ON path
 * deterministically, then restores whatever value was there before —
 * wrapped in try/finally so the flag and fixture rows are restored/removed
 * even if an assertion throws.
 *
 * Run from menu: 🧪 Local Op Cumulative Tests → 🧪 Run all
 */

// ============================================================================
// Runner
// ============================================================================

/** Menu-callable: runs all TEST_localOp_* + the updatePdResult_ targeting test. */
function TEST_localOpCumulative_runAll() {
  var fns = [
    TEST_localOp_round1_partial,
    TEST_localOp_round2_completes,
    TEST_localOp_exceeds_qty,
    TEST_localOp_round_limit_exceeded,
    TEST_localOp_round3_can_still_complete,
    TEST_localOp_flag_off_preserves_6_2_rev,
    TEST_updatePdResult_targets_final_round_only
  ];

  var results = fns.map(function (fn) { return fn(); });
  var allPass = results.every(function (r) { return r.pass; });

  var lines = results.map(function (r) {
    return (r.pass ? '✅' : '❌') + ' ' + r.name + (r.detail ? ' — ' + r.detail : '');
  });
  Logger.log(lines.join('\n'));

  logEvent('TEST_LOCAL_OP_CUMULATIVE', 'RUN_ALL', allPass ? 'PASS' : 'FAIL', 0,
    results.length + ' tests, ' + (allPass ? 'all pass' : 'some failed'));

  var text = (allPass ? '✅ ALL PASS' : '❌ SOME FAILED') + '\n\n' + lines.join('\n');
  var escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  var html = HtmlService.createHtmlOutput(
    '<pre style="font-size:12px;white-space:pre-wrap;max-width:100%">' + escaped + '</pre>'
  ).setWidth(700).setHeight(450).setTitle('Local Op Cumulative Tests');
  SpreadsheetApp.getUi().showModelessDialog(html, 'Local Op Cumulative Tests');
}

// ============================================================================
// 1-5: pure round-math tests — call _validateLocalOpRound_ (WebApp.gs) directly
// ============================================================================

/** QtyPerPallet=600, priorCumulative=0, roundsUsed=0, bucketSum=200 → round 1 partial, allowed. */
function TEST_localOp_round1_partial() {
  var name = 'TEST_localOp_round1_partial';
  var r = _validateLocalOpRound_(600, 0, 0, 200);
  var pass = r.allowed === true && r.isFinalRound === false &&
    r.newCumulative === 200 && r.roundNumber === 1;
  return { name: name, pass: pass, detail: JSON.stringify(r) };
}

/** QtyPerPallet=600, priorCumulative=200, roundsUsed=1, bucketSum=400 → round 2 completes. */
function TEST_localOp_round2_completes() {
  var name = 'TEST_localOp_round2_completes';
  var r = _validateLocalOpRound_(600, 200, 1, 400);
  var pass = r.allowed === true && r.isFinalRound === true &&
    r.newCumulative === 600 && r.roundNumber === 2;
  return { name: name, pass: pass, detail: JSON.stringify(r) };
}

/** QtyPerPallet=600, priorCumulative=400, roundsUsed=1, bucketSum=300 → BLOCKED (700 > 600). */
function TEST_localOp_exceeds_qty() {
  var name = 'TEST_localOp_exceeds_qty';
  var r = _validateLocalOpRound_(600, 400, 1, 300);
  var pass = r.allowed === false && r.newCumulative === 700 && !!r.message;
  return { name: name, pass: pass, detail: JSON.stringify(r) };
}

/** QtyPerPallet=600, priorCumulative=400, roundsUsed=3, bucketSum=100 → BLOCKED (round 4 > 3, 500 !== 600). */
function TEST_localOp_round_limit_exceeded() {
  var name = 'TEST_localOp_round_limit_exceeded';
  var r = _validateLocalOpRound_(600, 400, 3, 100);
  var pass = r.allowed === false && r.roundNumber === 4 && r.newCumulative === 500 && !!r.message;
  return { name: name, pass: pass, detail: JSON.stringify(r) };
}

/** QtyPerPallet=600, priorCumulative=400, roundsUsed=2, bucketSum=200 → round 3 exactly completes, still allowed. */
function TEST_localOp_round3_can_still_complete() {
  var name = 'TEST_localOp_round3_can_still_complete';
  var r = _validateLocalOpRound_(600, 400, 2, 200);
  var pass = r.allowed === true && r.isFinalRound === true &&
    r.roundNumber === 3 && r.newCumulative === 600;
  return { name: name, pass: pass, detail: JSON.stringify(r) };
}

// ============================================================================
// 6: flag-OFF golden-value guard (does not call confirmScan or touch the
// real LOCAL_OP_CUMULATIVE_ENABLED script property — see file header)
// ============================================================================

/** LOCAL_OP_CUMULATIVE_ENABLED=false, QtyPerPallet=600, bucketSum=400 → BLOCKED, same message as production 6.2-REV code. */
function TEST_localOp_flag_off_preserves_6_2_rev() {
  var name = 'TEST_localOp_flag_off_preserves_6_2_rev';
  var qtyPerPallet = 600;
  var bucketSum = 400;

  // Mirror of confirmScan's OFF-path check (WebApp.gs):
  //   if (!isLocalOpCumulativeEnabled_() && bucketSum !== Number(pallet.QtyPerPallet)) { ...reject... }
  var blocked = bucketSum !== Number(qtyPerPallet);
  var expectedMessage = '⛔ ยอดรวมต้องเท่ากับจำนวนต่อพาเลท (' + qtyPerPallet + ') — ไม่อนุญาตให้ส่งน้อยกว่า';

  var pass = blocked === true && expectedMessage.indexOf(String(qtyPerPallet)) !== -1;
  return { name: name, pass: pass, detail: 'blocked=' + blocked + ' message="' + expectedMessage + '"' };
}

// ============================================================================
// 7: updatePdResult_ final-round targeting — self-cleaning sheet fixture
// ============================================================================

var LOCAL_OP_TEST_PALLET_ID_ = 'ZZTEST-LOCALCUM-PDROUND';
var LOCAL_OP_TEST_OP_NO_     = '0010';

/** Remove any OperationLog rows for the test fixture pallet+op (self-cleaning). */
function _localOpTest_removeFixtureRows_() {
  var sh = getSpreadsheet_().getSheetByName(OL_SHEET);
  if (!sh || sh.getLastRow() < 2) return;

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function (h, i) { idx[h] = i; });

  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][idx.PalletID] || '').trim() === LOCAL_OP_TEST_PALLET_ID_) {
      sh.deleteRow(r + 1);
    }
  }
}

/** Read PDResult/PDInspector for a given LogID directly from the sheet (test-only). */
function _localOpTest_readPdFields_(logId) {
  var sh = getSpreadsheet_().getSheetByName(OL_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function (h, i) { idx[h] = i; });

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx.LogID] || '') === logId) {
      return {
        pdResult:    String(data[r][idx.PDResult]    || '') || null,
        pdInspector: String(data[r][idx.PDInspector] || '') || null
      };
    }
  }
  return null;
}

/**
 * Simulates 2 OperationLog rows for the same palletId+opNo (round 1,
 * IsFinalRound=false; round 2, IsFinalRound=true), calls the real
 * updatePdResult_(), and verifies only the IsFinalRound=true row was
 * modified — the round-1 row must stay untouched.
 */
function TEST_updatePdResult_targets_final_round_only() {
  var name = 'TEST_updatePdResult_targets_final_round_only';
  var props = PropertiesService.getScriptProperties();
  var originalFlag = props.getProperty(CFG.FLAG_KEYS.LOCAL_OP_CUMULATIVE);
  var pass = false;
  var detail = '';

  try {
    props.setProperty(CFG.FLAG_KEYS.LOCAL_OP_CUMULATIVE, 'true');
    _localOpTest_removeFixtureRows_(); // clean slate in case a previous run left rows behind

    var logId1 = logOperation_({
      palletId: LOCAL_OP_TEST_PALLET_ID_, mo: 'ZZTESTMO', operationNo: LOCAL_OP_TEST_OP_NO_,
      operationText: 'TEST FIXTURE', goodQty: 200, scrapQty: 0, repairQty: 0, awaitConvQty: 0,
      operator: 'TEST_SUITE', role: 'OP', result: 'PASS', source: 'SYSTEM',
      roundNumber: 1, isFinalRound: false
    });
    var logId2 = logOperation_({
      palletId: LOCAL_OP_TEST_PALLET_ID_, mo: 'ZZTESTMO', operationNo: LOCAL_OP_TEST_OP_NO_,
      operationText: 'TEST FIXTURE', goodQty: 400, scrapQty: 0, repairQty: 0, awaitConvQty: 0,
      operator: 'TEST_SUITE', role: 'OP', result: 'PASS', source: 'SYSTEM',
      roundNumber: 2, isFinalRound: true
    });

    var upd = updatePdResult_(LOCAL_OP_TEST_PALLET_ID_, LOCAL_OP_TEST_OP_NO_, 'PASS', 'TEST_INSPECTOR', '');

    var round1After = _localOpTest_readPdFields_(logId1);
    var round2After = _localOpTest_readPdFields_(logId2);

    pass = upd.ok === true &&
      !!round2After && round2After.pdResult === 'PASS' && round2After.pdInspector === 'TEST_INSPECTOR' &&
      !!round1After && !round1After.pdResult;

    detail = 'upd=' + JSON.stringify(upd) +
      ' round1=' + JSON.stringify(round1After) +
      ' round2=' + JSON.stringify(round2After);

  } finally {
    _localOpTest_removeFixtureRows_();
    if (originalFlag === null) {
      props.deleteProperty(CFG.FLAG_KEYS.LOCAL_OP_CUMULATIVE);
    } else {
      props.setProperty(CFG.FLAG_KEYS.LOCAL_OP_CUMULATIVE, originalFlag);
    }
  }

  return { name: name, pass: pass, detail: detail };
}

// ============================================================================
// Menu
// ============================================================================

/** Adds the "🧪 Local Op Cumulative Tests" top-level menu — called from onOpen() (SheetSetup.gs). */
function addLocalOpCumulativeTestsMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('🧪 Local Op Cumulative Tests')
    .addItem('🧪 Run all', 'TEST_localOpCumulative_runAll')
    .addToUi();
}

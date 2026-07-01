/**
 * CumulativeConfirmTests.gs — Phase 6.5 Gate 2 Part 1: unit tests
 * ===================================================================
 * Pure unit-style tests of the cumulative/partial confirmation round math
 * (_validateCumulativeRound_ / _validateExactMatchConfirm_ in Confirmation.gs).
 * Fake in-memory values only — no SAP call, no sheet read/write, does not
 * require SAP_WRITE_ENABLED. Each test returns its own pass boolean based on
 * real assertions (not "didn't throw"), same convention as Phase45Tests.gs /
 * TEST_OLSchemaGuard.
 *
 * Run from menu: 🧪 Gate 2 Part 1 Tests → 🧪 Run all Gate 2 Part 1 tests
 */

// ============================================================================
// Individual scenarios
// ============================================================================

/** QtyPerPallet=600, Cumulative=0, Round=0, bucketSum=200 → partial round 1 allowed. */
function TEST_cumulative_round1_partial() {
  var name = 'TEST_cumulative_round1_partial';
  var r = _validateCumulativeRound_(600, 0, 0, 200);
  var pass = r.allowed === true && r.isCompletingRound === false &&
    r.newCumulative === 200 && r.nextRound === 1;
  return { name: name, pass: pass, detail: JSON.stringify(r) };
}

/** QtyPerPallet=600, Cumulative=200, Round=1, bucketSum=400 → round 2 completes. */
function TEST_cumulative_round2_completes() {
  var name = 'TEST_cumulative_round2_completes';
  var r = _validateCumulativeRound_(600, 200, 1, 400);
  var pass = r.allowed === true && r.isCompletingRound === true &&
    r.newCumulative === 600 && r.nextRound === 2;
  return { name: name, pass: pass, detail: JSON.stringify(r) };
}

/** QtyPerPallet=600, Cumulative=400, Round=1, bucketSum=300 → blocked, exceeds qty. */
function TEST_cumulative_exceeds_qty() {
  var name = 'TEST_cumulative_exceeds_qty';
  var r = _validateCumulativeRound_(600, 400, 1, 300);
  var pass = r.allowed === false && r.newCumulative === 700 &&
    typeof r.message === 'string' && r.message.length > 0;
  return { name: name, pass: pass, detail: JSON.stringify(r) };
}

/** QtyPerPallet=600, Cumulative=400, Round=3, bucketSum=100 → blocked, round limit exceeded. */
function TEST_cumulative_round_limit_exceeded() {
  var name = 'TEST_cumulative_round_limit_exceeded';
  var r = _validateCumulativeRound_(600, 400, 3, 100);
  var pass = r.allowed === false && r.nextRound === 4 && r.newCumulative === 500 &&
    typeof r.message === 'string' && r.message.length > 0;
  return { name: name, pass: pass, detail: JSON.stringify(r) };
}

/** QtyPerPallet=600, Cumulative=400, Round=2, bucketSum=200 → round 3 still allowed to complete. */
function TEST_cumulative_round3_can_still_complete() {
  var name = 'TEST_cumulative_round3_can_still_complete';
  var r = _validateCumulativeRound_(600, 400, 2, 200);
  var pass = r.allowed === true && r.isCompletingRound === true &&
    r.nextRound === 3 && r.newCumulative === 600;
  return { name: name, pass: pass, detail: JSON.stringify(r) };
}

/**
 * Flag OFF must still enforce exact-match-only (6.2-REV) — proves the
 * OFF path (_validateExactMatchConfirm_) is untouched by this change.
 * Also asserts isCumulativeConfirmEnabled_() actually reads false by
 * default, without ever setting the ScriptProperty to 'true'.
 */
function TEST_flag_off_preserves_6_2_rev_behavior() {
  var name = 'TEST_flag_off_preserves_6_2_rev_behavior';
  var flagOff = isCumulativeConfirmEnabled_() === false;
  var r = _validateExactMatchConfirm_(600, 400);
  var pass = flagOff && r.allowed === false &&
    typeof r.message === 'string' && r.message.length > 0;
  return { name: name, pass: pass, detail: 'flagOff=' + flagOff + ' result=' + JSON.stringify(r) };
}

// ============================================================================
// Runner + menu
// ============================================================================

/**
 * Run all Gate 2 Part 1 unit tests. Each returns {name, pass, detail}.
 * Aggregates results, logs to EventLog, and shows a UI alert when run from menu.
 * @return {Array<{name:string, pass:boolean, detail:string}>}
 */
function TEST_gate2Part1_all_() {
  var t0 = Date.now();
  logEvent('TEST_RUN', 'CumulativeConfirmTests', 'START', 0, 'Gate 2 Part 1 test suite starting');

  var tests = [
    TEST_cumulative_round1_partial,
    TEST_cumulative_round2_completes,
    TEST_cumulative_exceeds_qty,
    TEST_cumulative_round_limit_exceeded,
    TEST_cumulative_round3_can_still_complete,
    TEST_flag_off_preserves_6_2_rev_behavior
  ];

  var results = [];
  for (var i = 0; i < tests.length; i++) {
    try {
      var r = tests[i]();
      results.push(r);
      Logger.log((r.pass ? '  ✅' : '  ❌') + ' ' + r.name + ': ' + r.detail);
    } catch (e) {
      var errResult = { name: tests[i].name || ('test_' + i), pass: false, detail: 'EXCEPTION: ' + e.message };
      results.push(errResult);
      Logger.log('  ❌ ' + errResult.name + ': ' + errResult.detail);
    }
  }

  var passCount = results.filter(function (r) { return r.pass; }).length;
  var failCount = results.length - passCount;
  var elapsed   = Date.now() - t0;
  var summary   = passCount + '/' + results.length + ' passed, ' + failCount + ' failed, ' + elapsed + 'ms';

  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(failCount === 0 ? '✅ ALL TESTS PASSED' : '❌ ' + failCount + ' TEST(S) FAILED');
  Logger.log(summary);
  Logger.log('══════════════════════════════════════════');

  logEvent('TEST_RUN', 'CumulativeConfirmTests', failCount === 0 ? 'ALL_PASS' : 'SOME_FAIL', elapsed, summary);

  try {
    var ui = SpreadsheetApp.getUi();
    var lines = results.map(function (r) { return (r.pass ? '✅ ' : '❌ ') + r.name; });
    ui.alert('🧪 Gate 2 Part 1 Tests — ' + summary + '\n\n' + lines.join('\n'));
  } catch (e) {
    // Not running in a UI context (e.g. triggered) — Logger output above is enough.
  }

  return results;
}

/** Additive menu hook — mirrors addGate0ProbeMenu_'s pattern in Gate0Probe.gs. */
function addGate2Part1TestsMenu_() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('🧪 Gate 2 Part 1 Tests')
    .addItem('🧪 Run all Gate 2 Part 1 tests', 'TEST_gate2Part1_all_')
    .addToUi();
}

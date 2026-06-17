/**
 * Tests.gs — Phase 2.5 (dev-only)
 * =================================
 * Pure-logic unit tests for the FIFO allocation algorithm.
 * Run any function below from Apps Script Editor → select function → Run.
 * No sheet reads or writes — safe to execute at any time.
 */

// ============================================================================
// Core test runner
// ============================================================================

/**
 * Simulates the allocatePallets() split logic without touching any sheets.
 *
 * @param {number} requestedQty
 * @param {number} moq
 * @param {Array<{mo:string, remaining:number}>} candidates  — already FIFO-sorted
 * @param {Object} existingSeq  — { [mo]: maxSeq }  (default 0 per MO)
 * @return {{ pallets: Array<{palletId,mo,qty}>, shortfall: number }}
 */
function simulateAllocation_(requestedQty, moq, candidates, existingSeq) {
  existingSeq = existingSeq || {};
  const pallets = [];
  const seqState = {}; // mutable within this run
  let remaining = requestedQty;

  candidates.forEach(function(c) {
    if (remaining <= 0) return;
    if (c.remaining <= 0) return;

    const toAllocate = Math.min(remaining, c.remaining);
    if (!seqState[c.mo]) seqState[c.mo] = (existingSeq[c.mo] || 0);
    let qty = toAllocate;

    while (qty > 0) {
      const palletQty = Math.min(qty, moq);
      seqState[c.mo]++;
      const seq    = seqState[c.mo];
      const seqStr = seq < 10 ? '0' + seq : String(seq);
      pallets.push({ palletId: 'PL-' + c.mo + '-L' + seqStr, mo: c.mo, qty: palletQty });
      qty -= palletQty;
    }

    remaining -= toAllocate;
  });

  return { pallets: pallets, shortfall: Math.max(0, remaining) };
}

function assert_(label, condition) {
  if (!condition) {
    Logger.log('  ❌ FAIL — ' + label);
    throw new Error('Assertion failed: ' + label);
  }
  Logger.log('  ✅ ' + label);
}

// ============================================================================
// Test cases
// ============================================================================

/**
 * Main scenario from the task spec:
 *   MOQ=2560, MO-A remaining=5120, MO-B remaining=99000, request=10000
 *   Expected: MO-A L01(2560)+L02(2560) → MO-B L01(2560)+L02(2320), shortfall=0
 */
function testAllocation() {
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' testAllocation  — 10000 PCS across 2 MOs');
  Logger.log('══════════════════════════════════════════');

  const r = simulateAllocation_(10000, 2560, [
    { mo: 'MO-A', remaining: 5120 },
    { mo: 'MO-B', remaining: 99000 }
  ]);

  Logger.log('Pallets (' + r.pallets.length + '):');
  r.pallets.forEach(function(p) {
    Logger.log('  ' + p.palletId + '  →  ' + p.qty + ' PCS');
  });
  Logger.log('Shortfall: ' + r.shortfall);

  assert_('4 pallets total',           r.pallets.length === 4);
  assert_('MO-A L01 = 2560',           r.pallets[0].palletId === 'PL-MO-A-L01' && r.pallets[0].qty === 2560);
  assert_('MO-A L02 = 2560',           r.pallets[1].palletId === 'PL-MO-A-L02' && r.pallets[1].qty === 2560);
  assert_('MO-B L01 = 2560',           r.pallets[2].palletId === 'PL-MO-B-L01' && r.pallets[2].qty === 2560);
  assert_('MO-B L02 = 2320 (last)',    r.pallets[3].palletId === 'PL-MO-B-L02' && r.pallets[3].qty === 2320);
  assert_('shortfall = 0',             r.shortfall === 0);

  // Verify sum
  const total = r.pallets.reduce(function(s, p) { return s + p.qty; }, 0);
  assert_('total allocated = 10000',   total === 10000);

  Logger.log('');
  Logger.log('✅ testAllocation PASSED');
}

/**
 * Shortfall case: request exceeds all open MO remaining qty.
 *   MOQ=100, MO-A remaining=300, request=500
 *   Expected: 3 pallets (300 PCS), shortfall=200
 */
function testAllocationShortfall() {
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' testAllocationShortfall — request > supply');
  Logger.log('══════════════════════════════════════════');

  const r = simulateAllocation_(500, 100, [
    { mo: 'MO-X', remaining: 300 }
  ]);

  Logger.log('Pallets (' + r.pallets.length + '):');
  r.pallets.forEach(function(p) {
    Logger.log('  ' + p.palletId + '  →  ' + p.qty + ' PCS');
  });
  Logger.log('Shortfall: ' + r.shortfall);

  assert_('3 pallets allocated',  r.pallets.length === 3);
  assert_('shortfall = 200',      r.shortfall === 200);

  Logger.log('');
  Logger.log('✅ testAllocationShortfall PASSED');
}

/**
 * Request smaller than one MOQ.
 *   MOQ=500, MO-A remaining=1000, request=180
 *   Expected: 1 pallet of 180, shortfall=0
 */
function testAllocationBelowMoq() {
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' testAllocationBelowMoq — qty < MOQ');
  Logger.log('══════════════════════════════════════════');

  const r = simulateAllocation_(180, 500, [
    { mo: 'MO-Y', remaining: 1000 }
  ]);

  Logger.log('Pallets (' + r.pallets.length + '):');
  r.pallets.forEach(function(p) {
    Logger.log('  ' + p.palletId + '  →  ' + p.qty + ' PCS');
  });
  Logger.log('Shortfall: ' + r.shortfall);

  assert_('1 pallet',              r.pallets.length === 1);
  assert_('pallet qty = 180',      r.pallets[0].qty === 180);
  assert_('shortfall = 0',         r.shortfall === 0);

  Logger.log('');
  Logger.log('✅ testAllocationBelowMoq PASSED');
}

/**
 * Sequence continues from existing pallets (idempotency).
 *   MO-A already has L01–L03 → next should be L04
 */
function testAllocationSeqContinuation() {
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' testAllocationSeqContinuation');
  Logger.log('══════════════════════════════════════════');

  const r = simulateAllocation_(200, 100, [
    { mo: 'MO-A', remaining: 700 }
  ], { 'MO-A': 3 }); // maxSeq=3 → next=L04

  Logger.log('Pallets (' + r.pallets.length + '):');
  r.pallets.forEach(function(p) {
    Logger.log('  ' + p.palletId + '  →  ' + p.qty + ' PCS');
  });

  assert_('first pallet = L04',  r.pallets[0].palletId === 'PL-MO-A-L04');
  assert_('second pallet = L05', r.pallets[1].palletId === 'PL-MO-A-L05');

  Logger.log('');
  Logger.log('✅ testAllocationSeqContinuation PASSED');
}

/**
 * Run all tests in sequence.
 */
function testAll() {
  Logger.log('');
  Logger.log('╔══════════════════════════════════════════╗');
  Logger.log('║   PrintEngine — Allocation Test Suite   ║');
  Logger.log('╚══════════════════════════════════════════╝');
  testAllocation();
  testAllocationShortfall();
  testAllocationBelowMoq();
  testAllocationSeqContinuation();
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log('✅ ALL TESTS PASSED');
  Logger.log('══════════════════════════════════════════');
}

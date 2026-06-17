/**
 * Tests.gs — Consolidated Test & Diagnostic Suite
 * =================================================
 * All manually-run test/diagnostic functions in one place.
 * Run any function from Apps Script Editor → select function → Run.
 *
 * INDEX:
 * ──────────────────────────────────────────────────────────────
 * ALLOCATION TESTS (pure-logic, no sheet/SAP access):
 *   testAllocation()               — 10000 PCS across 2 MOs, MOQ=2560
 *   testAllocationShortfall()      — request exceeds supply
 *   testAllocationBelowMoq()       — qty < MOQ → 1 partial pallet
 *   testAllocationSeqContinuation()— seq continues from existing pallets
 *   testAll()                      — run all allocation tests
 *
 * SAP CONNECTION:
 *   testSapConnection()            — GET $top=1 to confirm EntitySet reachable
 *   testCsrfSession()              — CSRF token+cookie handshake for PROD_ORDER_CONF
 *
 * CONFIRMATION / WRITEBACK:
 *   testDryRunConfirmation()       — dry-run confirmation, TEST='PL-1000035048-L01'
 *   testPostConfirmationDryRun()   — builds+posts (dry-run) for 'PL-1000036350-L01'
 *   testConfirmPallet()            — full orchestrator for 'PL-1000036350-L01'
 *   checkWritebackColumns()        — verify PalletMaster has writeback columns
 *
 * PRODUCTION ORDER DIAGNOSTICS:
 *   testFetchOpsDebug(mo)          — raw HTTP + fetchOperationsForMO_ for an MO
 *   debugOrderStatus()             — top-5 orders with status expand
 *   debugOrderRouting()            — 3-probe routing investigation, TEST='1000036350'
 *   inspectOrderCache()            — ProductionOrders sheet cache, TEST='1000036350'
 *   testRefreshOneOrder()          — backfill OperationsJSON for '1000036350' (WRITES)
 *
 * MATERIAL / SCHEMA:
 *   debugMaterialName()            — MaterialMaster lookup for 'STB1006-A0100S3XRX'
 *   debugPalletMasterSchema()      — dump PalletMaster headers + first data row
 *
 * PALLET DIAGNOSTICS:
 *   diagnosePallet()               — PM_HEADERS vs CFG header desync diagnosis
 *                                    for 'PL-1000036350-L01' (READ-ONLY)
 * ──────────────────────────────────────────────────────────────
 */

// ============================================================================
// Allocation test infrastructure (pure-logic, no sheet/SAP)
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
// Allocation test cases
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

/** Run all allocation tests in sequence. */
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

// ============================================================================
// SAP connection tests
// ============================================================================

/** Ping SAP with GET $top=1 — checks credential + connectivity. */
function testSapConnection() {
  // Use $top=1 with NO $select first — confirms EntitySet reachable
  const data = sapGet(CFG.ENDPOINTS.PRODUCTION_ORDERS,
    { '$top': '1' }, 'testSapConnection');
  const results = (data.d || {}).results || [];
  const n = results.length;
  if (n > 0) {
    console.log('SAP connection OK — sample row keys: ' + Object.keys(results[0]).join(', '));
  } else {
    console.log('SAP connection OK — 0 rows returned (check Plant filter or date range)');
  }
  return n;
}

/**
 * Test getCsrfSession_() against API_PROD_ORDER_CONFIRMATION_2_SRV.
 * Logs safe info only: token length, first 4 chars, cookie count/names.
 */
function testCsrfSession() {
  const serviceUrl = CFG.SAP_BASE_URL + CFG.SERVICES.PROD_ORDER_CONF;
  try {
    const session = getCsrfSession_(serviceUrl);
    const cookieNames = session.cookies
      ? session.cookies.split(';').map(function (c) { return c.split('=')[0].trim(); })
      : [];
    Logger.log('CSRF session OK — tokenLen=' + session.token.length +
      ' tokenPrefix=' + session.token.slice(0, 4) +
      ' cookieCount=' + cookieNames.length +
      ' cookieNames=[' + cookieNames.join(', ') + ']');
  } catch (err) {
    Logger.log('testCsrfSession FAILED: ' + err.message);
  }
}

// ============================================================================
// Confirmation / writeback tests
// ============================================================================

/**
 * Dry-run confirmation for a QC_COMPLETE pallet.
 * Uses dryRunConfirmation_() (Confirmation.gs). TEST='PL-1000035048-L01'.
 */
function testDryRunConfirmation() {
  // Replace with a real QC_COMPLETE PalletID before running
  const TEST_PALLET_ID = 'PL-1000035048-L01';

  try {
    const payload = dryRunConfirmation_(TEST_PALLET_ID);
    Logger.log(JSON.stringify(payload, null, 2));
  } catch (e) {
    Logger.log('ERROR: ' + e.message);
  }
}

/**
 * Build + post confirmation payload in dry-run mode.
 * Uses buildConfirmationPayload_() + postConfirmation_() (Confirmation.gs).
 * TEST='PL-1000036350-L01'.
 */
function testPostConfirmationDryRun() {
  const TEST_PALLET_ID = 'PL-1000036350-L01';

  const payload = buildConfirmationPayload_(TEST_PALLET_ID);
  Logger.log('Built payload:\n' + JSON.stringify(payload, null, 2));

  const result = postConfirmation_(payload);
  Logger.log('postConfirmation_ result:\n' + JSON.stringify(result, null, 2));
}

/**
 * Full confirmPallet orchestrator test. Under DRY_RUN builds+logs but no POST.
 * TEST='PL-1000036350-L01'.
 */
function testConfirmPallet() {
  const TEST_PALLET_ID = 'PL-1000036350-L01';

  try {
    var result = confirmPallet(TEST_PALLET_ID);
    Logger.log('confirmPallet result:\n' + JSON.stringify(result, null, 2));
  } catch (e) {
    Logger.log('ERROR: ' + e.message);
  }
}

/**
 * Check whether PalletMaster already has the columns Step 2c writeback needs.
 * Reporting only — does NOT create any column.
 */
function checkWritebackColumns() {
  const required = [
    'GRMaterialDocument', 'GRMaterialDocumentYear', 'ConfirmationGroup',
    'ConfirmationCount', 'ConfirmedAt', 'ConfirmedBy'
  ];

  const sh  = getSheet_(PM_SHEET);
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  required.forEach(function (col) {
    const exists = hdr.indexOf(col) !== -1;
    Logger.log((exists ? 'EXISTS  : ' : 'MISSING : ') + col);
  });
}

// ============================================================================
// Production Order diagnostics
// ============================================================================

/**
 * Debug fetch operations: clears cache for MO, raw HTTP + fetchOperationsForMO_.
 * @param {string} [mo='1000035048'] — ManufacturingOrder to inspect
 */
function testFetchOpsDebug(mo) {
  mo = String(mo || '1000035048');
  Logger.log('=== testFetchOpsDebug MO=' + mo + ' ===');

  // Clear any stale cache for this MO
  const cacheKey = 'OPS_' + mo;
  CacheService.getScriptCache().remove(cacheKey);
  Logger.log('Cleared cache: ' + cacheKey);

  // Raw HTTP call so we can log status + body
  const path   = CFG.ENDPOINTS.PRODUCTION_ORDERS + "('" + mo + "')";
  const params = {
    '$expand': 'to_ProductionOrderOperation',
    '$select': [
      'ManufacturingOrder',
      'to_ProductionOrderOperation/ManufacturingOrderOperation',
      'to_ProductionOrderOperation/MfgOrderOperationText',
      'to_ProductionOrderOperation/WorkCenter'
    ].join(','),
    '$format': 'json'
  };
  const url = buildSapUrl_(path, params);
  Logger.log('URL: ' + url);

  const creds = getSapCredentials_();
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });
  Logger.log('Response code: ' + resp.getResponseCode());
  Logger.log('Response body (first 800): ' + resp.getContentText().substring(0, 800));

  const ops = fetchOperationsForMO_(mo);
  Logger.log('fetchOperationsForMO_ result: ' + ops.length + ' ops');
  ops.forEach(function(op, i) { Logger.log('  [' + i + '] ' + JSON.stringify(op)); });
}

/**
 * Debug — top-5 orders with to_ProductionOrderStatus expand.
 * Shows StatusCode values from SAP.
 */
function debugOrderStatus() {
  const params = {
    '$top': '5',
    '$filter': "Plant eq '" + CFG.PLANT + "'",
    '$expand': 'to_ProductionOrderStatus',
    '$select': [
      'ManufacturingOrder',
      'Material',
      'OrderIsReleased',
      'to_ProductionOrderStatus/StatusCode',
      'to_ProductionOrderStatus/StatusShortName'
    ].join(',')
  };
  const data = sapGet(CFG.ENDPOINTS.PRODUCTION_ORDERS, params, 'debugOrderStatus');
  const results = (data.d || {}).results || [];
  console.log('Returned: ' + results.length + ' orders');
  results.forEach(function(r) {
    const sts = (r.to_ProductionOrderStatus && r.to_ProductionOrderStatus.results) || [];
    const stsList = sts.map(function(s) {
      return '[' + s.StatusCode + '|' + s.StatusShortName + ']';
    }).join(' ');
    console.log(
      'PO=' + r.ManufacturingOrder +
      ' | OrderIsReleased="' + r.OrderIsReleased + '"' +
      ' | Statuses=' + (stsList || '(empty)')
    );
  });
}

/**
 * 3-probe routing investigation for a specific order. Tests raw vs padded
 * OrderID and entityset-direct vs header+$expand paths. TEST='1000036350'.
 */
function debugOrderRouting() {
  const TEST_ORDER = '1000036350';
  const fn = 'debugOrderRouting';
  Logger.log('=== debugOrderRouting: TEST_ORDER=' + TEST_ORDER + ' Plant=' + CFG.PLANT + ' ===');

  // PROBE A — operation entityset direct, raw (unpadded) key
  const countA = debugProbeOperationEntitySet_(TEST_ORDER, 'A (raw key)');

  // PROBE B — same entityset, OrderID left-padded to 12 digits
  const paddedOrder = TEST_ORDER.padStart(12, '0');
  const countB = debugProbeOperationEntitySet_(paddedOrder, 'B (12-digit padded key)');

  // PROBE C — header + $expand, raw key first; padded key only if raw key errors
  let countC = debugProbeHeaderExpand_(TEST_ORDER, 'C (raw key)');
  if (countC === -1) {
    Logger.log('PROBE C raw key errored — retrying header+expand with 12-digit padded key');
    countC = debugProbeHeaderExpand_(paddedOrder, 'C-padded (12-digit padded key)');
  }

  // ---- Summary ----------------------------------------------------------
  const fmt = function (n) { return n === -1 ? 'HTTP ERROR' : n + ' ops'; };
  const summary = 'PROBE A(entityset,raw)=' + fmt(countA) +
    ' | PROBE B(entityset,padded)=' + fmt(countB) +
    ' | PROBE C(header+expand)=' + fmt(countC);
  Logger.log('=== SUMMARY: ' + summary + ' ===');

  let hint;
  if (countA <= 0 && countB > 0) {
    hint = 'Key format looks like the cause — raw key returns 0/error, 12-digit padded key returns operations.';
  } else if ((countA > 0 || countB > 0) && countC <= 0) {
    hint = 'Entityset-direct query works but header $expand does not — check the to_ProductionOrderOperation navigation path.';
  } else if (countA <= 0 && countB <= 0 && countC <= 0) {
    hint = 'All probes returned 0/error — likely a $filter mismatch (Plant/order type) or the operations are genuinely absent for this client, not a key-format issue.';
  } else {
    hint = 'At least one probe returned operations — compare the counts above to identify the working combination.';
  }
  Logger.log('=== HINT: ' + hint + ' ===');

  logEvent(fn, TEST_ORDER, 'INFO', 0, summary + ' || ' + hint);
}

/**
 * Probe helper A/B — queries ProductionOrderOperation entityset directly.
 * Used by debugOrderRouting(). Read-only.
 * @param {string} orderId — raw or 12-digit padded ManufacturingOrder key
 * @param {string} label — Logger.log prefix
 * @return {number} operation count, or -1 on non-2xx HTTP
 */
function debugProbeOperationEntitySet_(orderId, label) {
  const path = CFG.SERVICES.PRODUCTION_ORDERS + 'ProductionOrderOperation';
  const params = {
    '$filter': "ManufacturingOrder eq '" + orderId + "' and Plant eq '" + CFG.PLANT + "'",
    '$format': 'json'
  };
  const url = buildSapUrl_(path, params);
  Logger.log('--- PROBE ' + label + ' — entityset direct ---');
  Logger.log('URL: ' + url);

  const creds = getSapCredentials_();
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  Logger.log('PROBE ' + label + ' HTTP status: ' + code);

  if (code < 200 || code >= 300) {
    Logger.log('PROBE ' + label + ' FULL response body: ' + resp.getContentText());
    return -1;
  }

  const data = JSON.parse(resp.getContentText() || '{}');
  const ops = (data.d || {}).results || [];
  Logger.log('PROBE ' + label + ' operations returned: ' + ops.length);
  ops.forEach(function (op, i) {
    Logger.log('  [' + i + '] ManufacturingOrder=' + op.ManufacturingOrder +
      ' ManufacturingOrderOperation=' + op.ManufacturingOrderOperation +
      ' OperationText=' + (op.OperationText || op.MfgOrderOperationText || '') +
      ' WorkCenter=' + op.WorkCenter +
      ' Status=' + (op.OperationIsTechnicallyCompleted !== undefined ?
        op.OperationIsTechnicallyCompleted : 'n/a'));
    Logger.log('      raw=' + JSON.stringify(op));
  });

  return ops.length;
}

/**
 * Probe helper C — header entity with $expand=to_ProductionOrderOperation.
 * Used by debugOrderRouting(). Read-only.
 * @param {string} orderId — raw or 12-digit padded ManufacturingOrder key
 * @param {string} label — Logger.log prefix
 * @return {number} operation count under expand, or -1 on non-2xx HTTP
 */
function debugProbeHeaderExpand_(orderId, label) {
  const path = CFG.ENDPOINTS.PRODUCTION_ORDERS + "('" + orderId + "')";
  const params = {
    '$expand': 'to_ProductionOrderOperation',
    '$format': 'json'
  };
  const url = buildSapUrl_(path, params);
  Logger.log('--- PROBE ' + label + ' — header + expand ---');
  Logger.log('URL: ' + url);

  const creds = getSapCredentials_();
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  Logger.log('PROBE ' + label + ' HTTP status: ' + code);

  if (code < 200 || code >= 300) {
    Logger.log('PROBE ' + label + ' FULL response body: ' + resp.getContentText());
    return -1;
  }

  const data = JSON.parse(resp.getContentText() || '{}');
  const d = data.d || {};
  const ops = (d.to_ProductionOrderOperation || {}).results || [];
  Logger.log('PROBE ' + label + ' header ManufacturingOrder=' + d.ManufacturingOrder);
  Logger.log('PROBE ' + label + ' operations returned under expand: ' + ops.length);
  ops.forEach(function (op, i) {
    Logger.log('  [' + i + '] ManufacturingOrder=' + (op.ManufacturingOrder || d.ManufacturingOrder) +
      ' ManufacturingOrderOperation=' + op.ManufacturingOrderOperation +
      ' OperationText=' + (op.MfgOrderOperationText || op.OperationText || '') +
      ' WorkCenter=' + op.WorkCenter +
      ' Status=' + (op.OperationIsTechnicallyCompleted !== undefined ?
        op.OperationIsTechnicallyCompleted : 'n/a'));
    Logger.log('      raw=' + JSON.stringify(op));
  });

  return ops.length;
}

/**
 * Inspect ProductionOrders sheet cache for a specific order.
 * Logs OperationsJSON, Operations, FinalOperation + getOperationsForOrder() result.
 * Read-only (logEvent only). TEST='1000036350'.
 */
function inspectOrderCache() {
  const TEST_ORDER = '1000036350';
  const fn = 'inspectOrderCache';
  Logger.log('=== inspectOrderCache: TEST_ORDER=' + TEST_ORDER + ' ===');

  const sh = getSheet_(CFG.SHEETS.PRODUCTION_ORDERS);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    Logger.log('ROW MISSING');
    logEvent(fn, TEST_ORDER, 'INFO', 0, 'ROW MISSING — ProductionOrders sheet has no data rows');
    return;
  }

  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const moCol      = hdr.indexOf('ManufacturingOrder');
  const opsJsonCol = hdr.indexOf('OperationsJSON');
  const opsCol     = hdr.indexOf('Operations');
  const finalOpCol = hdr.indexOf('FinalOperation');

  if (moCol === -1) {
    Logger.log('ROW MISSING');
    logEvent(fn, TEST_ORDER, 'INFO', 0, 'ROW MISSING — ManufacturingOrder column not found in ProductionOrders sheet');
    return;
  }

  const data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  let rowIdx = -1;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][moCol] || '').trim() === TEST_ORDER) { rowIdx = i; break; }
  }

  if (rowIdx === -1) {
    Logger.log('ROW MISSING');
    logEvent(fn, TEST_ORDER, 'INFO', 0, 'ROW MISSING — ' + TEST_ORDER + ' not found in ProductionOrders sheet');
    return;
  }

  const row = data[rowIdx];
  const rawOpsJson = opsJsonCol > -1 ? String(row[opsJsonCol] || '').trim() : '';
  const rawOps     = opsCol     > -1 ? String(row[opsCol]     || '').trim() : '';
  const finalOp    = finalOpCol > -1 ? String(row[finalOpCol] || '').trim() : '';

  let parsedCount = 0;
  if (rawOpsJson) {
    try {
      const parsed = JSON.parse(rawOpsJson);
      if (Array.isArray(parsed)) parsedCount = parsed.length;
    } catch (e) {
      Logger.log('inspectOrderCache: OperationsJSON parse FAILED — ' + e.message);
    }
  }

  Logger.log('Row exists: YES (sheet row ' + (rowIdx + 2) + ')');
  Logger.log('OperationsJSON raw: ' + (rawOpsJson || 'EMPTY'));
  Logger.log('Operations raw: ' + (rawOps || 'EMPTY'));
  Logger.log('FinalOperation: ' + (finalOp || 'EMPTY'));
  Logger.log('OperationsJSON parsed count: ' + parsedCount);

  const cacheOps = getOpsForMo_(TEST_ORDER);
  const source = cacheOps.length > 0
    ? 'SHEET CACHE (getOpsForMo_ — OperationsJSON/Operations column)'
    : 'LIVE SAP FETCH (fetchOperationsForMO_ fallback)';

  const liveResult = getOperationsForOrder(TEST_ORDER);
  Logger.log('getOperationsForOrder() returned: ' + liveResult.length + ' ops — source: ' + source);

  const summary = 'TEST_ORDER=' + TEST_ORDER +
    ' rowExists=YES' +
    ' OperationsJSON=' + (rawOpsJson ? ('present,parsed=' + parsedCount) : 'EMPTY') +
    ' Operations=' + (rawOps ? 'present' : 'EMPTY') +
    ' FinalOperation=' + (finalOp || 'EMPTY') +
    ' getOperationsForOrder=' + liveResult.length + 'ops' +
    ' source=' + source;
  Logger.log('=== SUMMARY: ' + summary + ' ===');
  logEvent(fn, TEST_ORDER, 'INFO', 0, summary);
}

/**
 * Test refreshOrderOperationCache() for one known-stale order.
 * NOTE: this WRITES OperationsJSON/Operations/FinalOperation to the sheet.
 * TEST='1000036350'.
 */
function testRefreshOneOrder() {
  const TEST_ORDER = '1000036350';
  Logger.log('=== testRefreshOneOrder: TEST_ORDER=' + TEST_ORDER + ' ===');

  const summary = refreshOrderOperationCache(TEST_ORDER);
  Logger.log('refreshOrderOperationCache summary: ' + JSON.stringify(summary));

  const sh = getSheet_(CFG.SHEETS.PRODUCTION_ORDERS);
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const moCol      = hdr.indexOf('ManufacturingOrder');
  const opsJsonCol = hdr.indexOf('OperationsJSON');
  const finalOpCol = hdr.indexOf('FinalOperation');

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][moCol] || '').trim() === TEST_ORDER) {
      const rawOpsJson = String(data[i][opsJsonCol] || '').trim();
      const finalOp    = String(data[i][finalOpCol] || '').trim();
      let parsedCount = 0;
      try {
        const parsed = JSON.parse(rawOpsJson);
        if (Array.isArray(parsed)) parsedCount = parsed.length;
      } catch (e) {
        Logger.log('testRefreshOneOrder: OperationsJSON parse FAILED — ' + e.message);
      }
      Logger.log('AFTER refresh — OperationsJSON parsed count: ' + parsedCount +
        ', FinalOperation: ' + (finalOp || 'EMPTY'));
      return;
    }
  }
  Logger.log('AFTER refresh — row not found (unexpected)');
}

// ============================================================================
// Material / Schema diagnostics
// ============================================================================

/**
 * Lookup a specific material in MaterialMaster + getMaterialMap().
 * Uses TEST material 'STB1006-A0100S3XRX'.
 */
function debugMaterialName() {
  var mat = 'STB1006-A0100S3XRX';

  var map = getMaterialMap();
  Logger.log('getMaterialMap result for ' + mat + ':');
  Logger.log(JSON.stringify(map[mat] || 'NOT FOUND'));

  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName('MaterialMaster');
  if (!sh) { Logger.log('MaterialMaster sheet NOT FOUND'); return; }
  var data = sh.getDataRange().getValues();
  var hdrs = data[0];
  Logger.log('MaterialMaster headers: ' + JSON.stringify(hdrs));
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === mat) {
      Logger.log('Found row ' + i + ': ' + JSON.stringify(data[i]));
      return;
    }
  }
  Logger.log('Material NOT FOUND in MaterialMaster: ' + mat);
}

/**
 * Dump PalletMaster headers + first data row. Confirms column names and data.
 * Referenced by Admin menu ('Debug PM Schema').
 */
function debugPalletMasterSchema() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName('PalletMaster');
  if (!sh) { Logger.log('PalletMaster sheet NOT FOUND'); return; }

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Logger.log('PalletMaster lastRow=' + sh.getLastRow() +
             ' lastCol=' + sh.getLastColumn());
  Logger.log('PalletMaster headers: ' + JSON.stringify(headers));

  if (sh.getLastRow() > 1) {
    var row1 = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
    Logger.log('Row 1 data: ' + JSON.stringify(row1));
    headers.forEach(function(h, i) {
      Logger.log('  [' + i + '] ' + h + ' = "' + row1[i] + '"');
    });
  }
}

// ============================================================================
// Pallet diagnostics — PM_HEADERS vs CFG.HEADERS desync investigation
// ============================================================================

/**
 * Diagnose the confirmPallet() false-positive idempotency guard for a specific
 * pallet. Logs the live header, resolved column index for ConfirmationGroup,
 * the raw cell value at that position, neighbouring columns, and evaluates
 * each sub-condition of the guard separately.
 *
 * Investigates the suspected PM_HEADERS (28-col) vs CFG.HEADERS.PALLET_MASTER
 * (33-col) header/data desync — columns diverge at index 22.
 *
 * READ-ONLY: no writes, no POST.
 */
function diagnosePallet() {
  const PALLET_ID = 'PL-1000036350-L01';

  Logger.log('=== diagnosePallet: ' + PALLET_ID + ' ===');

  // ---- 1. Resolve pallet via lookupPalletById_ ----
  const pallet = lookupPalletById_(PALLET_ID);
  if (!pallet) {
    Logger.log('FATAL: lookupPalletById_ returned null for ' + PALLET_ID);
    return;
  }

  Logger.log('pallet Object.keys: ' + JSON.stringify(Object.keys(pallet)));
  Logger.log('pallet.ScanStatus: value=' + JSON.stringify(pallet.ScanStatus) +
    ' typeof=' + typeof pallet.ScanStatus);
  Logger.log('pallet.ConfirmationGroup: value=' + JSON.stringify(pallet.ConfirmationGroup) +
    ' typeof=' + typeof pallet.ConfirmationGroup +
    ' (expected: undefined — not in lookupPalletById_ return object)');
  Logger.log('pallet.rowNum: ' + pallet.rowNum);

  // ---- 2. Read live PalletMaster header ----
  const sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  Logger.log('Live header length: ' + hdr.length + ' columns');
  Logger.log('Live header: ' + JSON.stringify(hdr));

  // ---- 3. Compare with PM_HEADERS and CFG.HEADERS.PALLET_MASTER ----
  Logger.log('PM_HEADERS length: ' + PM_HEADERS.length);
  Logger.log('CFG.HEADERS.PALLET_MASTER length: ' + CFG.HEADERS.PALLET_MASTER.length);

  var firstDivergence = -1;
  for (var i = 0; i < Math.max(hdr.length, PM_HEADERS.length, CFG.HEADERS.PALLET_MASTER.length); i++) {
    var live = hdr[i] || '';
    var pm   = PM_HEADERS[i] || '';
    var cfg  = (CFG.HEADERS.PALLET_MASTER || [])[i] || '';
    if ((live !== pm || live !== cfg) && firstDivergence === -1) {
      firstDivergence = i;
    }
  }
  if (firstDivergence >= 0) {
    Logger.log('FIRST DIVERGENCE at index ' + firstDivergence + ':');
    Logger.log('  live header [' + firstDivergence + '] = ' + JSON.stringify(hdr[firstDivergence]));
    Logger.log('  PM_HEADERS  [' + firstDivergence + '] = ' + JSON.stringify(PM_HEADERS[firstDivergence]));
    Logger.log('  CFG.HEADERS [' + firstDivergence + '] = ' + JSON.stringify((CFG.HEADERS.PALLET_MASTER || [])[firstDivergence]));
  } else {
    Logger.log('No divergence found — all three headers match');
  }

  // ---- 4. ConfirmationGroup column resolution ----
  const cgColIdx = hdr.indexOf('ConfirmationGroup');
  Logger.log('hdr.indexOf("ConfirmationGroup") = ' + cgColIdx + ' (0-based)');

  if (cgColIdx < 0) {
    Logger.log('ConfirmationGroup NOT in live header — guard defaults cgVal to ""');
  } else {
    // Raw cell value at the resolved column
    const rawVal = sh.getRange(pallet.rowNum, cgColIdx + 1).getValue();
    Logger.log('Raw cell at (row=' + pallet.rowNum + ', col=' + (cgColIdx + 1) +
      '): value=' + JSON.stringify(rawVal) + ' typeof=' + typeof rawVal);

    const cgVal = String(rawVal || '').trim();
    Logger.log('cgVal after String(raw||"").trim(): "' + cgVal + '" length=' + cgVal.length);

    // ---- 5. Neighbouring columns (cgColIdx .. cgColIdx+2) ----
    Logger.log('Neighbouring columns around ConfirmationGroup:');
    for (var c = Math.max(0, cgColIdx); c <= Math.min(hdr.length - 1, cgColIdx + 2); c++) {
      var cellVal = sh.getRange(pallet.rowNum, c + 1).getValue();
      Logger.log('  col ' + c + ' (header="' + hdr[c] + '"): value=' +
        JSON.stringify(cellVal) + ' typeof=' + typeof cellVal);
    }

    // Cross-reference: what does PM_HEADERS say this column is?
    if (cgColIdx < PM_HEADERS.length) {
      Logger.log('PM_HEADERS[' + cgColIdx + '] = "' + PM_HEADERS[cgColIdx] +
        '" — if live header is CFG but data is PM-aligned, this cell holds ' +
        PM_HEADERS[cgColIdx] + ' data, NOT ConfirmationGroup');
    }
  }

  // ---- 6. Evaluate guard sub-conditions ----
  const subA = pallet.ScanStatus === 'CONFIRMED';
  Logger.log('Guard sub-A (pallet.ScanStatus === "CONFIRMED"): ' + subA +
    '  [ScanStatus="' + pallet.ScanStatus + '"]');

  var subB;
  if (cgColIdx >= 0) {
    var rawForGuard = sh.getRange(pallet.rowNum, cgColIdx + 1).getValue();
    var cgValForGuard = String(rawForGuard || '').trim();
    subB = cgValForGuard !== '';
    Logger.log('Guard sub-B (cgVal !== ""): ' + subB +
      '  [raw=' + JSON.stringify(rawForGuard) + ' coerced="' + cgValForGuard + '"]');
  } else {
    subB = false;
    Logger.log('Guard sub-B: false (ConfirmationGroup column absent)');
  }

  const guardFires = subA || subB;
  Logger.log('Guard fires (subA || subB): ' + guardFires);

  if (guardFires) {
    Logger.log('VERDICT: Guard returns {alreadyConfirmed:true} because ' +
      (subA ? 'sub-A (ScanStatus==="CONFIRMED")' : 'sub-B (ConfirmationGroup cell is non-empty)') +
      ' is true');
  } else {
    Logger.log('VERDICT: Guard would NOT fire — confirmPallet should proceed past the guard');
  }

  Logger.log('=== diagnosePallet complete ===');
}

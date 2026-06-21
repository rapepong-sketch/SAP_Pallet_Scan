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
 *
 * PERFORMANCE:
 *   timePreviewAllocation()         — profile previewPalletAllocation for STT1001-B1700S3ARX qty=450
 *
 * ALLOCATION DIAGNOSIS:
 *   diagnoseMaterialAllocation()    — why does previewPalletAllocation return 0 for STT1001-B1700S3ARX?
 *
 * STORAGE LOCATION:
 *   testStorageLocationBackfill()   — run populateMaterialStorageLocation() + verify
 *
 * OVERRIDE UI TEST HELPERS:
 *   seedOverrideTestPallet_()       — insert 5 fake QC_COMPLETE candidates (varied SLoc+Material)
 *   cleanupOverrideTestPallet_()    — remove all fake candidate rows (PL-TEST-OVR* + legacy)
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

// ============================================================================
// MaterialMaster ProductGroup audit (READ-ONLY)
// ============================================================================

/**
 * Audit MaterialMaster.ProductGroup population.
 * READ-ONLY — no writes, no SAP calls.
 * Run from Apps Script Editor → select diagnoseMaterialProductGroup → Run.
 */
function diagnoseMaterialProductGroup() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName('MaterialMaster');
  if (!sh) { Logger.log('MaterialMaster sheet NOT FOUND'); return; }

  var lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('MaterialMaster has no data rows'); return; }

  var data = sh.getRange(2, 1, lastRow - 1, MM_HEADERS.length).getValues();
  var totalRows = data.length;

  var nonEmpty = 0;
  var empty = 0;
  var groups = {};

  for (var i = 0; i < data.length; i++) {
    var mat = String(data[i][0] || '').trim();
    if (!mat) continue;
    var pg = String(data[i][MM_COL.PROD_GROUP - 1] || '').trim();
    if (pg) {
      nonEmpty++;
      groups[pg] = (groups[pg] || 0) + 1;
    } else {
      empty++;
    }
  }

  Logger.log('========================================');
  Logger.log('MaterialMaster ProductGroup Audit');
  Logger.log('========================================');
  Logger.log('1) Total material rows (excl header): ' + totalRows);
  Logger.log('');
  Logger.log('2) ProductGroup populated: ' + nonEmpty + '  |  empty: ' + empty);
  Logger.log('');

  Logger.log('3) Distinct ProductGroup values:');
  var keys = Object.keys(groups).sort();
  if (keys.length === 0) {
    Logger.log('   (none — all rows are empty)');
  } else {
    for (var k = 0; k < keys.length; k++) {
      Logger.log('   "' + keys[k] + '"  →  ' + groups[keys[k]] + ' materials');
    }
  }
  Logger.log('');

  Logger.log('4) Specific material lookups:');
  var targets = [
    'STT1001-A0200S3XRX',
    'STB1006-C0000005RX',
    'STB1006-A0503S3XRX',
    'FHW2001-101P30I03F'
  ];
  for (var t = 0; t < targets.length; t++) {
    var found = false;
    for (var j = 0; j < data.length; j++) {
      if (String(data[j][0] || '').trim() === targets[t]) {
        var pgVal = String(data[j][MM_COL.PROD_GROUP - 1] || '').trim();
        Logger.log('   ' + targets[t] + '  →  ' + (pgVal || '(empty)'));
        found = true;
        break;
      }
    }
    if (!found) Logger.log('   ' + targets[t] + '  →  (not in MaterialMaster)');
  }
  Logger.log('');

  Logger.log('5) VERDICT:');
  var pct = totalRows > 0 ? Math.round(nonEmpty / totalRows * 100) : 0;
  Logger.log('   ' + nonEmpty + '/' + totalRows + ' rows populated (' + pct + '%)');
  if (pct >= 80) {
    Logger.log('   ✅ ProductGroup is well-populated — cascade is viable now.');
  } else if (pct >= 30) {
    Logger.log('   ⚠️ Partial coverage — cascade would work for ' + pct + '% of materials, backfill recommended for the rest.');
  } else {
    Logger.log('   ❌ ProductGroup is mostly empty — needs backfill before driving a cascade.');
  }
  Logger.log('========================================');
}

// ============================================================================
// Preview allocation performance diagnosis
// ============================================================================

/**
 * Performance profiler for previewPalletAllocation (post-optimization).
 * Instruments the three data-loading functions + the full preview call for
 * material STT1001-B1700S3ARX, qty 450.
 *
 * Reports: total ms, #REL orders, #SAP calls, #sheet reads, biggest sink,
 * and execution-scope cache effectiveness.
 */
function timePreviewAllocation() {
  var MAT = 'STT1001-B1700S3ARX';
  var QTY = 450;

  Logger.log('');
  Logger.log('╔══════════════════════════════════════════════════════════╗');
  Logger.log('║  timePreviewAllocation — performance profiler           ║');
  Logger.log('║  material=' + MAT + '  qty=' + QTY + '      ║');
  Logger.log('╚══════════════════════════════════════════════════════════╝');
  Logger.log('');

  // ---- 1. Time each data-loading function independently (cold reads) -------
  clearAllocCache_();
  var t0, t1;
  var materialMap, poList, pmSummary;

  t0 = Date.now();
  materialMap = getMaterialMap();
  t1 = Date.now();
  var msMaterialMap = t1 - t0;
  Logger.log('[1/3] getMaterialMap()               : ' + msMaterialMap + ' ms  (' + Object.keys(materialMap).length + ' materials with MOQ>0)');

  clearAllocCache_();
  t0 = Date.now();
  poList = getReleasedPoDataForPreview_();
  t1 = Date.now();
  var msPoList = t1 - t0;
  Logger.log('[2/3] getReleasedPoDataForPreview_() : ' + msPoList + ' ms  (' + poList.length + ' REL orders total)');

  clearAllocCache_();
  t0 = Date.now();
  pmSummary = getPmPreviewSummary_();
  t1 = Date.now();
  var msPmSummary = t1 - t0;
  var pmIds = _allocCache_.existingPalletIds ? Object.keys(_allocCache_.existingPalletIds).length : 0;
  Logger.log('[3/3] getPmPreviewSummary_() (narrow): ' + msPmSummary + ' ms  (' + Object.keys(pmSummary).length + ' MOs, ' + pmIds + ' PalletIDs collected)');

  var msDataLoad = msMaterialMap + msPoList + msPmSummary;
  Logger.log('');
  Logger.log('Data loading total (cold): ' + msDataLoad + ' ms');

  // ---- 2. Count REL orders for this material --------------------------------
  var candidates = poList.filter(function(po) { return po.Material === MAT; });
  Logger.log('');
  Logger.log('REL orders for ' + MAT + ': ' + candidates.length);
  candidates.forEach(function(po, i) {
    var pm = pmSummary[po.ManufacturingOrder] || { confirmedPalletQty: 0, nonConfirmedPalletQty: 0 };
    var effectiveConfirmed = Math.max(po.MfgOrderConfirmedYieldQty, pm.confirmedPalletQty);
    var availableQty = Math.max(0, po.TotalQuantity - effectiveConfirmed - pm.nonConfirmedPalletQty);
    Logger.log('  [' + i + '] MO=' + po.ManufacturingOrder +
      ' Total=' + po.TotalQuantity +
      ' SAPConfirmedYield=' + po.MfgOrderConfirmedYieldQty +
      ' confirmedPalletQty=' + pm.confirmedPalletQty +
      ' nonConfirmedPalletQty=' + pm.nonConfirmedPalletQty +
      ' → availableQty=' + availableQty);
  });

  // ---- 3. Full preview call timing (clears cache, re-reads) -----------------
  Logger.log('');
  t0 = Date.now();
  var result = previewPalletAllocation([{ material: MAT, requestedQty: QTY }]);
  t1 = Date.now();
  var msPreview = t1 - t0;
  Logger.log('previewPalletAllocation() total: ' + msPreview + ' ms');

  // ---- 4. Cache effectiveness: second preview (should be near-zero reads) ---
  t0 = Date.now();
  var result2 = previewPalletAllocation([{ material: MAT, requestedQty: QTY }]);
  t1 = Date.now();
  var msPreview2 = t1 - t0;
  Logger.log('previewPalletAllocation() 2nd call (cache cleared by entry): ' + msPreview2 + ' ms');
  Logger.log('  (2nd call clears+re-reads; in commit flow, preview cache is reused for getMaterialMap + existingPalletIds)');

  // ---- 5. Result summary ----------------------------------------------------
  Logger.log('');
  if (result && result.length > 0) {
    var r = result[0];
    Logger.log('Result: allocated=' + r.allocatedQty + ' shortfall=' + r.shortfall +
      ' orders=' + r.orders.length +
      ' pallets=' + r.orders.reduce(function(s, o) { return s + o.pallets.length; }, 0));
  }

  // ---- 6. Diagnosis summary -------------------------------------------------
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log('DIAGNOSIS SUMMARY');
  Logger.log('══════════════════════════════════════════');
  Logger.log('Preview time         : ' + msPreview + ' ms');
  Logger.log('  getMaterialMap     : ' + msMaterialMap + ' ms');
  Logger.log('  getReleasedPO      : ' + msPoList + ' ms');
  Logger.log('  getPmPreviewSummary: ' + msPmSummary + ' ms (narrow: 4 of 33 cols)');
  Logger.log('  Data load subtotal : ' + msDataLoad + ' ms');
  Logger.log('  Overhead (logEvent): ~' + Math.max(0, msPreview - msDataLoad) + ' ms (single summary append)');
  Logger.log('');
  Logger.log('#REL orders for material : ' + candidates.length);
  Logger.log('#SAP HTTP calls          : 0');
  Logger.log('#Sheet reads (preview)   : 3 (cached within execution) + 1 EventLog append');
  Logger.log('#Sheet reads (commit)    : +1 PO full (getReleasedPoData_); MM + PM reuse cache');
  Logger.log('');

  var biggest = 'getMaterialMap';
  var biggestMs = msMaterialMap;
  if (msPoList > biggestMs)    { biggest = 'getReleasedPoDataForPreview_'; biggestMs = msPoList; }
  if (msPmSummary > biggestMs) { biggest = 'getPmPreviewSummary_';        biggestMs = msPmSummary; }
  Logger.log('Biggest single sink  : ' + biggest + ' (' + biggestMs + ' ms)');
  Logger.log('══════════════════════════════════════════');
}

// ============================================================================
// Material allocation diagnosis — why does previewPalletAllocation return 0?
// ============================================================================

/**
 * Diagnose why previewPalletAllocation returns 0 pallets for a specific material.
 * READ-ONLY — no writes, no SAP calls.
 *
 * Checks: (1) PO rows exist for the material, (2) MaterialMap has MOQ>0,
 * (3) PalletMaster consumption per order, (4) actual previewPalletAllocation
 * result, (5) verdict summarizing the root cause.
 */
function diagnoseMaterialAllocation() {
  var MAT = 'STT1001-B1700S3ARX';

  Logger.log('');
  Logger.log('╔══════════════════════════════════════════════════════════╗');
  Logger.log('║  diagnoseMaterialAllocation                             ║');
  Logger.log('║  material=' + MAT + '                  ║');
  Logger.log('╚══════════════════════════════════════════════════════════╝');

  // ---- PART 1: List ALL ProductionOrders rows for MAT ----------------------
  Logger.log('');
  Logger.log('── PART 1: ProductionOrders rows for ' + MAT + ' ──');

  var sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  var poRows = [];
  if (sh && sh.getLastRow() >= 2) {
    var data = sh.getDataRange().getValues();
    var hdr = data[0];
    var idx = {};
    hdr.forEach(function(h, i) { idx[h] = i; });

    for (var r = 1; r < data.length; r++) {
      if (String(data[r][idx.Material] || '').trim() !== MAT) continue;
      var row = data[r];
      var mo       = String(row[idx.ManufacturingOrder] || '').trim();
      var orderType = String(row[idx.ManufacturingOrderType] || '').trim();
      var isRel    = row[idx.IsReleased];
      var statusC  = String(row[idx.StatusCodes] || '').trim();
      var sloc     = String(row[idx.StorageLocation] || '').trim();
      var totalQty = Number(row[idx.TotalQuantity]) || 0;
      var confirmed = Number(row[idx.MfgOrderConfirmedYieldQty]) || 0;

      Logger.log('  MO=' + mo +
        ' | Type=' + orderType +
        ' | IsReleased=' + JSON.stringify(isRel) + ' (typeof ' + typeof isRel + ')' +
        ' | StatusCodes=' + (statusC || '(empty)') +
        ' | SLoc=' + (sloc || '(empty)') +
        ' | TotalQty=' + totalQty +
        ' | ConfirmedYield=' + confirmed);

      poRows.push({ mo: mo, orderType: orderType, isRel: isRel, totalQty: totalQty, confirmed: confirmed });
    }
  }
  Logger.log('PART 1 TOTAL: ' + poRows.length + ' PO rows for ' + MAT);
  if (poRows.length === 0) {
    Logger.log('  ⛔ No rows in ProductionOrders for this material — likely removed by removeStaleOrders_ during pullProductionOrders sync');
  }

  // ---- PART 2: MaterialMap check -------------------------------------------
  Logger.log('');
  Logger.log('── PART 2: getMaterialMap() lookup ──');

  var materialMap = getMaterialMap();
  var mmData = materialMap[MAT];
  if (mmData) {
    Logger.log('  FOUND in MaterialMap: moq=' + mmData.moq +
      ' unit=' + mmData.unit +
      ' status=' + mmData.status +
      ' orderType=' + mmData.orderType +
      ' storageLocation=' + (mmData.storageLocation || '(empty)') +
      ' productGroup=' + (mmData.productGroup || '(empty)'));
  } else {
    Logger.log('  ⛔ NOT FOUND in MaterialMap (moq=0 or missing from MaterialMaster)');
  }
  var hasMoq = mmData && mmData.moq > 0;
  Logger.log('  hasMoq=' + hasMoq + (hasMoq ? '' : ' → previewPalletAllocation will return NO_MOQ'));

  // ---- PART 3: PalletMaster consumption per order --------------------------
  Logger.log('');
  Logger.log('── PART 3: PalletMaster rows for ' + MAT + ' orders ──');

  var moSet = {};
  poRows.forEach(function(p) { moSet[p.mo] = true; });

  var pmSh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PALLET_MASTER);
  var pmByMo = {}; // { mo: { confirmedQty, nonConfirmedQty, count } }
  if (pmSh && pmSh.getLastRow() >= 2) {
    var pmData = pmSh.getDataRange().getValues();
    var pmHdr = pmData[0];
    var pmIdx = {};
    pmHdr.forEach(function(h, i) { pmIdx[h] = i; });

    for (var p = 1; p < pmData.length; p++) {
      var pmMo     = String(pmData[p][pmIdx.ManufacturingOrder] || '').trim();
      if (!moSet[pmMo]) continue;
      var pmQty    = Number(pmData[p][pmIdx.QtyPerPallet]) || 0;
      var pmStatus = String(pmData[p][pmIdx.ScanStatus] || '').trim().toUpperCase();

      if (!pmByMo[pmMo]) pmByMo[pmMo] = { confirmedQty: 0, nonConfirmedQty: 0, count: 0 };
      pmByMo[pmMo].count++;
      if (pmStatus === 'CONFIRMED') {
        pmByMo[pmMo].confirmedQty += pmQty;
      } else {
        pmByMo[pmMo].nonConfirmedQty += pmQty;
      }

      Logger.log('  PM: MO=' + pmMo +
        ' QtyPerPallet=' + pmQty +
        ' ScanStatus=' + pmStatus);
    }
  }

  var moKeys = Object.keys(pmByMo);
  if (moKeys.length === 0) {
    Logger.log('  (no PalletMaster rows for any of these orders)');
  } else {
    moKeys.forEach(function(mo) {
      var s = pmByMo[mo];
      Logger.log('  SUMMARY MO=' + mo +
        ': pallets=' + s.count +
        ' confirmedQty=' + s.confirmedQty +
        ' nonConfirmedQty(printed)=' + s.nonConfirmedQty +
        ' totalConsumed=' + (s.confirmedQty + s.nonConfirmedQty));
    });
  }

  // Compute availableQty per PO row using same logic as previewPalletAllocation
  Logger.log('');
  Logger.log('  Available qty per order (same calc as previewPalletAllocation):');
  poRows.forEach(function(po) {
    var pm = pmByMo[po.mo] || { confirmedQty: 0, nonConfirmedQty: 0 };
    var effectiveConfirmed = Math.max(po.confirmed, pm.confirmedQty);
    var alreadyPrinted = pm.nonConfirmedQty;
    var available = Math.max(0, po.totalQty - effectiveConfirmed - alreadyPrinted);
    Logger.log('    MO=' + po.mo +
      ' TotalQty=' + po.totalQty +
      ' effectiveConfirmed=' + effectiveConfirmed +
      ' (SAP=' + po.confirmed + ', PM=' + pm.confirmedQty + ')' +
      ' alreadyPrinted=' + alreadyPrinted +
      ' → availableQty=' + available);
  });

  // ---- PART 4: Actual previewPalletAllocation result -----------------------
  Logger.log('');
  Logger.log('── PART 4: previewPalletAllocation() result ──');

  var result = previewPalletAllocation([{ material: MAT, requestedQty: 450 }]);
  if (result && result.length > 0) {
    var res = result[0];
    Logger.log('  material=' + res.material +
      ' requestedQty=' + res.requestedQty +
      ' allocatedQty=' + res.allocatedQty +
      ' shortfall=' + res.shortfall +
      (res.error ? ' error=' + res.error : ''));

    if (res.orders && res.orders.length > 0) {
      res.orders.forEach(function(o, i) {
        Logger.log('  order[' + i + ']: MO=' + o.manufacturingOrder +
          ' totalQty=' + o.totalQuantity +
          ' confirmedQty=' + o.confirmedQty +
          ' alreadyPrinted=' + o.alreadyPrintedQty +
          ' availableQty=' + o.availableQty +
          ' allocated=' + o.allocatedFromThisOrder +
          ' pallets=' + o.pallets.length);
        o.pallets.forEach(function(p) {
          Logger.log('    L' + (p.palletSeq < 10 ? '0' : '') + p.palletSeq + ' qty=' + p.qty);
        });
      });
    } else {
      Logger.log('  NO ORDERS AFTER FILTER — candidates empty or all availableQty=0');
    }
  } else {
    Logger.log('  previewPalletAllocation returned empty array');
  }

  Logger.log('  FULL RESULT: ' + JSON.stringify(result, null, 2));

  // ---- PART 5: Verdict -----------------------------------------------------
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log('VERDICT');
  Logger.log('══════════════════════════════════════════');

  var allocatedQty = (result && result[0]) ? result[0].allocatedQty : 0;
  var error        = (result && result[0]) ? (result[0].error || '') : '';

  if (poRows.length === 0) {
    Logger.log('ROOT CAUSE: No ProductionOrders rows for ' + MAT + '.');
    Logger.log('  Orders were likely removed by removeStaleOrders_ during');
    Logger.log('  pullProductionOrders sync (order no longer passes isReleasedOrder_).');
  } else if (!hasMoq) {
    Logger.log('ROOT CAUSE: Material not in getMaterialMap() (MOQ=0 or missing).');
    Logger.log('  previewPalletAllocation returns NO_MOQ error=' + error);
  } else if (allocatedQty > 0) {
    Logger.log('ALLOCATION OK: allocated=' + allocatedQty + ' — issue may be timing/stale cache.');
  } else {
    // poRows exist and hasMoq but allocated=0 → all availableQty consumed
    var allConsumed = true;
    var anyRelFalse = false;
    poRows.forEach(function(po) {
      var pm = pmByMo[po.mo] || { confirmedQty: 0, nonConfirmedQty: 0 };
      var effectiveConfirmed = Math.max(po.confirmed, pm.confirmedQty);
      var available = Math.max(0, po.totalQty - effectiveConfirmed - pm.nonConfirmedQty);
      if (available > 0) allConsumed = false;
      if (!po.isRel && po.isRel !== 'TRUE' && po.isRel !== true) anyRelFalse = true;
    });

    if (anyRelFalse) {
      Logger.log('ROOT CAUSE: PO rows exist but IsReleased is falsy for some/all.');
      Logger.log('  getReleasedPoDataForPreview_ skips rows where IsReleased is not true/TRUE.');
      Logger.log('  Per-order IsReleased values:');
      poRows.forEach(function(po) {
        var passes = !(!po.isRel && po.isRel !== 'TRUE' && po.isRel !== true);
        Logger.log('    MO=' + po.mo + ' IsReleased=' + JSON.stringify(po.isRel) + ' passes=' + passes);
      });
    } else if (allConsumed) {
      Logger.log('ROOT CAUSE: All orders have availableQty=0.');
      Logger.log('  TotalQuantity fully consumed by confirmedQty + alreadyPrintedQty.');
    } else {
      Logger.log('ROOT CAUSE: Unknown — PO rows exist, IsReleased=true, MOQ>0,');
      Logger.log('  availableQty>0 for some orders, yet allocation=0.');
      Logger.log('  Check previewPalletAllocation FULL RESULT above for clues.');
    }
  }

  Logger.log('');
  Logger.log('SUMMARY: poRows=' + poRows.length +
    ' hasMoq=' + hasMoq +
    ' allocatedQty=' + allocatedQty +
    ' error=' + (error || 'none'));
  Logger.log('══════════════════════════════════════════');
}

// ============================================================================
// StorageLocation backfill test
// ============================================================================

/**
 * Test populateMaterialStorageLocation() and verify results for known materials.
 * Calls the backfill, then reads back specific materials to confirm SLoc values.
 */
function testStorageLocationBackfill() {
  Logger.log('=== testStorageLocationBackfill ===');

  const result = populateMaterialStorageLocation();
  Logger.log('Result: ' + JSON.stringify(result));

  const map = getMaterialMap();
  const checks = ['STT1001-A0200S3XRX', 'STB1006-C0000005RX', 'STB1006-A0503S3XRX'];
  checks.forEach(mat => {
    const info = map[mat];
    Logger.log(mat + ' → SLoc=' + (info ? info.storageLocation || '(empty)' : 'NOT IN MAP'));
  });

  // Find 2 PDFG materials (expect WF01)
  const pdfgSamples = Object.keys(map).filter(m => map[m].orderType === 'PDFG').slice(0, 2);
  pdfgSamples.forEach(mat => {
    Logger.log(mat + ' (PDFG) → SLoc=' + (map[mat].storageLocation || '(empty)'));
  });

  Logger.log('=== testStorageLocationBackfill complete ===');
}

// ============================================================================
// Override UI test helpers — seed / cleanup fake candidate in PalletMaster
// ============================================================================

/**
 * TEST ONLY: insert multiple fake override candidates into PalletMaster with
 * different StorageLocation + Material combos so the cascade filter can be
 * exercised. PalletIDs are clearly fake — WILL post to SAP if confirmed live,
 * so only confirm under DRY_RUN.
 *
 * Rows seeded (all MO 1000036350, FinalOperation 0030, QC_COMPLETE/PASS):
 *   PL-TEST-OVR-A1  ST39  TESTMAT-A
 *   PL-TEST-OVR-A2  ST39  TESTMAT-B
 *   PL-TEST-OVR-B1  PW30  TESTMAT-A
 *   PL-TEST-OVR-B2  PW40  TESTMAT-C
 *   PL-TEST-OVR-C1  ''    TESTMAT-A   (empty storage bucket)
 *
 * @return {string[]} PalletIDs actually created (skips duplicates)
 */
function seedOverrideTestPallet_() {
  const CANDIDATES = [
    { id: 'PL-TEST-OVR-A1', sloc: 'ST39', mat: 'TESTMAT-A', matName: 'Test A' },
    { id: 'PL-TEST-OVR-A2', sloc: 'ST39', mat: 'TESTMAT-B', matName: 'Test B' },
    { id: 'PL-TEST-OVR-B1', sloc: 'PW30', mat: 'TESTMAT-A', matName: 'Test A' },
    { id: 'PL-TEST-OVR-B2', sloc: 'PW40', mat: 'TESTMAT-C', matName: 'Test C' },
    { id: 'PL-TEST-OVR-C1', sloc: '',     mat: 'TESTMAT-A', matName: 'Test A' },
  ];

  const sh  = getSheet_(PM_SHEET);
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const pidCol = hdr.indexOf('PalletID');
  if (pidCol === -1) throw new Error('seedOverrideTestPallet_: PalletID column not found');

  const lastRow = sh.getLastRow();
  const existingIds = {};
  if (lastRow >= 2) {
    const pidVals = sh.getRange(2, pidCol + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < pidVals.length; i++) {
      existingIds[String(pidVals[i][0]).trim()] = true;
    }
  }

  const created = [];
  const newRows = [];

  for (const c of CANDIDATES) {
    if (existingIds[c.id]) {
      Logger.log('seedOverrideTestPallet_: ' + c.id + ' already exists — skipping');
      continue;
    }
    const vals = {
      PalletID:           c.id,
      ManufacturingOrder: '1000036350',
      Material:           c.mat,
      MaterialName:       c.matName,
      Batch:              '',
      QtyPerPallet:       10,
      Unit:               'PC',
      WorkCenter:         '',
      ProductionDate:     '',
      TotalQuantity:      1,
      Plant:              '1100',
      StorageLocation:    c.sloc,
      FinalOperation:     '0030',
      ScanStatus:         'QC_COMPLETE',
      QCStatus:           'INSPECTED',
      QCResult:           'PASS',
      ConfirmationGroup:  '',
    };
    newRows.push(hdr.map(function(h) { return vals.hasOwnProperty(h) ? vals[h] : ''; }));
    created.push(c.id);
  }

  if (newRows.length > 0) {
    sh.getRange(lastRow + 1, 1, newRows.length, hdr.length).setValues(newRows);
  }

  logEvent('TEST_SEED', 'OVERRIDE_MULTI', 'OK', 0,
    'Created ' + created.length + ' of ' + CANDIDATES.length + ': ' + created.join(', '));
  Logger.log('seedOverrideTestPallet_: created ' + created.length + ' row(s) — ' + created.join(', '));
  return created;
}

/**
 * TEST ONLY: delete all fake override candidate rows — matches PalletIDs
 * starting with 'PL-TEST-OVR' (new multi-row seeds) OR equal to
 * 'PL-TEST-OVERRIDE-001' (legacy single-row seed). Safe to run repeatedly.
 * @return {number} rows deleted
 */
/**
 * Phase 3.5 diagnostic: explain why PL-TEST-OVR-* rows are filtered out of
 * listOverrideCandidates(). Mirrors the EXACT same sheet access, column-name
 * resolution, and filter logic from listOverrideCandidates (WebApp.gs).
 *
 * For every PalletMaster row whose PalletID starts with 'PL-TEST-OVR', logs a
 * JSON object with raw field values and a boolean for each filter condition.
 *
 * READ-ONLY — no writes, no SAP calls.
 */
function diagWhyFiltered() {
  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' diagWhyFiltered — PL-TEST-OVR-* filter diagnosis');
  Logger.log('══════════════════════════════════════════');

  // ---- PalletMaster (same access as listOverrideCandidates) ----
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    Logger.log('PalletMaster sheet empty or missing');
    return;
  }

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  // ---- ProductionOrders FinalOperation map (same as listOverrideCandidates) ----
  var foMap = {};
  var poSh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  if (poSh && poSh.getLastRow() >= 2) {
    var poData = poSh.getDataRange().getValues();
    var poHdr  = poData[0];
    var poMoCol = poHdr.indexOf('ManufacturingOrder');
    var poFoCol = poHdr.indexOf('FinalOperation');
    if (poMoCol !== -1 && poFoCol !== -1) {
      for (var p = 1; p < poData.length; p++) {
        var poMo = String(poData[p][poMoCol] || '').trim();
        var poFo = String(poData[p][poFoCol] || '').trim();
        if (poMo) foMap[poMo] = poFo;
      }
    }
  }

  Logger.log('ProductionOrders foMap size: ' + Object.keys(foMap).length);

  Logger.log('has 1000036350 (plain)? ' + ('1000036350' in foMap));
  Logger.log('has 1000036350.0 ? ' + ('1000036350.0' in foMap));
  Logger.log('sample keys: ' + Object.keys(foMap).slice(0,5).join(' | '));
  Logger.log('val[1000036350]   = ' + foMap['1000036350']);
  Logger.log('val[1000036350.0] = ' + foMap['1000036350.0']);

  // ---- Scan PalletMaster for PL-TEST-OVR-* rows ----
  var found = 0;
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var palletId = String(row[idx['PalletID']] || '').trim();
    if (palletId.indexOf('PL-TEST-OVR') !== 0) continue;
    found++;

    var scanStatus        = String(row[idx['ScanStatus']]        || '').trim();
    var qcStatus          = String(row[idx['QCStatus']]          || '').trim();
    var qcResult          = String(row[idx['QCResult']]          || '').trim();
    var confirmationGroup = String(row[idx['ConfirmationGroup']] || '').trim();
    var mo                = String(row[idx['ManufacturingOrder']]|| '').trim();

    var moInFoMap    = foMap.hasOwnProperty(mo);
    var finalOpVal   = moInFoMap ? foMap[mo] : '';

    var pass_scan = scanStatus !== 'CONFIRMED';
    var pass_cg   = confirmationGroup === '';
    var pass_qc   = qcStatus === 'INSPECTED' && qcResult === 'PASS';
    var pass_fin  = moInFoMap && finalOpVal !== '';

    var allPass = pass_scan && pass_cg && pass_qc && pass_fin;

    Logger.log(JSON.stringify({
      PalletID:            palletId,
      ScanStatus:          scanStatus,
      QCStatus:            qcStatus,
      QCResult:            qcResult,
      ConfirmationGroup:   confirmationGroup,
      ManufacturingOrder:  mo,
      moInFoMap:           moInFoMap,
      FinalOperation:      finalOpVal,
      pass_scan:           pass_scan,
      pass_cg:             pass_cg,
      pass_qc:             pass_qc,
      pass_fin:            pass_fin,
      wouldBeIncluded:     allPass
    }));
  }

  Logger.log('');
  Logger.log('Total PL-TEST-OVR-* rows found: ' + found);
  if (found === 0) {
    Logger.log('No test rows found — run seedOverrideTestPallet_() first');
  }
  Logger.log('══════════════════════════════════════════');
}

/**
 * TEST ONLY: delete all fake override candidate rows — matches PalletIDs
 * starting with 'PL-TEST-OVR' (new multi-row seeds) OR equal to
 * 'PL-TEST-OVERRIDE-001' (legacy single-row seed). Safe to run repeatedly.
 * @return {number} rows deleted
 */
function cleanupOverrideTestPallet_() {
  const sh  = getSheet_(PM_SHEET);
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const pidCol = hdr.indexOf('PalletID');
  if (pidCol === -1) throw new Error('cleanupOverrideTestPallet_: PalletID column not found');

  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    logEvent('TEST_CLEANUP', 'OVERRIDE', 'OK', 0, '0 rows deleted (sheet empty)');
    return 0;
  }

  const pidVals = sh.getRange(2, pidCol + 1, lastRow - 1, 1).getValues();
  const toDelete = [];
  for (let i = 0; i < pidVals.length; i++) {
    const pid = String(pidVals[i][0]).trim();
    if (pid.startsWith('PL-TEST-OVR') || pid === 'PL-TEST-OVERRIDE-001') {
      toDelete.push(i + 2);
    }
  }

  for (let d = toDelete.length - 1; d >= 0; d--) {
    sh.deleteRow(toDelete[d]);
  }

  logEvent('TEST_CLEANUP', 'OVERRIDE', 'OK', 0, toDelete.length + ' rows deleted');
  Logger.log('cleanupOverrideTestPallet_: deleted ' + toDelete.length + ' row(s)');
  return toDelete.length;
}

// ============================================================================
// Phase 5: TEST — Auto-cache FinalOperation at pallet generation
// ============================================================================

/**
 * Self-cleaning test for the auto-cache FinalOperation warm path used by
 * allocatePallets(). Picks one MO that already has FinalOperation cached,
 * clears it, calls getFinalOperationForMo_() to re-warm, then asserts:
 *  1. The STORED cell value is the exact 4-digit zero-padded string
 *     (typeof string, getValue() === '0010') — locks in the storage fix.
 *  2. The returned value and stored value match the routing's expected
 *     final op when compared via _normOpNo_.
 * Restores original value in finally block.
 */
function TEST_autoCacheFinalOp() {
  var fn = 'TEST_autoCacheFinalOp';
  var t0 = Date.now();

  var sh = getSheet_(CFG.SHEETS.PRODUCTION_ORDERS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) throw new Error(fn + ': ProductionOrders sheet is empty');

  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var moCol      = hdr.indexOf('ManufacturingOrder');
  var foCol      = hdr.indexOf('FinalOperation');
  var opsJsonCol = hdr.indexOf('OperationsJSON');
  if (moCol === -1 || foCol === -1 || opsJsonCol === -1) {
    throw new Error(fn + ': required columns not found');
  }

  var data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var testMo = '';
  var originalFinalOp = '';
  var testRowNum = -1;

  for (var i = 0; i < data.length; i++) {
    var mo = String(data[i][moCol] || '').trim();
    var fo = String(data[i][foCol] || '').trim();
    var oj = String(data[i][opsJsonCol] || '').trim();
    if (mo && fo && oj) {
      testMo = mo;
      originalFinalOp = fo;
      testRowNum = i + 2;
      break;
    }
  }
  if (!testMo) throw new Error(fn + ': no MO with FinalOperation+OperationsJSON found');

  Logger.log(fn + ': testMo=' + testMo + ' originalFinalOp=' + originalFinalOp);

  var foCell = sh.getRange(testRowNum, foCol + 1);
  foCell.setValue('');
  SpreadsheetApp.flush();

  try {
    var warmedValue = getFinalOperationForMo_(testMo);
    SpreadsheetApp.flush();

    var storedRaw = sh.getRange(testRowNum, foCol + 1).getValue();
    var storedStr = String(storedRaw == null ? '' : storedRaw).trim();
    var storedType = typeof storedRaw;

    var opsJsonStr = String(sh.getRange(testRowNum, opsJsonCol + 1).getValue() || '').trim();
    var ops = [];
    try { ops = JSON.parse(opsJsonStr); } catch (pe) { /* empty */ }
    var expected = computeFinalOperation_(ops);
    var normExpected = _normOpNo_(expected);

    // Assert 1: stored cell is the exact 4-digit padded string
    var storageOk = storedStr === normExpected && storedType === 'string';
    // Assert 2: returned value normalizes to expected
    var returnOk  = _normOpNo_(warmedValue) === normExpected;
    var pass = storageOk && returnOk;

    var detail = 'mo=' + testMo +
                 ' expected=' + normExpected +
                 ' stored=' + storedStr + '(type=' + storedType + ')' +
                 ' returned=' + warmedValue +
                 ' storageOk=' + storageOk + ' returnOk=' + returnOk;

    Logger.log(pass ? '✅ ' + fn + ' PASSED: ' + detail : '❌ ' + fn + ' FAILED: ' + detail);
    logEvent(fn, testMo, pass ? 'PASS' : 'FAIL', Date.now() - t0, detail);
  } finally {
    foCell.setNumberFormat('@').setValue(_normOpNo_(originalFinalOp));
    SpreadsheetApp.flush();
    Logger.log(fn + ': restored FinalOperation=' + originalFinalOp + ' for ' + testMo);
  }
}

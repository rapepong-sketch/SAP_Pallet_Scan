/**
 * Gate0Probe.gs — Phase 6.5 Gate 0: SAP Partial-Confirmation Live Probe
 * =======================================================================
 * Isolated, throwaway test file. Answers Probe 3 Question C: does tenant
 * my417293 accept a partial confirmation (IsFinalConfirmation:false)
 * followed by a closing confirmation (IsFinalConfirmation:true) on the
 * SAME order operation, with SAP correctly accumulating yield qty across
 * both rounds?
 *
 * Does NOT touch WebApp.gs, Confirmation.gs, OperationLog.gs, Scanner.html,
 * Desktop.html, PalletMaster sheet, or PM_HEADERS. Writes only to a new
 * Gate0ProbeLog sheet (created on first run) against a Kor-supplied TEST
 * order — never against real production pallets.
 *
 * Reuses (read-only calls, no modification):
 *  - padOperation_()            (Confirmation.gs)
 *  - sapWriteEnabled_() / isDryRun_() (Flags.gs)
 *  - getCsrfSession_() / buildSapUrl_() / logEvent() (SapClient.gs)
 *  - getSapCredentials_()       (Config.gs)
 *  - getSpreadsheet_()          (SheetSetup.gs)
 *
 * Menu: a single additive call to addGate0ProbeMenu_() was added at the end
 * of onOpen() in SheetSetup.gs (GAS allows only one onOpen() per project).
 * No existing menu item, sheet, or function in SheetSetup.gs was changed.
 */

// ============================================================================
// TEST_CONFIG — Kor fills these in before running. Placeholders throw.
// ============================================================================

var TEST_CONFIG = {
  ORDER_ID:        '1000036971',   // 12-digit test MO, e.g. '0000012345'
  ORDER_OPERATION: '0010',         // 4-digit op, e.g. '0010'
  ROUND1_QTY:      4,              // e.g. 4
  ROUND2_QTY:      6,              // e.g. 6 (remainder — round1+round2 should equal test total)
  UNIT:            'PC',
  PALLET_ID:       'TESTPARTIAL'  // ConfirmationText token prefix
};

/** Throws loudly if TEST_CONFIG still has placeholder/invalid values. */
function _assertTestConfig_() {
  var c = TEST_CONFIG;
  if (!c.ORDER_ID || c.ORDER_ID === 'REPLACE_ME') {
    throw new Error('Gate0Probe: TEST_CONFIG.ORDER_ID not set — fill in the real test MO before running');
  }
  if (!c.ORDER_OPERATION || c.ORDER_OPERATION === 'REPLACE_ME') {
    throw new Error('Gate0Probe: TEST_CONFIG.ORDER_OPERATION not set — fill in the real test operation before running');
  }
  if (!(Number(c.ROUND1_QTY) > 0)) {
    throw new Error('Gate0Probe: TEST_CONFIG.ROUND1_QTY must be > 0');
  }
  if (!(Number(c.ROUND2_QTY) > 0)) {
    throw new Error('Gate0Probe: TEST_CONFIG.ROUND2_QTY must be > 0');
  }
  if (!c.PALLET_ID) {
    throw new Error('Gate0Probe: TEST_CONFIG.PALLET_ID not set');
  }
}

/**
 * Token design for partial-confirmation rounds (also the Phase 6.5 design
 * candidate if Gate 0 passes). Truncated to 40 chars same as ConfirmationText.
 * @param {string} palletId
 * @param {number} roundNumber
 * @return {string}
 */
function buildPartialConfirmationText_(palletId, roundNumber) {
  return (String(palletId) + '-R' + String(roundNumber)).slice(0, 40);
}

// ============================================================================
// Internal helpers — isolated from Confirmation.gs production path
// ============================================================================

/**
 * Build the confirmation payload for one round.
 * Round 1: IsFinalConfirmation=false, FinalConfirmationType OMITTED (no prior
 *   example of a non-final confirmation in this codebase — omitting rather
 *   than guessing a value is the whole point of this probe).
 * Round 2: IsFinalConfirmation=true, FinalConfirmationType='X' (same as the
 *   existing production payload shape in Confirmation.gs).
 * @param {1|2} round
 */
function _gate0BuildPayload_(round) {
  _assertTestConfig_();
  var c = TEST_CONFIG;
  var orderId = String(c.ORDER_ID).trim().padStart(12, '0');
  var op = padOperation_(c.ORDER_OPERATION);
  var isFinal = (round === 2);
  var qty = (round === 1) ? c.ROUND1_QTY : c.ROUND2_QTY;

  // OData V2 date literal for today at Bangkok midnight — same inline pattern
  // used for POST payloads in Transfer311.gs (no shared formatSapDate_ helper
  // exists in the codebase; Confirmation.gs's buildConfirmationPayload_ omits
  // PostingDate and lets SAP default it, but this probe sets it explicitly).
  var now = new Date();
  var bangkokMs = now.getTime() +
    (now.getTimezoneOffset() * 60000) + (7 * 3600000);
  var bangkokMidnight = new Date(bangkokMs);
  bangkokMidnight.setHours(0, 0, 0, 0);
  var odataDate = '/Date(' + bangkokMidnight.getTime() + ')/';

  var payload = {
    OrderID:                   orderId,
    OrderOperation:            op,
    Sequence:                  '0',
    ConfirmationYieldQuantity: String(qty),
    ConfirmationScrapQuantity: '0',
    ConfirmationUnit:          c.UNIT || 'PC',
    Plant:                     CFG.PLANT,
    PostingDate:               odataDate,
    IsFinalConfirmation:       isFinal,
    ConfirmationText:          buildPartialConfirmationText_(c.PALLET_ID, round)
  };
  if (isFinal) {
    payload.FinalConfirmationType = 'X';
  }
  return payload;
}

/** Live POST to ProdnOrdConf2 — copies the auth/CSRF/endpoint pattern from Confirmation.gs. */
function _gate0Post_(payload) {
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.PROD_ORDER_CONF;
  var session = getCsrfSession_(serviceRoot);
  var creds = getSapCredentials_();
  var postUrl = buildSapUrl_(serviceRoot + 'ProdnOrdConf2');

  var resp = UrlFetchApp.fetch(postUrl, {
    method: 'post',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'X-CSRF-Token': session.token,
      'Cookie': session.cookies,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  return { status: resp.getResponseCode(), body: resp.getContentText() };
}

/**
 * Scoped readback for the Gate 0 test token prefix. READ-ONLY, best-effort —
 * never throws (mirrors sapReadbackConfirmation_'s error-tolerant shape).
 * @param {string} confirmationText — exact token to filter on
 */
function _gate0Readback_(confirmationText) {
  try {
    var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.PROD_ORDER_CONF;
    var url = buildSapUrl_(serviceRoot + 'ProdnOrdConf2', {
      '$filter': "ConfirmationText eq '" + String(confirmationText) + "'",
      '$select': 'ConfirmationGroup,ConfirmationCount,OrderID,OrderOperation,' +
                  'ConfirmationText,ConfirmationYieldQuantity,ConfirmationScrapQuantity,ConfirmationUnit',
      '$top': '5',
      '$format': 'json'
    });
    var creds = getSapCredentials_();
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
        'Accept': 'application/json'
      },
      muteHttpExceptions: true
    });

    var code = resp.getResponseCode();
    var body = resp.getContentText();
    if (code < 200 || code >= 300) {
      return { found: false, error: 'HTTP ' + code + ': ' + body.slice(0, 300), raw: body };
    }

    var parsed = JSON.parse(body);
    var results = (parsed.d && parsed.d.results) || [];
    return { found: results.length > 0, results: results, raw: body };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

/**
 * Best-effort $metadata keyword scan for a possible cumulative/running-total
 * field at the confirmation or order-operation level. Does NOT assume any
 * field name exists — only surfaces candidate lines for manual review.
 */
function _gate0FetchMetadataKeywordScan_() {
  try {
    var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.PROD_ORDER_CONF;
    var creds = getSapCredentials_();
    var url = buildSapUrl_(serviceRoot + '$metadata');
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass) },
      muteHttpExceptions: true
    });

    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      return { ok: false, error: 'HTTP ' + code };
    }

    var xml = resp.getContentText();
    var lines = xml.split(/\r?\n/);
    var hits = lines.filter(function (l) {
      return /Cumulat|RunningTotal|TotalConfirmed|ConfirmedQty|ConfirmedQuantity/i.test(l);
    }).map(function (l) { return l.trim(); });

    return { ok: true, hits: hits, xmlLength: xml.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================================
// Gate0ProbeLog sheet — created on first run, never touches PalletMaster
// ============================================================================

var GATE0_LOG_SHEET_ = 'Gate0ProbeLog';

function _getGate0LogSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(GATE0_LOG_SHEET_);
  if (!sh) {
    sh = ss.insertSheet(GATE0_LOG_SHEET_);
    sh.getRange(1, 1, 1, 5).setValues([['Timestamp', 'Round', 'RequestPayload', 'ResponseStatus', 'ResponseBody']]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function _gate0LogRow_(round, requestPayload, responseStatus, responseBody) {
  var sh = _getGate0LogSheet_();
  sh.appendRow([
    new Date(),
    round,
    (typeof requestPayload === 'string') ? requestPayload : JSON.stringify(requestPayload),
    responseStatus,
    (typeof responseBody === 'string') ? responseBody : JSON.stringify(responseBody)
  ]);
}

/** Inserts the verdict as the top data row (row 2, right after the header). */
function _gate0WriteVerdict_(verdictText) {
  var sh = _getGate0LogSheet_();
  sh.insertRowAfter(1);
  sh.getRange(2, 1, 1, 5).setValues([[new Date(), 'VERDICT', '', '', verdictText]]);
}

// ============================================================================
// Main probe — menu-triggered, single sequential run
// ============================================================================

/**
 * Sequential Gate 0 probe: partial confirmation (round 1) + final confirmation
 * (round 2) against TEST_CONFIG's test MO/operation. Logs every request and
 * response verbatim to Logger and the Gate0ProbeLog sheet, then prints a
 * PASS / FAIL / AMBIGUOUS verdict.
 */
function TEST_probePartialConfirmation() {
  _assertTestConfig_();

  var sapWrite = sapWriteEnabled_();
  var dryRun = isDryRun_();

  Logger.log('=============================================');
  Logger.log('GATE 0 PROBE — this will attempt a REAL POST to SAP (test MO only)');
  Logger.log('Target OrderID=' + TEST_CONFIG.ORDER_ID + ' Operation=' + TEST_CONFIG.ORDER_OPERATION);
  Logger.log('SAP_WRITE_ENABLED=' + sapWrite + ' DRY_RUN=' + dryRun);
  Logger.log('=============================================');

  if (!sapWrite || dryRun) {
    var abortMsg = 'GATE0: ABORTED — requires SAP_WRITE_ENABLED=true and DRY_RUN=false. ' +
      'Current: SAP_WRITE_ENABLED=' + sapWrite + ' DRY_RUN=' + dryRun;
    Logger.log(abortMsg);
    logEvent('GATE0_PROBE', 'ABORT', abortMsg);
    _gate0WriteVerdict_(abortMsg);
    return;
  }

  logEvent('GATE0_PROBE', 'START', 'BEGIN live partial-confirmation probe on MO=' + TEST_CONFIG.ORDER_ID);

  // ---- Round 1: partial (non-final) ----
  var payload1 = _gate0BuildPayload_(1);
  Logger.log('Round 1 request payload: ' + JSON.stringify(payload1));
  var r1 = _gate0Post_(payload1);
  Logger.log('Round 1 response: HTTP ' + r1.status + ' ' + r1.body);
  _gate0LogRow_(1, payload1, r1.status, r1.body);

  if (r1.status < 200 || r1.status >= 300) {
    var verdictR1Fail = 'GATE0: FAIL — round 1 (non-final) rejected with HTTP ' + r1.status + ': ' + r1.body;
    Logger.log(verdictR1Fail);
    logEvent('GATE0_PROBE', 'FAIL', verdictR1Fail.slice(0, 500));
    _gate0WriteVerdict_(verdictR1Fail);
    return; // stop — do not attempt round 2
  }

  // ---- Round 1 readback ----
  Utilities.sleep(2000);
  var text1 = buildPartialConfirmationText_(TEST_CONFIG.PALLET_ID, 1);
  var rb1 = _gate0Readback_(text1);
  Logger.log('Round 1 readback (' + text1 + '): ' + JSON.stringify(rb1));
  _gate0LogRow_('1-READBACK', text1, rb1.found ? 'FOUND' : 'NOT_FOUND', JSON.stringify(rb1));

  // ---- Round 2: final ----
  var payload2 = _gate0BuildPayload_(2);
  Logger.log('Round 2 request payload: ' + JSON.stringify(payload2));
  var r2 = _gate0Post_(payload2);
  Logger.log('Round 2 response: HTTP ' + r2.status + ' ' + r2.body);
  _gate0LogRow_(2, payload2, r2.status, r2.body);

  if (r2.status < 200 || r2.status >= 300) {
    var verdictR2Fail = 'GATE0: FAIL — round 2 (final) rejected with HTTP ' + r2.status + ': ' + r2.body;
    Logger.log(verdictR2Fail);
    logEvent('GATE0_PROBE', 'FAIL', verdictR2Fail.slice(0, 500));
    _gate0WriteVerdict_(verdictR2Fail);
    return;
  }

  // ---- Round 2 readback + accumulation check ----
  Utilities.sleep(2000);
  var text2 = buildPartialConfirmationText_(TEST_CONFIG.PALLET_ID, 2);
  var rb1Final = _gate0Readback_(text1);
  var rb2 = _gate0Readback_(text2);
  Logger.log('Final readback R1 (' + text1 + '): ' + JSON.stringify(rb1Final));
  Logger.log('Final readback R2 (' + text2 + '): ' + JSON.stringify(rb2));
  _gate0LogRow_('2-READBACK', text1 + ' & ' + text2,
    (rb1Final.found && rb2.found) ? 'FOUND_BOTH' : 'MISSING',
    JSON.stringify({ r1: rb1Final, r2: rb2 }));

  var meta = _gate0FetchMetadataKeywordScan_();
  Logger.log('Metadata keyword scan (candidate cumulative-qty fields): ' + JSON.stringify(meta));
  _gate0LogRow_('METADATA_SCAN', '', meta.ok ? 'OK' : 'ERROR', JSON.stringify(meta));

  // ---- Verdict ----
  var qty1 = (rb1Final.found && rb1Final.results[0]) ? Number(rb1Final.results[0].ConfirmationYieldQuantity) : NaN;
  var qty2 = (rb2.found && rb2.results[0]) ? Number(rb2.results[0].ConfirmationYieldQuantity) : NaN;
  var expectedTotal = Number(TEST_CONFIG.ROUND1_QTY) + Number(TEST_CONFIG.ROUND2_QTY);

  var verdict;
  if (!rb1Final.found || !rb2.found) {
    verdict = 'GATE0: AMBIGUOUS — both POSTs returned 2xx but readback could not confirm both tokens ' +
      '(R1 found=' + rb1Final.found + ', R2 found=' + rb2.found + '). Needs manual SAP-side investigation.';
  } else if (!isNaN(qty1) && !isNaN(qty2) && (qty1 + qty2) === expectedTotal) {
    verdict = 'GATE0: PASS — tenant accepts partial + final confirmation, qty accumulates correctly (' +
      expectedTotal + ' = ' + qty1 + '+' + qty2 + ')';
  } else {
    verdict = 'GATE0: AMBIGUOUS — both POSTs succeeded but accumulated qty = ' + (qty1 + qty2) +
      ', expected ' + expectedTotal + ' (R1 yield=' + qty1 + ', R2 yield=' + qty2 +
      '). Needs manual SAP-side investigation.';
  }

  Logger.log(verdict);
  logEvent('GATE0_PROBE', 'VERDICT', verdict.slice(0, 500));
  _gate0WriteVerdict_(verdict);
}

// ============================================================================
// Read-only diagnostic — find open MM/PP posting period (no writes, no probe)
// ============================================================================

/** Parses an OData V2 /Date(ms)/ string or ISO date string into a JS Date, or null. */
function _gate0ParseODataDate_(v) {
  if (!v) return null;
  var m = String(v).match(/\/Date\((\d+)\)\//);
  if (m) return new Date(Number(m[1]));
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * READ-ONLY: finds the most recent accepted PostingDate on ProdnOrdConf2 for
 * Plant 1100, so Kor knows which PostingDate SAP currently accepts for Gate 0
 * round 1/round 2 payloads. Falls back to logging raw $metadata XML if no
 * confirmations exist yet. Logs to Logger only — no sheet writes, no POST.
 */
function TEST_findOpenPostingPeriod() {
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.PROD_ORDER_CONF;
  var creds = getSapCredentials_();

  var url = buildSapUrl_(serviceRoot + 'ProdnOrdConf2', {
    '$top': '1',
    '$filter': "Plant eq '1100'",
    '$orderby': 'ConfirmationEntryDate desc',
    '$select': 'ConfirmationEntryDate,PostingDate,Plant',
    '$format': 'json'
  });

  Logger.log('PERIOD CHECK: GET ' + url);

  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();
  Logger.log('PERIOD CHECK: response HTTP ' + code);

  if (code < 200 || code >= 300) {
    Logger.log('PERIOD CHECK: request failed HTTP ' + code + ': ' + body.slice(0, 500));
    return;
  }

  var parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    Logger.log('PERIOD CHECK: response was not JSON: ' + body.slice(0, 500));
    return;
  }
  var results = (parsed.d && parsed.d.results) || [];

  if (results.length === 0) {
    Logger.log('PERIOD CHECK: no prior confirmations found — paste metadata below');
    var metaUrl = buildSapUrl_(serviceRoot + '$metadata');
    var metaResp = UrlFetchApp.fetch(metaUrl, {
      method: 'get',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass) },
      muteHttpExceptions: true
    });
    var metaCode = metaResp.getResponseCode();
    var metaBody = metaResp.getContentText();
    Logger.log('PERIOD CHECK: $metadata HTTP ' + metaCode);
    Logger.log(metaBody);
    return;
  }

  var hit = results[0];
  var postingDate = _gate0ParseODataDate_(hit.PostingDate);

  Logger.log('PERIOD CHECK: most recent accepted PostingDate = ' +
    (postingDate ? postingDate.toISOString().slice(0, 10) : hit.PostingDate));

  if (postingDate) {
    var mm = String(postingDate.getMonth() + 1).padStart(2, '0');
    var yyyy = postingDate.getFullYear();
    Logger.log('PERIOD CHECK: fiscal period = ' + mm + '/' + yyyy);
  } else {
    Logger.log('PERIOD CHECK: fiscal period = UNKNOWN (could not parse PostingDate raw=' + hit.PostingDate + ')');
  }

  Logger.log('PERIOD CHECK: use this date in Gate 0 round 1 and round 2 payloads');
  Logger.log('PERIOD CHECK: raw entity = ' + JSON.stringify(hit));
}

// ============================================================================
// Menu — separate top-level "🧪 Gate 0 Probe" menu, not mixed into production menu
// ============================================================================

/** Called once from the end of onOpen() in SheetSetup.gs (additive-only). */
function addGate0ProbeMenu_() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('🧪 Gate 0 Probe')
    .addItem('⚠️ Run partial-confirmation probe (LIVE POST to TEST MO)', 'TEST_probePartialConfirmation')
    .addItem('🔍 Find Open Period', 'TEST_findOpenPostingPeriod')
    .addToUi();
}

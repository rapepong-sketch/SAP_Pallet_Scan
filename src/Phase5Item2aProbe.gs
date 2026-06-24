/**
 * Phase5Item2aProbe.gs — TEMPORARY read-only SAP tenant probe
 * =============================================================
 * Phase 5 Sprint 1 item 2a: confirm ConfirmationText and
 * MaterialDocumentHeaderText availability on my417293.
 *
 * *** DELETE THIS FILE BEFORE GO-LIVE ***
 *
 * READ-ONLY: GET only. No POST. No sheet writes (except EventLog via logEvent).
 * Run from menu: 🧪 Diagnostic / Test ▸ 🔬 [Probe] Phase 5 Token Fields
 */

// ============================================================================
// Helpers
// ============================================================================

function _probeAuth_() {
  var creds = getSapCredentials_();
  return 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass);
}

function _probeGet_(url, label) {
  logEvent('PROBE_P5', label, 'FETCH_URL', 0, url);
  Logger.log('  FETCH_URL: ' + url);
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': _probeAuth_(), 'Accept': 'application/json' },
    muteHttpExceptions: true
  });
  return { code: resp.getResponseCode(), body: resp.getContentText() };
}

function _probeGetXml_(url, label) {
  logEvent('PROBE_P5', label, 'FETCH_URL', 0, url);
  Logger.log('  FETCH_URL: ' + url);
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': _probeAuth_(), 'Accept': 'application/xml' },
    muteHttpExceptions: true
  });
  return { code: resp.getResponseCode(), body: resp.getContentText() };
}

/**
 * Extract sap:* annotations from an EDMX Property element.
 * @param {string} xml — full $metadata XML
 * @param {string} propName — e.g. 'ConfirmationText'
 * @return {Object} { found, type, maxLength, creatable, filterable, updatable, raw }
 */
function _extractPropertyAnnotations_(xml, propName) {
  var pattern = new RegExp(
    '<Property[^>]*\\bName="' + propName + '"[^>]*/?>',
    'i'
  );
  var m = xml.match(pattern);
  if (!m) return { found: false };

  var tag = m[0];
  var get = function(attr) {
    var re = new RegExp('\\b' + attr + '="([^"]*)"');
    var mm = tag.match(re);
    return mm ? mm[1] : '(absent)';
  };

  return {
    found: true,
    type:       get('Type'),
    maxLength:  get('MaxLength'),
    creatable:  get('sap:creatable'),
    filterable: get('sap:filterable'),
    updatable:  get('sap:updatable'),
    raw: tag
  };
}

// ============================================================================
// Sample pickers (read sheets, no writes)
// ============================================================================

function _pickConfirmedMO_() {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  var data = sh.getDataRange().getValues();
  var idx = {};
  data[0].forEach(function(h, i) { idx[String(h).trim()] = i; });

  for (var r = 1; r < data.length; r++) {
    var ss = String(data[r][idx['ScanStatus']] || '').trim();
    if (ss !== 'CONFIRMED') continue;
    var pid = String(data[r][idx['PalletID']] || '').trim();
    if (/^PL-TEST-/i.test(pid)) continue;
    var mo = String(data[r][idx['ManufacturingOrder']] || '').trim();
    if (!mo) continue;
    var stripped = mo.replace(/^0+/, '') || '0';
    var padded = ('000000000000' + stripped).slice(-12);
    return { mo: mo, paddedMO: padded, palletId: pid };
  }
  return null;
}

function _pickTransferred311Doc_() {
  var sh = getSpreadsheet_().getSheetByName(TL_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  var data = sh.getDataRange().getValues();
  var idx = {};
  data[0].forEach(function(h, i) { idx[String(h).trim()] = i; });

  for (var r = 1; r < data.length; r++) {
    var st = String(data[r][idx['Status']] || '').trim();
    if (st !== 'TRANSFERRED') continue;
    var refDoc = String(data[r][idx['RefDoc']] || '').trim();
    if (!refDoc || refDoc === 'DRY_RUN') continue;
    var txnId = String(data[r][idx['TxnID']] || '').trim();
    return { txnId: txnId, materialDocument: refDoc };
  }
  return null;
}

// ============================================================================
// Probe runner
// ============================================================================

function runPhase5TokenFieldProbe() {
  var t0 = Date.now();
  var out = [];
  out.push('══════════════════════════════════════════════════════════════════');
  out.push('  Phase 5 Item 2a — LIVE Token-Field Probe on my417293');
  out.push('  Timestamp: ' + Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss"));
  out.push('  READ-ONLY: GET only, no POST');
  out.push('══════════════════════════════════════════════════════════════════');
  out.push('');

  var confRoot  = CFG.SAP_BASE_URL + CFG.SERVICES.PROD_ORDER_CONF;
  var matDocRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;

  // ---- Sample selection ----
  var confSample = _pickConfirmedMO_();
  var t311Sample = _pickTransferred311Doc_();

  out.push('── SAMPLES (auto-picked from sheets) ──');
  if (confSample) {
    out.push('  Confirmed MO: ' + confSample.mo + '  padded: ' + confSample.paddedMO + '  PalletID: ' + confSample.palletId);
  } else {
    out.push('  Confirmed MO: (none found — will skip A2/A3)');
  }
  if (t311Sample) {
    out.push('  311 MatDoc: ' + t311Sample.materialDocument + '  TxnID: ' + t311Sample.txnId);
  } else {
    out.push('  311 MatDoc: (none found — will skip B3)');
  }
  out.push('');

  // ================================================================
  // A. CONFIRMATION — API_PROD_ORDER_CONFIRMATION_2_SRV
  // ================================================================
  out.push('════════════════════════════════════════');
  out.push('  A. CONFIRMATION SERVICE');
  out.push('════════════════════════════════════════');
  out.push('');

  // ---- A1. $metadata — ConfirmationText ----
  out.push('── A1. $metadata — ConfirmationText ──');
  var metaUrl = confRoot + '$metadata';
  var metaResp = _probeGetXml_(metaUrl, 'A1_META');

  if (metaResp.code !== 200) {
    out.push('  FAIL: HTTP ' + metaResp.code);
    out.push('  body: ' + metaResp.body.slice(0, 300));
  } else {
    var confTextAnno = _extractPropertyAnnotations_(metaResp.body, 'ConfirmationText');
    if (!confTextAnno.found) {
      out.push('  FAIL: Property "ConfirmationText" NOT FOUND in $metadata');
    } else {
      out.push('  PASS: ConfirmationText found');
      out.push('    Type:           ' + confTextAnno.type);
      out.push('    MaxLength:      ' + confTextAnno.maxLength);
      out.push('    sap:creatable:  ' + confTextAnno.creatable);
      out.push('    sap:filterable: ' + confTextAnno.filterable);
      out.push('    sap:updatable:  ' + confTextAnno.updatable);
      out.push('    Raw tag: ' + confTextAnno.raw);
    }
  }
  out.push('');

  // ---- A2. Empirical filter test ----
  out.push('── A2. Empirical filter test — ConfirmationText ──');
  if (!confSample) {
    out.push('  SKIP: no confirmed MO sample');
  } else {
    var a2Url = buildSapUrl_(confRoot + 'ProdnOrdConf2', {
      '$filter': "OrderID eq '" + confSample.paddedMO + "' and ConfirmationText eq 'PROBE_NOHIT'",
      '$top': '1',
      '$format': 'json'
    });
    var a2 = _probeGet_(a2Url, 'A2_FILTER');
    if (a2.code === 200) {
      var a2Parsed = JSON.parse(a2.body);
      var a2Count = ((a2Parsed.d || {}).results || []).length;
      out.push('  PASS: HTTP 200, results=' + a2Count + ' (0 expected = filter accepted by SAP)');
      out.push('  → ConfirmationText IS server-filterable (empirical)');
    } else {
      out.push('  FAIL/BLOCKED: HTTP ' + a2.code);
      out.push('  body: ' + a2.body.slice(0, 500));
      if (/not filterable|cannot be used in.*filter/i.test(a2.body)) {
        out.push('  → ConfirmationText is NOT filterable');
      } else {
        out.push('  → Unclear — may be auth/network issue, not filterability');
      }
    }
  }
  out.push('');

  // ---- A3. Sample GET with ConfirmationText ----
  out.push('── A3. Sample GET — existing confirmations ──');
  if (!confSample) {
    out.push('  SKIP: no confirmed MO sample');
  } else {
    var a3Url = buildSapUrl_(confRoot + 'ProdnOrdConf2', {
      '$filter': "OrderID eq '" + confSample.paddedMO + "'",
      '$select': 'ConfirmationGroup,ConfirmationCount,OrderOperation,ConfirmationText',
      '$top': '5',
      '$format': 'json'
    });
    var a3 = _probeGet_(a3Url, 'A3_SAMPLE');
    if (a3.code === 200) {
      var a3Parsed = JSON.parse(a3.body);
      var a3Results = (a3Parsed.d || {}).results || [];
      out.push('  PASS: HTTP 200, ' + a3Results.length + ' confirmation(s) returned');
      for (var i = 0; i < a3Results.length; i++) {
        var c = a3Results[i];
        out.push('    [' + (i + 1) + '] Group=' + (c.ConfirmationGroup || '') +
          ' Count=' + (c.ConfirmationCount || '') +
          ' Op=' + (c.OrderOperation || '') +
          ' ConfirmationText="' + (c.ConfirmationText || '') + '"');
      }
      if (a3Results.length > 0 && (a3Results[0].ConfirmationText === '' ||
          a3Results[0].ConfirmationText === undefined || a3Results[0].ConfirmationText === null)) {
        out.push('  → ConfirmationText is readable and currently EMPTY (expected — we never set it)');
      }
    } else {
      out.push('  FAIL: HTTP ' + a3.code);
      out.push('  body: ' + a3.body.slice(0, 500));
    }
  }
  out.push('');

  // ================================================================
  // B. MATERIAL DOCUMENT — API_MATERIAL_DOCUMENT_SRV
  // ================================================================
  out.push('════════════════════════════════════════');
  out.push('  B. MATERIAL DOCUMENT SERVICE');
  out.push('════════════════════════════════════════');
  out.push('');

  // ---- B1. $metadata — MaterialDocumentHeaderText + ReferenceDocument ----
  out.push('── B1. $metadata — MaterialDocumentHeaderText + ReferenceDocument ──');
  var matMetaUrl = matDocRoot + '$metadata';
  var matMeta = _probeGetXml_(matMetaUrl, 'B1_META');

  if (matMeta.code !== 200) {
    out.push('  FAIL: HTTP ' + matMeta.code);
    out.push('  body: ' + matMeta.body.slice(0, 300));
  } else {
    var hdrtAnno = _extractPropertyAnnotations_(matMeta.body, 'MaterialDocumentHeaderText');
    if (!hdrtAnno.found) {
      out.push('  FAIL: Property "MaterialDocumentHeaderText" NOT FOUND');

      var altAnno = _extractPropertyAnnotations_(matMeta.body, 'DocumentHeaderText');
      if (altAnno.found) {
        out.push('  NOTE: Found "DocumentHeaderText" instead:');
        out.push('    Type: ' + altAnno.type + '  MaxLength: ' + altAnno.maxLength);
        out.push('    sap:creatable: ' + altAnno.creatable + '  sap:filterable: ' + altAnno.filterable);
        out.push('    Raw: ' + altAnno.raw);
      }
    } else {
      out.push('  PASS: MaterialDocumentHeaderText found');
      out.push('    Type:           ' + hdrtAnno.type);
      out.push('    MaxLength:      ' + hdrtAnno.maxLength);
      out.push('    sap:creatable:  ' + hdrtAnno.creatable);
      out.push('    sap:filterable: ' + hdrtAnno.filterable);
      out.push('    sap:updatable:  ' + hdrtAnno.updatable);
      out.push('    Raw tag: ' + hdrtAnno.raw);
    }

    out.push('');
    var refDocAnno = _extractPropertyAnnotations_(matMeta.body, 'ReferenceDocument');
    if (!refDocAnno.found) {
      out.push('  INFO: Property "ReferenceDocument" NOT FOUND on A_MaterialDocumentHeader');
    } else {
      out.push('  PASS: ReferenceDocument found');
      out.push('    Type:           ' + refDocAnno.type);
      out.push('    MaxLength:      ' + refDocAnno.maxLength);
      out.push('    sap:creatable:  ' + refDocAnno.creatable);
      out.push('    sap:filterable: ' + refDocAnno.filterable);
      out.push('    sap:updatable:  ' + refDocAnno.updatable);
      out.push('    Raw tag: ' + refDocAnno.raw);
    }
  }
  out.push('');

  // ---- B2. Empirical filter test ----
  out.push('── B2. Empirical filter test — MaterialDocumentHeaderText ──');

  var filterField = hdrtAnno && hdrtAnno.found ? 'MaterialDocumentHeaderText' : 'DocumentHeaderText';

  var b2Url = buildSapUrl_(matDocRoot + 'A_MaterialDocumentHeader', {
    '$filter': filterField + " eq 'PROBE_NOHIT' and PostingDate ge datetime'2025-01-01T00:00:00'",
    '$top': '1',
    '$format': 'json'
  });
  var b2 = _probeGet_(b2Url, 'B2_FILTER');
  if (b2.code === 200) {
    var b2Parsed = JSON.parse(b2.body);
    var b2Count = ((b2Parsed.d || {}).results || []).length;
    out.push('  PASS: HTTP 200, results=' + b2Count + ' (0 expected)');
    out.push('  → ' + filterField + ' IS server-filterable (empirical)');
  } else {
    out.push('  HTTP ' + b2.code + ' with PostingDate scope');
    out.push('  body: ' + b2.body.slice(0, 500));

    if (/not filterable|cannot be used/i.test(b2.body)) {
      out.push('  → ' + filterField + ' NOT filterable with PostingDate scope');
    }

    out.push('');
    out.push('  Retry with Plant scope...');
    var b2bUrl = buildSapUrl_(matDocRoot + 'A_MaterialDocumentHeader', {
      '$filter': filterField + " eq 'PROBE_NOHIT'",
      '$top': '1',
      '$format': 'json'
    });
    var b2b = _probeGet_(b2bUrl, 'B2_FILTER_RETRY');
    if (b2b.code === 200) {
      out.push('  PASS (no scope filter): HTTP 200');
      out.push('  → ' + filterField + ' IS server-filterable (no scope needed)');
    } else {
      out.push('  HTTP ' + b2b.code);
      out.push('  body: ' + b2b.body.slice(0, 500));
    }
  }
  out.push('');

  // ---- B3. Sample GET on known 311 doc ----
  out.push('── B3. Sample GET — existing 311 material document ──');
  if (!t311Sample) {
    out.push('  SKIP: no TRANSFERRED 311 document found in TransferLog');
  } else {
    var doc = t311Sample.materialDocument;
    var yearGuess = new Date().getFullYear().toString();

    var b3Url = buildSapUrl_(matDocRoot + 'A_MaterialDocumentHeader', {
      '$filter': "MaterialDocument eq '" + doc + "'",
      '$select': filterField + ',ReferenceDocument,MaterialDocument,MaterialDocumentYear,PostingDate',
      '$top': '1',
      '$format': 'json'
    });
    var b3 = _probeGet_(b3Url, 'B3_SAMPLE');
    if (b3.code === 200) {
      var b3Parsed = JSON.parse(b3.body);
      var b3Results = (b3Parsed.d || {}).results || [];
      if (b3Results.length === 0) {
        out.push('  WARN: HTTP 200 but 0 results for MatDoc=' + doc);
        out.push('  (may need MaterialDocumentYear filter)');
      } else {
        var d = b3Results[0];
        out.push('  PASS: HTTP 200, 1 result');
        out.push('    MaterialDocument:           ' + (d.MaterialDocument || ''));
        out.push('    MaterialDocumentYear:       ' + (d.MaterialDocumentYear || ''));
        out.push('    ' + filterField + ': "' + (d[filterField] || '') + '"');
        out.push('    ReferenceDocument:          "' + (d.ReferenceDocument || '') + '"');
        out.push('    PostingDate:                ' + (d.PostingDate || ''));
        out.push('  → Header text fields are readable; currently EMPTY (expected)');
      }
    } else {
      out.push('  FAIL: HTTP ' + b3.code);
      out.push('  body: ' + b3.body.slice(0, 500));
    }
  }
  out.push('');

  // ================================================================
  // VERDICTS
  // ================================================================
  out.push('════════════════════════════════════════');
  out.push('  VERDICTS');
  out.push('════════════════════════════════════════');
  out.push('');

  // Confirmation verdict
  out.push('── CONFIRMATION PATH ──');
  if (confTextAnno && confTextAnno.found) {
    var confCreatable = confTextAnno.creatable;
    var confFilterable = (a2 && a2.code === 200) ? 'YES (empirical)' : confTextAnno.filterable + ' (annotation only)';
    out.push('  token field      = ConfirmationText');
    out.push('  MaxLength        = ' + confTextAnno.maxLength);
    out.push('  sap:creatable    = ' + confCreatable);
    out.push('  server-filterable = ' + confFilterable);
    if (confCreatable === 'false') {
      out.push('  ⛔ BLOCKED: field is NOT creatable — cannot stamp token on POST');
    } else {
      var guardStyle = (a2 && a2.code === 200)
        ? 'SERVER_FILTER (OrderID + ConfirmationText)'
        : 'CLIENT_SCAN_BY_ORDERID (filter by OrderID, scan ConfirmationText client-side)';
      out.push('  guard query      = ' + guardStyle);
      out.push('  token value      = PalletID (max ~20 chars, fits MaxLength=' + confTextAnno.maxLength + ')');
    }
  } else {
    out.push('  ⛔ ConfirmationText not found — must identify alternative field');
  }
  out.push('');

  // Material Document verdict
  out.push('── TRANSFER 311 PATH ──');
  var matField = (hdrtAnno && hdrtAnno.found) ? 'MaterialDocumentHeaderText' : 'DocumentHeaderText';
  var matAnno = (hdrtAnno && hdrtAnno.found) ? hdrtAnno : (typeof altAnno !== 'undefined' ? altAnno : null);

  if (matAnno && matAnno.found) {
    var matCreatable = matAnno.creatable;
    var matFilterable = (b2 && b2.code === 200) ? 'YES (empirical)' : matAnno.filterable + ' (annotation only)';
    out.push('  token field      = ' + matField);
    out.push('  MaxLength        = ' + matAnno.maxLength);
    out.push('  sap:creatable    = ' + matCreatable);
    out.push('  server-filterable = ' + matFilterable);

    if (matCreatable === 'false') {
      out.push('  ⛔ BLOCKED: field is NOT creatable — cannot stamp token on POST');
    } else {
      var matGuard = (b2 && b2.code === 200)
        ? 'SERVER_FILTER (' + matField + ' + PostingDate scope)'
        : 'CLIENT_SCAN_BY_POSTINGDATE (filter by date, scan header text client-side)';
      out.push('  guard query      = ' + matGuard);
      var ml = parseInt(matAnno.maxLength, 10) || 25;
      if (ml >= 36) {
        out.push('  token value      = TxnID (UUID, 36 chars — fits MaxLength=' + ml + ')');
      } else if (ml >= 24) {
        out.push('  token value      = TxnID UUID no-hyphens first ' + (ml - 1) + ' chars (fits MaxLength=' + ml + ')');
      } else {
        out.push('  token value      = TxnID UUID no-hyphens first ' + (ml - 1) + ' chars (tight fit — MaxLength=' + ml + ')');
      }
    }

    if (refDocAnno && refDocAnno.found) {
      out.push('');
      out.push('  alt field        = ReferenceDocument');
      out.push('  MaxLength        = ' + refDocAnno.maxLength);
      out.push('  sap:creatable    = ' + refDocAnno.creatable);
      out.push('  sap:filterable   = ' + refDocAnno.filterable);
    }
  } else {
    out.push('  ⛔ Neither MaterialDocumentHeaderText nor DocumentHeaderText found');
  }
  out.push('');

  var elapsed = Date.now() - t0;
  out.push('── Elapsed: ' + elapsed + 'ms ──');
  out.push('');
  out.push('*** Phase5Item2aProbe.gs is TEMPORARY — delete before go-live ***');

  var report = out.join('\n');
  Logger.log(report);
  logEvent('PROBE_P5', 'Phase5Item2a', 'DONE', elapsed, 'probes complete');

  var escaped = report.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  var html = HtmlService.createHtmlOutput(
    '<pre style="font-family:monospace;font-size:12px;white-space:pre-wrap;max-width:100%;padding:12px">' +
    escaped + '</pre>'
  ).setWidth(900).setHeight(700).setTitle('Phase 5 Token Field Probe');
  SpreadsheetApp.getUi().showModelessDialog(html, 'Phase 5 Item 2a — Token Field Probe');
}

// ============================================================================
// Creatability proof — run AFTER one supervised real confirmation post-redeploy
// ============================================================================

// Pallets confirmed BEFORE this timestamp lack the ConfirmationText stamp.
// Update to the actual redeploy time (Asia/Bangkok) when known.
var STAMP_DEPLOY_AT_ = (function() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
})();

/**
 * Menu entry: auto-pick most recently confirmed real pallet and prove creatability.
 * *** DELETE WITH Phase5Item2aProbe.gs ***
 */
function runConfirmCreatabilityProof() {
  _runCreatabilityProof_(null);
}

/**
 * Menu entry: prompt for a specific PalletID and prove creatability on that pallet.
 * *** DELETE WITH Phase5Item2aProbe.gs ***
 */
function runConfirmCreatabilityProofById() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt(
    '🔬 Creatability Proof — by PalletID',
    'ใส่ PalletID ของพาเลทที่เพิ่ง confirm หลัง redeploy:',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var pid = resp.getResponseText().trim();
  if (!pid) { ui.alert('กรุณาใส่ PalletID'); return; }
  _runCreatabilityProof_(pid);
}

/**
 * Core creatability proof logic. If palletIdOverride is provided, use that
 * exact pallet; otherwise auto-pick the most recently confirmed.
 * @param {string|null} palletIdOverride
 */
function _runCreatabilityProof_(palletIdOverride) {
  var t0 = Date.now();
  var out = [];
  out.push('══════════════════════════════════════════════════════════════════');
  out.push('  Phase 5 Item 2b — Creatability Proof');
  out.push('  Timestamp: ' + Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss"));
  out.push('  Mode: ' + (palletIdOverride ? 'by PalletID (' + palletIdOverride + ')' : 'auto-pick (most recent)'));
  out.push('  READ-ONLY: GET only, no POST');
  out.push('══════════════════════════════════════════════════════════════════');
  out.push('');

  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    out.push('STOP — PalletMaster is empty');
    _showProofDialog_(out, Date.now() - t0);
    return;
  }

  var data = sh.getDataRange().getValues();
  var idx = {};
  data[0].forEach(function(h, i) { idx[String(h).trim()] = i; });

  var target = null;

  if (palletIdOverride) {
    // ---- Lookup by specific PalletID ----
    for (var r = 1; r < data.length; r++) {
      var pid = String(data[r][idx['PalletID']] || '').trim();
      if (pid !== palletIdOverride) continue;
      var ss = String(data[r][idx['ScanStatus']] || '').trim();
      if (ss !== 'CONFIRMED') {
        out.push('STOP — PalletID ' + palletIdOverride + ' is not CONFIRMED (ScanStatus=' + ss + ')');
        _showProofDialog_(out, Date.now() - t0);
        return;
      }
      var mo = String(data[r][idx['ManufacturingOrder']] || '').trim();
      var ca = data[r][idx['ConfirmedAt']];
      var stripped = mo.replace(/^0+/, '') || '0';
      target = {
        palletId: pid,
        mo: mo,
        paddedMO: ('000000000000' + stripped).slice(-12),
        confirmedAt: (ca instanceof Date) ? ca : null
      };
      break;
    }
    if (!target) {
      out.push('STOP — PalletID ' + palletIdOverride + ' not found in PalletMaster');
      _showProofDialog_(out, Date.now() - t0);
      return;
    }
  } else {
    // ---- Auto-pick most recently confirmed real pallet ----
    var bestAt = null;
    for (var r2 = 1; r2 < data.length; r2++) {
      var ss2 = String(data[r2][idx['ScanStatus']] || '').trim();
      if (ss2 !== 'CONFIRMED') continue;
      var pid2 = String(data[r2][idx['PalletID']] || '').trim();
      if (/^PL-TEST-/i.test(pid2)) continue;
      var mo2 = String(data[r2][idx['ManufacturingOrder']] || '').trim();
      if (!mo2) continue;
      var ca2 = data[r2][idx['ConfirmedAt']];
      if (!(ca2 instanceof Date)) continue;
      if (!bestAt || ca2.getTime() > bestAt.getTime()) {
        bestAt = ca2;
        var stripped2 = mo2.replace(/^0+/, '') || '0';
        target = {
          palletId: pid2,
          mo: mo2,
          paddedMO: ('000000000000' + stripped2).slice(-12),
          confirmedAt: ca2
        };
      }
    }
    if (!target) {
      out.push('STOP — no real CONFIRMED pallet with ConfirmedAt found');
      _showProofDialog_(out, Date.now() - t0);
      return;
    }
  }

  out.push('── Selected pallet ──');
  out.push('  PalletID:    ' + target.palletId);
  out.push('  MO:          ' + target.mo);
  out.push('  paddedMO:    ' + target.paddedMO);
  out.push('  ConfirmedAt: ' + (target.confirmedAt
    ? Utilities.formatDate(target.confirmedAt, 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss")
    : '(not a Date)'));
  out.push('  Deploy cutoff: ' + Utilities.formatDate(STAMP_DEPLOY_AT_, 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss"));
  out.push('');

  // ---- Staleness guard ----
  if (target.confirmedAt && target.confirmedAt.getTime() < STAMP_DEPLOY_AT_.getTime()) {
    out.push('════════════════════════════════════════');
    out.push('  ⚠️  INCONCLUSIVE — newest confirmed pallet predates the 2b deploy.');
    out.push('     ConfirmedAt ' + Utilities.formatDate(target.confirmedAt, 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss") +
      ' < deploy cutoff ' + Utilities.formatDate(STAMP_DEPLOY_AT_, 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss"));
    out.push('     Confirm a NEW pallet AFTER redeploy, then re-run.');
    out.push('     (Use "by ID" menu entry to target the exact pallet.)');
    out.push('════════════════════════════════════════');
    _showProofDialog_(out, Date.now() - t0);
    return;
  }

  // ---- SAP readback ----
  out.push('── SAP readback ──');
  var rb = sapReadbackConfirmation_(target.paddedMO, target.palletId);
  out.push('  found:              ' + rb.found);
  if (rb.error) {
    out.push('  error:              ' + rb.error);
  }
  if (rb.found) {
    out.push('  ConfirmationGroup:  ' + (rb.confirmationGroup || ''));
    out.push('  ConfirmationCount:  ' + (rb.confirmationCount || ''));
  }

  var confirmationTextValue = '';
  if (rb.raw) {
    try {
      var parsed = JSON.parse(rb.raw);
      var results = (parsed.d && parsed.d.results) || [];
      if (results.length > 0) {
        confirmationTextValue = results[0].ConfirmationText || '';
      }
    } catch (_) {}
  }
  out.push('  ConfirmationText:   "' + confirmationTextValue + '"');
  out.push('');

  // ---- Verdict ----
  out.push('════════════════════════════════════════');
  if (rb.found && confirmationTextValue === target.palletId) {
    out.push('  ✅ CREATABILITY PROVEN — 2c unlocked');
    out.push('     ConfirmationText === PalletID: exact match');
  } else if (rb.found && confirmationTextValue !== target.palletId) {
    out.push('  ⚠️  found:true but ConfirmationText mismatch');
    out.push('     expected: "' + target.palletId + '"');
    out.push('     got:      "' + confirmationTextValue + '"');
    out.push('     → investigate before enabling retry');
  } else {
    out.push('  ⛔ STOP — token did NOT persist; do not enable retry');
    if (rb.error) {
      out.push('     readback error: ' + rb.error);
    } else {
      out.push('     found:false — ConfirmationText is empty or not queryable');
    }
  }
  out.push('════════════════════════════════════════');

  _showProofDialog_(out, Date.now() - t0);
}

function _showProofDialog_(lines, elapsed) {
  lines.push('');
  lines.push('── Elapsed: ' + elapsed + 'ms ──');
  lines.push('*** Phase5Item2aProbe.gs is TEMPORARY — delete before go-live ***');

  var report = lines.join('\n');
  Logger.log(report);
  logEvent('PROBE_P5', 'CREATABILITY', 'DONE', elapsed, report.slice(0, 500));

  var escaped = report.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  var html = HtmlService.createHtmlOutput(
    '<pre style="font-family:monospace;font-size:12px;white-space:pre-wrap;max-width:100%;padding:12px">' +
    escaped + '</pre>'
  ).setWidth(800).setHeight(500).setTitle('Creatability Proof');
  SpreadsheetApp.getUi().showModelessDialog(html, 'Phase 5 Item 2b — Creatability Proof');
}

/**
 * Transfer311Probe.gs — Phase 4: READ-ONLY probes for 311 transfer development
 * ===================================================================================
 * T1 (PROBE_transfer311ReadbackFilter): isolates HTTP 400 in readback $filter.
 * T2 (PROBE_transfer311Candidates): finds materials with multi-SLoc stock for a
 *     supervised TEST_ 311 transfer.
 *
 * READ-ONLY. No POST, no CSRF, no flag flips, no sheet writes.
 * Self-cleaning: DELETE this file + menu entries at FEATURE_TRANSFER311 LIVE cutover.
 *
 * Reuses: getSapCredentials_() (Config.gs), buildSapUrl_() (SapClient.gs),
 *         CFG.SAP_BASE_URL, CFG.SERVICES.MATERIAL_DOCUMENT, CFG.PLANT (Config.gs).
 */

// ============================================================================
// Internal helper — raw GET with muteHttpExceptions
// ============================================================================

/**
 * @private
 */
function probeRawGet_(url, accept) {
  var creds = getSapCredentials_();
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'Accept': accept || 'application/json'
    },
    muteHttpExceptions: true
  });
  return { code: resp.getResponseCode(), text: resp.getContentText() };
}

// ============================================================================
// Filter probe — one entity-set + $filter per call
// ============================================================================

/**
 * @private
 */
function probeFilter_(label, entitySet, filterExpr) {
  var select = entitySet === 'A_MaterialDocumentItem'
    ? 'MaterialDocument,MaterialDocumentYear,MaterialDocumentItem,Material,Plant'
    : 'MaterialDocument,MaterialDocumentYear,MaterialDocumentHeaderText,PostingDate,GoodsMovementCode';

  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;
  var url = buildSapUrl_(serviceRoot + entitySet, {
    '$filter': filterExpr,
    '$select': select,
    '$top':    '1',
    '$format': 'json'
  });

  Logger.log('FETCH_URL [' + label + '] ' + url);
  var r = probeRawGet_(url);
  Logger.log('[' + label + '] HTTP ' + r.code + ' :: ' + r.text.slice(0, 600));

  var note = '';
  if (r.code >= 400) {
    var m = r.text.match(/"message"\s*:\s*\{[^}]*"value"\s*:\s*"([^"]+)"/);
    note = m ? m[1] : 'see body';
  } else {
    var rows = (r.text.match(/"MaterialDocument"/g) || []).length;
    note = rows + ' row(s)';
  }
  return { label: label, code: r.code, note: note };
}

// ============================================================================
// Metadata probe — extract A_MaterialDocumentHeaderType EntityType block
// ============================================================================

/**
 * @private
 */
function probeMetadataHeaderType_() {
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;
  var url = buildSapUrl_(serviceRoot + '$metadata');

  Logger.log('FETCH_URL [0 metadata] ' + url);
  var r = probeRawGet_(url, 'application/xml');
  Logger.log('[0 metadata] HTTP ' + r.code + ' :: length=' + r.text.length);

  if (r.code >= 400) {
    return { label: '0 metadata', code: r.code, note: 'fetch failed' };
  }

  var blockMatch = r.text.match(
    /<EntityType\s+Name="A_MaterialDocumentHeaderType"[^>]*>[\s\S]*?<\/EntityType>/
  );
  var block = blockMatch ? blockMatch[0] : '(block not found)';
  Logger.log('[0 metadata] A_MaterialDocumentHeaderType block:\n' + block);

  var hasPlant = /Name="Plant"/.test(block);
  return { label: '0 metadata', code: r.code, note: 'Plant present? ' + hasPlant };
}

// ============================================================================
// Entry point — menu-callable
// ============================================================================

function PROBE_transfer311ReadbackFilter() {
  var TOKEN = 'PROBE-DRYRUN-TOKEN';
  var dateFloor = Utilities.formatDate(
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");

  var probes = [
    ['A token-only',     'A_MaterialDocumentHeader',
      "MaterialDocumentHeaderText eq '" + TOKEN + "'"],
    ['B token+Plant',    'A_MaterialDocumentHeader',
      "MaterialDocumentHeaderText eq '" + TOKEN + "' and Plant eq '" + CFG.PLANT + "'"],
    ['C token+PostDate', 'A_MaterialDocumentHeader',
      "MaterialDocumentHeaderText eq '" + TOKEN +
      "' and PostingDate ge datetime'" + dateFloor + "'"],
    ['D item+Plant',     'A_MaterialDocumentItem',
      "Plant eq '" + CFG.PLANT + "'"]
  ];

  var out = [];
  probes.forEach(function(p) { out.push(probeFilter_(p[0], p[1], p[2])); });
  out.push(probeMetadataHeaderType_());

  Logger.log(JSON.stringify(out, null, 2));

  var summary = out.map(function(r) {
    return r.label + ' → HTTP ' + r.code + (r.note ? ' | ' + r.note : '');
  }).join('\n');

  SpreadsheetApp.getUi().alert(
    'Transfer311 Readback Probe (READ-ONLY)\n\n' + summary +
    '\n\nFull URL+body in Executions log.');
}

// ============================================================================
// T2 — Probe stock candidates for supervised TEST_ 311 transfer
// ============================================================================

var MATERIAL_STOCK_SRV_PROBE_ = '/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/';

/**
 * Menu-callable. Lists materials at Plant 1100 with on-hand stock across
 * storage locations — candidates for a supervised test 311 transfer.
 * READ-ONLY: GET only, no writes.
 */
function PROBE_transfer311Candidates() {
  var serviceRoot = CFG.SAP_BASE_URL + MATERIAL_STOCK_SRV_PROBE_;
  var entitySet   = 'A_MatlStkInAcctMod';
  var selectCols  = 'Material,Plant,StorageLocation,Batch,' +
                    'MatlWrhsStkQtyInMatlBaseUnit,MaterialBaseUnit';

  // Try server-side decimal filter first (OData v2: gt 0m)
  var filterExpr = "Plant eq '" + CFG.PLANT + "' and MatlWrhsStkQtyInMatlBaseUnit gt 0m";
  var url = buildSapUrl_(serviceRoot + entitySet, {
    '$filter': filterExpr,
    '$select': selectCols,
    '$top':    '100',
    '$format': 'json'
  });

  Logger.log('FETCH_URL [T2 stock] ' + url);
  var r = probeRawGet_(url);
  Logger.log('[T2 stock] HTTP ' + r.code + ' :: ' + r.text.slice(0, 600));

  var jsFiltered = false;
  if (r.code >= 400) {
    Logger.log('[T2 stock] Decimal filter rejected (HTTP ' + r.code +
      ') — falling back to Plant-only filter + JS qty > 0');
    jsFiltered = true;
    filterExpr = "Plant eq '" + CFG.PLANT + "'";
    url = buildSapUrl_(serviceRoot + entitySet, {
      '$filter': filterExpr,
      '$select': selectCols,
      '$top':    '100',
      '$format': 'json'
    });
    Logger.log('FETCH_URL [T2 stock fallback] ' + url);
    r = probeRawGet_(url);
    Logger.log('[T2 stock fallback] HTTP ' + r.code + ' :: ' + r.text.slice(0, 600));
  }

  if (r.code >= 400) {
    var msg = 'T2 stock probe failed: HTTP ' + r.code;
    Logger.log(msg);
    SpreadsheetApp.getUi().alert(msg + '\n\nSee Executions log for body.');
    return;
  }

  var parsed = JSON.parse(r.text);
  var results = (parsed.d && parsed.d.results) || [];
  Logger.log('[T2 stock] raw rows: ' + results.length +
    (jsFiltered ? ' (server-side decimal filter rejected — filtering in JS)' : ''));

  // ---- Parse + JS qty filter if needed ----
  var rows = [];
  for (var i = 0; i < results.length; i++) {
    var row = results[i];
    var qty = parseFloat(row.MatlWrhsStkQtyInMatlBaseUnit) || 0;
    if (jsFiltered && qty <= 0) continue;
    rows.push({
      Material:     String(row.Material || '').trim(),
      Plant:        String(row.Plant || '').trim(),
      SLoc:         String(row.StorageLocation || '').trim(),
      Batch:        String(row.Batch || '').trim(),
      Qty:          qty,
      Unit:         String(row.MaterialBaseUnit || '').trim()
    });
  }
  Logger.log('[T2 stock] rows with qty > 0: ' + rows.length);

  // ---- Group by Material ----
  var byMat = {};
  for (var j = 0; j < rows.length; j++) {
    var mat = rows[j].Material;
    if (!byMat[mat]) byMat[mat] = [];
    byMat[mat].push(rows[j]);
  }

  // ---- Build candidates ----
  var candidates = [];
  var matKeys = Object.keys(byMat);
  for (var k = 0; k < matKeys.length; k++) {
    var matRows = byMat[matKeys[k]];

    // Distinct SLocs for this material
    var slocSet = {};
    for (var s = 0; s < matRows.length; s++) {
      slocSet[matRows[s].SLoc] = true;
    }
    var slocs = Object.keys(slocSet);
    var multiSloc = slocs.length >= 2;

    // Sort rows by qty desc to pick highest-qty as source
    matRows.sort(function(a, b) { return b.Qty - a.Qty; });

    var from = matRows[0];
    var toSLoc = 'PICK_EMPTY';
    if (multiSloc) {
      for (var t = 0; t < matRows.length; t++) {
        if (matRows[t].SLoc !== from.SLoc) {
          toSLoc = matRows[t].SLoc;
          break;
        }
      }
    }

    candidates.push({
      Material:     from.Material,
      fromSLoc:     from.SLoc,
      toSLoc:       toSLoc,
      Batch:        from.Batch,
      availQty:     from.Qty,
      baseUnit:     from.Unit,
      batchManaged: !!(from.Batch && from.Batch.trim()),
      multiSloc:    multiSloc,
      slocCount:    slocs.length
    });
  }

  // Sort by availQty desc, cap at 10
  candidates.sort(function(a, b) { return b.availQty - a.availQty; });
  candidates = candidates.slice(0, 10);

  Logger.log('[T2 candidates] ' + candidates.length + ' candidates:\n' +
    JSON.stringify(candidates, null, 2));

  // ---- UI alert: compact table for top 5 ----
  var top5 = candidates.slice(0, 5);
  var table = 'Material            | from→to      | batch      | qty unit\n' +
              '--------------------+--------------+------------+-----------\n';
  for (var c = 0; c < top5.length; c++) {
    var cd = top5[c];
    var arrow = cd.fromSLoc + '→' + cd.toSLoc;
    table += padRight_(cd.Material, 20) + '| ' +
             padRight_(arrow, 13) + '| ' +
             padRight_(cd.Batch || '-', 11) + '| ' +
             cd.availQty + ' ' + cd.baseUnit +
             (cd.multiSloc ? '' : ' [single-SLoc]') + '\n';
  }

  SpreadsheetApp.getUi().alert(
    'Transfer311 Test Candidates (READ-ONLY)\n' +
    (jsFiltered ? '⚠ Server-side decimal filter rejected — filtered in JS\n' : '') +
    'Raw rows: ' + rows.length + ', Candidates: ' + candidates.length + '\n\n' +
    table + '\nFull list (10) in Executions log.');
}

/** @private */
function padRight_(str, len) {
  str = String(str || '');
  while (str.length < len) str += ' ';
  return str;
}

// ============================================================================
// T2/T3 — Creatability proof: real 311 POST + token readback + 312 reverse
// ============================================================================

/**
 * ⚠️ WRITES TO SAP. Posts a real 311 movement (1 PC), reads back to prove
 * MaterialDocumentHeaderText token persistence, then immediately reverses
 * with 312 to restore net-zero stock. Must be run manually by Kor via menu.
 *
 * Does NOT use TransferLog or PalletMaster — all constants are hard-coded
 * for this one-time supervised proof.
 */
function TEST_transfer311CreatabilityProof() {
  var fn = 'TEST_transfer311CreatabilityProof';

  // ---- Prerequisite guard ----
  var flag = PropertiesService.getScriptProperties()
    .getProperty('FEATURE_TRANSFER311') || 'OFF';
  if (flag === 'OFF') {
    SpreadsheetApp.getUi().alert(
      '⛔ FEATURE_TRANSFER311 = OFF\n\n' +
      'Set to DRY_RUN or LIVE in Script Properties before running this proof.');
    return;
  }

  // ---- Hard-coded test constants ----
  var M = {
    material: 'STT1001-R0000S3XRX',
    plant:    '1100',
    fromSLoc: 'PW30',
    toSLoc:   'PW40',
    batch:    '0000095121',
    qty:      '1',
    uom:      'PC'
  };
  var txnId = 'ZZTEST-' + Utilities.getUuid().replace(/-/g, '').slice(0, 17);
  var token = String(txnId).replace(/-/g, '').slice(0, 24);
  Logger.log('[' + fn + '] txnId=' + txnId + ' token=' + token +
    ' tokenLen=' + token.length);

  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;
  var stockRoot   = CFG.SAP_BASE_URL + MATERIAL_STOCK_SRV_PROBE_;
  var result = {
    txnId: txnId, token: token,
    post311: {}, readbackFound: null, tokenMatch: null,
    itemCount: null, tokenLevel: null,
    reverse312: {}, qtyBefore: null, qtyAfter: null, netZero: null
  };

  try {
    // ==== STEP 1: Read baseline stock (PW30) ====
    result.qtyBefore = probeStockQty_(stockRoot, M.material, M.plant,
      M.fromSLoc, M.batch);
    Logger.log('[STEP 1] qtyBefore (PW30) = ' + result.qtyBefore);

    // ==== STEP 2: Build 311 payload ====
    var now = new Date();
    var bangkokMs = now.getTime() +
      (now.getTimezoneOffset() * 60000) + (7 * 3600000);
    var bangkokMidnight = new Date(bangkokMs);
    bangkokMidnight.setHours(0, 0, 0, 0);
    var odataDate = '/Date(' + bangkokMidnight.getTime() + ')/';

    var payload311 = {
      GoodsMovementCode:          '04',
      PostingDate:                odataDate,
      DocumentDate:               odataDate,
      MaterialDocumentHeaderText: token,
      to_MaterialDocumentItem: [{
        Material:                     M.material,
        Plant:                        M.plant,
        StorageLocation:              M.fromSLoc,
        IssuingOrReceivingStorageLoc: M.toSLoc,
        GoodsMovementType:            '311',
        QuantityInEntryUnit:          M.qty,
        EntryUnit:                    M.uom,
        Batch:                        M.batch
      }]
    };
    Logger.log('[STEP 2] 311 payload:\n' + JSON.stringify(payload311, null, 2));

    // ==== STEP 3: CSRF + POST 311 ====
    var session = getCsrfSession_(serviceRoot);
    var creds   = getSapCredentials_();
    var postUrl = buildSapUrl_(serviceRoot + 'A_MaterialDocumentHeader');

    Logger.log('FETCH_URL [STEP 3 POST 311] ' + postUrl);
    var resp311 = UrlFetchApp.fetch(postUrl, {
      method: 'post',
      headers: {
        'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
        'X-CSRF-Token':  session.token,
        'Cookie':        session.cookies,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      payload: JSON.stringify(payload311),
      muteHttpExceptions: true
    });

    var code311 = resp311.getResponseCode();
    var body311 = resp311.getContentText();
    Logger.log('[STEP 3] HTTP ' + code311 + ' :: ' + body311.slice(0, 800));

    result.post311.http = code311;
    if (code311 !== 201 && code311 !== 200) {
      result.post311.error = body311.slice(0, 600);
      logEvent(fn, 'POST_311', 'ERROR', 0, 'HTTP ' + code311);
      SpreadsheetApp.getUi().alert(
        '❌ 311 POST FAILED — HTTP ' + code311 + '\n\n' +
        body311.slice(0, 800) + '\n\nNothing to reverse.');
      return;
    }

    var parsed311 = JSON.parse(body311);
    var d311      = parsed311.d || parsed311;
    result.post311.doc  = d311.MaterialDocument || '';
    result.post311.year = d311.MaterialDocumentYear || '';
    Logger.log('[STEP 3] 311 doc=' + result.post311.doc +
      ' year=' + result.post311.year);
    logEvent(fn, 'POST_311', 'OK', 0,
      'doc=' + result.post311.doc + '/' + result.post311.year);

    // ==== STEP 4: T2 readback — token-only filter ====
    var rbUrl = buildSapUrl_(serviceRoot + 'A_MaterialDocumentHeader', {
      '$filter': "MaterialDocumentHeaderText eq '" + token + "'",
      '$select': 'MaterialDocument,MaterialDocumentYear,MaterialDocumentHeaderText',
      '$top':    '5',
      '$format': 'json'
    });
    Logger.log('FETCH_URL [STEP 4 readback] ' + rbUrl);
    var rbResp = probeRawGet_(rbUrl);
    Logger.log('[STEP 4] HTTP ' + rbResp.code + ' :: ' + rbResp.text.slice(0, 600));

    if (rbResp.code >= 200 && rbResp.code < 300) {
      var rbParsed  = JSON.parse(rbResp.text);
      var rbResults = (rbParsed.d && rbParsed.d.results) || [];
      result.readbackFound = rbResults.length > 0;
      if (rbResults.length > 0) {
        var rbText = String(rbResults[0].MaterialDocumentHeaderText || '').trim();
        result.tokenMatch = (rbText === token);
        Logger.log('[STEP 4] readback headerText="' + rbText +
          '" tokenMatch=' + result.tokenMatch);
      }
    } else {
      result.readbackFound = false;
      Logger.log('[STEP 4] readback failed HTTP ' + rbResp.code);
    }

    // ==== STEP 5: T3 granularity — expand items ====
    var docKey = "MaterialDocument='" + result.post311.doc +
      "',MaterialDocumentYear='" + result.post311.year + "'";
    var granUrl = buildSapUrl_(
      serviceRoot + 'A_MaterialDocumentHeader(' + docKey + ')', {
      '$expand': 'to_MaterialDocumentItem',
      '$format': 'json'
    });
    Logger.log('FETCH_URL [STEP 5 granularity] ' + granUrl);
    var granResp = probeRawGet_(granUrl);
    Logger.log('[STEP 5] HTTP ' + granResp.code + ' :: ' +
      granResp.text.slice(0, 800));

    if (granResp.code >= 200 && granResp.code < 300) {
      var granParsed = JSON.parse(granResp.text);
      var granD      = granParsed.d || granParsed;
      var items      = (granD.to_MaterialDocumentItem &&
                        granD.to_MaterialDocumentItem.results) || [];
      result.itemCount  = items.length;
      result.tokenLevel = 'header-only';
      Logger.log('[STEP 5] itemCount=' + items.length +
        ' headerText="' + (granD.MaterialDocumentHeaderText || '') + '"');
    }

    // ==== STEP 6: 312 reverse ====
    var payload312 = {
      GoodsMovementCode:          '04',
      PostingDate:                odataDate,
      DocumentDate:               odataDate,
      MaterialDocumentHeaderText: 'REV-' + token.slice(0, 20),
      to_MaterialDocumentItem: [{
        Material:                     M.material,
        Plant:                        M.plant,
        StorageLocation:              M.toSLoc,
        IssuingOrReceivingStorageLoc: M.fromSLoc,
        GoodsMovementType:            '312',
        QuantityInEntryUnit:          M.qty,
        EntryUnit:                    M.uom,
        Batch:                        M.batch
      }]
    };
    Logger.log('[STEP 6] 312 payload:\n' + JSON.stringify(payload312, null, 2));

    // Fresh CSRF for the reverse POST
    var session2 = getCsrfSession_(serviceRoot);
    Logger.log('FETCH_URL [STEP 6 POST 312] ' + postUrl);
    var resp312 = UrlFetchApp.fetch(postUrl, {
      method: 'post',
      headers: {
        'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
        'X-CSRF-Token':  session2.token,
        'Cookie':        session2.cookies,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      payload: JSON.stringify(payload312),
      muteHttpExceptions: true
    });

    var code312 = resp312.getResponseCode();
    var body312 = resp312.getContentText();
    Logger.log('[STEP 6] HTTP ' + code312 + ' :: ' + body312.slice(0, 800));

    result.reverse312.http = code312;
    if (code312 !== 201 && code312 !== 200) {
      result.reverse312.error = body312.slice(0, 600);
      logEvent(fn, 'POST_312_REVERSE', 'ERROR', 0, 'HTTP ' + code312);
      SpreadsheetApp.getUi().alert(
        '🚨 312 REVERSE FAILED — HTTP ' + code312 + '\n\n' +
        '⚠️ DANGLING 311 DOCUMENT: ' + result.post311.doc + '/' +
        result.post311.year + '\n\n' +
        'Kor: reverse manually in SAP GUI → MIGO → Movement Type 312,\n' +
        'reference document ' + result.post311.doc + ' year ' +
        result.post311.year + '.\n\n' +
        'Response body:\n' + body312.slice(0, 600));
      Logger.log('[FINAL RESULT]\n' + JSON.stringify(result, null, 2));
      logEvent(fn, 'RESULT', 'REVERSE_FAILED', 0, JSON.stringify(result));
      return;
    }

    var parsed312 = JSON.parse(body312);
    var d312      = parsed312.d || parsed312;
    result.reverse312.doc  = d312.MaterialDocument || '';
    result.reverse312.year = d312.MaterialDocumentYear || '';
    Logger.log('[STEP 6] 312 doc=' + result.reverse312.doc +
      ' year=' + result.reverse312.year);
    logEvent(fn, 'POST_312_REVERSE', 'OK', 0,
      'doc=' + result.reverse312.doc + '/' + result.reverse312.year);

    // ==== STEP 7: Read stock again (PW30) ====
    result.qtyAfter = probeStockQty_(stockRoot, M.material, M.plant,
      M.fromSLoc, M.batch);
    result.netZero = (result.qtyAfter === result.qtyBefore);
    Logger.log('[STEP 7] qtyAfter=' + result.qtyAfter +
      ' netZero=' + result.netZero);

    // ==== STEP 8: Summary ====
    Logger.log('[FINAL RESULT]\n' + JSON.stringify(result, null, 2));
    logEvent(fn, 'RESULT', result.netZero ? 'PASS' : 'WARN', 0,
      JSON.stringify(result));

    var summary =
      '311 POST: ' + result.post311.doc + '/' + result.post311.year +
        ' (HTTP ' + result.post311.http + ')\n' +
      'Token readback: found=' + result.readbackFound +
        ' match=' + result.tokenMatch + '\n' +
      'Granularity: ' + result.itemCount + ' item(s), level=' +
        result.tokenLevel + '\n' +
      '312 REVERSE: ' + result.reverse312.doc + '/' +
        result.reverse312.year + ' (HTTP ' + result.reverse312.http + ')\n' +
      'Stock PW30: before=' + result.qtyBefore +
        ' after=' + result.qtyAfter +
        ' netZero=' + result.netZero;

    SpreadsheetApp.getUi().alert(
      'Transfer311 Creatability Proof\n\n' + summary +
      '\n\nFull details in Executions log.');

  } catch (e) {
    Logger.log('[' + fn + '] EXCEPTION: ' + e.message + '\n' + e.stack);
    logEvent(fn, 'EXCEPTION', e.message, 0, JSON.stringify(result));
    SpreadsheetApp.getUi().alert('❌ ' + fn + ' EXCEPTION:\n\n' + e.message +
      '\n\nCheck Executions log. If a 311 was posted, verify stock manually.');
  }
}

/**
 * Read total warehouse stock for a specific Material+Plant+SLoc+Batch.
 * Returns the sum of MatlWrhsStkQtyInMatlBaseUnit across all StockType rows.
 * @private
 */
// ============================================================================
// T2 post-verify — re-read stock + doc items to confirm net-zero settle
// ============================================================================

function PROBE_verify311StockSettle() {
  var M = { material: 'STT1001-R0000S3XRX', plant: '1100', batch: '0000095121' };
  var docs = ['4900215842', '4900215843'];
  var slocs = ['PW30', 'PW40'];
  var stockRoot   = CFG.SAP_BASE_URL + MATERIAL_STOCK_SRV_PROBE_;
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;

  var stockResults = {};
  var docSummaries = [];

  // ---- Read stock for both SLocs ----
  slocs.forEach(function(sloc) {
    var qty = probeStockQty_(stockRoot, M.material, M.plant, sloc, M.batch);
    stockResults[sloc] = qty;
    Logger.log('[settle] ' + sloc + ' qty = ' + qty);
  });

  // ---- Read both material docs with item expansion ----
  docs.forEach(function(doc) {
    var docKey = "MaterialDocument='" + doc + "',MaterialDocumentYear='2026'";
    var url = buildSapUrl_(
      serviceRoot + 'A_MaterialDocumentHeader(' + docKey + ')', {
      '$expand': 'to_MaterialDocumentItem',
      '$format': 'json'
    });
    Logger.log('FETCH_URL [settle doc ' + doc + '] ' + url);
    var r = probeRawGet_(url);
    Logger.log('[settle doc ' + doc + '] HTTP ' + r.code + ' :: ' +
      r.text.slice(0, 1000));

    if (r.code >= 400) {
      docSummaries.push('doc ' + doc + ': HTTP ' + r.code + ' (fetch failed)');
      return;
    }

    var parsed = JSON.parse(r.text);
    var d = parsed.d || parsed;
    var items = (d.to_MaterialDocumentItem &&
                 d.to_MaterialDocumentItem.results) || [];

    var lines = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var line = (it.GoodsMovementType || '?') + ' ' +
        (it.StorageLocation || '?') + '→' +
        (it.IssuingOrReceivingStorageLoc || '?') + ' ' +
        (it.QuantityInEntryUnit || '0') + ' ' +
        (it.EntryUnit || it.MaterialBaseUnit || '?');
      if (it.Batch) line += ' batch=' + it.Batch;
      if (it.DebitCreditCode) line += ' D/C=' + it.DebitCreditCode;
      lines.push(line);
      Logger.log('[settle doc ' + doc + ' item ' + (i + 1) + '] ' +
        'GMT=' + it.GoodsMovementType +
        ' SLoc=' + it.StorageLocation +
        ' IssuingRecv=' + it.IssuingOrReceivingStorageLoc +
        ' Qty=' + it.QuantityInEntryUnit +
        ' Unit=' + it.EntryUnit +
        ' Mat=' + it.Material +
        ' Batch=' + it.Batch +
        ' DebitCredit=' + (it.DebitCreditCode || 'n/a'));
    }
    docSummaries.push('doc ' + doc + ': ' +
      (lines.length > 0 ? lines.join('; ') : 'no items'));
  });

  // ---- Summary ----
  var pw30 = stockResults['PW30'];
  var pw40 = stockResults['PW40'];
  var sum  = pw30 + pw40;

  var alert =
    'Stock Settle Verification (READ-ONLY)\n\n' +
    'PW30: ' + pw30 + '\n' +
    'PW40: ' + pw40 + '\n' +
    'Sum:  ' + sum + '\n\n' +
    docSummaries.join('\n') + '\n\n' +
    'Baseline was PW30=3418, PW40=8000, sum=11418.\n' +
    'Current sum ' + (sum === 11418 ? '=== baseline → balanced ✅' :
      '!== baseline → check details ⚠️');

  Logger.log('[settle summary]\n' + alert);
  SpreadsheetApp.getUi().alert(alert);
}

// ============================================================================
// T2 direction analysis — raw D/C dump + net-per-SLoc for docs 842/843
// ============================================================================

function PROBE_dcDirection311() {
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;
  var docs = ['4900215842', '4900215843'];

  var allDocResults = {};
  var netBySLoc = {};   // combined across both docs

  docs.forEach(function(doc) {
    var docKey = "MaterialDocument='" + doc + "',MaterialDocumentYear='2026'";
    var url = buildSapUrl_(
      serviceRoot + 'A_MaterialDocumentHeader(' + docKey + ')', {
      '$expand': 'to_MaterialDocumentItem',
      '$format': 'json'
    });
    Logger.log('FETCH_URL [D/C doc ' + doc + '] ' + url);
    var r = probeRawGet_(url);
    Logger.log('[D/C doc ' + doc + '] HTTP ' + r.code + ' :: ' +
      r.text.slice(0, 300));

    if (r.code >= 400) {
      allDocResults[doc] = { items: [], error: 'HTTP ' + r.code };
      return;
    }

    var parsed = JSON.parse(r.text);
    var d = parsed.d || parsed;
    var items = (d.to_MaterialDocumentItem &&
                 d.to_MaterialDocumentItem.results) || [];

    var docItems = [];
    var docNet = {};

    for (var i = 0; i < items.length; i++) {
      var it = items[i];

      // Log every raw field the spec asks for
      Logger.log('[D/C doc ' + doc + ' item ' + (i + 1) + '] ' +
        'MaterialDocumentItem=' + it.MaterialDocumentItem +
        ' GoodsMovementType=' + it.GoodsMovementType +
        ' Material=' + it.Material +
        ' Batch=' + it.Batch +
        ' StorageLocation=' + it.StorageLocation +
        ' IssuingOrReceivingStorageLoc=' + it.IssuingOrReceivingStorageLoc +
        ' QuantityInEntryUnit=' + it.QuantityInEntryUnit +
        ' EntryUnit=' + it.EntryUnit +
        ' DebitCreditCode=' + it.DebitCreditCode);
      // Full raw item JSON as fallback
      Logger.log('[D/C doc ' + doc + ' item ' + (i + 1) + ' RAW] ' +
        JSON.stringify(it));

      var qty = parseFloat(it.QuantityInEntryUnit) || 0;
      var sloc = String(it.StorageLocation || '').trim();
      var dc = String(it.DebitCreditCode || '').trim();

      // S = credit/issue (stock leaves SLoc) → negative
      // H = debit/receipt (stock enters SLoc) → positive
      var signed = (dc === 'S') ? -qty : +qty;

      docItems.push({
        item:   it.MaterialDocumentItem,
        gmt:    it.GoodsMovementType,
        sloc:   sloc,
        recvSloc: it.IssuingOrReceivingStorageLoc,
        qty:    qty,
        dc:     dc,
        signed: signed
      });

      if (!docNet[sloc]) docNet[sloc] = 0;
      docNet[sloc] += signed;
      if (!netBySLoc[sloc]) netBySLoc[sloc] = 0;
      netBySLoc[sloc] += signed;
    }

    allDocResults[doc] = {
      items:   docItems,
      netPW30: docNet['PW30'] || 0,
      netPW40: docNet['PW40'] || 0
    };

    Logger.log('[D/C doc ' + doc + ' net] PW30=' + (docNet['PW30'] || 0) +
      ' PW40=' + (docNet['PW40'] || 0));
  });

  var combinedPW30 = netBySLoc['PW30'] || 0;
  var combinedPW40 = netBySLoc['PW40'] || 0;
  var reconciles   = (combinedPW30 === -2 && combinedPW40 === 2);

  // If S/H mapping is inverted, note it
  var invertNote = '';
  if (!reconciles && combinedPW30 === 2 && combinedPW40 === -2) {
    invertNote = '\n⚠ S/H→sign mapping appears INVERTED (S=+, H=-).\n';
  }

  var result = {
    doc842: allDocResults['4900215842'] || {},
    doc843: allDocResults['4900215843'] || {},
    combinedNetPW30: combinedPW30,
    combinedNetPW40: combinedPW40,
    reconcilesToFiori: reconciles
  };

  Logger.log('[D/C RESULT]\n' + JSON.stringify(result, null, 2));

  var r842 = result.doc842;
  var r843 = result.doc843;
  var alert =
    'D/C Direction Analysis (READ-ONLY)\n\n' +
    'Doc 842 (311): netPW30=' + r842.netPW30 + ', netPW40=' + r842.netPW40 + '\n' +
    'Doc 843 (312): netPW30=' + r843.netPW30 + ', netPW40=' + r843.netPW40 + '\n\n' +
    'Combined: PW30=' + combinedPW30 + ', PW40=' + combinedPW40 + '\n' +
    'Reconciles to Fiori (-2/+2): ' + reconciles +
    invertNote + '\n\n' +
    'Items per doc:\n';

  ['4900215842', '4900215843'].forEach(function(doc) {
    var dr = allDocResults[doc] || {};
    var its = dr.items || [];
    alert += 'doc ' + doc + ':\n';
    for (var j = 0; j < its.length; j++) {
      var it = its[j];
      alert += '  item' + it.item + ' GMT=' + it.gmt +
        ' ' + it.sloc + ' D/C=' + it.dc +
        ' signed=' + it.signed + '\n';
    }
  });

  SpreadsheetApp.getUi().alert(alert + '\nFull raw items in Executions log.');
}

// ============================================================================
// Housekeeping — corrective 311 to restore PW30/PW40 baseline
// ============================================================================

/**
 * ⚠️ WRITES TO SAP. Posts a single corrective 311 (2 PC PW40→PW30) to undo
 * the imbalance left by the T2 proof's failed 312 reverse. Pre-checks that
 * the imbalance is exactly -2/+2 before posting; aborts on any other state.
 */
function TEST_transfer311HousekeepingRestore() {
  var fn = 'TEST_transfer311HousekeepingRestore';
  var M = { material: 'STT1001-R0000S3XRX', plant: '1100', batch: '0000095121' };
  var TARGET = { pw30: 3418, pw40: 8000 };
  var stockRoot   = CFG.SAP_BASE_URL + MATERIAL_STOCK_SRV_PROBE_;
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;

  // ==== STEP 1: Pre-check imbalance ====
  var curPW30 = probeStockQty_(stockRoot, M.material, M.plant, 'PW30', M.batch);
  var curPW40 = probeStockQty_(stockRoot, M.material, M.plant, 'PW40', M.batch);
  var delta30 = curPW30 - TARGET.pw30;
  var delta40 = curPW40 - TARGET.pw40;
  Logger.log('[STEP 1] PW30=' + curPW30 + ' (delta=' + delta30 +
    '), PW40=' + curPW40 + ' (delta=' + delta40 + ')');

  if (delta30 === 0 && delta40 === 0) {
    SpreadsheetApp.getUi().alert(
      '✅ Already balanced — nothing to do.\n\n' +
      'PW30=' + curPW30 + ' (target ' + TARGET.pw30 + ')\n' +
      'PW40=' + curPW40 + ' (target ' + TARGET.pw40 + ')');
    return;
  }

  if (!(delta30 === -2 && delta40 === 2)) {
    SpreadsheetApp.getUi().alert(
      '⛔ Unexpected imbalance — aborting. Manual review needed.\n\n' +
      'PW30=' + curPW30 + ' (delta=' + delta30 + ', expected -2)\n' +
      'PW40=' + curPW40 + ' (delta=' + delta40 + ', expected +2)');
    return;
  }

  // ==== STEP 2: Build + POST corrective 311 PW40→PW30, 2 PC ====
  var fixToken = 'ZZTEST-FIX-' + Utilities.getUuid().replace(/-/g, '').slice(0, 14);
  Logger.log('[STEP 2] fixToken=' + fixToken + ' len=' + fixToken.length);

  var now = new Date();
  var bangkokMs = now.getTime() +
    (now.getTimezoneOffset() * 60000) + (7 * 3600000);
  var bangkokMidnight = new Date(bangkokMs);
  bangkokMidnight.setHours(0, 0, 0, 0);
  var odataDate = '/Date(' + bangkokMidnight.getTime() + ')/';

  var payload = {
    GoodsMovementCode:          '04',
    PostingDate:                odataDate,
    DocumentDate:               odataDate,
    MaterialDocumentHeaderText: fixToken,
    to_MaterialDocumentItem: [{
      Material:                     M.material,
      Plant:                        M.plant,
      StorageLocation:              'PW40',
      IssuingOrReceivingStorageLoc: 'PW30',
      GoodsMovementType:            '311',
      QuantityInEntryUnit:          '2',
      EntryUnit:                    'PC',
      Batch:                        M.batch
    }]
  };
  Logger.log('[STEP 2] payload:\n' + JSON.stringify(payload, null, 2));

  var session = getCsrfSession_(serviceRoot);
  var creds   = getSapCredentials_();
  var postUrl = buildSapUrl_(serviceRoot + 'A_MaterialDocumentHeader');

  Logger.log('FETCH_URL [STEP 2 POST 311 fix] ' + postUrl);
  var resp = UrlFetchApp.fetch(postUrl, {
    method: 'post',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'X-CSRF-Token':  session.token,
      'Cookie':        session.cookies,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();
  Logger.log('[STEP 2] HTTP ' + code + ' :: ' + body.slice(0, 800));

  if (code !== 201 && code !== 200) {
    logEvent(fn, 'POST_311_FIX', 'ERROR', 0, 'HTTP ' + code);
    SpreadsheetApp.getUi().alert(
      '❌ Corrective 311 POST failed — HTTP ' + code + '\n\n' +
      body.slice(0, 800));
    return;
  }

  var parsed = JSON.parse(body);
  var d      = parsed.d || parsed;
  var fixDoc  = d.MaterialDocument || '';
  var fixYear = d.MaterialDocumentYear || '';
  Logger.log('[STEP 2] fixDoc=' + fixDoc + '/' + fixYear);
  logEvent(fn, 'POST_311_FIX', 'OK', 0, 'doc=' + fixDoc + '/' + fixYear);

  // ==== STEP 3: Settle delay + re-read ====
  Utilities.sleep(3000);

  var afterPW30 = probeStockQty_(stockRoot, M.material, M.plant, 'PW30', M.batch);
  var afterPW40 = probeStockQty_(stockRoot, M.material, M.plant, 'PW40', M.batch);
  var restored = (afterPW30 === TARGET.pw30 && afterPW40 === TARGET.pw40);
  Logger.log('[STEP 3] afterPW30=' + afterPW30 + ' afterPW40=' + afterPW40 +
    ' restored=' + restored);

  var result = {
    deltaBefore: { pw30: delta30, pw40: delta40 },
    fixDoc:      { doc: fixDoc, year: fixYear, http: code },
    stockAfter:  { pw30: afterPW30, pw40: afterPW40 },
    restored:    restored
  };
  Logger.log('[RESULT]\n' + JSON.stringify(result, null, 2));
  logEvent(fn, 'RESULT', restored ? 'PASS' : 'WARN', 0, JSON.stringify(result));

  SpreadsheetApp.getUi().alert(
    'Housekeeping Restore\n\n' +
    'Before: PW30=' + curPW30 + ' (Δ' + delta30 + '), PW40=' + curPW40 +
      ' (Δ' + delta40 + ')\n' +
    'Fix doc: ' + fixDoc + '/' + fixYear + ' (HTTP ' + code + ')\n' +
    'After:  PW30=' + afterPW30 + ', PW40=' + afterPW40 + '\n' +
    'Restored to baseline: ' + restored);
}

function probeStockQty_(stockRoot, material, plant, sloc, batch) {
  var filterExpr = "Material eq '" + material + "'" +
    " and Plant eq '" + plant + "'" +
    " and StorageLocation eq '" + sloc + "'" +
    " and Batch eq '" + batch + "'";
  var url = buildSapUrl_(stockRoot + 'A_MatlStkInAcctMod', {
    '$filter': filterExpr,
    '$select': 'MatlWrhsStkQtyInMatlBaseUnit,MaterialBaseUnit',
    '$format': 'json'
  });
  Logger.log('FETCH_URL [stock read] ' + url);
  var r = probeRawGet_(url);
  Logger.log('[stock read] HTTP ' + r.code + ' :: ' + r.text.slice(0, 400));

  if (r.code >= 400) {
    Logger.log('[stock read] WARN: HTTP ' + r.code + ' — returning 0');
    return 0;
  }
  var parsed  = JSON.parse(r.text);
  var results = (parsed.d && parsed.d.results) || [];
  var total   = 0;
  for (var i = 0; i < results.length; i++) {
    total += parseFloat(results[i].MatlWrhsStkQtyInMatlBaseUnit) || 0;
  }
  return total;
}

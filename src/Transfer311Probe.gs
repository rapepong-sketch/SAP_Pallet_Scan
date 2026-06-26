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

// ============================================================================
// Probe cancellation mechanism in API_MATERIAL_DOCUMENT_SRV $metadata
// ============================================================================

function PROBE_materialDocCancellation() {
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;
  var url = buildSapUrl_(serviceRoot + '$metadata');

  Logger.log('FETCH_URL [cancel metadata] ' + url);
  var r = probeRawGet_(url, 'application/xml');
  Logger.log('[cancel metadata] HTTP ' + r.code + ' length=' + r.text.length);

  if (r.code >= 400) {
    SpreadsheetApp.getUi().alert('❌ $metadata fetch failed: HTTP ' + r.code);
    return;
  }

  var xml = r.text;

  // ==== PART 1: FunctionImports ====
  var fiBlocks = xml.match(/<FunctionImport[\s\S]*?(?:\/>|<\/FunctionImport>)/g) || [];
  var functionImports = [];

  Logger.log('[PART 1] Found ' + fiBlocks.length + ' FunctionImport block(s)');
  for (var i = 0; i < fiBlocks.length; i++) {
    var block = fiBlocks[i];
    Logger.log('[FunctionImport ' + (i + 1) + ']\n' + block);

    var nameMatch   = block.match(/Name="([^"]+)"/);
    var methodMatch = block.match(/m:HttpMethod="([^"]+)"/);
    var returnMatch = block.match(/ReturnType="([^"]+)"/);

    var params = [];
    var paramMatches = block.match(/<Parameter[^>]*\/>/g) || [];
    for (var p = 0; p < paramMatches.length; p++) {
      var pName = (paramMatches[p].match(/Name="([^"]+)"/) || [])[1] || '?';
      var pType = (paramMatches[p].match(/Type="([^"]+)"/) || [])[1] || '?';
      var pMode = (paramMatches[p].match(/Mode="([^"]+)"/) || [])[1] || '';
      params.push(pName + ':' + pType + (pMode ? '(' + pMode + ')' : ''));
    }

    functionImports.push({
      name:       (nameMatch   || [])[1] || '?',
      httpMethod: (methodMatch || [])[1] || '?',
      returnType: (returnMatch || [])[1] || 'void',
      params:     params
    });
  }

  // ==== PART 2: Reversal fields on Header + Item EntityTypes ====
  var reversalFields = [
    'ReversedMaterialDocument', 'ReversedMaterialDocumentYear',
    'GoodsMovementIsCancelled', 'ReferenceDocument', 'InventoryTransactionType'
  ];

  var headerBlock = (xml.match(
    /<EntityType\s+Name="A_MaterialDocumentHeaderType"[^>]*>[\s\S]*?<\/EntityType>/
  ) || [''])[0];
  var itemBlock = (xml.match(
    /<EntityType\s+Name="A_MaterialDocumentItemType"[^>]*>[\s\S]*?<\/EntityType>/
  ) || [''])[0];

  var reversalFieldsOnHeader = {};
  var reversalFieldsOnItem = {};

  for (var f = 0; f < reversalFields.length; f++) {
    var field = reversalFields[f];

    // Header
    var hPropRe = new RegExp('<Property[^>]*Name="' + field + '"[^>]*/>', 'i');
    var hMatch = headerBlock.match(hPropRe);
    if (hMatch) {
      var hCreatable = (hMatch[0].match(/sap:creatable="([^"]+)"/) || [])[1] || 'not specified';
      var hUpdatable = (hMatch[0].match(/sap:updatable="([^"]+)"/) || [])[1] || 'not specified';
      reversalFieldsOnHeader[field] = 'EXISTS creatable=' + hCreatable + ' updatable=' + hUpdatable;
      Logger.log('[PART 2 header] ' + field + ': ' + hMatch[0]);
    } else {
      reversalFieldsOnHeader[field] = 'NOT FOUND';
    }

    // Item
    var iPropRe = new RegExp('<Property[^>]*Name="' + field + '"[^>]*/>', 'i');
    var iMatch = itemBlock.match(iPropRe);
    if (iMatch) {
      var iCreatable = (iMatch[0].match(/sap:creatable="([^"]+)"/) || [])[1] || 'not specified';
      var iUpdatable = (iMatch[0].match(/sap:updatable="([^"]+)"/) || [])[1] || 'not specified';
      reversalFieldsOnItem[field] = 'EXISTS creatable=' + iCreatable + ' updatable=' + iUpdatable;
      Logger.log('[PART 2 item] ' + field + ': ' + iMatch[0]);
    } else {
      reversalFieldsOnItem[field] = 'NOT FOUND';
    }
  }

  // ==== PART 3: EntitySets — flag cancel/reversal candidates ====
  var esMatches = xml.match(/<EntitySet\s+Name="[^"]+"/g) || [];
  var entitySets = [];
  var cancelSets = [];
  for (var e = 0; e < esMatches.length; e++) {
    var esName = (esMatches[e].match(/Name="([^"]+)"/) || [])[1] || '?';
    entitySets.push(esName);
    if (/cancel|revers/i.test(esName)) {
      cancelSets.push(esName);
    }
  }
  Logger.log('[PART 3] EntitySets (' + entitySets.length + '): ' +
    entitySets.join(', '));
  if (cancelSets.length) {
    Logger.log('[PART 3] Cancel/Reverse EntitySets: ' + cancelSets.join(', '));
  }

  // ==== Determine candidate mechanism ====
  var cancelFIs = functionImports.filter(function(fi) {
    return /cancel|revers/i.test(fi.name);
  });

  var candidateMechanism = 'unknown — needs probe';
  if (cancelFIs.length > 0) {
    candidateMechanism = 'FunctionImport:' + cancelFIs.map(function(fi) {
      return fi.name;
    }).join(',');
  } else if (reversalFieldsOnHeader['ReversedMaterialDocument'] &&
             reversalFieldsOnHeader['ReversedMaterialDocument'].indexOf('creatable=true') !== -1) {
    candidateMechanism = 'POST header with ReversedMaterialDocument (creatable=true)';
  } else if (reversalFieldsOnItem['ReversedMaterialDocument'] &&
             reversalFieldsOnItem['ReversedMaterialDocument'].indexOf('creatable=true') !== -1) {
    candidateMechanism = 'POST item with ReversedMaterialDocument (creatable=true on item)';
  }

  var summary = {
    functionImports:       functionImports,
    reversalFieldsOnHeader: reversalFieldsOnHeader,
    reversalFieldsOnItem:   reversalFieldsOnItem,
    entitySets:            entitySets,
    cancelEntitySets:      cancelSets,
    candidateMechanism:    candidateMechanism
  };

  Logger.log('[STRUCTURED SUMMARY]\n' + JSON.stringify(summary, null, 2));

  // ==== UI alert ====
  var alertLines = ['MatDoc Cancellation Mechanism Probe (READ-ONLY)\n'];
  alertLines.push('Candidate: ' + candidateMechanism + '\n');

  if (cancelFIs.length > 0) {
    alertLines.push('Cancel/Reverse FunctionImports:');
    cancelFIs.forEach(function(fi) {
      alertLines.push('  ' + fi.name + ' (' + fi.httpMethod + ') params=[' +
        fi.params.join(', ') + ']');
    });
  } else {
    alertLines.push('No Cancel/Reverse FunctionImports found.');
  }

  alertLines.push('\nReversal fields (header):');
  reversalFields.forEach(function(field) {
    alertLines.push('  ' + field + ': ' + reversalFieldsOnHeader[field]);
  });

  alertLines.push('\nReversal fields (item):');
  reversalFields.forEach(function(field) {
    alertLines.push('  ' + field + ': ' + reversalFieldsOnItem[field]);
  });

  if (cancelSets.length > 0) {
    alertLines.push('\nCancel/Reverse EntitySets: ' + cancelSets.join(', '));
  }

  alertLines.push('\nAll EntitySets: ' + entitySets.join(', '));
  alertLines.push('\nFull details in Executions log.');

  SpreadsheetApp.getUi().alert(alertLines.join('\n'));
}

// ============================================================================
// Reusable helper — reverse a material document via Cancel FunctionImport
// ============================================================================

/**
 * Reverse a material document by calling the Cancel FunctionImport on
 * API_MATERIAL_DOCUMENT_SRV. SAP creates the reversal document automatically
 * (correct direction, ReversedMaterialDocument stamped on items).
 *
 * Designed for promotion into Transfer311.gs at T4 cutover.
 *
 * @param {string} matDoc  - MaterialDocument number (e.g. '4900215842')
 * @param {string} matDocYear - MaterialDocumentYear (e.g. '2026')
 * @return {{ok:boolean, http:number, reversalDoc?:string, reversalYear?:string,
 *           raw?:string, body?:string}}
 */
function reverseMaterialDocByRef_(matDoc, matDocYear) {
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;

  var session = getCsrfSession_(serviceRoot);
  var creds   = getSapCredentials_();

  // OData v2 FunctionImport with Edm.String params requires single-quoted
  // string literals: MaterialDocument='4900215913', MaterialDocumentYear='2026'.
  // buildSapUrl_ encodes values, so passing "'val'" produces %27val%27.
  var cancelUrl = buildSapUrl_(serviceRoot + 'Cancel', {
    'MaterialDocument':     "'" + matDoc + "'",
    'MaterialDocumentYear': "'" + matDocYear + "'"
  });

  Logger.log('FETCH_URL [Cancel FunctionImport] ' + cancelUrl);
  var resp = UrlFetchApp.fetch(cancelUrl, {
    method: 'post',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'X-CSRF-Token':  session.token,
      'Cookie':        session.cookies,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    payload: '',
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();
  Logger.log('[Cancel] HTTP ' + code + ' :: ' + body.slice(0, 800));

  if (code !== 200 && code !== 201) {
    return { ok: false, http: code, body: body.slice(0, 800) };
  }

  var parsed = JSON.parse(body);
  var d = parsed.d || parsed;
  return {
    ok:           true,
    http:         code,
    reversalDoc:  d.MaterialDocument || '',
    reversalYear: d.MaterialDocumentYear || '',
    raw:          body.slice(0, 500)
  };
}

// ============================================================================
// T2/T3 redo — Cancel-by-reference proof (replaces broken hand-built 312)
// ============================================================================

/**
 * ⚠️ WRITES TO SAP. Posts a fresh 311 (1 PC PW30→PW40), then cancels it via
 * the Cancel FunctionImport (reverse-by-reference). Validates that SAP creates
 * the correct reversal and stock returns to baseline. Must be run manually.
 */
function TEST_transfer311CancelProof() {
  var fn = 'TEST_transfer311CancelProof';
  var M = {
    material: 'STT1001-R0000S3XRX',
    plant:    '1100',
    fromSLoc: 'PW30',
    toSLoc:   'PW40',
    batch:    '0000095121',
    qty:      '1',
    uom:      'PC'
  };
  var stockRoot   = CFG.SAP_BASE_URL + MATERIAL_STOCK_SRV_PROBE_;
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;

  var result = {
    baseline: {}, orig311: {}, cancel: {},
    reversalItems: [], stockAfter: {}, netZero: null
  };

  try {
    // ==== STEP 1: Baseline stock ====
    var pw30Before = probeStockQty_(stockRoot, M.material, M.plant, 'PW30', M.batch);
    var pw40Before = probeStockQty_(stockRoot, M.material, M.plant, 'PW40', M.batch);
    result.baseline = { pw30: pw30Before, pw40: pw40Before };
    Logger.log('[STEP 1] baseline PW30=' + pw30Before + ' PW40=' + pw40Before);

    // ==== STEP 2: Post fresh 311 (1 PC PW30→PW40) ====
    var txnId = 'ZZTEST-CXL-' + Utilities.getUuid().replace(/-/g, '').slice(0, 13);
    var token = txnId.replace(/-/g, '').slice(0, 24);
    Logger.log('[STEP 2] txnId=' + txnId + ' token=' + token);

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
    Logger.log('[STEP 2] payload:\n' + JSON.stringify(payload311, null, 2));

    var session = getCsrfSession_(serviceRoot);
    var creds   = getSapCredentials_();
    var postUrl = buildSapUrl_(serviceRoot + 'A_MaterialDocumentHeader');

    Logger.log('FETCH_URL [STEP 2 POST 311] ' + postUrl);
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
    Logger.log('[STEP 2] HTTP ' + code311 + ' :: ' + body311.slice(0, 800));

    if (code311 !== 201 && code311 !== 200) {
      result.orig311 = { http: code311, error: body311.slice(0, 600) };
      SpreadsheetApp.getUi().alert(
        '❌ 311 POST failed — HTTP ' + code311 + '\n\n' +
        body311.slice(0, 800) + '\n\nNothing to cancel.');
      return;
    }

    var parsed311 = JSON.parse(body311);
    var d311 = parsed311.d || parsed311;
    result.orig311 = {
      doc:  d311.MaterialDocument || '',
      year: d311.MaterialDocumentYear || '',
      http: code311
    };
    Logger.log('[STEP 2] origDoc=' + result.orig311.doc +
      '/' + result.orig311.year);
    logEvent(fn, 'POST_311', 'OK', 0,
      'doc=' + result.orig311.doc + '/' + result.orig311.year);

    // ==== STEP 3: Cancel via FunctionImport ====
    var cancelResult = reverseMaterialDocByRef_(
      result.orig311.doc, result.orig311.year);
    result.cancel = cancelResult;
    Logger.log('[STEP 3] cancel result: ' + JSON.stringify(cancelResult));

    if (!cancelResult.ok) {
      logEvent(fn, 'CANCEL', 'ERROR', 0, 'HTTP ' + cancelResult.http);
      SpreadsheetApp.getUi().alert(
        '🚨 CANCEL FAILED — HTTP ' + cancelResult.http + '\n\n' +
        '⚠️ DANGLING 311: ' + result.orig311.doc + '/' +
        result.orig311.year + '\n\n' +
        'Kor: cancel manually in Fiori/MIGO → reference doc ' +
        result.orig311.doc + ' year ' + result.orig311.year + '.\n\n' +
        (cancelResult.body || ''));
      Logger.log('[RESULT]\n' + JSON.stringify(result, null, 2));
      logEvent(fn, 'RESULT', 'CANCEL_FAILED', 0, JSON.stringify(result));
      return;
    }

    logEvent(fn, 'CANCEL', 'OK', 0,
      'reversalDoc=' + cancelResult.reversalDoc + '/' + cancelResult.reversalYear);

    // ==== STEP 4: Verify reversal doc items ====
    var revDocKey = "MaterialDocument='" + cancelResult.reversalDoc +
      "',MaterialDocumentYear='" + cancelResult.reversalYear + "'";
    var revUrl = buildSapUrl_(
      serviceRoot + 'A_MaterialDocumentHeader(' + revDocKey + ')', {
      '$expand': 'to_MaterialDocumentItem',
      '$format': 'json'
    });
    Logger.log('FETCH_URL [STEP 4 reversal doc] ' + revUrl);
    var revResp = probeRawGet_(revUrl);
    Logger.log('[STEP 4] HTTP ' + revResp.code + ' :: ' +
      revResp.text.slice(0, 800));

    if (revResp.code >= 200 && revResp.code < 300) {
      var revParsed = JSON.parse(revResp.text);
      var revD = revParsed.d || revParsed;
      var revItems = (revD.to_MaterialDocumentItem &&
                      revD.to_MaterialDocumentItem.results) || [];
      for (var i = 0; i < revItems.length; i++) {
        var it = revItems[i];
        Logger.log('[STEP 4 item ' + (i + 1) + '] ' +
          'GMT=' + it.GoodsMovementType +
          ' SLoc=' + it.StorageLocation +
          ' IssuingRecv=' + it.IssuingOrReceivingStorageLoc +
          ' D/C=' + it.DebitCreditCode +
          ' Qty=' + it.QuantityInEntryUnit +
          ' ReversedMatDoc=' + it.ReversedMaterialDocument);
        result.reversalItems.push({
          gmt:        it.GoodsMovementType,
          sloc:       it.StorageLocation,
          recvSloc:   it.IssuingOrReceivingStorageLoc,
          dc:         it.DebitCreditCode,
          qty:        it.QuantityInEntryUnit,
          reversedDoc: it.ReversedMaterialDocument
        });
      }
    }

    // ==== STEP 5: Settle + re-read stock ====
    Utilities.sleep(3000);

    var pw30After = probeStockQty_(stockRoot, M.material, M.plant, 'PW30', M.batch);
    var pw40After = probeStockQty_(stockRoot, M.material, M.plant, 'PW40', M.batch);
    result.stockAfter = { pw30: pw30After, pw40: pw40After };
    result.netZero = (pw30After === pw30Before && pw40After === pw40Before);
    Logger.log('[STEP 5] PW30=' + pw30After + ' PW40=' + pw40After +
      ' netZero=' + result.netZero);

    Logger.log('[RESULT]\n' + JSON.stringify(result, null, 2));
    logEvent(fn, 'RESULT', result.netZero ? 'PASS' : 'WARN', 0,
      JSON.stringify(result));

    // ==== Summary ====
    var revItemDesc = result.reversalItems.map(function(ri) {
      return ri.gmt + ' ' + ri.sloc + '→' + ri.recvSloc +
        ' ' + ri.qty + ' D/C=' + ri.dc +
        ' ref=' + ri.reversedDoc;
    }).join('\n  ');

    SpreadsheetApp.getUi().alert(
      'Cancel-by-Ref Proof\n\n' +
      'Baseline: PW30=' + pw30Before + ', PW40=' + pw40Before + '\n' +
      '311 POST: ' + result.orig311.doc + '/' + result.orig311.year +
        ' (HTTP ' + result.orig311.http + ')\n' +
      'Cancel:   ' + cancelResult.reversalDoc + '/' +
        cancelResult.reversalYear + ' (HTTP ' + cancelResult.http + ')\n' +
      'Reversal items:\n  ' + revItemDesc + '\n\n' +
      'After: PW30=' + pw30After + ', PW40=' + pw40After + '\n' +
      'Net zero: ' + result.netZero);

  } catch (e) {
    Logger.log('[' + fn + '] EXCEPTION: ' + e.message + '\n' + e.stack);
    logEvent(fn, 'EXCEPTION', e.message, 0, JSON.stringify(result));
    SpreadsheetApp.getUi().alert('❌ ' + fn + ' EXCEPTION:\n\n' + e.message +
      '\n\nCheck Executions log. If a 311 was posted, verify/cancel manually.');
  }
}

// ============================================================================
// One-shot corrective — cancel dangling doc 4900215913 (T2 proof leftover)
// ============================================================================

/**
 * ⚠️ WRITES TO SAP. Cancels the dangling 311 doc 4900215913/2026 left by the
 * T2 proof's failed 312 attempt. No new 311 — only Cancel the existing doc.
 * Pre-checks stock imbalance and cancellation status before writing.
 */
function TEST_cancelDanglingDoc() {
  var fn = 'TEST_cancelDanglingDoc';
  var DANGLING = { doc: '4900215913', year: '2026' };
  var M = { material: 'STT1001-R0000S3XRX', plant: '1100', batch: '0000095121' };
  var TARGET = { pw30: 3418, pw40: 8000 };
  var stockRoot   = CFG.SAP_BASE_URL + MATERIAL_STOCK_SRV_PROBE_;
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;

  var result = {
    stockBefore: {}, cancel: {}, reversalItems: [], stockAfter: {}, netZero: null
  };

  try {
    // ==== STEP 0: Guard — check if already balanced ====
    var pw30Before = probeStockQty_(stockRoot, M.material, M.plant, 'PW30', M.batch);
    var pw40Before = probeStockQty_(stockRoot, M.material, M.plant, 'PW40', M.batch);
    result.stockBefore = { pw30: pw30Before, pw40: pw40Before };
    Logger.log('[STEP 0] PW30=' + pw30Before + ' PW40=' + pw40Before);

    if (pw30Before === TARGET.pw30 && pw40Before === TARGET.pw40) {
      SpreadsheetApp.getUi().alert(
        '✅ Already balanced — doc may already be cancelled.\n\n' +
        'PW30=' + pw30Before + ' (target ' + TARGET.pw30 + ')\n' +
        'PW40=' + pw40Before + ' (target ' + TARGET.pw40 + ')');
      return;
    }

    // ==== STEP 1: Verify target still cancellable ====
    var docKey = "MaterialDocument='" + DANGLING.doc +
      "',MaterialDocumentYear='" + DANGLING.year + "'";
    var checkUrl = buildSapUrl_(
      serviceRoot + 'A_MaterialDocumentHeader(' + docKey + ')', {
      '$expand': 'to_MaterialDocumentItem',
      '$format': 'json'
    });
    Logger.log('FETCH_URL [STEP 1 check doc] ' + checkUrl);
    var checkResp = probeRawGet_(checkUrl);
    Logger.log('[STEP 1] HTTP ' + checkResp.code + ' :: ' +
      checkResp.text.slice(0, 800));

    if (checkResp.code >= 200 && checkResp.code < 300) {
      var checkParsed = JSON.parse(checkResp.text);
      var checkD = checkParsed.d || checkParsed;
      var checkItems = (checkD.to_MaterialDocumentItem &&
                        checkD.to_MaterialDocumentItem.results) || [];

      var alreadyCancelled = false;
      for (var c = 0; c < checkItems.length; c++) {
        var ci = checkItems[c];
        Logger.log('[STEP 1 item ' + (c + 1) + '] GMT=' + ci.GoodsMovementType +
          ' SLoc=' + ci.StorageLocation +
          ' IssuingRecv=' + ci.IssuingOrReceivingStorageLoc +
          ' IsCancelled=' + ci.GoodsMovementIsCancelled +
          ' ReversedDoc=' + ci.ReversedMaterialDocument);
        if (ci.GoodsMovementIsCancelled === 'X' ||
            ci.GoodsMovementIsCancelled === true) {
          alreadyCancelled = true;
        }
      }

      if (alreadyCancelled) {
        Logger.log('[STEP 1] Doc already cancelled — skipping to stock re-read');
        SpreadsheetApp.getUi().alert(
          '⚠ Doc ' + DANGLING.doc + ' already cancelled.\n\n' +
          'PW30=' + pw30Before + ' PW40=' + pw40Before +
          '\n(Expected ' + TARGET.pw30 + '/' + TARGET.pw40 + ')');
        return;
      }
    }

    // ==== STEP 2: Cancel via FunctionImport ====
    var cancelResult = reverseMaterialDocByRef_(DANGLING.doc, DANGLING.year);
    result.cancel = cancelResult;
    Logger.log('[STEP 2] cancel result: ' + JSON.stringify(cancelResult));

    if (!cancelResult.ok) {
      logEvent(fn, 'CANCEL', 'ERROR', 0, 'HTTP ' + cancelResult.http);
      SpreadsheetApp.getUi().alert(
        '🚨 CANCEL FAILED — HTTP ' + cancelResult.http + '\n\n' +
        '⚠️ Doc ' + DANGLING.doc + '/' + DANGLING.year +
        ' still dangling.\n\n' +
        'Kor: cancel manually in Fiori/MIGO.\n\n' +
        (cancelResult.body || ''));
      Logger.log('[RESULT]\n' + JSON.stringify(result, null, 2));
      logEvent(fn, 'RESULT', 'CANCEL_FAILED', 0, JSON.stringify(result));
      return;
    }

    logEvent(fn, 'CANCEL', 'OK', 0,
      'reversalDoc=' + cancelResult.reversalDoc + '/' + cancelResult.reversalYear);

    // ==== STEP 3: Verify reversal doc ====
    var revDocKey = "MaterialDocument='" + cancelResult.reversalDoc +
      "',MaterialDocumentYear='" + cancelResult.reversalYear + "'";
    var revUrl = buildSapUrl_(
      serviceRoot + 'A_MaterialDocumentHeader(' + revDocKey + ')', {
      '$expand': 'to_MaterialDocumentItem',
      '$format': 'json'
    });
    Logger.log('FETCH_URL [STEP 3 reversal doc] ' + revUrl);
    var revResp = probeRawGet_(revUrl);
    Logger.log('[STEP 3] HTTP ' + revResp.code + ' :: ' +
      revResp.text.slice(0, 800));

    if (revResp.code >= 200 && revResp.code < 300) {
      var revParsed = JSON.parse(revResp.text);
      var revD = revParsed.d || revParsed;
      var revItems = (revD.to_MaterialDocumentItem &&
                      revD.to_MaterialDocumentItem.results) || [];
      for (var i = 0; i < revItems.length; i++) {
        var it = revItems[i];
        Logger.log('[STEP 3 item ' + (i + 1) + '] ' +
          'GMT=' + it.GoodsMovementType +
          ' SLoc=' + it.StorageLocation +
          ' IssuingRecv=' + it.IssuingOrReceivingStorageLoc +
          ' D/C=' + it.DebitCreditCode +
          ' Qty=' + it.QuantityInEntryUnit +
          ' ReversedDoc=' + it.ReversedMaterialDocument);
        result.reversalItems.push({
          gmt:        it.GoodsMovementType,
          sloc:       it.StorageLocation,
          recvSloc:   it.IssuingOrReceivingStorageLoc,
          dc:         it.DebitCreditCode,
          qty:        it.QuantityInEntryUnit,
          reversedDoc: it.ReversedMaterialDocument
        });
      }
    }

    // ==== STEP 4: Settle + re-read stock ====
    Utilities.sleep(3000);

    var pw30After = probeStockQty_(stockRoot, M.material, M.plant, 'PW30', M.batch);
    var pw40After = probeStockQty_(stockRoot, M.material, M.plant, 'PW40', M.batch);
    result.stockAfter = { pw30: pw30After, pw40: pw40After };
    result.netZero = (pw30After === TARGET.pw30 && pw40After === TARGET.pw40);
    Logger.log('[STEP 4] PW30=' + pw30After + ' PW40=' + pw40After +
      ' netZero=' + result.netZero);

    Logger.log('[RESULT]\n' + JSON.stringify(result, null, 2));
    logEvent(fn, 'RESULT', result.netZero ? 'PASS' : 'WARN', 0,
      JSON.stringify(result));

    var revItemDesc = result.reversalItems.map(function(ri) {
      return ri.gmt + ' ' + ri.sloc + '→' + ri.recvSloc +
        ' ' + ri.qty + ' D/C=' + ri.dc + ' ref=' + ri.reversedDoc;
    }).join('\n  ');

    SpreadsheetApp.getUi().alert(
      'Cancel Dangling Doc ' + DANGLING.doc + '\n\n' +
      'Before: PW30=' + pw30Before + ', PW40=' + pw40Before + '\n' +
      'Cancel: ' + cancelResult.reversalDoc + '/' +
        cancelResult.reversalYear + ' (HTTP ' + cancelResult.http + ')\n' +
      'Reversal items:\n  ' + revItemDesc + '\n\n' +
      'After: PW30=' + pw30After + ', PW40=' + pw40After + '\n' +
      'Restored to baseline: ' + result.netZero);

  } catch (e) {
    Logger.log('[' + fn + '] EXCEPTION: ' + e.message + '\n' + e.stack);
    logEvent(fn, 'EXCEPTION', e.message, 0, JSON.stringify(result));
    SpreadsheetApp.getUi().alert('❌ ' + fn + ' EXCEPTION:\n\n' + e.message +
      '\n\nDoc ' + DANGLING.doc + '/' + DANGLING.year +
      ' may still be dangling. Check manually.');
  }
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

// ============================================================================
// DIAG — tier-3 batch resolution integration check (READ-ONLY)
// ============================================================================

function DIAG_tier3BatchResolve() {
  var cases = [
    { pid:'PL-1000036121-L01', grDoc:'4900214455', grYear:'2026', expect:'0000094815' },
    { pid:'PL-1000036325-L02', grDoc:'4900215829', grYear:'2026', expect:'0000095389' }
  ];
  var out = [];
  cases.forEach(function(c) {
    var b = resolveBatchFromGrDoc_(c.grDoc, c.grYear, 'STT1001-R0000S3XRX', { sloc: 'PW30' });
    var pass = (b === c.expect);
    out.push(c.pid + ': got="' + b + '" expect="' + c.expect + '" ' + (pass ? 'PASS' : 'FAIL'));
  });
  Logger.log(out.join('\n'));
  SpreadsheetApp.getUi().alert('Tier-3 Batch Resolve (RO)\n\n' + out.join('\n'));
}

// ============================================================================
// DIAG — verify PalletMaster.Batch for first-live (READ-ONLY)
// ============================================================================

function DIAG_checkBatchForFirstLive() {
  var sh = getSpreadsheet_().getSheetByName('PalletMaster');
  if (!sh || sh.getLastRow() < 2) { Logger.log('PalletMaster empty'); return; }
  var data = sh.getDataRange().getValues();
  var idx = {};
  data[0].forEach(function(h, i) { idx[String(h).trim()] = i; });

  function col(name) { return (name in idx) ? idx[name] : -1; }
  function val(row, name) { var c = col(name); return c < 0 ? '<NO_COL>' : String(row[c] || '').trim(); }

  Logger.log('PalletMaster columns: ' + Object.keys(idx).join(', '));

  // 1. Target pallet
  var found = false;
  for (var r = 1; r < data.length; r++) {
    if (val(data[r], 'PalletID') === 'PL-1000036121-L01') {
      found = true;
      Logger.log('TARGET PL-1000036121-L01: Batch="' + val(data[r], 'Batch') +
        '" Material="' + val(data[r], 'Material') +
        '" MO="' + val(data[r], 'ManufacturingOrder') +
        '" ScanStatus="' + val(data[r], 'ScanStatus') + '"');
    }
  }
  if (!found) Logger.log('TARGET PL-1000036121-L01 NOT FOUND in PalletMaster');

  // 2. All STT1001 CONFIRMED pallets WITH non-empty batch — cap 15
  Logger.log('STT1001-R0000S3XRX CONFIRMED pallets with non-empty Batch:');
  var n = 0;
  for (var r2 = 1; r2 < data.length && n < 15; r2++) {
    if (val(data[r2], 'Material') === 'STT1001-R0000S3XRX' &&
        val(data[r2], 'ScanStatus') === 'CONFIRMED' &&
        val(data[r2], 'Batch') && val(data[r2], 'Batch') !== '<NO_COL>') {
      Logger.log('  ' + val(data[r2], 'PalletID') + ' batch=' + val(data[r2], 'Batch') +
        ' MO=' + val(data[r2], 'ManufacturingOrder'));
      n++;
    }
  }
  if (n === 0) Logger.log('  NONE — all STT1001 pallets have empty Batch (backfill needed)');

  // 3. Any pallet with batch 0000095121 (T2-proven)?
  Logger.log('Pallets with batch=0000095121:');
  var m = 0;
  for (var r3 = 1; r3 < data.length; r3++) {
    if (val(data[r3], 'Batch') === '0000095121') {
      Logger.log('  ' + val(data[r3], 'PalletID') + ' mat=' + val(data[r3], 'Material') +
        ' status=' + val(data[r3], 'ScanStatus'));
      m++;
    }
  }
  if (m === 0) Logger.log('  NONE found with batch 0000095121');
}

// ============================================================================
// DIAG — prove batch is recoverable from GRMaterialDocument (READ-ONLY)
// ============================================================================

/**
 * For PL-1000036121-L01 (and a few other CONFIRMED STT1001 pallets):
 *   1. Read GRMaterialDocument + GRMaterialDocumentYear from PalletMaster
 *   2. GET that material doc from SAP with $expand=to_MaterialDocumentItem
 *   3. Log the item-level Batch field — proving the batch IS recoverable
 * READ-ONLY. No writes. No POST.
 */
function DIAG_grDocBatchProof() {
  var sh = getSpreadsheet_().getSheetByName('PalletMaster');
  if (!sh || sh.getLastRow() < 2) { Logger.log('PalletMaster empty'); return; }
  var data = sh.getDataRange().getValues();
  var idx = {};
  data[0].forEach(function(h, i) { idx[String(h).trim()] = i; });

  function col(name) { return (name in idx) ? idx[name] : -1; }
  function val(row, name) { var c = col(name); return c < 0 ? '<NO_COL>' : String(row[c] || '').trim(); }

  // Collect up to 5 CONFIRMED STT1001 pallets with a GRMaterialDocument
  var targets = [];
  // Always include PL-1000036121-L01 even if GRMaterialDocument is empty
  var foundTarget = false;
  for (var r = 1; r < data.length; r++) {
    var pid = val(data[r], 'PalletID');
    if (pid === 'PL-1000036121-L01') {
      foundTarget = true;
      targets.push({
        palletId: pid,
        grDoc:    val(data[r], 'GRMaterialDocument'),
        grYear:   val(data[r], 'GRMaterialDocumentYear'),
        batch:    val(data[r], 'Batch'),
        material: val(data[r], 'Material'),
        mo:       val(data[r], 'ManufacturingOrder'),
        status:   val(data[r], 'ScanStatus')
      });
    }
  }
  // Add a few more with GRMaterialDocument populated
  for (var r2 = 1; r2 < data.length && targets.length < 5; r2++) {
    var pid2 = val(data[r2], 'PalletID');
    if (pid2 === 'PL-1000036121-L01') continue;
    if (val(data[r2], 'Material') === 'STT1001-R0000S3XRX' &&
        val(data[r2], 'ScanStatus') === 'CONFIRMED' &&
        val(data[r2], 'GRMaterialDocument') &&
        val(data[r2], 'GRMaterialDocument') !== '<NO_COL>') {
      targets.push({
        palletId: pid2,
        grDoc:    val(data[r2], 'GRMaterialDocument'),
        grYear:   val(data[r2], 'GRMaterialDocumentYear'),
        batch:    val(data[r2], 'Batch'),
        material: val(data[r2], 'Material'),
        mo:       val(data[r2], 'ManufacturingOrder'),
        status:   val(data[r2], 'ScanStatus')
      });
    }
  }

  if (!foundTarget) Logger.log('PL-1000036121-L01 NOT FOUND in PalletMaster');
  Logger.log('Targets (' + targets.length + '):\n' + JSON.stringify(targets, null, 2));

  // For each target with a GRMaterialDocument, read the doc from SAP
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;
  var alertLines = ['GR Doc Batch Proof (READ-ONLY)\n'];

  targets.forEach(function(t) {
    Logger.log('---- ' + t.palletId + ' ----');
    Logger.log('  PalletMaster.Batch="' + t.batch + '" GRDoc="' + t.grDoc +
      '" GRYear="' + t.grYear + '"');

    alertLines.push(t.palletId + ':');
    alertLines.push('  PM.Batch="' + t.batch + '" GRDoc=' + t.grDoc + '/' + t.grYear);

    if (!t.grDoc || t.grDoc === '<NO_COL>') {
      Logger.log('  GRMaterialDocument empty — cannot resolve batch from GR doc');
      alertLines.push('  → GRDoc EMPTY (no SAP call)');
      return;
    }

    var docKey = "MaterialDocument='" + t.grDoc +
      "',MaterialDocumentYear='" + t.grYear + "'";
    var url = buildSapUrl_(
      serviceRoot + 'A_MaterialDocumentHeader(' + docKey + ')', {
      '$expand': 'to_MaterialDocumentItem',
      '$select': 'MaterialDocument,MaterialDocumentYear,' +
        'to_MaterialDocumentItem/Batch,' +
        'to_MaterialDocumentItem/Material,' +
        'to_MaterialDocumentItem/Plant,' +
        'to_MaterialDocumentItem/StorageLocation,' +
        'to_MaterialDocumentItem/GoodsMovementType,' +
        'to_MaterialDocumentItem/QuantityInEntryUnit',
      '$format': 'json'
    });

    Logger.log('FETCH_URL [GR doc ' + t.grDoc + '] ' + url);
    var r = probeRawGet_(url);
    Logger.log('[GR doc ' + t.grDoc + '] HTTP ' + r.code + ' :: ' +
      r.text.slice(0, 600));

    if (r.code >= 400) {
      alertLines.push('  → SAP HTTP ' + r.code + ' (fetch failed)');
      return;
    }

    var parsed = JSON.parse(r.text);
    var d = parsed.d || parsed;
    var items = (d.to_MaterialDocumentItem &&
                 d.to_MaterialDocumentItem.results) || [];

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      Logger.log('  item' + (i + 1) + ': GMT=' + it.GoodsMovementType +
        ' Mat=' + it.Material + ' Batch=' + it.Batch +
        ' SLoc=' + it.StorageLocation + ' Qty=' + it.QuantityInEntryUnit);
      alertLines.push('  item' + (i + 1) + ': GMT=' + it.GoodsMovementType +
        ' Batch=' + (it.Batch || 'EMPTY') +
        ' SLoc=' + it.StorageLocation + ' Qty=' + it.QuantityInEntryUnit);
    }

    if (items.length === 0) {
      alertLines.push('  → no items');
    }
  });

  Logger.log('\n' + alertLines.join('\n'));
  SpreadsheetApp.getUi().alert(alertLines.join('\n'));
}

// ============================================================================
// Backfill PalletMaster.Batch from GR material document (SHEET WRITE ONLY)
// ============================================================================

/**
 * For every CONFIRMED pallet with empty Batch but non-empty GRMaterialDocument,
 * resolves the batch via resolveBatchFromGrDoc_ (SAP GET only) and writes it
 * back to PalletMaster.Batch. No SAP POST — sheet write only.
 *
 * @param {{dryRun:boolean}} opts  dryRun defaults TRUE
 * @return {{planned:number, written:number, skipped:number, ambiguous:number}}
 */
function BACKFILL_palletMasterBatch(opts) {
  var dryRun = !opts || opts.dryRun !== false;
  var fn = 'BACKFILL_palletMasterBatch';

  var sh = getSpreadsheet_().getSheetByName('PalletMaster');
  if (!sh || sh.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('PalletMaster sheet empty or missing.');
    return;
  }
  var data = sh.getDataRange().getValues();
  var idx = {};
  data[0].forEach(function(h, i) { idx[String(h).trim()] = i; });

  var required = ['PalletID', 'Material', 'Batch', 'ScanStatus',
                  'GRMaterialDocument', 'GRMaterialDocumentYear'];
  var missing = required.filter(function(c) { return !(c in idx); });
  if (missing.length) {
    SpreadsheetApp.getUi().alert('Missing required columns: ' + missing.join(', '));
    return;
  }

  var hasSloc = 'StorageLocation' in idx;

  var planned = [], skipped = [], ambiguous = [], errors = [];
  var candidates = 0;

  for (var r = 1; r < data.length; r++) {
    var row    = data[r];
    var pid    = String(row[idx['PalletID']] || '').trim();
    var batch  = String(row[idx['Batch']] || '').trim();
    var status = String(row[idx['ScanStatus']] || '').trim();
    var grDoc  = String(row[idx['GRMaterialDocument']] || '').trim();
    var grYear = String(row[idx['GRMaterialDocumentYear']] || '').trim();
    var mat    = String(row[idx['Material']] || '').trim();
    var sloc   = hasSloc ? String(row[idx['StorageLocation']] || '').trim() : '';

    if (status !== 'CONFIRMED') continue;
    var batchCorrupt = batch && /^\d+$/.test(batch) && batch.length < 10;
    if (batch && !batchCorrupt) { skipped.push(pid + ' (already has ' + batch + ')'); continue; }
    if (!grDoc || !grYear) { skipped.push(pid + ' (no GR doc)'); continue; }

    candidates++;
    if (candidates > 200) {
      Logger.log('[' + fn + '] >200 candidates — stopping scan. Run in batches.');
      break;
    }

    if (candidates % 25 === 0) {
      Logger.log('[' + fn + '] progress: scanned ' + candidates + ' candidates so far...');
    }

    try {
      var resolved = resolveBatchFromGrDoc_(grDoc, grYear, mat, { sloc: sloc });
    } catch (e) {
      errors.push(pid + ' grDoc=' + grDoc + ' error=' + e.message);
      continue;
    }

    if (!resolved) {
      ambiguous.push(pid + ' grDoc=' + grDoc + ' (unresolved/ambiguous)');
      continue;
    }

    planned.push({ rowNum: r + 1, pid: pid, batch: resolved });
  }

  var written = 0;
  if (!dryRun) {
    planned.forEach(function(p) {
      var cell = sh.getRange(p.rowNum, idx['Batch'] + 1);
      cell.setNumberFormat('@');
      cell.setValue(String(p.batch));
      written++;
    });
    logEvent(fn, 'APPLY', 'OK', 0, 'wrote ' + written + ' batches');
  }

  var summary = (dryRun ? '[DRY RUN] ' : '[APPLIED] ') +
    'planned=' + planned.length + ' written=' + written +
    ' skipped=' + skipped.length + ' ambiguous=' + ambiguous.length +
    ' errors=' + errors.length;
  Logger.log(summary);
  Logger.log('PLANNED:\n' + planned.map(function(p) {
    return '  ' + p.pid + ' → ' + p.batch;
  }).join('\n'));
  if (ambiguous.length) {
    Logger.log('AMBIGUOUS (need manual review):\n  ' + ambiguous.join('\n  '));
  }
  if (errors.length) {
    Logger.log('ERRORS:\n  ' + errors.join('\n  '));
  }
  if (candidates > 200) {
    Logger.log('⚠ >200 candidates — scan stopped early. Re-run after applying to continue.');
  }

  SpreadsheetApp.getUi().alert(
    'Backfill PalletMaster.Batch\n\n' + summary +
    '\n\nPlanned: ' + planned.length + ' | Ambiguous: ' + ambiguous.length +
    (errors.length ? ' | Errors: ' + errors.length : '') +
    '\n\nDetails in Executions log.' +
    (dryRun ? '\n\n⚠️ DRY RUN — no writes. Re-run with APPLY to commit.' : '') +
    (candidates > 200 ? '\n\n⚠ >200 candidates — stopped early. Run again after applying.' : ''));

  return { planned: planned.length, written: written,
    skipped: skipped.length, ambiguous: ambiguous.length };
}

function BACKFILL_palletMasterBatch_dryRun()  { BACKFILL_palletMasterBatch({ dryRun: true }); }
function BACKFILL_palletMasterBatch_apply()   { BACKFILL_palletMasterBatch({ dryRun: false }); }

// ============================================================================
// DIAG — verify Batch leading zeros in PalletMaster (READ-ONLY)
// ============================================================================

function DIAG_verifyBatchLeadingZeros() {
  var sh = getSpreadsheet_().getSheetByName('PalletMaster');
  if (!sh || sh.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('PalletMaster empty.');
    return;
  }
  var data = sh.getDataRange().getValues();
  var idx = {};
  data[0].forEach(function(h, i) { idx[String(h).trim()] = i; });

  var ok = [], corrupt = [];
  for (var r = 1; r < data.length; r++) {
    var pid   = String(data[r][idx['PalletID']] || '').trim();
    var batch = String(data[r][idx['Batch']] || '').trim();
    if (!batch) continue;

    var isCorrupt = /^\d+$/.test(batch) && batch.length < 10;
    var entry = pid + ' batch="' + batch + '" len=' + batch.length;
    if (isCorrupt) {
      corrupt.push(entry);
      Logger.log('CORRUPT: ' + entry);
    } else {
      ok.push(entry);
      Logger.log('OK: ' + entry);
    }
  }

  var summary = 'Batch Leading Zeros Check (READ-ONLY)\n\n' +
    'OK: ' + ok.length + ' | Corrupt (numeric <10 chars): ' + corrupt.length;
  if (corrupt.length) {
    summary += '\n\nCorrupt rows:\n' + corrupt.join('\n');
  }
  summary += '\n\nDetails in Executions log.';

  Logger.log(summary);
  SpreadsheetApp.getUi().alert(summary);
}

// ============================================================================
// PROBE — pallet → batch → PW30 stock (READ-ONLY, for first-live selection)
// ============================================================================

/**
 * For every CONFIRMED STT1001-R0000S3XRX pallet in PalletMaster, reads its Batch
 * and queries A_MatlStkInAcctMod for the actual unrestricted PW30 stock.
 * Deduplicates by batch (one SAP call per distinct batch).
 * Also explicitly checks batch 0000095121 (T2-proven 3418 PC) regardless of
 * whether any pallet carries it yet.
 *
 * Output: sorted table PalletID | Batch | PW30_qty. Best candidate highlighted.
 * READ-ONLY — GET only, no writes.
 */
function PROBE_palletBatchStock() {
  var MATERIAL     = 'STT1001-R0000S3XRX';
  var PLANT        = '1100';
  var SLOC         = 'PW30';
  var TARGET_BATCH = '0000095121'; // T2-proven: 3418 PC in PW30

  var sh = getSpreadsheet_().getSheetByName('PalletMaster');
  if (!sh || sh.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('PalletMaster sheet empty or missing.');
    return;
  }
  var data = sh.getDataRange().getValues();
  var pmIdx = {};
  data[0].forEach(function(h, i) { pmIdx[String(h).trim()] = i; });

  function pmVal(row, name) {
    var c = pmIdx[name];
    return (c !== undefined) ? String(row[c] || '').trim() : '';
  }

  // Collect all CONFIRMED STT1001 pallets
  var pallets = [];
  for (var r = 1; r < data.length; r++) {
    if (pmVal(data[r], 'Material') !== MATERIAL) continue;
    if (pmVal(data[r], 'ScanStatus') !== 'CONFIRMED') continue;
    pallets.push({
      palletId: pmVal(data[r], 'PalletID'),
      batch:    pmVal(data[r], 'Batch'),
      grDoc:    pmVal(data[r], 'GRMaterialDocument')
    });
  }

  Logger.log('[PROBE_palletBatchStock] CONFIRMED ' + MATERIAL +
    ' pallets in PalletMaster: ' + pallets.length);

  if (pallets.length === 0) {
    SpreadsheetApp.getUi().alert(
      'PROBE Pallet Batch Stock\n\nNo CONFIRMED ' + MATERIAL +
      ' pallets found in PalletMaster.');
    return;
  }

  // Collect distinct non-empty batches
  var stockRoot = CFG.SAP_BASE_URL + MATERIAL_STOCK_SRV_PROBE_;
  var batchQty = {};
  var distinctBatches = [];
  pallets.forEach(function(p) {
    if (p.batch && distinctBatches.indexOf(p.batch) < 0) {
      distinctBatches.push(p.batch);
    }
  });

  Logger.log('[PROBE_palletBatchStock] Distinct batches: ' +
    distinctBatches.length + ' → ' + distinctBatches.join(', '));

  // SAP stock read — one call per distinct batch
  distinctBatches.forEach(function(b) {
    var qty = probeStockQty_(stockRoot, MATERIAL, PLANT, SLOC, b);
    batchQty[b] = qty;
    Logger.log('[stock] batch=' + b + ' PW30=' + qty);
  });

  // Always check T2 target batch, even if no pallet carries it yet
  if (!(TARGET_BATCH in batchQty)) {
    var tq = probeStockQty_(stockRoot, MATERIAL, PLANT, SLOC, TARGET_BATCH);
    batchQty[TARGET_BATCH] = tq;
    Logger.log('[stock] TARGET batch=' + TARGET_BATCH +
      ' PW30=' + tq + ' (not yet in any pallet)');
  }

  // Build result rows
  var rows = pallets.map(function(p) {
    var qty = p.batch ? (batchQty[p.batch] || 0) : null;
    return {
      palletId: p.palletId,
      batch:    p.batch || '(empty)',
      pw30:     (qty !== null) ? qty : '—',
      usable:   (qty !== null) && qty >= 1,
      sortKey:  (qty !== null) ? qty : -1,
      note:     !p.batch
        ? 'Batch empty — run BACKFILL first'
        : qty >= 1 ? '✅ usable' : '❌ no stock'
    };
  });

  rows.sort(function(a, b) { return b.sortKey - a.sortKey; });

  // Log full table
  var SEP = new Array(68).join('-');
  Logger.log('[PROBE_palletBatchStock] Full table:\n' + SEP);
  Logger.log(padRight_('PalletID', 26) + ' | ' +
             padRight_('Batch', 12) + ' | ' +
             padRight_('PW30', 8) + ' | Note');
  Logger.log(SEP);
  rows.forEach(function(r) {
    Logger.log(padRight_(r.palletId, 26) + ' | ' +
               padRight_(r.batch, 12) + ' | ' +
               padRight_(String(r.pw30), 8) + ' | ' + r.note);
  });
  Logger.log(SEP);

  // Build UI alert
  var usable = rows.filter(function(r) { return r.usable; });
  var best   = usable.length > 0 ? usable[0] : null;

  var targetQty    = batchQty[TARGET_BATCH];
  var targetPallets = pallets.filter(function(p) { return p.batch === TARGET_BATCH; });

  var alertLines = [
    'Pallet → Batch → PW30 Stock (READ-ONLY)',
    'Material: ' + MATERIAL + '  |  SLoc: PW30  |  Plant: ' + PLANT,
    ''
  ];

  // Table header
  alertLines.push(padRight_('PalletID', 24) + ' | ' +
                  padRight_('Batch', 12) + ' | PW30');
  alertLines.push(new Array(48).join('-'));
  rows.slice(0, 12).forEach(function(r) {
    alertLines.push(padRight_(r.palletId, 24) + ' | ' +
                    padRight_(r.batch, 12) + ' | ' + r.pw30);
  });
  if (rows.length > 12) {
    alertLines.push('... (' + (rows.length - 12) + ' more in Executions log)');
  }

  // T2-proven target batch
  alertLines.push('');
  alertLines.push('── Target batch ' + TARGET_BATCH + ' (T2-proven) ──');
  alertLines.push('PW30 stock: ' + targetQty + ' PC');
  if (targetPallets.length > 0) {
    alertLines.push('PalletMaster match: ' +
      targetPallets.map(function(p) { return p.palletId; }).join(', '));
  } else {
    alertLines.push('No pallet carries this batch yet → run BACKFILL_palletMasterBatch_apply first');
  }

  // Best candidate
  alertLines.push('');
  if (best) {
    alertLines.push('✅ Best candidate: ' + best.palletId +
      '  batch=' + best.batch + '  PW30=' + best.pw30 + ' PC');
  } else {
    alertLines.push('❌ No usable candidate (all batches have 0 PW30 stock)');
    alertLines.push('→ Run BACKFILL_palletMasterBatch_apply to populate Batch, then re-probe.');
  }

  alertLines.push('');
  alertLines.push('Full table (' + rows.length + ' pallets) in Executions log.');

  Logger.log('[PROBE_palletBatchStock] DONE');
  SpreadsheetApp.getUi().alert(alertLines.join('\n'));
}

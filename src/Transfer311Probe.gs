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

/**
 * Transfer311Probe.gs — Phase 4: READ-ONLY filter probe for sapReadbackTransfer311_
 * ===================================================================================
 * Isolates the HTTP 400 source in the readback $filter by testing four filter
 * variants (token-only, +Plant, +PostDate, item-level Plant) and a $metadata
 * probe against API_MATERIAL_DOCUMENT_SRV.
 *
 * READ-ONLY. No POST, no CSRF, no flag flips, no sheet writes.
 * Self-cleaning: DELETE this file + menu entry at FEATURE_TRANSFER311 LIVE cutover.
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

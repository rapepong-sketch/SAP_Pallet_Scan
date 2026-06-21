/**
 * Transfer311Diagnostic.gs — Phase 4 Step 1: READ-ONLY SAP diagnostic
 * ====================================================================
 * Probes API_MATERIAL_DOCUMENT_SRV and Material Stock service on the
 * live tenant to confirm exact field names before building a 311
 * transfer-posting payload.  NO writes to SAP — GET only.
 *
 * Reuses: getSapCredentials_() (Config.gs), buildSapUrl_() (SapClient.gs),
 *         logEvent() (SapClient.gs), getSheet_() (SheetSetup.gs).
 */

// ============================================================================
// Internal helper — raw GET returning text (for $metadata XML)
// ============================================================================

/**
 * GET a SAP OData URL and return { code, text }.
 * Uses the same auth path as the rest of the project.
 * Accept header is configurable (default JSON, pass 'application/xml' for $metadata).
 * @private
 */
function diagRawGet_(path, accept) {
  const creds = getSapCredentials_();
  const url = buildSapUrl_(path);
  const t0 = Date.now();
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'Accept': accept || 'application/json'
    },
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  logEvent('TRANSFER311_DIAG', path.split('?')[0], code, Date.now() - t0,
    'len=' + text.length);
  return { code: code, text: text };
}

// ============================================================================
// 1. Probe Material Document $metadata
// ============================================================================

/**
 * GET API_MATERIAL_DOCUMENT_SRV/$metadata and extract property names for
 * A_MaterialDocumentHeaderType and A_MaterialDocumentItemType.
 * @return {{ httpCode: number, header: string[], item: string[] }}
 */
function diagProbeMaterialDocMetadata_() {
  logEvent('TRANSFER311_DIAG', 'diagProbeMaterialDocMetadata_', 'START', 0, '');
  try {
    var r = diagRawGet_(
      CFG.SERVICES.MATERIAL_DOCUMENT + '$metadata', 'application/xml');

    if (r.code !== 200) {
      logEvent('TRANSFER311_DIAG', 'diagProbeMaterialDocMetadata_', 'ERROR', 0,
        'HTTP ' + r.code + ': ' + r.text.slice(0, 300));
      return { httpCode: r.code, header: [], item: [], raw: r.text.slice(0, 500) };
    }

    var xml = r.text;

    var extractProps = function (entityTypeName) {
      var re = new RegExp(
        'EntityType Name="' + entityTypeName + '"[\\s\\S]*?<\\/EntityType>');
      var block = xml.match(re);
      if (!block) return [];
      var props = block[0].match(/Property Name="[^"]+"/g) || [];
      return props.map(function (p) { return p.replace(/Property Name="|"/g, ''); });
    };

    var headerProps = extractProps('A_MaterialDocumentHeaderType');
    var itemProps   = extractProps('A_MaterialDocumentItemType');

    logEvent('TRANSFER311_DIAG', 'diagProbeMaterialDocMetadata_', 'OK', 0,
      'header=' + headerProps.length + ' item=' + itemProps.length);
    return { httpCode: r.code, header: headerProps, item: itemProps };

  } catch (e) {
    logEvent('TRANSFER311_DIAG', 'diagProbeMaterialDocMetadata_', 'ERROR', 0, e.message);
    throw e;
  }
}

// ============================================================================
// 2. List recent Material Document Items (self-discovering, no hardcoded keys)
// ============================================================================

/**
 * LIST A_MaterialDocumentItem filtered by GoodsMovementType '311', top 5.
 * Falls back to unfiltered top 5 if no 311 records exist.
 * Also fetches the parent header for the first returned item to capture
 * GoodsMovementCode.  READ-ONLY — GET only.
 * @return {{ filterUsed: string, httpCode: number, items: Object[],
 *            headerSample: Object|null, headerHttpCode: number }}
 */
function diagListRecentMatDocItems_() {
  logEvent('TRANSFER311_DIAG', 'diagListRecentMatDocItems_', 'START', 0, '');
  var result = {
    filterUsed: '', httpCode: 0, items: [],
    headerSample: null, headerHttpCode: 0
  };

  try {
    var path = CFG.SERVICES.MATERIAL_DOCUMENT + 'A_MaterialDocumentItem';

    // --- Attempt 1: GoodsMovementType '311' with orderby ---
    var got311 = false;
    try {
      var data = sapGet(path, {
        '$filter': "GoodsMovementType eq '311'",
        '$top': '5',
        '$orderby': 'PostingDate desc'
      }, 'TRANSFER311_DIAG.listItems311');
      var rows = (data.d && data.d.results) || [];
      result.httpCode = 200;
      result.filterUsed = "GoodsMovementType eq '311' orderby PostingDate desc";
      result.items = rows;
      got311 = true;
    } catch (e311) {
      // $orderby may not be supported — retry without it
      try {
        var data2 = sapGet(path, {
          '$filter': "GoodsMovementType eq '311'",
          '$top': '5'
        }, 'TRANSFER311_DIAG.listItems311noSort');
        var rows2 = (data2.d && data2.d.results) || [];
        result.httpCode = 200;
        result.filterUsed = "GoodsMovementType eq '311' (no orderby)";
        result.items = rows2;
        got311 = true;
      } catch (e311b) {
        result.error311 = e311b.message;
      }
    }

    // --- Attempt 2: fallback — any recent items (no movement-type filter) ---
    if (result.items.length === 0) {
      try {
        var dataAny = sapGet(path, { '$top': '5' },
          'TRANSFER311_DIAG.listItemsAny');
        var rowsAny = (dataAny.d && dataAny.d.results) || [];
        result.httpCode = 200;
        result.filterUsed = '(no filter — fallback)';
        result.items = rowsAny;
      } catch (eAny) {
        if (result.httpCode === 0) result.httpCode = -1;
        result.errorFallback = eAny.message;
      }
    }

    // --- Clean items: strip __metadata, keep only non-empty values ---
    result.items = result.items.map(function (row) {
      var clean = {};
      Object.keys(row).forEach(function (k) {
        if (k === '__metadata') return;
        var v = row[k];
        if (v !== null && v !== undefined && v !== '') clean[k] = v;
      });
      return clean;
    });

    // --- GET parent header for first item → capture GoodsMovementCode ---
    if (result.items.length > 0) {
      var first = result.items[0];
      var matDoc = first.MaterialDocument;
      var matDocYear = first.MaterialDocumentYear;
      if (matDoc && matDocYear) {
        try {
          var headerPath = CFG.SERVICES.MATERIAL_DOCUMENT +
            "A_MaterialDocumentHeader(MaterialDocument='" + matDoc +
            "',MaterialDocumentYear='" + matDocYear + "')";
          var hdrData = sapGet(headerPath, {}, 'TRANSFER311_DIAG.headerSample');
          var hdr = hdrData.d || hdrData;
          var cleanHdr = {};
          Object.keys(hdr).forEach(function (k) {
            if (k === '__metadata' || k === 'to_MaterialDocumentItem') return;
            var v = hdr[k];
            if (v !== null && v !== undefined && v !== '') cleanHdr[k] = v;
          });
          result.headerSample = cleanHdr;
          result.headerHttpCode = 200;
        } catch (eHdr) {
          result.headerHttpCode = -1;
          result.headerError = eHdr.message;
        }
      }
    }

    logEvent('TRANSFER311_DIAG', 'diagListRecentMatDocItems_', 'OK', 0,
      'filter=' + result.filterUsed + ' items=' + result.items.length);

  } catch (e) {
    logEvent('TRANSFER311_DIAG', 'diagListRecentMatDocItems_', 'ERROR', 0, e.message);
    result.error = e.message;
  }

  return result;
}

// ============================================================================
// 3. Probe Material Stock service
// ============================================================================

/** Material Stock service path (SAP_COM_0164) */
var MATERIAL_STOCK_SRV_ = '/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/';

/**
 * LIST stock rows for Plant 1100 (no specific Material filter).
 * First $metadata to discover entity sets and quantity field names,
 * then GET top 10 rows.  Returns rows where qty > 0 (with fallback to
 * all rows if none have positive stock).  READ-ONLY — GET only.
 * @return {{ metaHttpCode: number, entitySets: string[], entityTypes: string[],
 *            dataHttpCode: number, stockRows: Object[], qtyFieldNames: string[] }}
 */
function diagListMaterialStock_() {
  logEvent('TRANSFER311_DIAG', 'diagListMaterialStock_', 'START', 0,
    'Plant=' + CFG.PLANT);
  var result = {
    metaHttpCode: 0, entitySets: [], entityTypes: [],
    dataHttpCode: 0, stockRows: [], qtyFieldNames: []
  };

  try {
    // --- $metadata ---
    var meta = diagRawGet_(MATERIAL_STOCK_SRV_ + '$metadata', 'application/xml');
    result.metaHttpCode = meta.code;

    if (meta.code === 200) {
      var setMatches = meta.text.match(/EntitySet Name="[^"]+"/g) || [];
      result.entitySets = setMatches.map(function (s) {
        return s.replace(/EntitySet Name="|"/g, '');
      });
      var typeMatches = meta.text.match(/EntityType Name="[^"]+"/g) || [];
      result.entityTypes = typeMatches.map(function (s) {
        return s.replace(/EntityType Name="|"/g, '');
      });

      var stockTypeRe = /EntityType Name="(A_M[^"]*Stock[^"]*)"[\s\S]*?<\/EntityType>/;
      var stockBlock = meta.text.match(stockTypeRe);
      if (stockBlock) {
        var qtyProps = stockBlock[0].match(/Property Name="[^"]*[Qq](?:ty|uantity)[^"]*"/g) || [];
        result.qtyFieldNames = qtyProps.map(function (p) {
          return p.replace(/Property Name="|"/g, '');
        });
      }
    }

    // --- Data query: Plant only, no Material filter ---
    if (result.entitySets.length > 0) {
      var entitySet = result.entitySets[0];
      var dataPath = MATERIAL_STOCK_SRV_ + entitySet;
      var dataParams = {
        '$top': '10',
        '$filter': "Plant eq '" + CFG.PLANT + "'"
      };

      try {
        var data = sapGet(dataPath, dataParams, 'TRANSFER311_DIAG.stockList');
        var allRows = (data.d && data.d.results) || [];
        result.dataHttpCode = 200;

        var cleaned = allRows.map(function (row) {
          var clean = {};
          Object.keys(row).forEach(function (k) {
            if (k !== '__metadata') clean[k] = row[k];
          });
          return clean;
        });

        var qtyFields = result.qtyFieldNames;
        var positiveRows = cleaned.filter(function (row) {
          return qtyFields.some(function (qf) {
            var v = parseFloat(row[qf]);
            return !isNaN(v) && v > 0;
          });
        });

        result.stockRows = positiveRows.length > 0 ? positiveRows : cleaned;
        result.positiveOnly = positiveRows.length > 0;

      } catch (dataErr) {
        var codeMatch = dataErr.message.match(/HTTP (\d+)/);
        result.dataHttpCode = codeMatch ? parseInt(codeMatch[1], 10) : -1;
        result.dataError = dataErr.message;
      }
    }

    logEvent('TRANSFER311_DIAG', 'diagListMaterialStock_', 'OK', 0,
      'entitySets=' + result.entitySets.length + ' rows=' + result.stockRows.length);

  } catch (e) {
    logEvent('TRANSFER311_DIAG', 'diagListMaterialStock_', 'ERROR', 0, e.message);
    result.error = e.message;
  }

  return result;
}

// ============================================================================
// 4. Test runner — writes results to _Diag311 scratch sheet
// ============================================================================

/**
 * Run all three diagnostic probes and write a readable summary to the
 * _Diag311 sheet (cleared + recreated each run).
 * No arguments needed — all probes self-discover real data via LIST queries.
 */
function TEST_runTransfer311Diagnostics() {
  Logger.log('=== Transfer 311 Diagnostic — START ===');

  // ---- Prepare scratch sheet ----
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var diagSheet = ss.getSheetByName('_Diag311');
  if (diagSheet) ss.deleteSheet(diagSheet);
  diagSheet = ss.insertSheet('_Diag311');
  var row = 1;

  function writeSection(title, rows) {
    diagSheet.getRange(row, 1).setValue(title).setFontWeight('bold');
    row++;
    rows.forEach(function (r) {
      diagSheet.getRange(row, 1, 1, r.length).setValues([r]);
      row++;
    });
    row++;
  }

  // ==================================================================
  // Probe 1: Material Document $metadata (unchanged)
  // ==================================================================
  Logger.log('--- Probe 1: Material Document $metadata ---');
  var metaResult = diagProbeMaterialDocMetadata_();
  var metaRows = [['HTTP Status', metaResult.httpCode]];

  var targetFields = [
    'GoodsMovementType', 'GoodsMovementCode',
    'IssuingOrReceivingStorageLocation', 'StorageLocation',
    'Material', 'Plant', 'Batch',
    'QuantityInEntryUnit', 'EntryUnit'
  ];

  metaRows.push(['', '']);
  metaRows.push(['--- Header fields (' + metaResult.header.length + ') ---', '']);
  metaResult.header.forEach(function (f) { metaRows.push(['  ' + f, '']); });

  metaRows.push(['', '']);
  metaRows.push(['--- Item fields (' + metaResult.item.length + ') ---', '']);
  metaResult.item.forEach(function (f) { metaRows.push(['  ' + f, '']); });

  metaRows.push(['', '']);
  metaRows.push(['--- 311-critical field check (on Item) ---', '']);
  targetFields.forEach(function (f) {
    var found = metaResult.item.indexOf(f) >= 0;
    metaRows.push(['  ' + f, found ? 'FOUND' : 'MISSING']);
  });

  var refFields = metaResult.item.filter(function (f) { return /Ref/i.test(f); });
  metaRows.push(['', '']);
  metaRows.push(['--- *Ref* fields on Item ---', '']);
  refFields.forEach(function (f) { metaRows.push(['  ' + f, '']); });

  writeSection('PROBE 1: API_MATERIAL_DOCUMENT_SRV $metadata', metaRows);
  Logger.log('Probe 1 done — header=' + metaResult.header.length +
    ' item=' + metaResult.item.length);

  // ==================================================================
  // Probe 2: List recent Material Document Items (self-discovering)
  // ==================================================================
  Logger.log('--- Probe 2: List recent MatDoc items ---');
  var listResult = diagListRecentMatDocItems_();
  var listRows = [
    ['HTTP Status', listResult.httpCode],
    ['Filter used', listResult.filterUsed],
    ['Items returned', listResult.items.length]
  ];

  if (listResult.error) listRows.push(['Error', listResult.error]);
  if (listResult.error311) listRows.push(['311 filter error', listResult.error311]);
  if (listResult.errorFallback) listRows.push(['Fallback error', listResult.errorFallback]);

  // Show each returned item with its non-empty fields
  listResult.items.forEach(function (item, idx) {
    listRows.push(['', '']);
    listRows.push(['--- Item[' + idx + '] ---', '']);
    Object.keys(item).forEach(function (k) {
      listRows.push(['  ' + k, String(item[k])]);
    });
  });

  // Show parent header sample (GoodsMovementCode lives here)
  if (listResult.headerSample) {
    listRows.push(['', '']);
    listRows.push(['--- Parent header (HTTP ' + listResult.headerHttpCode + ') ---', '']);
    Object.keys(listResult.headerSample).forEach(function (k) {
      listRows.push(['  ' + k, String(listResult.headerSample[k])]);
    });
  } else if (listResult.headerError) {
    listRows.push(['', '']);
    listRows.push(['Header fetch error', listResult.headerError]);
  }

  writeSection('PROBE 2: Recent MatDoc Items (LIST, self-discovered)', listRows);
  Logger.log('Probe 2 done — items=' + listResult.items.length +
    ' filter=' + listResult.filterUsed);

  // ==================================================================
  // Probe 3: Material Stock — Plant 1100 (self-discovering)
  // ==================================================================
  Logger.log('--- Probe 3: Material Stock for Plant ' + CFG.PLANT + ' ---');
  var stockResult = diagListMaterialStock_();
  var stockRows = [
    ['Metadata HTTP', stockResult.metaHttpCode],
    ['Data HTTP',     stockResult.dataHttpCode],
    ['Positive-qty only?', stockResult.positiveOnly ? 'YES' : 'NO (showing all)']
  ];

  if (stockResult.error) stockRows.push(['Error', stockResult.error]);
  if (stockResult.dataError) stockRows.push(['Data Error', stockResult.dataError]);

  stockRows.push(['', '']);
  stockRows.push(['--- Entity Sets ---', '']);
  stockResult.entitySets.forEach(function (s) { stockRows.push(['  ' + s, '']); });

  stockRows.push(['', '']);
  stockRows.push(['--- Entity Types ---', '']);
  stockResult.entityTypes.forEach(function (s) { stockRows.push(['  ' + s, '']); });

  stockRows.push(['', '']);
  stockRows.push(['--- Quantity field names ---', '']);
  stockResult.qtyFieldNames.forEach(function (f) { stockRows.push(['  ' + f, '']); });

  // Show each stock row with key fields
  stockResult.stockRows.forEach(function (srow, idx) {
    stockRows.push(['', '']);
    stockRows.push(['--- Stock row[' + idx + '] ---', '']);
    var keyFields = ['Material', 'Plant', 'StorageLocation', 'Batch'];
    keyFields.forEach(function (kf) {
      if (srow[kf] !== undefined) stockRows.push(['  ' + kf, String(srow[kf])]);
    });
    stockResult.qtyFieldNames.forEach(function (qf) {
      if (srow[qf] !== undefined) stockRows.push(['  ' + qf, String(srow[qf])]);
    });
    // Also show any other non-empty fields not already shown
    var shown = {};
    keyFields.concat(stockResult.qtyFieldNames).forEach(function (f) { shown[f] = true; });
    Object.keys(srow).forEach(function (k) {
      if (shown[k]) return;
      var v = srow[k];
      if (v !== null && v !== undefined && v !== '' && v !== '0' && v !== 0)
        stockRows.push(['  ' + k, String(v)]);
    });
  });

  if (stockResult.stockRows.length === 0) {
    stockRows.push(['', '']);
    stockRows.push(['No stock rows returned', '']);
  } else {
    stockRows.push(['', '']);
    stockRows.push(['Total rows returned', stockResult.stockRows.length]);
  }

  writeSection('PROBE 3: Material Stock — Plant ' + CFG.PLANT + ' (LIST, self-discovered)', stockRows);
  Logger.log('Probe 3 done — entitySets=' + stockResult.entitySets.length +
    ' rows=' + stockResult.stockRows.length);

  // ---- Final summary ----
  diagSheet.autoResizeColumns(1, 2);
  Logger.log('=== Transfer 311 Diagnostic — COMPLETE ===');
  Logger.log('Results written to _Diag311 sheet.');
}

// ============================================================================
// 5. Batch Probe — find real Batch values for a Material + StorageLocation
// ============================================================================

/**
 * GET A_MaterialDocumentItem filtered by Material + Plant + StorageLocation.
 * Returns rows where Batch is non-empty.  READ-ONLY — GET only.
 * @param {string} material - SAP Material number
 * @param {string} sloc     - Storage Location code (e.g. 'PW30')
 * @return {Array<{Batch:string, GoodsMovementType:string, Qty:string}>}
 */
function diagFindBatchForMaterial_(material, sloc) {
  var path = CFG.SERVICES.MATERIAL_DOCUMENT + 'A_MaterialDocumentItem';
  var params = {
    '$filter': "Material eq '" + material + "' and Plant eq '" + CFG.PLANT +
               "' and StorageLocation eq '" + sloc + "'",
    '$select': 'Material,StorageLocation,Batch,GoodsMovementType,QuantityInEntryUnit',
    '$top': '10'
  };

  logEvent('TRANSFER311_DIAG', 'BATCH_PROBE', material + '/' + sloc, 0, 'START');

  try {
    var data = sapGet(path, params, 'TRANSFER311_DIAG.batchProbe');
    var rows = (data.d && data.d.results) || [];

    var results = [];
    rows.forEach(function (row) {
      if (row.Batch && row.Batch !== '') {
        results.push({
          Batch: row.Batch,
          GoodsMovementType: row.GoodsMovementType || '',
          Qty: row.QuantityInEntryUnit || ''
        });
      }
    });

    logEvent('TRANSFER311_DIAG', 'BATCH_PROBE', material + '/' + sloc, 0,
      'OK total=' + rows.length + ' withBatch=' + results.length);
    return results;

  } catch (e) {
    logEvent('TRANSFER311_DIAG', 'BATCH_PROBE', material + '/' + sloc, 0,
      'ERROR: ' + e.message);
    throw e;
  }
}

// ============================================================================
// 6. Test runner — Batch Probe → _Diag311 sheet (append, don't clear)
// ============================================================================

/**
 * Find Batch values for STT1001-A0200S3XRX in PW30 and PW40.
 * Appends results to _Diag311 sheet (does not clear existing content).
 * No arguments — run from Apps Script editor.
 */
function TEST_findBatchForTest() {
  var material = 'STT1001-A0200S3XRX';
  var slocs = ['PW30', 'PW40'];

  Logger.log('=== Batch Probe — START ===');
  Logger.log('Material: ' + material);

  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var diagSheet = ss.getSheetByName('_Diag311');
  if (!diagSheet) diagSheet = ss.insertSheet('_Diag311');

  var lastRow = diagSheet.getLastRow();
  var row = lastRow + 2;

  diagSheet.getRange(row, 1).setValue('BATCH PROBE').setFontWeight('bold');
  diagSheet.getRange(row, 2).setValue(new Date().toISOString());
  row++;
  diagSheet.getRange(row, 1).setValue('Material').setFontWeight('bold');
  diagSheet.getRange(row, 2).setValue(material);
  row++;

  slocs.forEach(function (sloc) {
    row++;
    diagSheet.getRange(row, 1).setValue('--- StorageLocation: ' + sloc + ' ---')
      .setFontWeight('bold');
    row++;

    try {
      var results = diagFindBatchForMaterial_(material, sloc);
      Logger.log('SLoc ' + sloc + ': ' + results.length + ' rows with Batch');

      if (results.length === 0) {
        diagSheet.getRange(row, 1).setValue('(no rows with Batch found)');
        row++;
      } else {
        diagSheet.getRange(row, 1, 1, 3).setValues([['Batch', 'GoodsMovementType', 'Qty']])
          .setFontWeight('bold');
        row++;
        results.forEach(function (r) {
          diagSheet.getRange(row, 1, 1, 3).setValues([[r.Batch, r.GoodsMovementType, r.Qty]]);
          Logger.log('  Batch=' + r.Batch + ' GMT=' + r.GoodsMovementType + ' Qty=' + r.Qty);
          row++;
        });
      }
    } catch (e) {
      diagSheet.getRange(row, 1).setValue('ERROR: ' + e.message);
      Logger.log('SLoc ' + sloc + ' ERROR: ' + e.message);
      row++;
    }
  });

  diagSheet.autoResizeColumns(1, 3);
  Logger.log('=== Batch Probe — COMPLETE ===');
}

// ============================================================================
// 7. Positive-stock Batch probe — which Batch has unrestricted qty NOW?
// ============================================================================

/**
 * Two-approach probe for current positive stock of STT1001-A0200S3XRX at PW30.
 * Approach 1: keyed GET on A_MatlStkInAcctMod per known batch.
 * Approach 2: LIST A_MaterialStock with $filter (fallback).
 * READ-ONLY — GET only.  No arguments — run from Apps Script editor.
 */
function TEST_findPositiveStockBatch() {
  var material = 'STT1001-A0200S3XRX';
  var sloc     = 'PW30';
  var batches  = ['0000000683', '0000000754', '0000001474', '0000001475'];

  Logger.log('=== Positive-Stock Batch Probe — START ===');
  Logger.log('Material: ' + material + '  SLoc: ' + sloc);

  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var diagSheet = ss.getSheetByName('_Diag311');
  if (!diagSheet) diagSheet = ss.insertSheet('_Diag311');
  var row = diagSheet.getLastRow() + 2;

  diagSheet.getRange(row, 1).setValue('POSITIVE-STOCK BATCH PROBE').setFontWeight('bold');
  diagSheet.getRange(row, 2).setValue(new Date().toISOString());
  row++;
  diagSheet.getRange(row, 1).setValue('Material');
  diagSheet.getRange(row, 2).setValue(material);
  diagSheet.getRange(row, 3).setValue('SLoc');
  diagSheet.getRange(row, 4).setValue(sloc);
  row += 2;

  // ---- Approach 1: keyed GET on A_MatlStkInAcctMod per batch ----
  diagSheet.getRange(row, 1).setValue('APPROACH 1 — A_MatlStkInAcctMod (keyed per batch)')
    .setFontWeight('bold');
  row++;

  var approach1Hits = [];

  batches.forEach(function (batch) {
    Logger.log('--- Approach 1: batch=' + batch + ' ---');
    diagSheet.getRange(row, 1).setValue('Batch: ' + batch).setFontWeight('bold');
    row++;

    var keyPath = MATERIAL_STOCK_SRV_ + "A_MatlStkInAcctMod(" +
      "Material='" + material + "'," +
      "Plant='" + CFG.PLANT + "'," +
      "StorageLocation='" + sloc + "'," +
      "Batch='" + batch + "')";

    var tried = false;
    var attempts = [
      { label: 'without StockType', path: keyPath },
      { label: 'with StockType=1',  path: keyPath.replace(/\)$/, ",StockType='1')") }
    ];

    for (var a = 0; a < attempts.length; a++) {
      var attempt = attempts[a];
      if (tried) break;

      try {
        var data = sapGet(attempt.path, {}, 'TRANSFER311_DIAG.stockBatch');
        var d = data.d || data;
        tried = true;

        var clean = {};
        Object.keys(d).forEach(function (k) {
          if (k === '__metadata') return;
          var v = d[k];
          if (v !== null && v !== undefined && v !== '') clean[k] = v;
        });

        var keys = Object.keys(clean);
        if (keys.length === 0) {
          diagSheet.getRange(row, 1).setValue('  (empty response)');
          Logger.log('  empty response');
          row++;
        } else {
          keys.forEach(function (k) {
            diagSheet.getRange(row, 1).setValue('  ' + k);
            diagSheet.getRange(row, 2).setValue(String(clean[k]));
            row++;
          });

          var qtyFields = keys.filter(function (k) {
            return /qty|quantity|stock/i.test(k);
          });
          var hasPositive = qtyFields.some(function (qf) {
            var v = parseFloat(clean[qf]);
            return !isNaN(v) && v > 0;
          });
          if (hasPositive) {
            approach1Hits.push(batch);
            Logger.log('  ** POSITIVE STOCK for batch ' + batch);
          }
        }

        diagSheet.getRange(row, 1).setValue('  (fetched ' + attempt.label + ')');
        row++;

      } catch (e) {
        var is404 = /404/.test(e.message);
        if (is404 && a === 0) {
          continue;
        }
        var msg = is404 ? 'no stock for batch ' + batch : e.message;
        diagSheet.getRange(row, 1).setValue('  ' + msg);
        Logger.log('  ' + msg);
        row++;
        tried = true;
      }
    }

    row++;
  });

  diagSheet.getRange(row, 1).setValue('Approach 1 hits: ' +
    (approach1Hits.length > 0 ? approach1Hits.join(', ') : '(none)'))
    .setFontWeight('bold');
  row += 2;

  // ---- Approach 2: LIST A_MaterialStock with $filter (fallback) ----
  diagSheet.getRange(row, 1).setValue('APPROACH 2 — A_MaterialStock (LIST with $filter)')
    .setFontWeight('bold');
  row++;

  if (approach1Hits.length > 0) {
    diagSheet.getRange(row, 1).setValue('(skipped — approach 1 found results)');
    Logger.log('Approach 2 skipped — approach 1 found: ' + approach1Hits.join(', '));
    row++;
  } else {
    Logger.log('--- Approach 2: LIST A_MaterialStock ---');
    try {
      var listPath = MATERIAL_STOCK_SRV_ + 'A_MaterialStock';
      var listData = sapGet(listPath, {
        '$filter': "Material eq '" + material + "' and Plant eq '" + CFG.PLANT +
                   "' and StorageLocation eq '" + sloc + "'",
        '$top': '10'
      }, 'TRANSFER311_DIAG.stockList2');

      var rows2 = (listData.d && listData.d.results) || [];
      Logger.log('Approach 2: ' + rows2.length + ' rows returned');

      if (rows2.length === 0) {
        diagSheet.getRange(row, 1).setValue('(no rows returned)');
        row++;
      } else {
        rows2.forEach(function (srow, idx) {
          diagSheet.getRange(row, 1).setValue('--- Row[' + idx + '] ---')
            .setFontWeight('bold');
          row++;
          Object.keys(srow).forEach(function (k) {
            if (k === '__metadata') return;
            var v = srow[k];
            if (v !== null && v !== undefined && v !== '') {
              diagSheet.getRange(row, 1).setValue('  ' + k);
              diagSheet.getRange(row, 2).setValue(String(v));
              Logger.log('  ' + k + '=' + v);
              row++;
            }
          });
        });
      }
    } catch (e2) {
      diagSheet.getRange(row, 1).setValue('ERROR: ' + e2.message);
      Logger.log('Approach 2 ERROR: ' + e2.message);
      row++;
    }
  }

  // ---- Summary ----
  row += 1;
  var summary = approach1Hits.length > 0
    ? 'Batches with positive stock: ' + approach1Hits.join(', ')
    : 'No positive stock found via approach 1 — check approach 2 results above';
  diagSheet.getRange(row, 1).setValue(summary).setFontWeight('bold');
  Logger.log('=== SUMMARY: ' + summary + ' ===');

  diagSheet.autoResizeColumns(1, 4);
  logEvent('TRANSFER311_DIAG', 'STOCK_BATCH_PROBE', material + '/' + sloc, 0,
    'hits=' + approach1Hits.length);
  Logger.log('=== Positive-Stock Batch Probe — COMPLETE ===');
}



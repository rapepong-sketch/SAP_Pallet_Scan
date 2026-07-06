/**
 * Transfer311.gs — Phase 4 Steps 2–3: 311 transfer posting (payload builder + live POST)
 * ========================================================================================
 * buildTransfer311Payload_()    — builder: reads TransferLog + PalletMaster, tier-3 GR doc batch.
 * resolveBatchFromGrDoc_()      — shared helper: resolves batch from GR material doc items (GET).
 * postTransfer311_()            — gate-driven POST: CSRF, idempotency, DRY_RUN flag, writeback.
 * reverseMaterialDocByRef_()    — Cancel FunctionImport reversal (auto-312, reference-based).
 *
 * Reversal: hand-built 312 payloads do NOT work on this tenant (movement 312 re-posts the
 * same direction instead of reversing — proven 2026-06-25 doc 4900215843). Use the Cancel
 * FunctionImport via reverseMaterialDocByRef_ exclusively.
 *
 * Reuses: CFG (Config.gs), getSpreadsheet_ (SheetSetup.gs),
 *         logEvent (SapClient.gs), TL_SHEET / TL_HEADERS / tlHeaderIdx_ (TransferLog.gs),
 *         PM_SHEET (PalletGen.gs), getCsrfSession_ / buildSapUrl_ / getSapCredentials_ (SapClient.gs)
 */

// ============================================================================
// Unit mapping — no unit conversion needed on this tenant — SAP uses PC natively.
// ============================================================================

function mapUnitToSap_(unit) { return String(unit || '').trim(); }

// ============================================================================
// Shared batch-resolution helper (READ-ONLY — GET only, no SAP writes)
// ============================================================================

/**
 * Resolve the SAP-assigned batch from a GR material document's items.
 * Filters to GoodsMovementType 101 (receipt leg) matching the given material.
 * Returns '' on miss, ambiguity, or error — never guesses.
 *
 * @param {string} grDoc - MaterialDocument number (e.g. '4900214455')
 * @param {string} grYear - MaterialDocumentYear (e.g. '2026')
 * @param {string} material - Material number to match
 * @param {Object} [opts] - { qty, sloc, fetchFn } for tighter matching / test injection
 * @return {string} batch string (leading-zero-preserved) or '' on miss/ambiguous
 * @private
 */
function resolveBatchFromGrDoc_(grDoc, grYear, material, opts) {
  opts = opts || {};
  if (!grDoc || !grYear) {
    logEvent('TRANSFER311', 'BATCH_RESOLVE', 'SKIP — grDoc or grYear empty');
    return '';
  }

  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;
  var docKey = "MaterialDocument='" + grDoc +
    "',MaterialDocumentYear='" + grYear + "'";
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

  Logger.log('FETCH_URL [resolveBatchFromGrDoc_] ' + url);

  var resp;
  try {
    if (opts.fetchFn) {
      resp = opts.fetchFn(url);
    } else {
      var creds = getSapCredentials_();
      resp = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: {
          'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
          'Accept': 'application/json'
        },
        muteHttpExceptions: true
      });
    }
  } catch (e) {
    logEvent('TRANSFER311', 'BATCH_RESOLVE_ERR', 'fetch exception: ' + e.message);
    return '';
  }

  var code = resp.getResponseCode();
  var body = resp.getContentText();

  if (code < 200 || code >= 300) {
    logEvent('TRANSFER311', 'BATCH_RESOLVE_ERR',
      'HTTP ' + code + ' grDoc=' + grDoc + ' ' + body.slice(0, 300));
    return '';
  }

  var parsed = JSON.parse(body);
  var d = parsed.d || parsed;
  var items = (d.to_MaterialDocumentItem &&
               d.to_MaterialDocumentItem.results) || [];

  var candidates = items.filter(function(it) {
    return String(it.Material || '').trim() === material &&
           String(it.GoodsMovementType || '').trim() === '101';
  });

  if (candidates.length === 0) {
    logEvent('TRANSFER311', 'BATCH_RESOLVE', 'NO_MATCH grDoc=' + grDoc +
      ' material=' + material + ' (0 items with GMT=101)');
    return '';
  }

  if (opts.sloc) {
    var slocMatch = candidates.filter(function(it) {
      return String(it.StorageLocation || '').trim() === opts.sloc;
    });
    if (slocMatch.length > 0) candidates = slocMatch;
  }

  var distinctBatches = {};
  candidates.forEach(function(it) {
    var b = String(it.Batch || '').trim();
    if (b) distinctBatches[b] = true;
  });
  var batchKeys = Object.keys(distinctBatches);

  if (batchKeys.length === 0) {
    logEvent('TRANSFER311', 'BATCH_RESOLVE', 'EMPTY_BATCH grDoc=' + grDoc +
      ' material=' + material + ' — items matched but Batch field blank');
    return '';
  }

  if (batchKeys.length > 1) {
    logEvent('TRANSFER311', 'BATCH_RESOLVE_AMBIGUOUS',
      'grDoc=' + grDoc + ' material=' + material +
      ' candidates=[' + batchKeys.join(',') + '] — returning empty (no guess)');
    return '';
  }

  var resolved = batchKeys[0];
  logEvent('TRANSFER311', 'BATCH_RESOLVED',
    'grDoc=' + grDoc + ' material=' + material + ' → batch=' + resolved);
  return resolved;
}

// ============================================================================
// Pure payload builder
// ============================================================================

/**
 * Build an OData V2 deep-insert payload for a 311 transfer posting.
 * Batch resolution: tier-1 TransferLog.Batch → tier-2 PalletMaster.Batch →
 * tier-3 resolveBatchFromGrDoc_ (GR doc item batch via SAP GET).
 *
 * @param {string} txnId - TxnID from TransferLog
 * @param {string} destSloc - destination StorageLocation (must be in CFG.DEST_SLOCS)
 * @return {Object} OData V2 payload for POST A_MaterialDocumentHeader
 * @throws {Error} on validation failure
 * @private
 */
function buildTransfer311Payload_(txnId, destSloc) {
  // ---- Read TransferLog row by TxnID ----
  var ss = getSpreadsheet_();
  var tlSh = ss.getSheetByName(TL_SHEET);
  if (!tlSh || tlSh.getLastRow() < 2) {
    throw new Error('TransferLog sheet empty or missing');
  }

  var tlData = tlSh.getDataRange().getValues();
  var tlIdx = tlHeaderIdx_(tlData[0]);

  var txnRow = null;
  for (var r = 1; r < tlData.length; r++) {
    if (String(tlData[r][tlIdx['TxnID']] || '').trim() === txnId) {
      txnRow = {};
      TL_HEADERS.forEach(function (h) {
        txnRow[h] = tlData[r][tlIdx[h]];
      });
      break;
    }
  }

  if (!txnRow) {
    throw new Error('TxnID not found in TransferLog: ' + txnId);
  }

  // ---- Verify TxnType and Status ----
  var txnType = String(txnRow['TxnType'] || '').trim();
  if (txnType !== 'SPLIT_ISSUE' && txnType !== 'SCAN_ISSUE') {
    throw new Error('TxnType must be SPLIT_ISSUE or SCAN_ISSUE, got: ' + txnType);
  }

  var status = String(txnRow['Status'] || '').trim();
  if (status === 'TRANSFERRED') {
    throw new Error('TxnID ' + txnId + ' already TRANSFERRED');
  }

  // ---- Extract fields from TransferLog row ----
  var material = String(txnRow['Material'] || '').trim();
  var issueQty = Number(txnRow['IssueQty']) || 0;
  var unit = String(txnRow['Unit'] || '').trim();
  var sourceSLoc = String(txnRow['SourceSLoc'] || '').trim();
  var parentPalletId = String(txnRow['ParentPalletID'] || '').trim();

  // ---- Resolve real SAP Batch: tier1 TransferLog, tier2 PalletMaster, tier3 GR doc ----
  var batch = String(txnRow['Batch'] || '').trim();                    // tier-1
  var grDoc = '';
  var grYear = '';
  if (!batch && parentPalletId) {
    var pmSh = ss.getSheetByName(PM_SHEET);
    if (pmSh && pmSh.getLastRow() >= 2) {
      var pmData = pmSh.getDataRange().getValues();
      var pmIdx = tlHeaderIdx_(pmData[0]);
      var pmPidCol = pmIdx['PalletID'];
      var pmBatchCol = pmIdx['Batch'];
      var pmGrDocCol = pmIdx['GRMaterialDocument'];
      var pmGrYearCol = pmIdx['GRMaterialDocumentYear'];
      if (pmPidCol !== undefined) {
        for (var p = 1; p < pmData.length; p++) {
          if (String(pmData[p][pmPidCol] || '').trim() === parentPalletId) {
            if (pmBatchCol !== undefined) {
              batch = String(pmData[p][pmBatchCol] || '').trim();      // tier-2
            }
            if (pmGrDocCol !== undefined) {
              grDoc = String(pmData[p][pmGrDocCol] || '').trim();
            }
            if (pmGrYearCol !== undefined) {
              grYear = String(pmData[p][pmGrYearCol] || '').trim();
            }
            break;
          }
        }
      }
    }
  }

  // tier-3: resolve batch from GR material document items
  if (!batch && grDoc && grYear) {
    batch = resolveBatchFromGrDoc_(grDoc, grYear, material, { sloc: sourceSLoc });
  }

  // loud log when all tiers fail — batch-less 311 will likely fail M7 018
  if (!batch) {
    logEvent('TRANSFER311', 'BATCH_UNRESOLVED',
      'pallet=' + parentPalletId + ' grDoc=' + grDoc +
      ' — 311 will likely fail M7 018');
  }

  // ---- Validate ----
  if (!CFG.DEST_SLOCS || CFG.DEST_SLOCS.length === 0) {
    throw new Error('CFG.DEST_SLOCS is empty — populate with real SLocs before use');
  }
  if (CFG.DEST_SLOCS.indexOf(destSloc) === -1) {
    throw new Error('destSloc "' + destSloc + '" not in CFG.DEST_SLOCS whitelist: [' +
      CFG.DEST_SLOCS.join(', ') + ']');
  }
  if (destSloc === sourceSLoc) {
    throw new Error('destSloc === sourceSLoc ("' + destSloc + '") — cannot transfer to same location');
  }
  if (issueQty <= 0) {
    throw new Error('IssueQty must be > 0, got: ' + issueQty);
  }
  if (!material) {
    throw new Error('Material is empty for TxnID: ' + txnId);
  }
  if (!sourceSLoc) {
    throw new Error('SourceSLoc is empty for TxnID: ' + txnId);
  }

  // ---- Live re-check: PalletMaster.ScanStatus must still be CONFIRMED ----
  // Fresh read at build time — independent of the tier-2 batch-resolution lookup
  // above, which only runs when TransferLog.Batch is empty and so cannot be relied
  // on to have loaded this row. Closes the TOCTOU gap where a pallet's status
  // changes (excluded, reverted, superseded) after the TransferLog row was created
  // but before this payload is built/POSTed. Fail-closed: missing row = reject.
  var pmScanSh = ss.getSheetByName(PM_SHEET);
  if (!pmScanSh || pmScanSh.getLastRow() < 2) {
    throw new Error('PalletMaster sheet empty or missing — cannot verify ScanStatus for ' + parentPalletId);
  }
  var pmScanData = pmScanSh.getDataRange().getValues();
  var pmScanHdrClean = pmScanData[0].map(function(h) { return String(h).trim(); });
  var pmScanIdx = tlHeaderIdx_(pmScanHdrClean);
  var pmScanPidCol = pmScanIdx['PalletID'];
  var pmScanStatusCol = pmScanIdx['ScanStatus'];
  var liveScanStatus = null;
  if (pmScanPidCol !== undefined) {
    for (var q = 1; q < pmScanData.length; q++) {
      if (String(pmScanData[q][pmScanPidCol] || '').trim() === parentPalletId) {
        liveScanStatus = String(pmScanData[q][pmScanStatusCol] || '').trim();
        break;
      }
    }
  }
  if (liveScanStatus === null) {
    throw new Error('PalletMaster row not found for ParentPalletID: ' + parentPalletId +
      ' — cannot verify ScanStatus');
  }
  if (liveScanStatus !== 'CONFIRMED') {
    throw new Error('ParentPalletID ' + parentPalletId + ' ScanStatus is "' + liveScanStatus +
      '", expected CONFIRMED — pallet status changed since TransferLog row was created');
  }

  // ---- Build OData V2 dates (Asia/Bangkok) ----
  var now = new Date();
  var bangkokMs = now.getTime() +
    (now.getTimezoneOffset() * 60000) + (7 * 3600000);
  var bangkokMidnight = new Date(bangkokMs);
  bangkokMidnight.setHours(0, 0, 0, 0);
  var odataDate = '/Date(' + bangkokMidnight.getTime() + ')/';

  // ---- Build item line ----
  var item = {
    Material:                       material,
    Plant:                          CFG.PLANT,
    StorageLocation:                sourceSLoc,
    IssuingOrReceivingStorageLoc:   destSloc,
    GoodsMovementType:              '311',
    QuantityInEntryUnit:            String(issueQty),
    EntryUnit:                      mapUnitToSap_(unit)
  };

  if (batch) {
    item.Batch = batch;
  }

  // ---- Build header + deep insert ----
  // Phase 5 item 2b: stamp a deterministic token for SAP readback idempotency.
  // NOTE: creatability of MaterialDocumentHeaderText is NOT yet empirically proven
  // (no live 311 doc exists; FEATURE_TRANSFER311=DRY_RUN). Proof deferred to 311 LIVE cutover.
  var token311 = String(txnId).replace(/-/g, '').slice(0, 24);
  var payload = {
    GoodsMovementCode:              '04',
    PostingDate:                    odataDate,
    DocumentDate:                   odataDate,
    MaterialDocumentHeaderText:     token311,
    to_MaterialDocumentItem: [item]
  };

  return payload;
}

// ============================================================================
// Gate-driven POST — CSRF + idempotency + DRY_RUN flag + writeback
// ============================================================================

/**
 * SAP readback: check whether a 311 material document with this token already exists.
 * READ-ONLY, best-effort — never throws.
 * NOTE: creatability not yet proven (FEATURE_TRANSFER311=DRY_RUN). Proof deferred to LIVE cutover.
 *
 * @param {string} token — 24-char hex token derived from TxnID
 * @return {{found:boolean, materialDocument?:string, materialDocumentYear?:string, raw?:string, error?:string}}
 */
function sapReadbackTransfer311_(token) {
  // RESOLVED 2026-06-25 (T1 probe): Plant is item-level on this tenant —
  // "Property Plant not found in type A_MaterialDocumentHeaderType" (HTTP 400).
  // Readback is token-only by MaterialDocumentHeaderText (MaxLength 25, fits
  // 24-char txnId), mirroring confirmation readback. Plant filtering unnecessary:
  // token uniquely identifies the txn. See Transfer311Probe.gs PROBE_* (A=200,
  // B=400, C=200, D=200, metadata Plant=false).
  try {
    var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;
    var url = buildSapUrl_(serviceRoot + 'A_MaterialDocumentHeader', {
      '$filter': "MaterialDocumentHeaderText eq '" + String(token) + "'",
      '$select': 'MaterialDocument,MaterialDocumentYear,MaterialDocumentHeaderText',
      '$top': '1',
      '$format': 'json'
    });

    logEvent('TRANSFER311', 'READBACK_URL', url);
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
      logEvent('TRANSFER311', 'READBACK_HTTP_ERR', code + ' ' + body.slice(0, 300));
      return { found: false, error: 'HTTP ' + code };
    }

    var parsed = JSON.parse(body);
    var results = (parsed.d && parsed.d.results) || [];

    if (results.length === 0) {
      return { found: false };
    }

    var hit = results[0];
    return {
      found: true,
      materialDocument: hit.MaterialDocument || '',
      materialDocumentYear: hit.MaterialDocumentYear || '',
      raw: body.slice(0, 500)
    };
  } catch (e) {
    logEvent('TRANSFER311', 'READBACK_EXCEPTION', e.message);
    return { found: false, error: e.message };
  }
}

/**
 * DEPRECATED for production — superseded by postTransfer311WithRetry_ via
 * confirmTransfer311 orchestrator. Retained for TEST_ only.
 *
 * Post a 311 transfer to SAP for the given TransferLog TxnID.
 * Gate: ScriptProperties FEATURE_TRANSFER311 ('DRY_RUN'|'LIVE'; default 'DRY_RUN').
 * Idempotent: skips if Status already TRANSFERRED.
 *
 * @param {string} txnId
 * @param {string} destSloc
 * @return {{success:boolean, materialDocument:string, materialDocumentYear?:string,
 *           dryRun:boolean, error?:string}}
 * @deprecated Use confirmTransfer311 (orchestrator → postTransfer311WithRetry_)
 */
function postTransfer311_(txnId, destSloc) {
  // ---- 1. IDEMPOTENCY CHECK ----
  var ss = getSpreadsheet_();
  var tlSh = ss.getSheetByName(TL_SHEET);
  if (!tlSh || tlSh.getLastRow() < 2) {
    throw new Error('TransferLog sheet empty or missing');
  }
  var tlData = tlSh.getDataRange().getValues();
  var tlIdx  = tlHeaderIdx_(tlData[0]);

  var txnRowNum = -1;
  for (var r = 1; r < tlData.length; r++) {
    if (String(tlData[r][tlIdx['TxnID']] || '').trim() === txnId) {
      txnRowNum = r + 1;
      break;
    }
  }
  if (txnRowNum === -1) {
    throw new Error('TxnID not found in TransferLog: ' + txnId);
  }

  var curStatus = String(tlData[txnRowNum - 1][tlIdx['Status']] || '').trim();
  if (curStatus === 'TRANSFERRED') {
    var existingDoc = String(tlData[txnRowNum - 1][tlIdx['RefDoc']] || '').trim();
    logEvent('TRANSFER311', TL_SHEET, 'SKIP_IDEMPOTENT', 0, txnId);
    return { success: true, materialDocument: existingDoc, dryRun: false };
  }

  // ---- 1b. SAP readback guard (best-effort, timeout-after-success recovery) ----
  var rbToken = String(txnId).replace(/-/g, '').slice(0, 24);
  var rb = sapReadbackTransfer311_(rbToken);
  if (rb.found) {
    tlSh.getRange(txnRowNum, tlIdx['Status'] + 1).setValue('TRANSFERRED');
    tlSh.getRange(txnRowNum, tlIdx['RefDoc'] + 1).setValue(rb.materialDocument);
    if (tlIdx['DestSLoc'] !== undefined) {
      tlSh.getRange(txnRowNum, tlIdx['DestSLoc'] + 1).setValue(destSloc);
    }
    if (tlIdx['Note'] !== undefined) {
      tlSh.getRange(txnRowNum, tlIdx['Note'] + 1)
        .setValue('HEALED from SAP readback ' + rb.materialDocument);
    }
    if (tlIdx['UpdatedAt'] !== undefined) {
      tlSh.getRange(txnRowNum, tlIdx['UpdatedAt'] + 1).setValue(new Date().toISOString());
    }
    logEvent('TRANSFER311', TL_SHEET, 'HEAL_SKIP', 0,
      txnId + ' found in SAP via readback doc=' + rb.materialDocument);
    return { success: true, materialDocument: rb.materialDocument,
      materialDocumentYear: rb.materialDocumentYear || '', dryRun: false };
  }
  if (rb.error) {
    logEvent('TRANSFER311', TL_SHEET, 'READBACK_DEGRADED', 0, txnId + ' ' + rb.error);
  }

  // ---- 2. BUILD PAYLOAD (validates destSloc, source≠dest, qty, etc.) ----
  var payload = buildTransfer311Payload_(txnId, destSloc);

  // ---- 3. DRY_RUN gate ----
  var flag = PropertiesService.getScriptProperties()
    .getProperty('FEATURE_TRANSFER311') || 'DRY_RUN';
  if (flag !== 'LIVE') {
    logEvent('TRANSFER311', TL_SHEET, 'DRY_RUN', 0, JSON.stringify(payload));
    return { success: true, materialDocument: 'DRY_RUN', dryRun: true };
  }

  // ---- 4. LIVE POST ----
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;
  var session = getCsrfSession_(serviceRoot);
  var creds   = getSapCredentials_();
  var postUrl = buildSapUrl_(serviceRoot + 'A_MaterialDocumentHeader');

  var resp = UrlFetchApp.fetch(postUrl, {
    method: 'post',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'X-CSRF-Token': session.token,
      'Cookie':       session.cookies,
      'Content-Type': 'application/json',
      'Accept':       'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();

  if (code !== 201) {
    logEvent('TRANSFER311', TL_SHEET, 'ERROR', 0, code + ' ' + body.slice(0, 400));
    throw new Error('SAP Transfer 311 POST failed HTTP ' + code + ': ' + body.slice(0, 600));
  }

  var parsed    = JSON.parse(body);
  var d         = parsed.d || parsed;
  var matDoc     = d.MaterialDocument || '';
  var matDocYear = d.MaterialDocumentYear || '';

  // ---- 4e. WRITEBACK to TransferLog ----
  tlSh.getRange(txnRowNum, tlIdx['Status'] + 1).setValue('TRANSFERRED');
  tlSh.getRange(txnRowNum, tlIdx['DestSLoc'] + 1).setValue(destSloc);
  tlSh.getRange(txnRowNum, tlIdx['RefDoc'] + 1).setValue(matDoc);
  tlSh.getRange(txnRowNum, tlIdx['Note'] + 1)
    .setValue('MT311 posted ' + matDoc + '/' + matDocYear);
  if (tlIdx['UpdatedAt'] !== undefined) {
    tlSh.getRange(txnRowNum, tlIdx['UpdatedAt'] + 1)
      .setValue(new Date().toISOString());
  }

  logEvent('TRANSFER311', TL_SHEET, 'LIVE_OK', 0, txnId + ' → ' + matDoc);

  return {
    success: true,
    materialDocument: matDoc,
    materialDocumentYear: matDocYear,
    dryRun: false
  };
}

// ============================================================================
// Reverse-by-reference via Cancel bound FunctionImport
// ============================================================================

/**
 * Reverse a material document by calling the Cancel FunctionImport on
 * API_MATERIAL_DOCUMENT_SRV. SAP auto-creates reversal (auto-312, correct
 * direction) and stamps ReversedMaterialDocument=origDoc on items.
 * Edm.String params MUST be single-quoted.
 * Proven 2026-06-25 docs 4900215913→4900215914.
 *
 * @param {string} matDoc  - MaterialDocument number (e.g. '4900215913')
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
// T4 — Raw POST (extracted CSRF+POST mechanics, injectable for testing)
// ============================================================================

/**
 * POST a pre-built 311 payload to SAP. No idempotency check, no writeback.
 * On 200/201 returns {code, body, doc, year}. On failure throws with HTTP code
 * in the message (for _classifyTransfer311Error_).
 * @param {Object} payload — OData deep-insert payload
 * @return {{code:number, body:string, doc:string, year:string}}
 */
function postTransfer311Raw_(payload) {
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;
  var session = getCsrfSession_(serviceRoot);
  var creds   = getSapCredentials_();
  var postUrl = buildSapUrl_(serviceRoot + 'A_MaterialDocumentHeader');

  Logger.log('FETCH_URL [postTransfer311Raw_] ' + postUrl);
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
  Logger.log('[postTransfer311Raw_] HTTP ' + code + ' :: ' + body.slice(0, 400));

  if (code === 201 || code === 200) {
    var parsed = JSON.parse(body);
    var d = parsed.d || parsed;
    return { code: code, body: body.slice(0, 500),
      doc: d.MaterialDocument || '', year: d.MaterialDocumentYear || '' };
  }

  throw new Error('SAP Transfer 311 POST failed HTTP ' + code + ': ' + body.slice(0, 600));
}

/** @private */
function _classifyTransfer311Error_(e) {
  var msg = String(e.message || e || '');
  var m = msg.match(/HTTP (\d+)/);
  var code = m ? parseInt(m[1], 10) : 0;
  if (code === 403 && /csrf/i.test(msg)) return { type: 'TRANSIENT', code: 403 };
  if (code === 429) return { type: 'TRANSIENT', code: 429 };
  if (code >= 500) return { type: 'TRANSIENT', code: code };
  if (code >= 400) return { type: 'BUSINESS', code: code };
  return { type: 'TIMEOUT_UNKNOWN', code: 0 };
}

// ============================================================================
// T4 — Retry wrapper with readback-first idempotency + dead-letter
// ============================================================================

var T311_MAX_ATTEMPTS_ = 3;
var T311_BACKOFF_ = [0, 2000, 5000];

/**
 * POST a 311 payload with readback-first idempotency, retry on transient
 * failures, and dead-letter capture on exhaustion. Mirrors the confirmation
 * path's postConfirmationWithRetry_.
 *
 * STABLE-TOKEN INVARIANT: txnId is created ONCE by the caller. The derived
 * MaterialDocumentHeaderText token is identical across all attempts.
 *
 * @param {Object} payload — OData deep-insert payload (from buildTransfer311Payload_)
 * @param {string} txnId — TxnID (stable across retries)
 * @param {Object} [opts] — { readbackFn, postFn, sleepFn } for test injection
 * @return {{ok:boolean, status:string, doc?:string, year?:string, error?:string}}
 */
function postTransfer311WithRetry_(payload, txnId, opts) {
  if (!txnId) throw new Error('postTransfer311WithRetry_: txnId is required (stable-token invariant)');

  var _readback = (opts && opts.readbackFn) || sapReadbackTransfer311_;
  var _post     = (opts && opts.postFn)     || postTransfer311Raw_;
  var _sleep    = (opts && opts.sleepFn)    || function(ms) { Utilities.sleep(ms); };
  var MAX       = T311_MAX_ATTEMPTS_;

  var token = String(txnId).replace(/-/g, '').slice(0, 24);

  // ---- Step A: readback-first ----
  var rb = _readback(token);
  if (rb.found) {
    logEvent('TRANSFER311', 'READBACK_FIRST', 'ALREADY_POSTED token=' + token);
    return { ok: true, status: 'ALREADY_POSTED',
      doc: rb.materialDocument || '', year: rb.materialDocumentYear || '' };
  }

  var flag = PropertiesService.getScriptProperties()
    .getProperty('FEATURE_TRANSFER311') || 'DRY_RUN';

  var lastOutcome = 'NONE';
  var lastError   = '';

  for (var attempt = 1; attempt <= MAX; attempt++) {
    // DRY_RUN gate — never POST
    if (flag !== 'LIVE') {
      logEvent('TRANSFER311', 'DRY_RUN', 'attempt=' + attempt +
        ' token=' + token + ' payload=' + JSON.stringify(payload).slice(0, 300));
      return { ok: true, status: 'DRY_RUN', doc: null, year: null };
    }

    try {
      var result = _post(payload);

      // POST succeeded — readback to confirm
      var postRb = _readback(token);
      if (postRb.found) {
        logEvent('TRANSFER311', 'POSTED', token + ' doc=' +
          (postRb.materialDocument || result.doc));
        return { ok: true, status: 'POSTED',
          doc: postRb.materialDocument || result.doc,
          year: postRb.materialDocumentYear || result.year };
      }

      // POST 201 but readback miss — ambiguous
      logEvent('TRANSFER311', 'POST_OK_READBACK_MISS',
        token + ' attempt=' + attempt + ' doc=' + result.doc);
      lastOutcome = 'TIMEOUT_UNKNOWN';
    } catch (e) {
      var cls = _classifyTransfer311Error_(e);
      logEvent('TRANSFER311', 'RETRY_ATTEMPT', token +
        ' attempt=' + attempt + '/' + MAX + ' class=' + cls.type +
        ' code=' + cls.code + ' ' + String(e.message || '').slice(0, 200));

      if (cls.type === 'BUSINESS') {
        lastOutcome = cls.type;
        lastError = String(e.message || '').slice(0, 500);
        break;
      }

      lastOutcome = cls.type;
      lastError = String(e.message || '').slice(0, 500);

      // Transient — readback before retry
      var retryRb = _readback(token);
      if (retryRb.found) {
        logEvent('TRANSFER311', 'HEAL_ON_RETRY', token + ' attempt=' + attempt);
        return { ok: true, status: 'POSTED_ON_RETRY',
          doc: retryRb.materialDocument || '', year: retryRb.materialDocumentYear || '' };
      }
    }

    if (attempt < MAX) {
      _sleep(T311_BACKOFF_[attempt] || 2000);
    }
  }

  // ---- Exhausted: final readback ----
  var finalRb = _readback(token);
  if (finalRb.found) {
    logEvent('TRANSFER311', 'HEAL_FINAL', token);
    return { ok: true, status: 'POSTED_LATE',
      doc: finalRb.materialDocument || '', year: finalRb.materialDocumentYear || '' };
  }

  var dlStatus = (lastOutcome === 'TIMEOUT_UNKNOWN') ? 'UNKNOWN_STATE' : 'FAILED_PERMANENT';
  lastError = lastError || 'Transfer311 ' + dlStatus + ' after ' + MAX + ' attempts';

  captureDeadLetter_({
    path: 'TRANSFER311', palletId: txnId,
    mo: '', paddedMO: '',
    outcome: dlStatus, attempts: MAX,
    lastErrorClass: lastOutcome,
    lastErrorMsg: lastError,
    payload: payload, token: token
  });

  try {
    var ts = Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");
    sendLarkText_('🔴 Transfer311 dead-letter: ' + txnId +
      ' status=' + dlStatus + ' lastError=' + lastError.slice(0, 150) +
      ' at ' + ts);
  } catch (larkErr) {
    logEvent('TRANSFER311', 'LARK_FAIL', larkErr.message);
  }

  return { ok: false, status: dlStatus, error: lastError };
}

// ============================================================================
// T4 — Manual replay + manual reverse
// ============================================================================

/**
 * Replay a Transfer311 dead-letter row. Reads back by token first — if SAP has
 * the doc, marks resolved without re-POST. Otherwise re-attempts with the SAME
 * txnId (stable token preserved).
 * @param {string} dlid — DLID to replay
 * @return {{ok:boolean, status:string, message:string}}
 */
function replayTransfer311DeadLetter_(dlid) {
  var sh = getSpreadsheet_().getSheetByName(DL_SHEET_);
  if (!sh || sh.getLastRow() < 2) {
    return { ok: false, status: 'NO_SHEET', message: 'DeadLetter sheet not found' };
  }

  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var idx = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var rowNum = -1;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['DLID']] || '').trim() === dlid) { rowNum = r + 1; break; }
  }
  if (rowNum < 0) return { ok: false, status: 'NOT_FOUND', message: 'DLID not found: ' + dlid };

  var row = data[rowNum - 1];
  if (String(row[idx['Path']] || '').trim() !== 'TRANSFER311') {
    return { ok: false, status: 'WRONG_PATH', message: 'Not a TRANSFER311 dead-letter' };
  }
  if (String(row[idx['ReplayStatus']] || '').trim() !== 'OPEN') {
    return { ok: false, status: 'SKIP', message: 'ReplayStatus is not OPEN' };
  }

  var txnId      = String(row[idx['PalletID']] || '').trim();
  var payloadStr = String(row[idx['PayloadJSON']] || '').trim();
  if (!txnId || !payloadStr) {
    return { ok: false, status: 'INVALID', message: 'Missing txnId or PayloadJSON' };
  }
  var payload;
  try { payload = JSON.parse(payloadStr); } catch (e) {
    return { ok: false, status: 'INVALID', message: 'PayloadJSON parse error: ' + e.message };
  }

  logEvent('TRANSFER311_DL', 'REPLAY_START', dlid + ' ' + txnId);

  try {
    // ---- Live re-check: PalletMaster.ScanStatus must still be CONFIRMED ----
    // Same TOCTOU gap as Commit 3, but on the replay path: PayloadJSON was already
    // built and serialized at first-attempt time, so buildTransfer311Payload_'s
    // re-check never runs here. A pallet's status can still change (excluded,
    // reverted, superseded) between the original dead-letter capture and this
    // replay. Fail-closed: missing row = reject. The DL row's PalletID column
    // actually holds txnId for this path (see captureDeadLetter_ callers), so the
    // real ParentPalletID must be resolved via TransferLog first.
    var ss = getSpreadsheet_();
    var tlReplaySh = ss.getSheetByName(TL_SHEET);
    if (!tlReplaySh || tlReplaySh.getLastRow() < 2) {
      throw new Error('TransferLog sheet empty or missing — cannot verify ScanStatus for TxnID: ' + txnId);
    }
    var tlReplayData = tlReplaySh.getDataRange().getValues();
    var tlReplayHdrClean = tlReplayData[0].map(function(h) { return String(h).trim(); });
    var tlReplayIdx = tlHeaderIdx_(tlReplayHdrClean);
    var tlReplayTxnCol = tlReplayIdx['TxnID'];
    var tlReplayParentCol = tlReplayIdx['ParentPalletID'];
    var replayParentPalletId = '';
    if (tlReplayTxnCol !== undefined) {
      for (var t = 1; t < tlReplayData.length; t++) {
        if (String(tlReplayData[t][tlReplayTxnCol] || '').trim() === txnId) {
          replayParentPalletId = String(tlReplayData[t][tlReplayParentCol] || '').trim();
          break;
        }
      }
    }
    if (!replayParentPalletId) {
      throw new Error('TransferLog row not found for TxnID: ' + txnId +
        ' — cannot verify ScanStatus');
    }

    var pmReplaySh = ss.getSheetByName(PM_SHEET);
    if (!pmReplaySh || pmReplaySh.getLastRow() < 2) {
      throw new Error('PalletMaster sheet empty or missing — cannot verify ScanStatus for ' + replayParentPalletId);
    }
    var pmReplayData = pmReplaySh.getDataRange().getValues();
    var pmReplayHdrClean = pmReplayData[0].map(function(h) { return String(h).trim(); });
    var pmReplayIdx = tlHeaderIdx_(pmReplayHdrClean);
    var pmReplayPidCol = pmReplayIdx['PalletID'];
    var pmReplayStatusCol = pmReplayIdx['ScanStatus'];
    var replayScanStatus = null;
    if (pmReplayPidCol !== undefined) {
      for (var q2 = 1; q2 < pmReplayData.length; q2++) {
        if (String(pmReplayData[q2][pmReplayPidCol] || '').trim() === replayParentPalletId) {
          replayScanStatus = String(pmReplayData[q2][pmReplayStatusCol] || '').trim();
          break;
        }
      }
    }
    if (replayScanStatus === null) {
      throw new Error('PalletMaster row not found for ParentPalletID: ' + replayParentPalletId +
        ' — cannot verify ScanStatus');
    }
    if (replayScanStatus !== 'CONFIRMED') {
      throw new Error('ParentPalletID ' + replayParentPalletId + ' ScanStatus is "' + replayScanStatus +
        '", expected CONFIRMED — pallet status changed since dead-letter was captured');
    }

    var result = postTransfer311WithRetry_(payload, txnId);
    var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");

    if (result.status === 'ALREADY_POSTED' || result.status === 'POSTED_ON_RETRY' ||
        result.status === 'POSTED_LATE') {
      sh.getRange(rowNum, idx['ReplayStatus'] + 1).setValue('RESOLVED_ALREADY_POSTED');
      sh.getRange(rowNum, idx['ReplayedAt'] + 1).setValue(now);
      sh.getRange(rowNum, idx['ReplayNote'] + 1)
        .setValue('Readback found doc=' + (result.doc || '') + ' status=' + result.status);
      logEvent('TRANSFER311_DL', 'REPLAY_HEALED', dlid + ' doc=' + (result.doc || ''));
      return { ok: true, status: 'RESOLVED', message: 'SAP has doc ' + (result.doc || '') };
    }

    if (result.ok && result.status === 'POSTED') {
      sh.getRange(rowNum, idx['ReplayStatus'] + 1).setValue('REPLAYED_OK');
      sh.getRange(rowNum, idx['ReplayedAt'] + 1).setValue(now);
      sh.getRange(rowNum, idx['ReplayNote'] + 1)
        .setValue('Fresh POST doc=' + (result.doc || ''));
      logEvent('TRANSFER311_DL', 'REPLAY_OK', dlid + ' doc=' + (result.doc || ''));
      return { ok: true, status: 'REPLAYED_OK', message: 'Posted doc ' + (result.doc || '') };
    }

    if (result.status === 'DRY_RUN') {
      sh.getRange(rowNum, idx['ReplayNote'] + 1).setValue('Replay: DRY_RUN mode');
      return { ok: false, status: 'FLAG_BLOCKED', message: 'FEATURE_TRANSFER311 is DRY_RUN' };
    }

    sh.getRange(rowNum, idx['LastErrorMsg'] + 1).setValue(String(result.error || '').slice(0, 500));
    sh.getRange(rowNum, idx['ReplayNote'] + 1)
      .setValue('Replay failed: ' + (result.status || 'unknown'));
    logEvent('TRANSFER311_DL', 'REPLAY_STILL_OPEN', dlid + ' ' + (result.error || ''));
    return { ok: false, status: 'STILL_OPEN', message: result.error || 'Replay failed' };
  } catch (e) {
    logEvent('TRANSFER311_DL', 'REPLAY_ERROR', dlid + ' ' + e.message);
    return { ok: false, status: 'ERROR', message: e.message };
  }
}

/**
 * Manual reverse of a 311 material document. Checks the target's items for
 * ReversedMaterialDocument (already-cancelled guard) before calling Cancel.
 * @param {string} matDoc
 * @param {string} matDocYear
 * @return {{ok:boolean, status:string, reversalDoc?:string, message:string}}
 */
function reverseTransfer311Manual_(matDoc, matDocYear) {
  var serviceRoot = CFG.SAP_BASE_URL + CFG.SERVICES.MATERIAL_DOCUMENT;

  // ---- Already-cancelled guard ----
  var docKey = "MaterialDocument='" + matDoc + "',MaterialDocumentYear='" + matDocYear + "'";
  var checkUrl = buildSapUrl_(serviceRoot + 'A_MaterialDocumentHeader(' + docKey + ')', {
    '$expand': 'to_MaterialDocumentItem',
    '$format': 'json'
  });
  var creds = getSapCredentials_();
  var checkResp = UrlFetchApp.fetch(checkUrl, {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });

  if (checkResp.getResponseCode() >= 400) {
    return { ok: false, status: 'DOC_NOT_FOUND',
      message: 'Cannot read doc ' + matDoc + ': HTTP ' + checkResp.getResponseCode() };
  }

  var checkParsed = JSON.parse(checkResp.getContentText());
  var checkD = checkParsed.d || checkParsed;
  var items = (checkD.to_MaterialDocumentItem && checkD.to_MaterialDocumentItem.results) || [];
  for (var i = 0; i < items.length; i++) {
    var rev = String(items[i].ReversedMaterialDocument || '').trim();
    if (rev) {
      return { ok: false, status: 'ALREADY_CANCELLED',
        message: 'Doc ' + matDoc + ' already cancelled — ReversedMaterialDocument=' + rev };
    }
  }

  // ---- Cancel ----
  var result = reverseMaterialDocByRef_(matDoc, matDocYear);
  if (!result.ok) {
    return { ok: false, status: 'CANCEL_FAILED',
      message: 'Cancel HTTP ' + result.http + ': ' + (result.body || '') };
  }

  logEvent('TRANSFER311', 'MANUAL_REVERSE', matDoc + ' → ' + result.reversalDoc);
  return { ok: true, status: 'CANCELLED', reversalDoc: result.reversalDoc,
    message: 'Cancelled → reversal doc ' + result.reversalDoc + '/' + result.reversalYear };
}

// ============================================================================
// T4 — Tests (injectable, self-cleaning, no real SAP writes)
// ============================================================================

function TEST_t311_stableTokenAcrossRetries() {
  var fn = 'TEST_t311_stableTokenAcrossRetries';
  var txnId = 'ZZTEST-STABLE-TOKEN-001';
  var expectedToken = txnId.replace(/-/g, '').slice(0, 24);
  var capturedTokens = [];
  var postCallCount = 0;

  var fakePost = function(payload) {
    postCallCount++;
    capturedTokens.push(payload.MaterialDocumentHeaderText);
    if (postCallCount === 1) throw new Error('SAP Transfer 311 POST failed HTTP 503: fake transient');
    return { code: 201, body: '{}', doc: 'FAKE001', year: '2026' };
  };
  var rbCall = 0;
  var fakeReadback = function() {
    rbCall++;
    if (rbCall >= 4) return { found: true, materialDocument: 'FAKE001', materialDocumentYear: '2026' };
    return { found: false };
  };
  var fakeSleep = function() {};

  var payload = { MaterialDocumentHeaderText: expectedToken, to_MaterialDocumentItem: [] };
  var saved = PropertiesService.getScriptProperties().getProperty('FEATURE_TRANSFER311');
  PropertiesService.getScriptProperties().setProperty('FEATURE_TRANSFER311', 'LIVE');

  var pass = true;
  var detail = '';
  try {
    var r = postTransfer311WithRetry_(payload, txnId,
      { readbackFn: fakeReadback, postFn: fakePost, sleepFn: fakeSleep });

    if (capturedTokens.length < 2) {
      pass = false; detail += 'postCalls=' + capturedTokens.length + '(expected>=2) ';
    } else {
      var allSame = capturedTokens.every(function(t) { return t === expectedToken; });
      if (!allSame) {
        pass = false; detail += 'tokens diverged: ' + JSON.stringify(capturedTokens) + ' ';
      } else {
        detail += 'tokens stable across ' + capturedTokens.length + ' attempts OK ';
      }
    }
  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }
  finally { PropertiesService.getScriptProperties().setProperty('FEATURE_TRANSFER311', saved || 'DRY_RUN'); }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

function TEST_t311_readbackFirstPreventsDoublePost() {
  var fn = 'TEST_t311_readbackFirstPreventsDoublePost';
  var postCalled = false;

  var fakeReadback = function() {
    return { found: true, materialDocument: 'EXISTING_DOC', materialDocumentYear: '2026' };
  };
  var fakePost = function() { postCalled = true; return { code: 201, doc: 'X', year: '2026' }; };

  var pass = true;
  var detail = '';
  try {
    var r = postTransfer311WithRetry_({}, 'ZZTEST-RB-FIRST-001',
      { readbackFn: fakeReadback, postFn: fakePost, sleepFn: function(){} });

    if (postCalled) { pass = false; detail += 'POST was called despite readback.found=true '; }
    else { detail += 'no POST issued OK '; }

    if (r.status !== 'ALREADY_POSTED') { pass = false; detail += 'status=' + r.status + '(expected ALREADY_POSTED) '; }
    else { detail += 'status=ALREADY_POSTED OK '; }

    if (r.doc !== 'EXISTING_DOC') { pass = false; detail += 'doc=' + r.doc + ' '; }
    else { detail += 'doc=EXISTING_DOC OK '; }
  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

function TEST_t311_ambiguousTimeoutReadsBackBeforeRetry() {
  var fn = 'TEST_t311_ambiguousTimeoutReadsBackBeforeRetry';
  var postCount = 0;
  var rbSequence = [];

  var rbCall = 0;
  var fakeReadback = function() {
    rbCall++;
    rbSequence.push('rb' + rbCall);
    if (rbCall === 1) return { found: false };
    return { found: true, materialDocument: 'TIMEOUT_DOC', materialDocumentYear: '2026' };
  };
  var fakePost = function() {
    postCount++;
    throw new Error('network timeout — no HTTP code');
  };

  var saved = PropertiesService.getScriptProperties().getProperty('FEATURE_TRANSFER311');
  PropertiesService.getScriptProperties().setProperty('FEATURE_TRANSFER311', 'LIVE');

  var pass = true;
  var detail = '';
  try {
    var r = postTransfer311WithRetry_({}, 'ZZTEST-TIMEOUT-001',
      { readbackFn: fakeReadback, postFn: fakePost, sleepFn: function(){} });

    if (postCount !== 1) { pass = false; detail += 'postCount=' + postCount + '(expected 1) '; }
    else { detail += 'postCount=1 OK '; }

    if (r.status !== 'POSTED_ON_RETRY') { pass = false; detail += 'status=' + r.status + ' '; }
    else { detail += 'status=POSTED_ON_RETRY OK '; }

    if (rbCall < 2) { pass = false; detail += 'rbCalls=' + rbCall + '(expected>=2) '; }
    else { detail += 'readback-before-retry confirmed (' + rbCall + ' calls) OK '; }
  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }
  finally { PropertiesService.getScriptProperties().setProperty('FEATURE_TRANSFER311', saved || 'DRY_RUN'); }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

function TEST_t311_unknownStateNeverReposts() {
  var fn = 'TEST_t311_unknownStateNeverReposts';

  var fakeReadback = function() { return { found: false }; };
  var postCount = 0;
  var fakePost = function() {
    postCount++;
    throw new Error('network timeout — no HTTP code');
  };

  var saved = PropertiesService.getScriptProperties().getProperty('FEATURE_TRANSFER311');
  PropertiesService.getScriptProperties().setProperty('FEATURE_TRANSFER311', 'LIVE');

  var pass = true;
  var detail = '';
  try {
    var r = postTransfer311WithRetry_({}, 'ZZTEST-UNKNOWN-001',
      { readbackFn: fakeReadback, postFn: fakePost, sleepFn: function(){} });

    if (r.status !== 'UNKNOWN_STATE') {
      pass = false; detail += 'status=' + r.status + '(expected UNKNOWN_STATE) ';
    } else { detail += 'status=UNKNOWN_STATE OK '; }

    if (postCount !== T311_MAX_ATTEMPTS_) {
      pass = false; detail += 'postCount=' + postCount + '(expected ' + T311_MAX_ATTEMPTS_ + ') ';
    } else { detail += 'postCount=' + postCount + ' OK '; }
  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }
  finally { PropertiesService.getScriptProperties().setProperty('FEATURE_TRANSFER311', saved || 'DRY_RUN'); }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

function TEST_t311_deadLetterRowShape() {
  var fn = 'TEST_t311_deadLetterRowShape';
  var TEST_TXNID = 'ZZTEST-DL-SHAPE-001';

  var fakeReadback = function() { return { found: false }; };
  var fakePost = function() { throw new Error('SAP Transfer 311 POST failed HTTP 400: fake business error'); };

  var saved = PropertiesService.getScriptProperties().getProperty('FEATURE_TRANSFER311');
  PropertiesService.getScriptProperties().setProperty('FEATURE_TRANSFER311', 'LIVE');

  var pass = true;
  var detail = '';
  try {
    postTransfer311WithRetry_({ test: true }, TEST_TXNID,
      { readbackFn: fakeReadback, postFn: fakePost, sleepFn: function(){} });

    // Read DL sheet for the row we just wrote
    var sh = getSpreadsheet_().getSheetByName(DL_SHEET_);
    if (!sh) { pass = false; detail += 'DL sheet missing '; }
    else {
      var data = sh.getDataRange().getValues();
      var hdr = data[0];
      var idx = {};
      hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

      var found = false;
      for (var r = data.length - 1; r >= 1; r--) {
        if (String(data[r][idx['PalletID']] || '').trim() === TEST_TXNID &&
            String(data[r][idx['Path']] || '').trim() === 'TRANSFER311') {
          found = true;
          var row = data[r];

          if (row[idx['Path']] !== 'TRANSFER311') { pass = false; detail += 'Path mismatch '; }
          else { detail += 'Path=TRANSFER311 OK '; }

          if (String(row[idx['Outcome']] || '') !== 'FAILED_PERMANENT') {
            pass = false; detail += 'Outcome=' + row[idx['Outcome']] + ' ';
          } else { detail += 'Outcome=FAILED_PERMANENT OK '; }

          if (String(row[idx['ReplayStatus']] || '') !== 'OPEN') {
            pass = false; detail += 'ReplayStatus=' + row[idx['ReplayStatus']] + ' ';
          } else { detail += 'ReplayStatus=OPEN OK '; }

          var payloadStr = String(row[idx['PayloadJSON']] || '');
          try {
            var roundTrip = JSON.parse(payloadStr);
            if (roundTrip.test !== true) { pass = false; detail += 'payload round-trip fail '; }
            else { detail += 'payload JSON round-trip OK '; }
          } catch (pe) { pass = false; detail += 'PayloadJSON parse fail '; }

          var token = String(row[idx['Token']] || '').trim();
          var expected = TEST_TXNID.replace(/-/g, '').slice(0, 24);
          if (token !== expected) { pass = false; detail += 'token=' + token + '(expected ' + expected + ') '; }
          else { detail += 'token OK '; }

          break;
        }
      }
      if (!found) { pass = false; detail += 'DL row not found '; }
    }
  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }
  finally {
    PropertiesService.getScriptProperties().setProperty('FEATURE_TRANSFER311', saved || 'DRY_RUN');
    // Cleanup DL row
    try {
      var dlSh = getSpreadsheet_().getSheetByName(DL_SHEET_);
      if (dlSh) {
        var dlData = dlSh.getDataRange().getValues();
        var dlIdx = {};
        dlData[0].forEach(function(h, i) { dlIdx[String(h).trim()] = i; });
        for (var d = dlData.length - 1; d >= 1; d--) {
          if (String(dlData[d][dlIdx['PalletID']] || '').trim() === TEST_TXNID) {
            dlSh.deleteRow(d + 1);
          }
        }
      }
    } catch (ce) { Logger.log(fn + ' cleanup error: ' + ce.message); }
  }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

/**
 * Regression test (Commit 4 fix): replayTransfer311DeadLetter_ re-reads
 * PalletMaster.ScanStatus fresh before replaying a stored payload. Mirrors
 * TEST_buildPayload_rejectsStaleScanStatus, but seeds a DeadLetter row with an
 * already-serialized PayloadJSON (per TEST_t311_deadLetterRowShape's fixture
 * shape) instead of calling buildTransfer311Payload_ — this path replays a
 * payload built before the pallet's status went stale, so Commit 3's build-time
 * check never runs here.
 */
function TEST_t311_replayRejectsStaleScanStatus() {
  var fn = 'TEST_t311_replayRejectsStaleScanStatus';
  var TEST_TXNID = 'ZZTEST-DL-STALESTATUS-001';
  var TEST_PARENT = 'ZZTEST-DL-STALE-PARENT';
  var TEST_DLID = 'DL-ZZTEST-STALESTATUS-001';

  // Seed a TransferLog row — replayTransfer311DeadLetter_ must resolve
  // ParentPalletID from here since the DL row's own PalletID column holds txnId.
  var ss   = getSpreadsheet_();
  var tlSh = ss.getSheetByName(TL_SHEET);
  if (!tlSh) throw new Error(fn + ': TransferLog sheet missing');
  var tlHdr = tlSh.getRange(1, 1, 1, tlSh.getLastColumn()).getValues()[0];
  var tlIdx = {};
  tlHdr.forEach(function(h, i) { tlIdx[String(h).trim()] = i; });

  var tlSeedRow = new Array(tlHdr.length).fill('');
  tlSeedRow[tlIdx['TxnID']]          = TEST_TXNID;
  tlSeedRow[tlIdx['TxnType']]        = 'SPLIT_ISSUE';
  tlSeedRow[tlIdx['Status']]         = 'PENDING';
  tlSeedRow[tlIdx['Material']]       = 'ZZTEST-MAT-STALE';
  tlSeedRow[tlIdx['IssueQty']]       = 1;
  tlSeedRow[tlIdx['Unit']]           = 'PC';
  tlSeedRow[tlIdx['SourceSLoc']]     = 'PW30';
  tlSeedRow[tlIdx['Batch']]          = '0000099999';
  tlSeedRow[tlIdx['ParentPalletID']] = TEST_PARENT;
  tlSeedRow[tlIdx['CreatedAt']]      = new Date().toISOString();
  tlSeedRow[tlIdx['IdempotencyKey']] = TEST_TXNID;
  tlSh.appendRow(tlSeedRow);

  // Seed a PalletMaster row with a NON-CONFIRMED ScanStatus — same stand-in
  // (QC_COMPLETE) used by TEST_buildPayload_rejectsStaleScanStatus for "pallet
  // reverted/excluded/superseded after the original attempt was dead-lettered".
  var pmSh = ss.getSheetByName(PM_SHEET);
  if (!pmSh) throw new Error(fn + ': PalletMaster sheet missing');
  var pmHdr = pmSh.getRange(1, 1, 1, pmSh.getLastColumn()).getValues()[0];
  var pmIdx = {};
  pmHdr.forEach(function(h, i) { pmIdx[String(h).trim()] = i; });

  var pmSeedRow = new Array(pmHdr.length).fill('');
  pmSeedRow[pmIdx['PalletID']]   = TEST_PARENT;
  pmSeedRow[pmIdx['Batch']]      = '0000099999';
  pmSeedRow[pmIdx['Material']]   = 'ZZTEST-MAT-STALE';
  pmSeedRow[pmIdx['ScanStatus']] = 'QC_COMPLETE';
  pmSh.appendRow(pmSeedRow);

  // Seed a DeadLetter row directly (per TEST_t311_deadLetterRowShape's fixture
  // shape) — PalletID column holds TxnID for TRANSFER311 rows, ReplayStatus=OPEN
  // so replayTransfer311DeadLetter_ will act on it.
  var dlSh = ensureDeadLetterSheet_();
  var dlIdx = {};
  DL_HEADERS_.forEach(function(h, i) { dlIdx[h] = i; });
  var dlSeedRow = DL_HEADERS_.map(function(h) {
    switch (h) {
      case 'DLID':          return TEST_DLID;
      case 'CapturedAt':    return new Date();
      case 'Path':          return 'TRANSFER311';
      case 'PalletID':      return TEST_TXNID;
      case 'Outcome':       return 'FAILED_PERMANENT';
      case 'Attempts':      return 3;
      case 'LastErrorClass': return 'BUSINESS';
      case 'PayloadJSON':   return JSON.stringify({ test: true });
      case 'Token':         return TEST_TXNID.replace(/-/g, '').slice(0, 24);
      case 'ReplayStatus':  return 'OPEN';
      default:              return '';
    }
  });
  dlSh.appendRow(dlSeedRow);
  SpreadsheetApp.flush();

  var pass = true;
  var detail = '';

  try {
    // FIXED (Commit 4): replayTransfer311DeadLetter_ now re-reads
    // PalletMaster.ScanStatus fresh before replaying and must reject a pallet
    // that is no longer CONFIRMED.
    var result = replayTransfer311DeadLetter_(TEST_DLID);

    if (result.ok) {
      pass = false;
      detail += 'UNEXPECTED SUCCESS: replay accepted despite ScanStatus=QC_COMPLETE (gap NOT closed) ';
    } else if (!/ScanStatus/i.test(result.message || '')) {
      pass = false;
      detail += 'rejected, but not for the expected ScanStatus reason: ' + result.message + ' ';
    } else {
      detail += 'REJECTED as expected: status=' + result.status + ' ' + result.message + ' ';
    }

    // The row should remain OPEN — a stale-status rejection is a pre-flight
    // validation failure, not a replay outcome, so it must not be marked
    // resolved/replayed (same convention as the WRONG_PATH/INVALID guards above).
    var dlData = dlSh.getDataRange().getValues();
    var stillOpen = false;
    for (var d = 1; d < dlData.length; d++) {
      if (String(dlData[d][dlIdx['DLID']] || '').trim() === TEST_DLID) {
        stillOpen = String(dlData[d][dlIdx['ReplayStatus']] || '').trim() === 'OPEN';
        break;
      }
    }
    if (!stillOpen) {
      pass = false; detail += 'ReplayStatus was mutated on rejection (expected to remain OPEN) ';
    } else {
      detail += 'ReplayStatus remained OPEN OK ';
    }
  } catch (e) {
    pass = false;
    detail += 'UNEXPECTED EXCEPTION (replay should return, not throw, past its own try/catch): ' + e.message;
  } finally {
    // Cleanup TransferLog
    try {
      var cleanTl = tlSh.getDataRange().getValues();
      for (var t2 = cleanTl.length - 1; t2 >= 1; t2--) {
        if (String(cleanTl[t2][tlIdx['TxnID']] || '').trim() === TEST_TXNID) {
          tlSh.deleteRow(t2 + 1);
        }
      }
    } catch (ce) { Logger.log(fn + ' TL cleanup: ' + ce.message); }

    // Cleanup PalletMaster
    try {
      var cleanPm = pmSh.getDataRange().getValues();
      for (var p2 = cleanPm.length - 1; p2 >= 1; p2--) {
        if (String(cleanPm[p2][pmIdx['PalletID']] || '').trim() === TEST_PARENT) {
          pmSh.deleteRow(p2 + 1);
        }
      }
    } catch (ce2) { Logger.log(fn + ' PM cleanup: ' + ce2.message); }

    // Cleanup DeadLetter
    try {
      var cleanDl = dlSh.getDataRange().getValues();
      for (var d2 = cleanDl.length - 1; d2 >= 1; d2--) {
        if (String(cleanDl[d2][dlIdx['DLID']] || '').trim() === TEST_DLID) {
          dlSh.deleteRow(d2 + 1);
        }
      }
    } catch (ce3) { Logger.log(fn + ' DL cleanup: ' + ce3.message); }
  }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

function TEST_t311_doubleCancelGuard() {
  var fn = 'TEST_t311_doubleCancelGuard';
  var pass = true;
  var detail = '';

  // We can't easily mock the UrlFetchApp.fetch inside reverseTransfer311Manual_
  // without real SAP. Instead, test the guard logic: call with a known-cancelled
  // doc. Doc 4900215913 was cancelled (ReversedMaterialDocument=4900215914).
  // If the doc exists on this tenant and is cancelled, the guard should refuse.
  // If the doc doesn't exist (test environment), we accept DOC_NOT_FOUND as a
  // valid guard response (can't cancel what you can't read).
  try {
    var r = reverseTransfer311Manual_('4900215913', '2026');
    if (r.status === 'ALREADY_CANCELLED') {
      detail += 'status=ALREADY_CANCELLED OK (guard works) ';
    } else if (r.status === 'DOC_NOT_FOUND') {
      detail += 'status=DOC_NOT_FOUND (doc not readable — guard still safe) ';
    } else if (r.status === 'CANCELLED') {
      pass = false;
      detail += 'FAIL: guard allowed double-cancel! reversal=' + r.reversalDoc + ' ';
    } else {
      detail += 'status=' + r.status + ' ' + r.message + ' ';
    }
  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

function TEST_t311_runAll() {
  var fn = 'TEST_t311_runAll';
  var t0 = Date.now();
  var tests = [
    { name: 'stableTokenAcrossRetries',                run: TEST_t311_stableTokenAcrossRetries },
    { name: 'readbackFirstPreventsDoublePost',         run: TEST_t311_readbackFirstPreventsDoublePost },
    { name: 'ambiguousTimeoutReadsBackBeforeRetry',    run: TEST_t311_ambiguousTimeoutReadsBackBeforeRetry },
    { name: 'unknownStateNeverReposts',                run: TEST_t311_unknownStateNeverReposts },
    { name: 'deadLetterRowShape',                      run: TEST_t311_deadLetterRowShape },
    { name: 'replayRejectsStaleScanStatus',            run: TEST_t311_replayRejectsStaleScanStatus },
    { name: 'doubleCancelGuard',                       run: TEST_t311_doubleCancelGuard }
  ];

  var results = [];
  tests.forEach(function(t) {
    try {
      var verdict = t.run();
      results.push({ name: t.name, ok: verdict !== false });
    }
    catch (e) { results.push({ name: t.name, ok: false, error: e.message }); }
  });

  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  var allPass = results.every(function(r) { return r.ok; });
  Logger.log(fn + ': ' + (allPass ? 'ALL PASS' : 'SOME FAILED') +
    ' (' + (Date.now() - t0) + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name + (r.error ? ' — ' + r.error : ''));
  });
  Logger.log('──────────────────────────────────────────');

  logEvent(fn, 'Transfer311', allPass ? 'PASS' : 'FAIL', Date.now() - t0,
    results.length + ' tests');

  SpreadsheetApp.getUi().alert(
    'T4 Test Suite: ' + (allPass ? 'ALL PASS ✅' : 'SOME FAILED ❌') + '\n\n' +
    results.map(function(r) {
      return (r.ok ? '✅ ' : '❌ ') + r.name + (r.error ? ' — ' + r.error : '');
    }).join('\n') + '\n\nDetails in Executions log.');
}

// ============================================================================
// T5 — TEST: confirmTransfer311 orchestrator wiring
// ============================================================================

/**
 * Self-cleaning test: seeds a ZZTEST TransferLog row, calls confirmTransfer311
 * with injected fakes (via a temporary override of globals) to verify:
 *   (a) it calls postTransfer311WithRetry_ (not bare poster)
 *   (b) on POSTED → writes MaterialDocument/Year to TransferLog by name
 *   (c) on UNKNOWN_STATE → does NOT write a success doc
 *   (d) returns plain-JSON (no Date, no Java array)
 */
function TEST_confirmTransfer311_orchestration() {
  var fn = 'TEST_confirmTransfer311_orchestration';
  var TEST_TXNID = 'ZZTEST-ORCH-001';
  var t0 = Date.now();

  // ---- Seed a TransferLog row ----
  var ss   = getSpreadsheet_();
  var tlSh = ss.getSheetByName(TL_SHEET);
  if (!tlSh) throw new Error(fn + ': TransferLog sheet missing');
  var tlHdr = tlSh.getRange(1, 1, 1, tlSh.getLastColumn()).getValues()[0];
  var tlIdx = {};
  tlHdr.forEach(function(h, i) { tlIdx[String(h).trim()] = i; });

  var seedRow = new Array(tlHdr.length).fill('');
  seedRow[tlIdx['TxnID']]          = TEST_TXNID;
  seedRow[tlIdx['TxnType']]        = 'SPLIT_ISSUE';
  seedRow[tlIdx['Status']]         = 'PENDING';
  seedRow[tlIdx['Material']]       = 'ZZTEST-MAT';
  seedRow[tlIdx['IssueQty']]       = 1;
  seedRow[tlIdx['Unit']]           = 'PC';
  seedRow[tlIdx['SourceSLoc']]     = 'PW30';
  seedRow[tlIdx['Batch']]          = '0000099999';
  seedRow[tlIdx['CreatedAt']]      = new Date().toISOString();
  seedRow[tlIdx['IdempotencyKey']] = TEST_TXNID;
  tlSh.appendRow(seedRow);
  SpreadsheetApp.flush();

  var pass = true;
  var detail = '';

  // Save originals for monkey-patch
  var origWithRetry = postTransfer311WithRetry_;
  var origBuildPayload = buildTransfer311Payload_;

  try {
    // ---- SUB-TEST A: POSTED path — verify wrapper called + writeback ----
    var wrapperCalled = false;
    var capturedTxnId = '';

    // Monkey-patch to intercept
    postTransfer311WithRetry_ = function(payload, txnId) {
      wrapperCalled = true;
      capturedTxnId = txnId;
      return { ok: true, status: 'POSTED', doc: 'FAKEDOC001', year: '2026' };
    };
    buildTransfer311Payload_ = function() { return { test: true }; };

    var r1 = confirmTransfer311(TEST_TXNID, 'PW40');

    if (!wrapperCalled) { pass = false; detail += 'A: wrapper NOT called '; }
    else { detail += 'A:wrapperCalled OK '; }

    if (capturedTxnId !== TEST_TXNID) {
      pass = false; detail += 'A:txnId=' + capturedTxnId + ' ';
    }

    if (!r1.success) { pass = false; detail += 'A:success=false '; }
    if (r1.materialDocument !== 'FAKEDOC001') {
      pass = false; detail += 'A:doc=' + r1.materialDocument + ' ';
    } else { detail += 'A:doc=FAKEDOC001 OK '; }

    // Check TransferLog writeback
    SpreadsheetApp.flush();
    var tlAfter = tlSh.getDataRange().getValues();
    var wroteDoc = false;
    for (var r = 1; r < tlAfter.length; r++) {
      if (String(tlAfter[r][tlIdx['TxnID']] || '').trim() === TEST_TXNID) {
        var status = String(tlAfter[r][tlIdx['Status']] || '').trim();
        var refDoc = String(tlAfter[r][tlIdx['RefDoc']] || '').trim();
        if (status === 'TRANSFERRED' && refDoc === 'FAKEDOC001') wroteDoc = true;
        break;
      }
    }
    if (!wroteDoc) { pass = false; detail += 'A:writeback missing '; }
    else { detail += 'A:writeback OK '; }

    // Reset row for sub-test B
    for (var r2 = 1; r2 < tlAfter.length; r2++) {
      if (String(tlAfter[r2][tlIdx['TxnID']] || '').trim() === TEST_TXNID) {
        tlSh.getRange(r2 + 1, tlIdx['Status'] + 1).setValue('PENDING');
        tlSh.getRange(r2 + 1, tlIdx['RefDoc'] + 1).setValue('');
        break;
      }
    }
    SpreadsheetApp.flush();

    // ---- SUB-TEST B: UNKNOWN_STATE — no success doc written ----
    postTransfer311WithRetry_ = function() {
      return { ok: false, status: 'UNKNOWN_STATE', error: 'simulated timeout' };
    };

    var r2result = confirmTransfer311(TEST_TXNID, 'PW40');

    if (r2result.success) { pass = false; detail += 'B:success=true(expected false) '; }
    else { detail += 'B:success=false OK '; }

    SpreadsheetApp.flush();
    var tlAfter2 = tlSh.getDataRange().getValues();
    for (var r3 = 1; r3 < tlAfter2.length; r3++) {
      if (String(tlAfter2[r3][tlIdx['TxnID']] || '').trim() === TEST_TXNID) {
        var status2 = String(tlAfter2[r3][tlIdx['Status']] || '').trim();
        var refDoc2 = String(tlAfter2[r3][tlIdx['RefDoc']] || '').trim();
        if (status2 === 'TRANSFERRED') {
          pass = false; detail += 'B:status=TRANSFERRED(should NOT be) ';
        } else { detail += 'B:noFalseTransfer OK '; }
        if (refDoc2 && refDoc2 !== 'FAKEDOC001') {
          pass = false; detail += 'B:refDoc=' + refDoc2 + ' ';
        } else { detail += 'B:noFalseDoc OK '; }
        break;
      }
    }

    // ---- SUB-TEST C: plain-JSON return (no Date, no Java array) ----
    postTransfer311WithRetry_ = function() {
      return { ok: true, status: 'DRY_RUN', doc: null, year: null };
    };
    // Reset status again
    for (var r4 = 1; r4 < tlAfter2.length; r4++) {
      if (String(tlAfter2[r4][tlIdx['TxnID']] || '').trim() === TEST_TXNID) {
        tlSh.getRange(r4 + 1, tlIdx['Status'] + 1).setValue('PENDING');
        tlSh.getRange(r4 + 1, tlIdx['RefDoc'] + 1).setValue('');
        break;
      }
    }
    SpreadsheetApp.flush();

    var r3result = confirmTransfer311(TEST_TXNID, 'PW40');
    var jsonStr = JSON.stringify(r3result);
    try {
      var parsed = JSON.parse(jsonStr);
      if (typeof parsed !== 'object') { pass = false; detail += 'C:not object '; }
      else { detail += 'C:plainJSON OK '; }
    } catch (pe) { pass = false; detail += 'C:JSON parse fail '; }

  } catch (e) {
    pass = false;
    detail += 'EXCEPTION: ' + e.message;
  } finally {
    // Restore originals
    postTransfer311WithRetry_ = origWithRetry;
    buildTransfer311Payload_ = origBuildPayload;

    // Cleanup test TransferLog row
    try {
      var cleanData = tlSh.getDataRange().getValues();
      for (var d = cleanData.length - 1; d >= 1; d--) {
        if (String(cleanData[d][tlIdx['TxnID']] || '').trim() === TEST_TXNID) {
          tlSh.deleteRow(d + 1);
        }
      }
    } catch (ce) { Logger.log(fn + ' cleanup: ' + ce.message); }
  }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', Date.now() - t0, detail);
}

// ============================================================================
// Seed / cleanup helpers — editor-run, self-cleaning, NO UrlFetchApp
// ============================================================================

/**
 * Seed ONE TransferLog row for DRY_RUN test. Append-only — no SAP.
 * @return {string} the seeded TxnID
 */
function TEST_seedTransferLogForDryRun() {
  var sh = ensureTransferLogSheet_();
  var txnId = 'DRYRUN-TEST-0001';

  var rowObj = {};
  rowObj['TxnID']          = txnId;
  rowObj['TxnType']        = 'SPLIT_ISSUE';
  rowObj['Status']         = 'PENDING';
  rowObj['Material']       = 'STT1001-A0200S3XRX';
  rowObj['IssueQty']       = 10;
  rowObj['Unit']           = 'PC';
  rowObj['SourceSLoc']     = 'PW30';
  rowObj['DestSLoc']       = '';
  rowObj['ParentPalletID'] = 'PL-1000035032-L01';
  rowObj['CreatedAt']      = new Date().toISOString();
  rowObj['IdempotencyKey'] = txnId;

  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var sheetRow = hdr.map(function (h) { return rowObj[h] !== undefined ? rowObj[h] : ''; });
  sh.getRange(sh.getLastRow() + 1, 1, 1, sheetRow.length).setValues([sheetRow]);

  logEvent('TRANSFER311_SEED', TL_SHEET, 'OK', 0, txnId);
  Logger.log('Seeded TransferLog row: ' + txnId);
  return txnId;
}

/**
 * Remove any TransferLog rows whose TxnID starts with 'DRYRUN-TEST-'.
 * Header-map based — safe regardless of column order.
 */
function TEST_cleanupTransferLogDryRun() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(TL_SHEET);
  if (!sh || sh.getLastRow() < 2) return;

  var data = sh.getDataRange().getValues();
  var idx  = tlHeaderIdx_(data[0]);
  var col  = idx['TxnID'];
  if (col === undefined) return;

  var deleted = 0;
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][col] || '').indexOf('DRYRUN-TEST-') === 0) {
      sh.deleteRow(r + 1);
      deleted++;
    }
  }

  logEvent('TRANSFER311_SEED', TL_SHEET, 'CLEANUP', 0, deleted + ' rows deleted');
  Logger.log('Cleaned up ' + deleted + ' DRYRUN-TEST-* rows');
}

// ============================================================================
// Test runner — editor-run, self-cleaning, NO UrlFetchApp
// ============================================================================

/**
 * DRY_RUN test: seed → build → log → cleanup.
 * Writes pretty JSON to scratch sheet '_DryRun311' for inspection.
 * Does NOT call UrlFetchApp — build only.
 */
function TEST_dryRunTransfer311() {
  var txnId    = TEST_seedTransferLogForDryRun();
  var destSloc = CFG.DEST_SLOCS[0];

  try {
    var payload = buildTransfer311Payload_(txnId, destSloc);
    var json    = JSON.stringify(payload, null, 2);
    Logger.log(json);

    var ss = getSpreadsheet_();
    var diagSheet = ss.getSheetByName('_DryRun311');
    if (diagSheet) ss.deleteSheet(diagSheet);
    diagSheet = ss.insertSheet('_DryRun311');
    diagSheet.getRange(1, 1).setValue('Transfer 311 DRY_RUN — OK').setFontWeight('bold');
    diagSheet.getRange(2, 1).setValue('TxnID: ' + txnId);
    diagSheet.getRange(3, 1).setValue('DestSLoc: ' + destSloc);
    diagSheet.getRange(4, 1).setValue('Timestamp: ' +
      Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss"));
    var lines = json.split('\n');
    for (var i = 0; i < lines.length; i++) {
      diagSheet.getRange(6 + i, 1).setValue(lines[i]);
    }
    diagSheet.autoResizeColumn(1);

    logEvent('TRANSFER311_DRYRUN', '_DryRun311', 'OK', 0, txnId);
  } catch (e) {
    logEvent('TRANSFER311_DRYRUN', '_DryRun311', 'ERROR', 0, e.message);
    throw e;
  } finally {
    TEST_cleanupTransferLogDryRun();
  }
}

/**
 * Test postTransfer311_ in DRY_RUN mode — no SAP POST.
 * Ensures FEATURE_TRANSFER311 = 'DRY_RUN', seeds, calls, asserts, cleans up.
 */
function TEST_postTransfer311DryRunMode() {
  var txnId  = TEST_seedTransferLogForDryRun();
  var props  = PropertiesService.getScriptProperties();
  var saved  = props.getProperty('FEATURE_TRANSFER311');

  try {
    props.setProperty('FEATURE_TRANSFER311', 'DRY_RUN');

    var result = postTransfer311_(txnId, CFG.DEST_SLOCS[0]);

    if (!result.dryRun) {
      throw new Error('Expected dryRun=true, got false');
    }
    if (result.materialDocument !== 'DRY_RUN') {
      throw new Error('Expected materialDocument=DRY_RUN, got ' + result.materialDocument);
    }

    Logger.log('TEST_postTransfer311DryRunMode PASSED');
    Logger.log(JSON.stringify(result, null, 2));
  } finally {
    if (saved === null) {
      props.deleteProperty('FEATURE_TRANSFER311');
    } else {
      props.setProperty('FEATURE_TRANSFER311', saved);
    }
    TEST_cleanupTransferLogDryRun();
  }
}

// ============================================================================
// Web App API — called by google.script.run from Scanner.html (transfer mode)
// ============================================================================

/**
 * Look up a TransferLog row by TxnID and return display info for the scanner UI.
 * @param {string} txnId
 * @return {Object} slip info or {error:...}
 */
function getTransferSlipInfo(txnId) {
  try {
    txnId = String(txnId || '').trim();
    if (!txnId) return { error: 'TxnID ว่าง' };

    var ss = getSpreadsheet_();
    var tlSh = ss.getSheetByName(TL_SHEET);
    if (!tlSh || tlSh.getLastRow() < 2) return { error: 'TransferLog ว่าง' };

    var tlData = tlSh.getDataRange().getValues();
    var tlIdx  = tlHeaderIdx_(tlData[0]);

    var txnRow = null;
    for (var r = 1; r < tlData.length; r++) {
      if (String(tlData[r][tlIdx['TxnID']] || '').trim() === txnId) {
        txnRow = {};
        TL_HEADERS.forEach(function (h) {
          if (tlIdx[h] !== undefined) txnRow[h] = tlData[r][tlIdx[h]];
        });
        break;
      }
    }

    if (!txnRow) return { error: 'ไม่พบ TxnID: ' + txnId };

    if (String(txnRow['Status'] || '').trim() === 'TRANSFERRED') {
      return {
        error: 'already_transferred',
        refDoc: String(txnRow['RefDoc'] || '').trim(),
        destSloc: String(txnRow['DestSLoc'] || '').trim()
      };
    }

    var flag = PropertiesService.getScriptProperties()
      .getProperty('FEATURE_TRANSFER311') || 'DRY_RUN';

    return JSON.parse(JSON.stringify({
      txnId:           txnId,
      material:        String(txnRow['Material'] || '').trim(),
      issueQty:        Number(txnRow['IssueQty']) || 0,
      unit:            String(txnRow['Unit'] || '').trim(),
      sourceSLoc:      String(txnRow['SourceSLoc'] || '').trim(),
      lotNo:           String(txnRow['LotNo'] || '').trim(),
      batch:           String(txnRow['Batch'] || '').trim(),
      status:          String(txnRow['Status'] || '').trim(),
      destSLocOptions: CFG.DEST_SLOCS,
      dryRun:          flag !== 'LIVE'
    }));

  } catch (e) {
    logError('getTransferSlipInfo', TL_SHEET, e.message, txnId);
    return { error: 'เกิดข้อผิดพลาด: ' + e.message };
  }
}

/**
 * Execute a 311 transfer posting from the scanner UI. Orchestrator:
 *   1. TransferLog idempotency check (already TRANSFERRED → skip)
 *   2. Build payload via buildTransfer311Payload_
 *   3. POST via postTransfer311WithRetry_ (hardened: readback-first, retry,
 *      dead-letter, stable-token)
 *   4. Write back to TransferLog on success
 *
 * @param {string} txnId — stable TxnID from TransferLog (never regenerated)
 * @param {string} destSloc — destination StorageLocation
 * @return {{success:boolean, materialDocument?:string, materialDocumentYear?:string,
 *           dryRun?:boolean, error?:string}}
 */
function confirmTransfer311(txnId, destSloc) {
  try {
    txnId    = String(txnId || '').trim();
    destSloc = String(destSloc || '').trim();
    if (!txnId)    return { success: false, error: 'TxnID ว่าง' };
    if (!destSloc) return { success: false, error: 'กรุณาเลือกปลายทาง' };

    // ---- 1. TransferLog row lookup + idempotency ----
    var ss   = getSpreadsheet_();
    var tlSh = ss.getSheetByName(TL_SHEET);
    if (!tlSh || tlSh.getLastRow() < 2) {
      return { success: false, error: 'TransferLog sheet empty or missing' };
    }
    var tlData = tlSh.getDataRange().getValues();
    var tlIdx  = tlHeaderIdx_(tlData[0]);

    var txnRowNum = -1;
    for (var r = 1; r < tlData.length; r++) {
      if (String(tlData[r][tlIdx['TxnID']] || '').trim() === txnId) {
        txnRowNum = r + 1;
        break;
      }
    }
    if (txnRowNum === -1) {
      return { success: false, error: 'TxnID not found in TransferLog: ' + txnId };
    }

    var curStatus = String(tlData[txnRowNum - 1][tlIdx['Status']] || '').trim();
    if (curStatus === 'TRANSFERRED') {
      var existingDoc = String(tlData[txnRowNum - 1][tlIdx['RefDoc']] || '').trim();
      logEvent('TRANSFER311', TL_SHEET, 'SKIP_IDEMPOTENT', 0, txnId);
      return JSON.parse(JSON.stringify(
        { success: true, materialDocument: existingDoc, dryRun: false }));
    }

    // ---- 2. Build payload ----
    var payload = buildTransfer311Payload_(txnId, destSloc);

    // ---- 3. POST via hardened wrapper ----
    var result = postTransfer311WithRetry_(payload, txnId);

    // ---- 4. Write back to TransferLog based on outcome ----
    var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");

    if (result.ok && result.status !== 'DRY_RUN') {
      tlSh.getRange(txnRowNum, tlIdx['Status'] + 1).setValue('TRANSFERRED');
      if (tlIdx['DestSLoc'] !== undefined) {
        tlSh.getRange(txnRowNum, tlIdx['DestSLoc'] + 1).setValue(destSloc);
      }
      if (tlIdx['RefDoc'] !== undefined) {
        tlSh.getRange(txnRowNum, tlIdx['RefDoc'] + 1).setValue(result.doc || '');
      }
      if (tlIdx['Note'] !== undefined) {
        tlSh.getRange(txnRowNum, tlIdx['Note'] + 1)
          .setValue('MT311 ' + result.status + ' ' + (result.doc || '') +
            '/' + (result.year || ''));
      }
      if (tlIdx['UpdatedAt'] !== undefined) {
        tlSh.getRange(txnRowNum, tlIdx['UpdatedAt'] + 1).setValue(now);
      }
      logEvent('TRANSFER311', TL_SHEET, result.status, 0,
        txnId + ' → ' + (result.doc || ''));

      return JSON.parse(JSON.stringify({
        success: true,
        materialDocument: result.doc || '',
        materialDocumentYear: result.year || '',
        dryRun: false
      }));
    }

    if (result.status === 'DRY_RUN') {
      logEvent('TRANSFER311', TL_SHEET, 'DRY_RUN', 0, txnId);
      return JSON.parse(JSON.stringify({
        success: true, materialDocument: 'DRY_RUN', dryRun: true
      }));
    }

    // UNKNOWN_STATE / FAILED_PERMANENT — do NOT write success doc
    if (tlIdx['Note'] !== undefined) {
      tlSh.getRange(txnRowNum, tlIdx['Note'] + 1)
        .setValue('MT311 ' + result.status + ': ' + (result.error || '').slice(0, 200));
    }
    if (tlIdx['UpdatedAt'] !== undefined) {
      tlSh.getRange(txnRowNum, tlIdx['UpdatedAt'] + 1).setValue(now);
    }
    logEvent('TRANSFER311', TL_SHEET, result.status, 0,
      txnId + ' ' + (result.error || ''));

    return JSON.parse(JSON.stringify({
      success: false, error: result.error || result.status
    }));

  } catch (e) {
    logError('confirmTransfer311', TL_SHEET, e.message, txnId + '→' + destSloc);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// LIVE test seeder + runner — permanent row, no auto-cleanup
// ============================================================================

/** Seed ONE TransferLog row for a real LIVE 311 POST test. */
function TEST_seedRealTransferLogRow() {
  var sh = ensureTransferLogSheet_();
  var txnId = 'LIVE-TEST-' + Date.now();

  var rowObj = {};
  rowObj['TxnID']          = txnId;
  rowObj['TxnType']        = 'SPLIT_ISSUE';
  rowObj['Status']         = 'PENDING';
  rowObj['Material']       = 'STT5001-L0100S3XRX';
  rowObj['IssueQty']       = 1;
  rowObj['Unit']           = 'PC';
  rowObj['SourceSLoc']     = 'PW30';
  rowObj['DestSLoc']       = '';
  rowObj['ParentPalletID'] = 'PL-1000035032-L01';
  rowObj['Batch']          = '0000036391';
  rowObj['CreatedAt']      = new Date().toISOString();
  rowObj['IdempotencyKey'] = txnId;

  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var batchCol = -1;
  for (var c = 0; c < hdr.length; c++) {
    if (hdr[c] === 'Batch') { batchCol = c; break; }
  }
  var sheetRow = hdr.map(function (h) { return rowObj[h] !== undefined ? rowObj[h] : ''; });
  var newRow = sh.getLastRow() + 1;
  sh.getRange(newRow, 1, 1, sheetRow.length).setValues([sheetRow]);
  if (batchCol >= 0) {
    sh.getRange(newRow, batchCol + 1).setNumberFormat('@');
    sh.getRange(newRow, batchCol + 1).setValue(rowObj['Batch']);
  }

  Logger.log('Seeded LIVE test row: ' + txnId);
  return txnId;
}

/** Seed + POST a real 311 transfer to SAP. Requires FEATURE_TRANSFER311 = 'LIVE'. */
function TEST_runLiveTransfer311() {
  var txnId = TEST_seedRealTransferLogRow();
  Logger.log('About to POST 311 LIVE for TxnID: ' + txnId);

  var result = postTransfer311_(txnId, 'PW40');
  Logger.log(JSON.stringify(result, null, 2));

  if (result.success) {
    Logger.log('SAP MatDoc: ' + result.materialDocument);
  }
}

// ============================================================================
// Phase 5 — TEST: transfer 311 readback stamp + guard
// ============================================================================

/**
 * Self-cleaning test for the 311 SAP readback guard (Phase 5 item 2b).
 * Seeds a TransferLog row, verifies payload stamping + readback behaviour, cleans up.
 * Calls SAP GET (read-only) — never POSTs.
 */
function TEST_transfer311ReadbackStamp() {
  var fn = 'TEST_transfer311ReadbackStamp';
  var t0 = Date.now();

  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' ' + fn);
  Logger.log('══════════════════════════════════════════');

  var pass = true;
  var results = [];

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    Logger.log((ok ? '✅' : '❌') + ' ' + name + (detail ? ' — ' + detail : ''));
    if (!ok) pass = false;
  }

  // ---- Seed a TransferLog row for payload test ----
  var txnId = TEST_seedTransferLogForDryRun();

  try {
    // ---- (1) Payload stamp ----
    var payload = buildTransfer311Payload_(txnId, CFG.DEST_SLOCS[0]);
    var expectedToken = txnId.replace(/-/g, '').slice(0, 24);

    assert('(1) payload has MaterialDocumentHeaderText',
      payload.MaterialDocumentHeaderText !== undefined,
      'value=' + (payload.MaterialDocumentHeaderText || '(absent)'));

    assert('(1) token matches expected derivation',
      payload.MaterialDocumentHeaderText === expectedToken,
      'got=' + payload.MaterialDocumentHeaderText + ' expected=' + expectedToken);

    assert('(1) token length ≤ 25',
      (payload.MaterialDocumentHeaderText || '').length <= 25,
      'len=' + (payload.MaterialDocumentHeaderText || '').length);

    assert('(1) seeded token length ≤ 24',
      (payload.MaterialDocumentHeaderText || '').length <= 24,
      'len=' + (payload.MaterialDocumentHeaderText || '').length);

    // ---- (1b) Production-realistic UUID derivation ----
    var u = Utilities.getUuid();
    var t = u.replace(/-/g, '').slice(0, 24);
    assert('(1b) UUID-derived token is exactly 24 chars',
      t.length === 24,
      'uuid=' + u + ' token=' + t + ' len=' + t.length);

    assert('(1b) UUID derivation is deterministic',
      t === u.replace(/-/g, '').substring(0, 24),
      'slice vs substring match');

    // ---- (2) sapReadbackTransfer311_ — no-hit probe ----
    var rb = sapReadbackTransfer311_('000000000000000000000000');
    assert('(2) readback no-hit — found:false',
      rb.found === false,
      'found=' + rb.found + (rb.error ? ' error=' + rb.error : ''));

    assert('(2) readback no-hit — no throw (graceful)',
      true, 'reached this line without exception');

  } finally {
    TEST_cleanupTransferLogDryRun();
    Logger.log('Cleaned up DRYRUN-TEST-* rows');
  }

  var elapsed = Date.now() - t0;
  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  Logger.log(fn + ': ' + (pass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name);
  });
  Logger.log('──────────────────────────────────────────');

  logEvent('TEST_T311_RB', 'Transfer311', pass ? 'PASS' : 'FAIL', elapsed,
    results.length + ' assertions');
}

// ============================================================================
// Tests — resolveBatchFromGrDoc_ + tier-3 wiring (injectable, no real SAP)
// ============================================================================

function TEST_resolveBatch_singleItem() {
  var fn = 'TEST_resolveBatch_singleItem';
  var fakeFetch = function() {
    return {
      getResponseCode: function() { return 200; },
      getContentText: function() {
        return JSON.stringify({ d: {
          to_MaterialDocumentItem: { results: [
            { Material: 'MAT001', GoodsMovementType: '101', Batch: '0000094815',
              Plant: '1100', StorageLocation: 'PW30', QuantityInEntryUnit: '10' }
          ] }
        } });
      }
    };
  };

  var result = resolveBatchFromGrDoc_('4900214455', '2026', 'MAT001', { fetchFn: fakeFetch });
  var pass = result === '0000094815';
  var detail = 'result=' + result + (pass ? ' OK' : ' EXPECTED 0000094815');
  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

function TEST_resolveBatch_ambiguous() {
  var fn = 'TEST_resolveBatch_ambiguous';
  var fakeFetch = function() {
    return {
      getResponseCode: function() { return 200; },
      getContentText: function() {
        return JSON.stringify({ d: {
          to_MaterialDocumentItem: { results: [
            { Material: 'MAT001', GoodsMovementType: '101', Batch: '0000094815',
              Plant: '1100', StorageLocation: 'PW30', QuantityInEntryUnit: '5' },
            { Material: 'MAT001', GoodsMovementType: '101', Batch: '0000099999',
              Plant: '1100', StorageLocation: 'PW30', QuantityInEntryUnit: '5' }
          ] }
        } });
      }
    };
  };

  var result = resolveBatchFromGrDoc_('4900214455', '2026', 'MAT001', { fetchFn: fakeFetch });
  var pass = result === '';
  var detail = 'result="' + result + '"' + (pass ? ' (empty=OK, no guess)' : ' EXPECTED empty');
  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

function TEST_resolveBatch_noGrDoc() {
  var fn = 'TEST_resolveBatch_noGrDoc';
  var fetchCalled = false;
  var fakeFetch = function() { fetchCalled = true; return { getResponseCode: function() { return 200; }, getContentText: function() { return '{}'; } }; };

  var result = resolveBatchFromGrDoc_('', '2026', 'MAT001', { fetchFn: fakeFetch });
  var pass = result === '' && !fetchCalled;
  var detail = 'result="' + result + '" fetchCalled=' + fetchCalled +
    (pass ? ' OK' : ' EXPECTED empty+noFetch');
  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

function TEST_resolveBatch_preservesLeadingZeros() {
  var fn = 'TEST_resolveBatch_preservesLeadingZeros';
  var fakeFetch = function() {
    return {
      getResponseCode: function() { return 200; },
      getContentText: function() {
        return JSON.stringify({ d: {
          to_MaterialDocumentItem: { results: [
            { Material: 'MAT001', GoodsMovementType: '101', Batch: '0000094815',
              Plant: '1100', StorageLocation: 'PW30', QuantityInEntryUnit: '10' }
          ] }
        } });
      }
    };
  };

  var result = resolveBatchFromGrDoc_('4900214455', '2026', 'MAT001', { fetchFn: fakeFetch });
  var pass = result === '0000094815' && typeof result === 'string';
  var detail = 'result=' + result + ' type=' + typeof result +
    (pass ? ' (string with leading zeros OK)' : ' EXPECTED string "0000094815"');
  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

function TEST_buildPayload_tier3() {
  var fn = 'TEST_buildPayload_tier3';
  var TEST_TXNID = 'ZZTEST-TIER3-001';

  // Seed a TransferLog row with empty Batch + a ParentPalletID
  var ss   = getSpreadsheet_();
  var tlSh = ss.getSheetByName(TL_SHEET);
  if (!tlSh) throw new Error(fn + ': TransferLog sheet missing');
  var tlHdr = tlSh.getRange(1, 1, 1, tlSh.getLastColumn()).getValues()[0];
  var tlIdx = {};
  tlHdr.forEach(function(h, i) { tlIdx[String(h).trim()] = i; });

  var seedRow = new Array(tlHdr.length).fill('');
  seedRow[tlIdx['TxnID']]          = TEST_TXNID;
  seedRow[tlIdx['TxnType']]        = 'SPLIT_ISSUE';
  seedRow[tlIdx['Status']]         = 'PENDING';
  seedRow[tlIdx['Material']]       = 'ZZTEST-MAT-T3';
  seedRow[tlIdx['IssueQty']]       = 1;
  seedRow[tlIdx['Unit']]           = 'PC';
  seedRow[tlIdx['SourceSLoc']]     = 'PW30';
  seedRow[tlIdx['Batch']]          = '';
  seedRow[tlIdx['ParentPalletID']] = 'ZZTEST-PARENT-T3';
  seedRow[tlIdx['CreatedAt']]      = new Date().toISOString();
  seedRow[tlIdx['IdempotencyKey']] = TEST_TXNID;
  tlSh.appendRow(seedRow);

  // Seed a PalletMaster row with GRMaterialDocument but empty Batch
  var pmSh = ss.getSheetByName(PM_SHEET);
  if (!pmSh) throw new Error(fn + ': PalletMaster sheet missing');
  var pmHdr = pmSh.getRange(1, 1, 1, pmSh.getLastColumn()).getValues()[0];
  var pmIdx = {};
  pmHdr.forEach(function(h, i) { pmIdx[String(h).trim()] = i; });

  var pmSeedRow = new Array(pmHdr.length).fill('');
  pmSeedRow[pmIdx['PalletID']]                 = 'ZZTEST-PARENT-T3';
  pmSeedRow[pmIdx['Batch']]                    = '';
  pmSeedRow[pmIdx['GRMaterialDocument']]       = 'FAKE_GR_001';
  pmSeedRow[pmIdx['GRMaterialDocumentYear']]   = '2026';
  pmSeedRow[pmIdx['Material']]                 = 'ZZTEST-MAT-T3';
  pmSeedRow[pmIdx['ScanStatus']]               = 'CONFIRMED';
  pmSh.appendRow(pmSeedRow);
  SpreadsheetApp.flush();

  // Monkey-patch resolveBatchFromGrDoc_ to return known batch
  var origResolve = resolveBatchFromGrDoc_;
  var pass = true;
  var detail = '';

  try {
    resolveBatchFromGrDoc_ = function(grDoc, grYear, mat, opts) {
      if (grDoc === 'FAKE_GR_001' && grYear === '2026' && mat === 'ZZTEST-MAT-T3') {
        return '0000094815';
      }
      return '';
    };

    var payload = buildTransfer311Payload_(TEST_TXNID, CFG.DEST_SLOCS[0]);
    var items = payload.to_MaterialDocumentItem || [];
    var batchInPayload = items.length > 0 ? (items[0].Batch || '') : '';

    if (batchInPayload !== '0000094815') {
      pass = false;
      detail += 'Batch=' + batchInPayload + '(expected 0000094815) ';
    } else {
      detail += 'tier3 batch=0000094815 in payload OK ';
    }
  } catch (e) {
    pass = false;
    detail += 'EXCEPTION: ' + e.message;
  } finally {
    resolveBatchFromGrDoc_ = origResolve;

    // Cleanup TransferLog
    try {
      var cleanTl = tlSh.getDataRange().getValues();
      for (var d = cleanTl.length - 1; d >= 1; d--) {
        if (String(cleanTl[d][tlIdx['TxnID']] || '').trim() === TEST_TXNID) {
          tlSh.deleteRow(d + 1);
        }
      }
    } catch (ce) { Logger.log(fn + ' TL cleanup: ' + ce.message); }

    // Cleanup PalletMaster
    try {
      var cleanPm = pmSh.getDataRange().getValues();
      for (var d2 = cleanPm.length - 1; d2 >= 1; d2--) {
        if (String(cleanPm[d2][pmIdx['PalletID']] || '').trim() === 'ZZTEST-PARENT-T3') {
          pmSh.deleteRow(d2 + 1);
        }
      }
    } catch (ce2) { Logger.log(fn + ' PM cleanup: ' + ce2.message); }
  }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

/**
 * Regression test (Commit 3 fix): buildTransfer311Payload_ now re-reads
 * PalletMaster.ScanStatus fresh at build time. A TransferLog row can be
 * created while a pallet is CONFIRMED, but by the time the 311 payload is
 * built the pallet's ScanStatus may have moved off CONFIRMED (e.g. excluded,
 * superseded, or reverted) — this test confirms that gap is now closed.
 *
 * Asserts the FIXED behavior: payload build must REJECT (throw) when
 * ScanStatus is not CONFIRMED, even though the TransferLog row itself is
 * otherwise valid (real Batch, valid TxnType/Status).
 */
function TEST_buildPayload_rejectsStaleScanStatus() {
  var fn = 'TEST_buildPayload_rejectsStaleScanStatus';
  var TEST_TXNID = 'ZZTEST-STALESTATUS-001';

  // Seed a TransferLog row with a real Batch (tier-1) — no GR-doc resolution needed.
  var ss   = getSpreadsheet_();
  var tlSh = ss.getSheetByName(TL_SHEET);
  if (!tlSh) throw new Error(fn + ': TransferLog sheet missing');
  var tlHdr = tlSh.getRange(1, 1, 1, tlSh.getLastColumn()).getValues()[0];
  var tlIdx = {};
  tlHdr.forEach(function(h, i) { tlIdx[String(h).trim()] = i; });

  var seedRow = new Array(tlHdr.length).fill('');
  seedRow[tlIdx['TxnID']]          = TEST_TXNID;
  seedRow[tlIdx['TxnType']]        = 'SPLIT_ISSUE';
  seedRow[tlIdx['Status']]         = 'PENDING';
  seedRow[tlIdx['Material']]       = 'ZZTEST-MAT-STALE';
  seedRow[tlIdx['IssueQty']]       = 1;
  seedRow[tlIdx['Unit']]           = 'PC';
  seedRow[tlIdx['SourceSLoc']]     = 'PW30';
  seedRow[tlIdx['Batch']]          = '0000099999';
  seedRow[tlIdx['ParentPalletID']] = 'ZZTEST-PARENT-STALE';
  seedRow[tlIdx['CreatedAt']]      = new Date().toISOString();
  seedRow[tlIdx['IdempotencyKey']] = TEST_TXNID;
  tlSh.appendRow(seedRow);

  // Seed a PalletMaster row with a NON-CONFIRMED ScanStatus. QC_COMPLETE is the
  // lifecycle step immediately before CONFIRMED (CREATED → SCANNED → PD_COMPLETE
  // → QC_COMPLETE → CONFIRMED — see PHASE3_README.md), so it's the realistic
  // stand-in for "not actually confirmed" — e.g. a pallet reverted, excluded, or
  // superseded after this TransferLog row was already created against it.
  var pmSh = ss.getSheetByName(PM_SHEET);
  if (!pmSh) throw new Error(fn + ': PalletMaster sheet missing');
  var pmHdr = pmSh.getRange(1, 1, 1, pmSh.getLastColumn()).getValues()[0];
  var pmIdx = {};
  pmHdr.forEach(function(h, i) { pmIdx[String(h).trim()] = i; });

  var pmSeedRow = new Array(pmHdr.length).fill('');
  pmSeedRow[pmIdx['PalletID']]   = 'ZZTEST-PARENT-STALE';
  pmSeedRow[pmIdx['Batch']]      = '0000099999';
  pmSeedRow[pmIdx['Material']]   = 'ZZTEST-MAT-STALE';
  pmSeedRow[pmIdx['ScanStatus']] = 'QC_COMPLETE';
  pmSh.appendRow(pmSeedRow);
  SpreadsheetApp.flush();

  var pass = true;
  var detail = '';

  try {
    // FIXED (Commit 3): buildTransfer311Payload_ now re-reads PalletMaster.ScanStatus
    // fresh at build time and must reject a pallet that is no longer CONFIRMED.
    buildTransfer311Payload_(TEST_TXNID, CFG.DEST_SLOCS[0]);
    pass = false;
    detail += 'UNEXPECTED SUCCESS: payload built despite ScanStatus=QC_COMPLETE (gap NOT closed) ';
  } catch (e) {
    if (/ScanStatus/i.test(e.message)) {
      detail += 'REJECTED as expected: ' + e.message + ' ';
    } else {
      pass = false;
      detail += 'threw, but not for the expected ScanStatus reason: ' + e.message + ' ';
    }
  } finally {
    // Cleanup TransferLog
    try {
      var cleanTl = tlSh.getDataRange().getValues();
      for (var d = cleanTl.length - 1; d >= 1; d--) {
        if (String(cleanTl[d][tlIdx['TxnID']] || '').trim() === TEST_TXNID) {
          tlSh.deleteRow(d + 1);
        }
      }
    } catch (ce) { Logger.log(fn + ' TL cleanup: ' + ce.message); }

    // Cleanup PalletMaster
    try {
      var cleanPm = pmSh.getDataRange().getValues();
      for (var d2 = cleanPm.length - 1; d2 >= 1; d2--) {
        if (String(cleanPm[d2][pmIdx['PalletID']] || '').trim() === 'ZZTEST-PARENT-STALE') {
          pmSh.deleteRow(d2 + 1);
        }
      }
    } catch (ce2) { Logger.log(fn + ' PM cleanup: ' + ce2.message); }
  }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'Transfer311', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

function TEST_resolveBatch_runAll() {
  var fn = 'TEST_resolveBatch_runAll';
  var t0 = Date.now();
  var tests = [
    { name: 'singleItem',            run: TEST_resolveBatch_singleItem },
    { name: 'ambiguous',             run: TEST_resolveBatch_ambiguous },
    { name: 'noGrDoc',               run: TEST_resolveBatch_noGrDoc },
    { name: 'preservesLeadingZeros', run: TEST_resolveBatch_preservesLeadingZeros },
    { name: 'buildPayload_tier3',    run: TEST_buildPayload_tier3 },
    { name: 'buildPayload_rejectsStaleScanStatus', run: TEST_buildPayload_rejectsStaleScanStatus }
  ];

  var results = [];
  tests.forEach(function(t) {
    try {
      var verdict = t.run();
      results.push({ name: t.name, ok: verdict !== false });
    }
    catch (e) { results.push({ name: t.name, ok: false, error: e.message }); }
  });

  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  var allPass = results.every(function(r) { return r.ok; });
  Logger.log(fn + ': ' + (allPass ? 'ALL PASS' : 'SOME FAILED') +
    ' (' + (Date.now() - t0) + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name + (r.error ? ' — ' + r.error : ''));
  });
  Logger.log('──────────────────────────────────────────');

  logEvent(fn, 'Transfer311', allPass ? 'PASS' : 'FAIL', Date.now() - t0,
    results.length + ' tests');

  SpreadsheetApp.getUi().alert(
    'Batch Resolution Test Suite: ' + (allPass ? 'ALL PASS ✅' : 'SOME FAILED ❌') + '\n\n' +
    results.map(function(r) {
      return (r.ok ? '✅ ' : '❌ ') + r.name + (r.error ? ' — ' + r.error : '');
    }).join('\n') + '\n\nDetails in Executions log.');
}

// ============================================================================
// Manual Reversal — editor wrapper (Part 1) + menu entry (Part 2)
// ============================================================================

/**
 * One-shot editor wrapper: reverse the specific dangling first-live transfer doc
 * 4900216057/2026. Hardcoded — run once from the menu or editor, then retire.
 * WRITES to SAP (Cancel FunctionImport). Guard inside reverseTransfer311Manual_
 * prevents double-cancel.
 */
function REVERSE_firstLiveDoc() {
  var matDoc = '4900216057';
  var matDocYear = '2026';
  var result = reverseTransfer311Manual_(matDoc, matDocYear);
  Logger.log('REVERSE result: ' + JSON.stringify(result));
  SpreadsheetApp.getUi().alert(
    'Reverse 4900216057/2026\n\n' +
    'status: ' + result.status + '\n' +
    (result.reversalDoc ? 'reversal doc: ' + result.reversalDoc + '\n' : '') +
    'message: ' + result.message);
  return result;
}

/**
 * Menu-driven manual reversal — prompts for MaterialDocument + Year, confirms,
 * then calls reverseTransfer311Manual_. WRITES to SAP (Cancel FunctionImport).
 */
function MENU_reverseTransfer311() {
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('Reverse Transfer 311', 'MaterialDocument number:',
    ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var matDoc = r1.getResponseText().trim();

  var r2 = ui.prompt('Reverse Transfer 311', 'MaterialDocumentYear:',
    ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var matDocYear = r2.getResponseText().trim();

  if (!matDoc || !matDocYear) { ui.alert('Missing doc/year'); return; }

  var confirm = ui.alert('Confirm Reverse',
    'Cancel material doc ' + matDoc + '/' + matDocYear + '? This posts a reversal in SAP.',
    ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  var result = reverseTransfer311Manual_(matDoc, matDocYear);
  ui.alert('Reverse result',
    'status: ' + result.status + '\n' +
    (result.reversalDoc ? 'reversal doc: ' + result.reversalDoc + '\n' : '') +
    result.message, ui.ButtonSet.OK);
}

/**
 * Transfer311.gs — Phase 4 Steps 2–3: 311 transfer posting (payload builder + live POST)
 * ========================================================================================
 * buildTransfer311Payload_() — PURE builder: reads TransferLog + PalletMaster, returns object.
 * postTransfer311_()         — gate-driven POST: CSRF, idempotency, DRY_RUN flag, writeback.
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
// Pure payload builder
// ============================================================================

/**
 * Build an OData V2 deep-insert payload for a 311 transfer posting.
 * Reads TransferLog row by TxnID and resolves batch from PalletMaster.
 * Pure function — no sheet writes, no SAP calls.
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
  if (txnType !== 'SPLIT_ISSUE') {
    throw new Error('TxnType must be SPLIT_ISSUE, got: ' + txnType);
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

  // ---- Resolve real SAP Batch: TransferLog first, PalletMaster fallback ----
  var batch = String(txnRow['Batch'] || '').trim();
  if (!batch && parentPalletId) {
    var pmSh = ss.getSheetByName(PM_SHEET);
    if (pmSh && pmSh.getLastRow() >= 2) {
      var pmData = pmSh.getDataRange().getValues();
      var pmIdx = tlHeaderIdx_(pmData[0]);
      var pmPidCol = pmIdx['PalletID'];
      var pmBatchCol = pmIdx['Batch'];
      if (pmPidCol !== undefined && pmBatchCol !== undefined) {
        for (var p = 1; p < pmData.length; p++) {
          if (String(pmData[p][pmPidCol] || '').trim() === parentPalletId) {
            batch = String(pmData[p][pmBatchCol] || '').trim();
            break;
          }
        }
      }
    }
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
 * Post a 311 transfer to SAP for the given TransferLog TxnID.
 * Gate: ScriptProperties FEATURE_TRANSFER311 ('DRY_RUN'|'LIVE'; default 'DRY_RUN').
 * Idempotent: skips if Status already TRANSFERRED.
 *
 * @param {string} txnId
 * @param {string} destSloc
 * @return {{success:boolean, materialDocument:string, materialDocumentYear?:string,
 *           dryRun:boolean, error?:string}}
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
 * Execute a 311 transfer posting from the scanner UI.
 * Delegates to postTransfer311_ which handles DRY_RUN/LIVE gate + idempotency.
 * @param {string} txnId
 * @param {string} destSloc
 * @return {Object} result from postTransfer311_
 */
function confirmTransfer311(txnId, destSloc) {
  try {
    txnId    = String(txnId || '').trim();
    destSloc = String(destSloc || '').trim();
    if (!txnId)    return { success: false, error: 'TxnID ว่าง' };
    if (!destSloc) return { success: false, error: 'กรุณาเลือกปลายทาง' };

    var result = postTransfer311_(txnId, destSloc);
    return JSON.parse(JSON.stringify(result));

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

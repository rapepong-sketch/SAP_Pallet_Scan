/**
 * ScanTransfer.gs — Phase 3.5 Scan-to-Transfer adapter
 * =======================================================
 * Server functions for the scan-to-transfer flow: operator scans a pallet QR
 * directly (no AdminSlip), system creates a TransferLog SCAN_ISSUE row and
 * delegates posting to confirmTransfer311.
 *
 * TxnType = 'SCAN_ISSUE' distinguishes these rows from AdminSlip 'SPLIT_ISSUE'.
 *
 * Feature flag: ScriptProperty FEATURE_SCAN_TRANSFER ('OFF'|'DRY_RUN'|'LIVE').
 * Default = 'OFF'. Nothing in the UI calls these yet.
 *
 * Reuses globals from same GAS project scope (no imports needed):
 *   TL_SHEET, TL_HEADERS, tlHeaderIdx_, ensureTransferLogSheet_  (TransferLog.gs)
 *   PM_SHEET                                                      (PalletGen.gs)
 *   fetchSapBatchStockForBatches_                                 (TransferLog.gs)
 *   buildTransfer311Payload_, confirmTransfer311                  (Transfer311.gs)
 *   logEvent, logError                                            (SapClient.gs)
 *   getSpreadsheet_                                               (SheetSetup.gs)
 *   CFG                                                           (Config.gs)
 */

// ============================================================================
// Private helpers
// ============================================================================

/**
 * Read one PalletMaster row by PalletID using header-map (never positional index).
 * @param {string} palletId
 * @return {{row:Object}|null}
 * @private
 */
function _readPmRow_(palletId) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;

  var data   = sh.getDataRange().getValues();
  var idx    = tlHeaderIdx_(data[0]);
  var pidCol = idx['PalletID'];
  if (pidCol === undefined) return null;

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][pidCol] || '').trim() === palletId) {
      var row = {};
      data[0].forEach(function (h, i) { row[h] = data[r][i]; });
      return { row: row };
    }
  }
  return null;
}

// ============================================================================
// scanTransferLookup — READ-ONLY, no writes, no flag gate
// ============================================================================

/**
 * Look up a pallet for the scan-to-transfer flow. Validates CONFIRMED status and
 * performs a live SAP batch-stock pre-check. Read-only — safe to call repeatedly.
 *
 * Batch resolution: tier-1 only (PalletMaster.Batch). Tier-2/3 fallback happens
 * inside buildTransfer311Payload_ at confirm time — not duplicated here.
 *
 * @param {string} palletId
 * @return {{ok:boolean, error?:string, palletId?:string, mo?:string,
 *   material?:string, batch?:string, qty?:number, unit?:string,
 *   workCenter?:string, sourceSLoc?:string, sapStock?:number}}
 */
function scanTransferLookup(palletId) {
  try {
    palletId = String(palletId || '').trim();
    if (!palletId) {
      return JSON.parse(JSON.stringify({ ok: false, error: 'PalletID ว่าง' }));
    }

    var found = _readPmRow_(palletId);
    if (!found) {
      logEvent('SCAN_TRANSFER', 'scanTransferLookup', 'NOT_FOUND', 0, palletId);
      return JSON.parse(JSON.stringify({
        ok: false, error: 'พาเลทยังไม่ confirmed หรือไม่พบ'
      }));
    }

    var pm         = found.row;
    var scanStatus = String(pm['ScanStatus']          || '').trim();
    if (scanStatus !== 'CONFIRMED') {
      logEvent('SCAN_TRANSFER', 'scanTransferLookup', 'NOT_CONFIRMED', 0,
        palletId + ' status=' + scanStatus);
      return JSON.parse(JSON.stringify({
        ok: false, error: 'พาเลทยังไม่ confirmed หรือไม่พบ'
      }));
    }

    var material   = String(pm['Material']           || '').trim();
    var batch      = String(pm['Batch']              || '').trim();
    var qty        = Number(pm['QtyPerPallet'])       || 0;
    var unit       = String(pm['Unit']               || '').trim();
    var workCenter = String(pm['WorkCenter']          || '').trim();
    var sourceSLoc = String(pm['StorageLocation']     || '').trim();
    var mo         = String(pm['ManufacturingOrder']  || '').trim();

    var sapStock = 0;
    if (batch) {
      var stockMap = fetchSapBatchStockForBatches_(
        material, CFG.PLANT, sourceSLoc, [batch]);
      sapStock = stockMap[batch] || 0;
      if (sapStock <= 0) {
        logEvent('SCAN_TRANSFER', 'scanTransferLookup', 'STOCK_ZERO', 0,
          palletId + ' batch=' + batch + ' sloc=' + sourceSLoc);
        return JSON.parse(JSON.stringify({
          ok: false,
          error: 'SAP stock = 0 สำหรับ batch=' + batch + ' ที่ ' + sourceSLoc +
                 ' — ไม่สามารถโอนย้ายได้'
        }));
      }
    }
    // batch='' → skip stock check; tier-2/3 resolves in buildTransfer311Payload_

    logEvent('SCAN_TRANSFER', 'scanTransferLookup', 'OK', 0,
      palletId + ' material=' + material + ' batch=' + (batch || '(empty)') +
      ' sapStock=' + sapStock + ' qty=' + qty);

    return JSON.parse(JSON.stringify({
      ok:         true,
      palletId:   palletId,
      mo:         mo,
      material:   material,
      batch:      batch,
      qty:        qty,
      unit:       unit,
      workCenter: workCenter,
      sourceSLoc: sourceSLoc,
      sapStock:   sapStock
    }));

  } catch (e) {
    logError('scanTransferLookup', 'SCAN_TRANSFER', e.message, palletId);
    return JSON.parse(JSON.stringify({ ok: false, error: e.message }));
  }
}

// ============================================================================
// scanTransferConfirm — WRITE, flag-gated
// ============================================================================

/**
 * Confirm a scan-to-transfer for a pallet. Re-validates CONFIRMED status and
 * live SAP stock, then creates (or reuses) a TransferLog SCAN_ISSUE row and
 * delegates the SAP 311 POST to confirmTransfer311.
 *
 * Double-tap guard: if a non-terminal SCAN_ISSUE row for this pallet already
 * exists in TransferLog, reuses its TxnID rather than creating a duplicate.
 * Terminal statuses that do NOT block a new row: TRANSFERRED, REVERSED, DEAD.
 *
 * DRY_RUN self-cleans its seeded row so the sheet stays tidy during testing.
 *
 * NOTE: buildTransfer311Payload_ currently rejects TxnType != 'SPLIT_ISSUE'.
 * DRY_RUN surfaces this as buildErr. A follow-up commit must relax that guard
 * before LIVE is viable. Flag stays OFF until then.
 *
 * @param {string} palletId
 * @param {string} destSloc
 * @return {{ok:boolean, dryRun?:boolean, materialDocument?:string,
 *           materialDocumentYear?:string, txnId?:string,
 *           payloadPreview?:Object, error?:string}}
 */
function scanTransferConfirm(palletId, destSloc) {
  try {
    palletId = String(palletId || '').trim();
    destSloc = String(destSloc || '').trim();

    // ---- Flag gate ----
    var flag = PropertiesService.getScriptProperties()
      .getProperty('FEATURE_SCAN_TRANSFER') || 'OFF';
    if (flag === 'OFF') {
      return JSON.parse(JSON.stringify({
        ok: false, error: 'FEATURE_SCAN_TRANSFER=OFF'
      }));
    }

    if (!palletId) {
      return JSON.parse(JSON.stringify({ ok: false, error: 'PalletID ว่าง' }));
    }
    if (!destSloc) {
      return JSON.parse(JSON.stringify({ ok: false, error: 'กรุณาเลือกปลายทาง' }));
    }

    // ---- Re-run lookup guards ----
    var found = _readPmRow_(palletId);
    if (!found) {
      return JSON.parse(JSON.stringify({
        ok: false, error: 'พาเลทยังไม่ confirmed หรือไม่พบ'
      }));
    }

    var pm         = found.row;
    var scanStatus = String(pm['ScanStatus']         || '').trim();
    if (scanStatus !== 'CONFIRMED') {
      return JSON.parse(JSON.stringify({
        ok: false, error: 'พาเลทยังไม่ confirmed หรือไม่พบ'
      }));
    }

    var material   = String(pm['Material']          || '').trim();
    var batch      = String(pm['Batch']             || '').trim();
    var qty        = Number(pm['QtyPerPallet'])      || 0;
    var unit       = String(pm['Unit']              || '').trim();
    var sourceSLoc = String(pm['StorageLocation']   || '').trim();
    // LotNo mirrors getConfirmedStockByMaterial_: batch if known, else palletId
    var lotNo      = batch ? batch : palletId;

    if (destSloc === sourceSLoc) {
      return JSON.parse(JSON.stringify({
        ok: false, error: 'ปลายทางตรงกับต้นทาง (' + destSloc + ')'
      }));
    }

    // Stock re-check — guard against stale lookup result
    if (batch) {
      var stockMap = fetchSapBatchStockForBatches_(
        material, CFG.PLANT, sourceSLoc, [batch]);
      var sapStock = stockMap[batch] || 0;
      if (sapStock <= 0) {
        logEvent('SCAN_TRANSFER', 'scanTransferConfirm', 'STOCK_ZERO', 0,
          palletId + ' batch=' + batch + ' sloc=' + sourceSLoc);
        return JSON.parse(JSON.stringify({
          ok: false,
          error: 'SAP stock = 0 สำหรับ batch=' + batch + ' ที่ ' + sourceSLoc
        }));
      }
    }

    // ---- Double-tap guard ----
    var ss   = getSpreadsheet_();
    var tlSh = ss.getSheetByName(TL_SHEET) || ensureTransferLogSheet_();
    var txnId       = null;
    var newRowCreated = false;
    var TERMINAL    = { 'TRANSFERRED': true, 'REVERSED': true, 'DEAD': true };

    if (tlSh.getLastRow() >= 2) {
      var tlData    = tlSh.getDataRange().getValues();
      var tlIdx     = tlHeaderIdx_(tlData[0]);
      var colTxnId  = tlIdx['TxnID'];
      var colType   = tlIdx['TxnType'];
      var colPPid   = tlIdx['ParentPalletID'];
      var colStatus = tlIdx['Status'];

      if (colTxnId !== undefined && colType !== undefined &&
          colPPid  !== undefined && colStatus !== undefined) {
        for (var r = 1; r < tlData.length; r++) {
          if (String(tlData[r][colType]   || '').trim() === 'SCAN_ISSUE' &&
              String(tlData[r][colPPid]   || '').trim() === palletId &&
              !TERMINAL[String(tlData[r][colStatus] || '').trim()]) {
            txnId = String(tlData[r][colTxnId] || '').trim();
            logEvent('SCAN_TRANSFER', 'scanTransferConfirm', 'REUSE_TXN', 0,
              palletId + ' txnId=' + txnId);
            break;
          }
        }
      }
    }

    // ---- Create new TransferLog ISSUED row ----
    if (!txnId) {
      txnId = Utilities.getUuid();

      var now       = Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");
      var createdBy = Session.getActiveUser().getEmail();

      var sheetHdr = tlSh.getRange(1, 1, 1, tlSh.getLastColumn()).getValues()[0];

      // LotNo intentionally set '' here — written via post-appendRow cell fix below
      var rowObj = {
        TxnID:          txnId,
        PickID:         '',
        CreatedAt:      now,
        TxnType:        'SCAN_ISSUE',
        ParentPalletID: palletId,
        ChildSlipID:    '',
        Material:       material,
        LotNo:          '',
        Unit:           unit,
        IssueQty:       qty,
        SourceSLoc:     sourceSLoc,
        DestSLoc:       '',
        RefDoc:         '',
        Status:         'ISSUED',
        CreatedBy:      createdBy,
        Note:           '',
        IdempotencyKey: ''
        // Batch and UpdatedAt absent → fall through to '' via header map
      };

      var sheetRow = sheetHdr.map(function (h) {
        return rowObj[h] !== undefined ? rowObj[h] : '';
      });

      // appendRow first; leading-zero coercion on empty string is a no-op
      tlSh.appendRow(sheetRow);
      var newRowNum = tlSh.getLastRow();

      // Post-appendRow fix: force text format THEN write real lotNo string
      var lotNoColIdx = sheetHdr.indexOf('LotNo');
      if (lotNoColIdx >= 0) {
        tlSh.getRange(newRowNum, lotNoColIdx + 1)
          .setNumberFormat('@')
          .setValue(String(lotNo));
      }

      newRowCreated = true;
      logEvent('SCAN_TRANSFER', 'scanTransferConfirm', 'ROW_CREATED', 0,
        palletId + ' txnId=' + txnId);
    }

    // ---- DRY_RUN: build payload for proof, log, self-clean seeded row ----
    if (flag === 'DRY_RUN') {
      var previewPayload = null;
      var buildErr       = null;
      try {
        previewPayload = buildTransfer311Payload_(txnId, destSloc);
      } catch (be) {
        buildErr = be.message;
      }

      logEvent('SCAN_TRANSFER', 'scanTransferConfirm', 'DRY_RUN', 0,
        palletId + ' txnId=' + txnId + ' destSloc=' + destSloc +
        (buildErr ? ' buildErr=' + buildErr.slice(0, 150) : ' payload=OK'));

      if (newRowCreated) {
        try {
          var cleanData   = tlSh.getDataRange().getValues();
          var cleanIdx    = tlHeaderIdx_(cleanData[0]);
          var cleanTxnCol = cleanIdx['TxnID'];
          for (var d = cleanData.length - 1; d >= 1; d--) {
            if (String(cleanData[d][cleanTxnCol] || '').trim() === txnId) {
              tlSh.deleteRow(d + 1);
              break;
            }
          }
        } catch (ce) {
          logEvent('SCAN_TRANSFER', 'scanTransferConfirm', 'DRY_RUN_CLEANUP_ERR', 0,
            ce.message);
        }
      }

      if (buildErr) {
        return JSON.parse(JSON.stringify({
          ok: false, dryRun: true,
          error: 'DRY_RUN — payload build failed: ' + buildErr
        }));
      }

      return JSON.parse(JSON.stringify({
        ok: true, dryRun: true, txnId: txnId,
        payloadPreview: previewPayload
      }));
    }

    // ---- LIVE: delegate entirely to confirmTransfer311 ----
    var r311 = confirmTransfer311(txnId, destSloc);

    logEvent('SCAN_TRANSFER', 'scanTransferConfirm',
      r311.success ? 'LIVE_OK' : 'LIVE_FAIL', 0,
      palletId + ' txnId=' + txnId +
      ' doc=' + (r311.materialDocument || '') +
      (r311.error ? ' err=' + String(r311.error).slice(0, 150) : ''));

    var ret = {
      ok:                  !!r311.success,
      txnId:               txnId,
      materialDocument:    r311.materialDocument     || '',
      materialDocumentYear: r311.materialDocumentYear || '',
      dryRun:              false
    };
    if (r311.error) ret.error = r311.error;

    return JSON.parse(JSON.stringify(ret));

  } catch (e) {
    logError('scanTransferConfirm', 'SCAN_TRANSFER', e.message,
      palletId + '→' + destSloc);
    return JSON.parse(JSON.stringify({ ok: false, error: e.message }));
  }
}

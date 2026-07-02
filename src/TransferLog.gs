/**
 * TransferLog.gs — Phase 3.5 Step 2b
 * ====================================
 * Data layer + FIFO allocator for pallet split-issue transactions.
 * READ-ONLY on PalletMaster. Append-only to TransferLog sheet.
 * No print, no HTML, no web, no menu.
 *
 * Reuses: PM_HEADERS, PM_SHEET (PalletGen.gs), getSpreadsheet_ (SheetSetup.gs),
 *         logEvent (SapClient.gs), sapGet (SapClient.gs), buildSapUrl_ (SapClient.gs)
 *
 * SAP stock pre-filter (Phase 3.5 fix): getConfirmedStockByMaterial_ fetches live
 * unrestricted batch stock from API_MATERIAL_STOCK_SRV once per plan call and
 * filters out pallets whose batch has 0 SAP stock (stale local data). planFifoPick_
 * fails-safe — returns sapCheckError:true if the SAP check throws.
 */

// ============================================================================
// Schema
// ============================================================================

/** @const {string} */
var TL_SHEET = 'TransferLog';

/** @const {string[]} */
var TL_HEADERS = [
  'TxnID', 'PickID', 'CreatedAt', 'TxnType', 'ParentPalletID', 'ChildSlipID',
  'Material', 'Batch', 'LotNo', 'Unit', 'IssueQty', 'SourceSLoc', 'DestSLoc', 'RefDoc',
  'Status', 'CreatedBy', 'Note', 'IdempotencyKey', 'UpdatedAt'
];

// ============================================================================
// Sheet bootstrap
// ============================================================================

/**
 * Create 'TransferLog' sheet with TL_HEADERS if absent. Idempotent.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function ensureTransferLogSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(TL_SHEET);

  if (!sh) {
    sh = ss.insertSheet(TL_SHEET);
    sh.getRange(1, 1, 1, TL_HEADERS.length).setValues([TL_HEADERS]);
    sh.getRange(1, 1, 1, TL_HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#d9e2f3');
    sh.setFrozenRows(1);
    logEvent('ENSURE_SHEET', TL_SHEET, 'CREATED', 0, TL_HEADERS.length + ' cols');
    return sh;
  }

  var existingHdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var existingSet = {};
  existingHdr.forEach(function (h) { existingSet[String(h).trim()] = true; });

  var missing = TL_HEADERS.filter(function (h) { return !existingSet[h]; });
  if (missing.length > 0) {
    var startCol = existingHdr.length + 1;
    sh.getRange(1, startCol, 1, missing.length).setValues([missing]);
    sh.getRange(1, startCol, 1, missing.length)
      .setFontWeight('bold')
      .setBackground('#d9e2f3');
    logEvent('ENSURE_SHEET', TL_SHEET, 'MIGRATED', 0,
      'added ' + missing.length + ' cols: ' + missing.join(', '));
  }

  return sh;
}

// ============================================================================
// PalletMaster readers (by column NAME)
// ============================================================================

/**
 * Build column-name → index map for a header row.
 * @param {Array} hdr
 * @return {Object.<string, number>}
 */
function tlHeaderIdx_(hdr) {
  var idx = {};
  hdr.forEach(function(h, i) { idx[h] = i; });
  return idx;
}

// ============================================================================
// SAP live batch-stock reader — used by FIFO pre-filter
// ============================================================================

/** @const {string} */
var TL_MATERIAL_STOCK_SRV_ = '/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/';

/**
 * @deprecated Use fetchSapBatchStockForBatches_ — blind $top=200 scan misses
 * batches that sort beyond the window (e.g. 0000095389 fell outside 200 rows).
 * Retained only as a reference; no longer called by production code.
 */
function fetchSapBatchStock_(material, plant, storageLocation) {
  var path = TL_MATERIAL_STOCK_SRV_ + 'A_MatlStkInAcctMod';
  var filterStr = "Material eq '" + material +
    "' and Plant eq '" + plant +
    "' and StorageLocation eq '" + storageLocation + "'";

  var t0 = Date.now();
  var data = sapGet(path, {
    '$filter':  filterStr,
    '$select':  'Batch,InventoryStockType,MatlWrhsStkQtyInMatlBaseUnit',
    '$top':     '200'
  }, 'fetchSapBatchStock_');

  var rows = (data.d && data.d.results) || [];
  var batchQty = {};
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].InventoryStockType || '').trim() !== '01') continue;
    var b = String(rows[i].Batch || '').trim();
    if (!b) continue;
    var q = parseFloat(rows[i].MatlWrhsStkQtyInMatlBaseUnit) || 0;
    batchQty[b] = (batchQty[b] || 0) + q;
  }

  logEvent('FIFO', 'SAP_BATCH_STOCK_OK', 200, Date.now() - t0,
    material + '/' + storageLocation + ' batches=' + Object.keys(batchQty).length);

  return batchQty;
}

/**
 * Fetch unrestricted (InventoryStockType '01') batch stock from SAP
 * A_MatlStkInAcctMod using an OR-filter targeting ONLY the specific batches
 * the local candidates carry. Fixes the $top=200 truncation bug where SAP
 * returns rows sorted ascending by batch and live batches (e.g. 0000095389)
 * fell beyond position 200, making them invisible to the FIFO pre-filter.
 *
 * Batches are chunked at 20 per GET to keep the OData $filter URL within SAP
 * length limits. Results are merged across chunks.
 *
 * @param {string} material
 * @param {string} plant
 * @param {string} storageLocation
 * @param {string[]} batches — distinct batch strings to query (empty → returns {})
 * @return {Object.<string, number>} batch string → unrestricted qty
 * @throws {Error} on HTTP error, network failure, or JSON parse failure
 */
function fetchSapBatchStockForBatches_(material, plant, storageLocation, batches) {
  if (!batches || batches.length === 0) return {};

  var path = TL_MATERIAL_STOCK_SRV_ + 'A_MatlStkInAcctMod';
  var baseFilter = "Material eq '" + material +
    "' and Plant eq '" + plant +
    "' and StorageLocation eq '" + storageLocation + "'";

  var CHUNK = 20;
  var batchQty = {};
  var t0 = Date.now();
  var totalRows = 0;
  var chunks = Math.ceil(batches.length / CHUNK);

  for (var start = 0; start < batches.length; start += CHUNK) {
    var chunk = batches.slice(start, start + CHUNK);
    var batchClause = chunk.map(function(b) {
      return "Batch eq '" + b + "'";
    }).join(' or ');

    var data = sapGet(path, {
      '$filter': baseFilter + ' and (' + batchClause + ')',
      '$select': 'Batch,InventoryStockType,MatlWrhsStkQtyInMatlBaseUnit',
      '$top':    '200'
    }, 'fetchSapBatchStockForBatches_');

    var rows = (data.d && data.d.results) || [];
    totalRows += rows.length;

    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].InventoryStockType || '').trim() !== '01') continue;
      var b = String(rows[i].Batch || '').trim();
      if (!b) continue;
      var q = parseFloat(rows[i].MatlWrhsStkQtyInMatlBaseUnit) || 0;
      batchQty[b] = (batchQty[b] || 0) + q;
    }
  }

  logEvent('FIFO', 'SAP_BATCH_STOCK_OK', 200, Date.now() - t0,
    material + '/' + storageLocation +
    ' batches=' + batches.length +
    ' chunks=' + chunks +
    ' rows=' + totalRows +
    ' hits=' + Object.keys(batchQty).length);

  return batchQty;
}

/**
 * Compute remaining qty for a parent pallet.
 * original = QtyPerPallet from PalletMaster.
 * issued = sum(IssueQty) in TransferLog where ParentPalletID matches AND TxnType==='SPLIT_ISSUE'.
 *
 * @param {string} parentPalletId
 * @return {{original: number, issued: number, remaining: number}}
 * @throws {Error} if pallet not found in PalletMaster
 */
function getRemainingQty_(parentPalletId) {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) throw new Error('PalletMaster empty or missing');

  var pmData = sh.getDataRange().getValues();
  var pmIdx  = tlHeaderIdx_(pmData[0]);
  var pidCol = pmIdx['PalletID'];
  var qtyCol = pmIdx['QtyPerPallet'];
  if (pidCol === undefined || qtyCol === undefined) {
    throw new Error('PalletMaster missing PalletID or QtyPerPallet column');
  }

  var original = -1;
  for (var r = 1; r < pmData.length; r++) {
    if (String(pmData[r][pidCol] || '').trim() === parentPalletId) {
      original = Number(pmData[r][qtyCol]) || 0;
      break;
    }
  }
  if (original < 0) throw new Error('Pallet not found: ' + parentPalletId);

  var issued = 0;
  var tlSh = getSpreadsheet_().getSheetByName(TL_SHEET);
  if (tlSh && tlSh.getLastRow() >= 2) {
    var tlData = tlSh.getDataRange().getValues();
    var tlIdx  = tlHeaderIdx_(tlData[0]);
    var ppCol  = tlIdx['ParentPalletID'];
    var ttCol  = tlIdx['TxnType'];
    var iqCol  = tlIdx['IssueQty'];
    if (ppCol !== undefined && ttCol !== undefined && iqCol !== undefined) {
      for (var t = 1; t < tlData.length; t++) {
        if (String(tlData[t][ppCol] || '').trim() === parentPalletId &&
            String(tlData[t][ttCol] || '').trim() === 'SPLIT_ISSUE') {
          issued += Number(tlData[t][iqCol]) || 0;
        }
      }
    }
  }

  return { original: original, issued: issued, remaining: original - issued };
}

/**
 * Return CONFIRMED pallets of a given material at a specific storage location,
 * with remaining qty > 0, pre-filtered by live SAP batch stock, sorted FIFO
 * by ConfirmedAt ASC then PalletID ASC.
 *
 * SAP pre-filter: collects the distinct batches the local candidates carry, then
 * queries SAP ONLY for those specific batches via an OR-filter.
 * Avoids the $top=200 truncation bug where batches sorted beyond position 200
 * (e.g. 0000095389) were invisible. Remaining is capped at SAP qty so the plan
 * never exceeds what SAP can post.
 * Throws on SAP check failure — planFifoPick_ catches and returns sapCheckError.
 *
 * @param {string} material
 * @param {string} storageLocation
 * @param {{stockFetchFn?:function}} [opts]
 *   stockFetchFn — injectable for tests:
 *     fn(material, plant, sloc, batches) → batchQtyMap | throws
 * @return {Array<{PalletID:string, LotNo:string, Unit:string, ConfirmedAt:*,
 *   original:number, issued:number, remaining:number}>}
 * @throws {Error} if live SAP stock check fails (propagates to planFifoPick_)
 */
function getConfirmedStockByMaterial_(material, storageLocation, opts) {
  opts = opts || {};
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  var data = sh.getDataRange().getValues();
  var idx  = tlHeaderIdx_(data[0]);

  var needed = ['PalletID', 'Material', 'Batch', 'Unit', 'StorageLocation',
                'ScanStatus', 'QtyPerPallet', 'ConfirmedAt'];
  for (var k = 0; k < needed.length; k++) {
    if (idx[needed[k]] === undefined) return [];
  }

  // Pre-load all SPLIT_ISSUE sums from TransferLog for efficiency
  var issuedMap = {};
  var tlSh = getSpreadsheet_().getSheetByName(TL_SHEET);
  if (tlSh && tlSh.getLastRow() >= 2) {
    var tlData = tlSh.getDataRange().getValues();
    var tlIdx  = tlHeaderIdx_(tlData[0]);
    var ppCol  = tlIdx['ParentPalletID'];
    var ttCol  = tlIdx['TxnType'];
    var iqCol  = tlIdx['IssueQty'];
    if (ppCol !== undefined && ttCol !== undefined && iqCol !== undefined) {
      for (var t = 1; t < tlData.length; t++) {
        if (String(tlData[t][ttCol] || '').trim() === 'SPLIT_ISSUE') {
          var pp = String(tlData[t][ppCol] || '').trim();
          issuedMap[pp] = (issuedMap[pp] || 0) + (Number(tlData[t][iqCol]) || 0);
        }
      }
    }
  }

  // Build local candidate list (same local filter as before — batch stored for SAP check)
  var candidates = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (String(row[idx['ScanStatus']] || '').trim() !== 'CONFIRMED') continue;
    if (String(row[idx['Material']] || '').trim() !== material) continue;
    if (String(row[idx['StorageLocation']] || '').trim() !== storageLocation) continue;

    var pid      = String(row[idx['PalletID']] || '').trim();
    var original = Number(row[idx['QtyPerPallet']]) || 0;
    var issued   = issuedMap[pid] || 0;
    var remaining = original - issued;
    if (remaining <= 0) continue;

    var batch = String(row[idx['Batch']] || '').trim();
    candidates.push({
      PalletID:    pid,
      Batch:       batch,
      LotNo:       batch ? batch : pid,
      Unit:        String(row[idx['Unit']] || '').trim(),
      ConfirmedAt: row[idx['ConfirmedAt']] || null,
      original:    original,
      issued:      issued,
      remaining:   remaining
    });
  }

  // Short-circuit: no local candidates → nothing to filter, skip SAP call
  if (candidates.length === 0) return [];

  // Collect distinct non-empty batches from candidates for targeted SAP query
  var batchSet = {};
  for (var b = 0; b < candidates.length; b++) {
    if (candidates[b].Batch) batchSet[candidates[b].Batch] = true;
  }
  var distinctBatches = Object.keys(batchSet);

  // Live SAP batch-stock pre-filter — targeted OR-filter on candidate batches only.
  // Throws on SAP error; planFifoPick_ catches and returns sapCheckError:true.
  var _fetchStock = opts.stockFetchFn || fetchSapBatchStockForBatches_;
  var sapBatchQty = _fetchStock(material, CFG.PLANT, storageLocation, distinctBatches);

  var results = [];
  for (var c = 0; c < candidates.length; c++) {
    var cand = candidates[c];

    // No batch → cannot validate against SAP → skip (prevents batch-less pallets being offered)
    if (!cand.Batch) {
      logEvent('FIFO', 'STALE_SKIP',
        cand.PalletID + ' batch=(empty) — unresolved, skip');
      continue;
    }

    var sapQty = sapBatchQty[cand.Batch];
    if (sapQty === undefined || sapQty <= 0) {
      logEvent('FIFO', 'STALE_SKIP',
        cand.PalletID + ' batch=' + cand.Batch + ' sapQty=' +
        (sapQty === undefined ? 'unknown' : sapQty));
      continue;
    }

    results.push({
      PalletID:    cand.PalletID,
      LotNo:       cand.LotNo,
      Unit:        cand.Unit,
      ConfirmedAt: cand.ConfirmedAt,
      original:    cand.original,
      issued:      cand.issued,
      remaining:   Math.min(cand.remaining, sapQty)  // cap at SAP qty
    });
  }

  results.sort(function(a, b) {
    var ca = a.ConfirmedAt instanceof Date ? a.ConfirmedAt.getTime() : 0;
    var cb = b.ConfirmedAt instanceof Date ? b.ConfirmedAt.getTime() : 0;
    if (ca !== cb) return ca - cb;
    return a.PalletID < b.PalletID ? -1 : a.PalletID > b.PalletID ? 1 : 0;
  });

  return results;
}

// ============================================================================
// FIFO planner (pure — no writes)
// ============================================================================

/**
 * Plan a FIFO pick: allocate wantQty across confirmed pallets oldest-first.
 * Pure function — does NOT write anything.
 *
 * Fail-safe: if the live SAP batch-stock check throws (network/5xx), returns
 * { ok:false, sapCheckError:true, error:'ไม่สามารถตรวจสอบ stock SAP ได้ ลองใหม่ ...' }
 * rather than falling back to stale local data.
 *
 * @param {string} material
 * @param {string} storageLocation
 * @param {number} wantQty
 * @param {{stockFetchFn?:function}} [opts] — passed through to getConfirmedStockByMaterial_
 * @return {{ok:boolean, totalAvail:number, shortfall?:number, sapCheckError?:boolean,
 *   error?:string, allocations:Array<{ParentPalletID:string, LotNo:string, Unit:string,
 *     takeQty:number, remainingAfter:number}>}}
 * @throws {Error} if wantQty is not a positive number
 */
function planFifoPick_(material, storageLocation, wantQty, opts) {
  if (typeof wantQty !== 'number' || wantQty <= 0 || isNaN(wantQty)) {
    throw new Error('wantQty must be a positive number, got: ' + wantQty);
  }

  var stock;
  try {
    stock = getConfirmedStockByMaterial_(material, storageLocation, opts);
  } catch (e) {
    logEvent('FIFO', 'SAP_CHECK_FAIL', e.message.slice(0, 300));
    return {
      ok: false,
      sapCheckError: true,
      error: 'ไม่สามารถตรวจสอบ stock SAP ได้ ลองใหม่ (' + e.message.slice(0, 120) + ')',
      totalAvail: 0,
      allocations: []
    };
  }

  var totalAvail = 0;
  for (var i = 0; i < stock.length; i++) totalAvail += stock[i].remaining;

  if (wantQty > totalAvail) {
    return { ok: false, shortfall: wantQty - totalAvail, totalAvail: totalAvail, allocations: [] };
  }

  var allocations = [];
  var needLeft = wantQty;
  for (var j = 0; j < stock.length && needLeft > 0; j++) {
    var take = Math.min(stock[j].remaining, needLeft);
    allocations.push({
      ParentPalletID: stock[j].PalletID,
      LotNo:          stock[j].LotNo,
      Unit:           stock[j].Unit,
      takeQty:        take,
      remainingAfter: stock[j].remaining - take
    });
    needLeft -= take;
  }

  return { ok: true, totalAvail: totalAvail, allocations: allocations };
}

// ============================================================================
// Pick ID generator
// ============================================================================

/**
 * Generate next PickID: PK-yyyymmdd-nnn (Asia/Bangkok).
 * nnn = count of distinct PickIDs created today in TransferLog + 1, zero-padded 3.
 *
 * @return {string}
 */
function nextPickId_() {
  var now    = new Date();
  var prefix = 'PK-' + Utilities.formatDate(now, 'Asia/Bangkok', 'yyyyMMdd') + '-';

  var existing = {};
  var tlSh = getSpreadsheet_().getSheetByName(TL_SHEET);
  if (tlSh && tlSh.getLastRow() >= 2) {
    var data  = tlSh.getDataRange().getValues();
    var tlIdx = tlHeaderIdx_(data[0]);
    var piCol = tlIdx['PickID'];
    if (piCol !== undefined) {
      for (var r = 1; r < data.length; r++) {
        var pk = String(data[r][piCol] || '').trim();
        if (pk.indexOf(prefix) === 0) existing[pk] = true;
      }
    }
  }

  var seq = Object.keys(existing).length + 1;
  var pad = seq < 10 ? '00' + seq : seq < 100 ? '0' + seq : String(seq);
  return prefix + pad;
}

// ============================================================================
// Issue guard
// ============================================================================

/**
 * Check if a split-issue of qty from parentPalletId is allowed.
 *
 * @param {string} parentPalletId
 * @param {number} qty
 * @return {{ok:boolean, reason?:string, remaining:number}}
 */
function canIssue_(parentPalletId, qty) {
  if (typeof qty !== 'number' || qty <= 0 || isNaN(qty)) {
    return { ok: false, reason: 'qty must be a positive number', remaining: 0 };
  }

  // Check pallet exists and is CONFIRMED
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    return { ok: false, reason: 'PalletMaster empty or missing', remaining: 0 };
  }
  var data = sh.getDataRange().getValues();
  var idx  = tlHeaderIdx_(data[0]);
  var pidCol = idx['PalletID'];
  var ssCol  = idx['ScanStatus'];
  if (pidCol === undefined || ssCol === undefined) {
    return { ok: false, reason: 'PalletMaster missing required columns', remaining: 0 };
  }

  var found = false;
  var status = '';
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][pidCol] || '').trim() === parentPalletId) {
      found = true;
      status = String(data[r][ssCol] || '').trim();
      break;
    }
  }
  if (!found) return { ok: false, reason: 'Pallet not found: ' + parentPalletId, remaining: 0 };
  if (status !== 'CONFIRMED') {
    return { ok: false, reason: 'ScanStatus is ' + status + ', expected CONFIRMED', remaining: 0 };
  }

  var rem = getRemainingQty_(parentPalletId);
  if (qty > rem.remaining) {
    return { ok: false, reason: 'Requested ' + qty + ' > remaining ' + rem.remaining, remaining: rem.remaining };
  }

  return { ok: true, remaining: rem.remaining };
}

// ============================================================================
// Commit (atomic append to TransferLog)
// ============================================================================

/**
 * Execute a FIFO pick: re-plan at commit time and append rows to TransferLog.
 * Idempotent via opts.idempotencyKey — duplicate key returns existing result.
 * Does NOT modify PalletMaster.
 *
 * @param {string} material
 * @param {string} storageLocation
 * @param {number} wantQty
 * @param {{refDoc?:string, note?:string, idempotencyKey?:string, createdBy?:string}} opts
 * @return {{ok:boolean, pickId?:string, rows?:Array, allocations?:Array,
 *   shortfall?:number, totalAvail?:number, idempotent?:boolean}}
 */
function commitFifoPick_(material, storageLocation, wantQty, opts) {
  opts = opts || {};
  var sh = ensureTransferLogSheet_();

  // Idempotency check
  if (opts.idempotencyKey) {
    var existingData = sh.getLastRow() >= 2 ? sh.getDataRange().getValues() : [];
    if (existingData.length > 1) {
      var eIdx  = tlHeaderIdx_(existingData[0]);
      var ikCol = eIdx['IdempotencyKey'];
      var pkCol = eIdx['PickID'];
      if (ikCol !== undefined && pkCol !== undefined) {
        var matchedPickId = null;
        var matchedRows   = [];
        for (var e = 1; e < existingData.length; e++) {
          if (String(existingData[e][ikCol] || '').trim() === opts.idempotencyKey) {
            if (!matchedPickId) matchedPickId = String(existingData[e][pkCol] || '').trim();
            var rowObj = {};
            TL_HEADERS.forEach(function(h) { rowObj[h] = existingData[e][eIdx[h]]; });
            matchedRows.push(rowObj);
          }
        }
        if (matchedPickId) {
          logEvent('SPLIT_ISSUE', TL_SHEET, 'IDEMPOTENT', 0,
            'key=' + opts.idempotencyKey + ' pickId=' + matchedPickId);
          return { ok: true, idempotent: true, pickId: matchedPickId, rows: matchedRows };
        }
      }
    }
  }

  // Fresh plan at commit time (opts.stockFetchFn passes through for test injection)
  var plan = planFifoPick_(material, storageLocation, wantQty, opts);
  if (!plan.ok) {
    if (plan.sapCheckError) {
      logEvent('SPLIT_ISSUE', TL_SHEET, 'SAP_CHECK_FAIL', 0,
        material + ' ' + plan.error);
      return { ok: false, sapCheckError: true, error: plan.error };
    }
    logEvent('SPLIT_ISSUE', TL_SHEET, 'SHORTFALL', 0,
      material + ' want=' + wantQty + ' avail=' + plan.totalAvail);
    return { ok: false, shortfall: plan.shortfall, totalAvail: plan.totalAvail };
  }

  var pickId    = nextPickId_();
  var now       = Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");
  var createdBy = opts.createdBy || Session.getActiveUser().getEmail();
  var appendRows = [];
  var rowObjects = [];

  var sheetHdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  for (var i = 0; i < plan.allocations.length; i++) {
    var alloc = plan.allocations[i];
    var seq   = i + 1;
    var pad2  = seq < 10 ? '0' + seq : String(seq);

    var rowObj = {
      TxnID:           Utilities.getUuid(),
      PickID:          pickId,
      CreatedAt:       now,
      TxnType:         'SPLIT_ISSUE',
      ParentPalletID:  alloc.ParentPalletID,
      ChildSlipID:     alloc.ParentPalletID + '-S' + pad2,
      Material:        material,
      LotNo:           String(alloc.LotNo || ''),
      Unit:            alloc.Unit,
      IssueQty:        alloc.takeQty,
      SourceSLoc:      storageLocation,
      DestSLoc:        '',
      RefDoc:          opts.refDoc || '',
      Status:          'ISSUED',
      CreatedBy:       createdBy,
      Note:            opts.note || '',
      IdempotencyKey:  opts.idempotencyKey || ''
    };
    rowObjects.push(rowObj);

    var sheetRow = sheetHdr.map(function(h) { return rowObj[h] !== undefined ? rowObj[h] : ''; });
    appendRows.push(sheetRow);
  }

  var firstNewRow = sh.getLastRow() + 1;
  ['LotNo', 'Batch'].forEach(function(colName) {
    var ci = sheetHdr.indexOf(colName);
    if (ci >= 0) {
      sh.getRange(firstNewRow, ci + 1, appendRows.length, 1).setNumberFormat('@');
    }
  });
  sh.getRange(firstNewRow, 1, appendRows.length, sheetHdr.length)
    .setValues(appendRows);

  // Log consumed pallets (remaining now 0) — derived, not stored
  for (var c = 0; c < plan.allocations.length; c++) {
    if (plan.allocations[c].remainingAfter === 0) {
      logEvent('SLIP_CONSUMED', plan.allocations[c].ParentPalletID, 'OK', 0,
        'pickId=' + pickId);
    }
  }

  logEvent('SPLIT_ISSUE', TL_SHEET, 'OK', 0,
    pickId + ' ' + material + ' x' + wantQty + ' rows=' + plan.allocations.length);

  return { ok: true, pickId: pickId, rows: rowObjects, allocations: plan.allocations };
}

// ============================================================================
// Test wrappers (editor-runnable)
// ============================================================================

/**
 * TEST: Seed 2 CONFIRMED pallets in PalletMaster for FIFO testing.
 * Older pallet: QtyPerPallet=600, newer: QtyPerPallet=700.
 * Material='ZZTEST-FIFO', StorageLocation='PW30'.
 */
function TEST_seedFifoPallets_() {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh) throw new Error('PalletMaster sheet not found');

  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = tlHeaderIdx_(hdr);

  var ids = ['PL-ZZTEST-FIFO-L01', 'PL-ZZTEST-FIFO-L02'];
  // Check for existing test pallets
  if (sh.getLastRow() >= 2) {
    var data = sh.getDataRange().getValues();
    var pidCol = idx['PalletID'];
    for (var r = 1; r < data.length; r++) {
      var pid = String(data[r][pidCol] || '').trim();
      if (ids.indexOf(pid) >= 0) {
        Logger.log('Test pallets already exist, skipping seed. IDs: ' + JSON.stringify(ids));
        return;
      }
    }
  }

  var now = new Date();
  var olderDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  var newerDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

  var rows = [
    { PalletID: ids[0], ManufacturingOrder: 'ZZTEST-MO-001', Material: 'ZZTEST-FIFO',
      MaterialName: 'TEST FIFO Material', Batch: '', QtyPerPallet: 600, Unit: 'PC',
      PalletSeq: 1, TotalPallets: 2, WorkCenter: 'WC-TEST', ProductionDate: olderDate,
      TotalQuantity: 1300, Plant: '1100', StorageLocation: 'PW30', QRPayload: '',
      Status: 'CONFIRMED', CreatedAt: olderDate, PrintedAt: olderDate,
      ScannedAt: olderDate, ScannedBy: 'TEST', ScanStatus: 'CONFIRMED',
      GRMaterialDocument: '', GRMaterialDocumentYear: '', ConfirmationGroup: '',
      ConfirmationCount: '', ConfirmedAt: olderDate, ConfirmedBy: 'TEST',
      QCStatus: 'INSPECTED', QCResult: 'PASS', InspectionLot: '', LabelPrintedAt: '',
      UpdatedAt: now, QCResultNote: '', OverrideBy: '', OverrideReason: '', OverrideAt: '' },
    { PalletID: ids[1], ManufacturingOrder: 'ZZTEST-MO-001', Material: 'ZZTEST-FIFO',
      MaterialName: 'TEST FIFO Material', Batch: '', QtyPerPallet: 700, Unit: 'PC',
      PalletSeq: 2, TotalPallets: 2, WorkCenter: 'WC-TEST', ProductionDate: newerDate,
      TotalQuantity: 1300, Plant: '1100', StorageLocation: 'PW30', QRPayload: '',
      Status: 'CONFIRMED', CreatedAt: newerDate, PrintedAt: newerDate,
      ScannedAt: newerDate, ScannedBy: 'TEST', ScanStatus: 'CONFIRMED',
      GRMaterialDocument: '', GRMaterialDocumentYear: '', ConfirmationGroup: '',
      ConfirmationCount: '', ConfirmedAt: newerDate, ConfirmedBy: 'TEST',
      QCStatus: 'INSPECTED', QCResult: 'PASS', InspectionLot: '', LabelPrintedAt: '',
      UpdatedAt: now, QCResultNote: '', OverrideBy: '', OverrideReason: '', OverrideAt: '' }
  ];

  var sheetRows = rows.map(function(obj) {
    return PM_HEADERS.map(function(h) {
      return obj[h] !== undefined ? obj[h] : '';
    });
  });

  sh.getRange(sh.getLastRow() + 1, 1, sheetRows.length, PM_HEADERS.length)
    .setValues(sheetRows);

  logEvent('TEST_SEED', PM_SHEET, 'OK', 0, 'ZZTEST-FIFO x2 pallets');
  Logger.log('Seeded test pallets: ' + JSON.stringify(ids));
}

/**
 * TEST: Plan a 1000-unit FIFO pick for ZZTEST-FIFO at PW30.
 * Expect: 600 from older pallet (remaining 0) + 400 from newer (remaining 300).
 */
function TEST_planPick1000_() {
  var result = planFifoPick_('ZZTEST-FIFO', 'PW30', 1000);
  Logger.log('planFifoPick_ result:');
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * TEST: Commit a 1000-unit FIFO pick with idempotency key.
 * Run TWICE to verify: 2nd call returns idempotent:true, no new rows.
 */
function TEST_commitPick1000_() {
  var result = commitFifoPick_('ZZTEST-FIFO', 'PW30', 1000, {
    refDoc: 'TEST-REF',
    note: 'editor test',
    idempotencyKey: 'TEST-IDEM-001'
  });
  Logger.log('commitFifoPick_ result:');
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * TEST: Over-issue — request 99999 from ZZTEST-FIFO at PW30.
 * Expect: ok:false + shortfall.
 */
function TEST_overIssue_() {
  var result = planFifoPick_('ZZTEST-FIFO', 'PW30', 99999);
  Logger.log('Over-issue result:');
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * TEST: Cleanup — delete ZZTEST-FIFO pallets from PalletMaster and TransferLog. Idempotent.
 */
function TEST_cleanupFifoPallets_() {
  var ss = getSpreadsheet_();

  // Clean PalletMaster
  var pm = ss.getSheetByName(PM_SHEET);
  if (pm && pm.getLastRow() >= 2) {
    var pmData = pm.getDataRange().getValues();
    var pmIdx  = tlHeaderIdx_(pmData[0]);
    var matCol = pmIdx['Material'];
    var delPm  = 0;
    for (var r = pmData.length - 1; r >= 1; r--) {
      if (String(pmData[r][matCol] || '').trim() === 'ZZTEST-FIFO') {
        pm.deleteRow(r + 1);
        delPm++;
      }
    }
    Logger.log('Deleted ' + delPm + ' PalletMaster rows');
  }

  // Clean TransferLog
  var tl = ss.getSheetByName(TL_SHEET);
  if (tl && tl.getLastRow() >= 2) {
    var tlData = tl.getDataRange().getValues();
    var tlIdx  = tlHeaderIdx_(tlData[0]);
    var tlMatCol = tlIdx['Material'];
    var delTl = 0;
    for (var t = tlData.length - 1; t >= 1; t--) {
      if (String(tlData[t][tlMatCol] || '').trim() === 'ZZTEST-FIFO') {
        tl.deleteRow(t + 1);
        delTl++;
      }
    }
    Logger.log('Deleted ' + delTl + ' TransferLog rows');
  }

  logEvent('TEST_CLEANUP', 'ZZTEST-FIFO', 'OK', 0, 'PM+TL cleaned');
  Logger.log('Cleanup complete');
}

// ============================================================================
// Tests — SAP batch-stock pre-filter (injectable stockFetchFn, no real SAP)
// ============================================================================

/**
 * TEST: Pallet with local qty=8 but sapBatchQty=0 is excluded.
 * Pallet with sapBatchQty=2000 is included and selected.
 */
function TEST_fifo_skipsStaleBatch() {
  var fn         = 'TEST_fifo_skipsStaleBatch';
  var STALE_PID  = 'PL-ZZTEST-SF-STALE';
  var LIVE_PID   = 'PL-ZZTEST-SF-LIVE';
  var STALE_BATCH = 'BSTALE001';
  var LIVE_BATCH  = 'BLIVE001';
  var MAT  = 'ZZTEST-SF-A';
  var SLOC = 'PW30';

  var sh  = getSpreadsheet_().getSheetByName(PM_SHEET);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = tlHeaderIdx_(hdr);
  var now = new Date();

  var r1 = new Array(hdr.length).fill('');
  r1[idx['PalletID']]        = STALE_PID;
  r1[idx['Material']]        = MAT;
  r1[idx['QtyPerPallet']]    = 8;
  r1[idx['Unit']]            = 'PC';
  r1[idx['Batch']]           = STALE_BATCH;
  r1[idx['StorageLocation']] = SLOC;
  r1[idx['ScanStatus']]      = 'CONFIRMED';
  r1[idx['ConfirmedAt']]     = new Date(now.getTime() - 2 * 86400000); // older

  var r2 = new Array(hdr.length).fill('');
  r2[idx['PalletID']]        = LIVE_PID;
  r2[idx['Material']]        = MAT;
  r2[idx['QtyPerPallet']]    = 2000;
  r2[idx['Unit']]            = 'PC';
  r2[idx['Batch']]           = LIVE_BATCH;
  r2[idx['StorageLocation']] = SLOC;
  r2[idx['ScanStatus']]      = 'CONFIRMED';
  r2[idx['ConfirmedAt']]     = new Date(now.getTime() - 1 * 86400000); // newer

  sh.appendRow(r1);
  sh.appendRow(r2);
  SpreadsheetApp.flush();

  var pass = true;
  var detail = '';
  try {
    var fakeStock = function() {
      var m = {};
      m[STALE_BATCH] = 0;
      m[LIVE_BATCH]  = 2000;
      return m;
    };

    var result = planFifoPick_(MAT, SLOC, 500, { stockFetchFn: fakeStock });

    if (!result.ok)                         { pass = false; detail += 'ok=false '; }
    else                                    { detail += 'ok=true OK '; }
    if (result.allocations.length !== 1)    { pass = false; detail += 'alloc.length=' + result.allocations.length + '(exp 1) '; }
    else                                    { detail += 'alloc.length=1 OK '; }
    if (result.allocations.length > 0 && result.allocations[0].ParentPalletID !== LIVE_PID) {
      pass = false; detail += 'picked=' + result.allocations[0].ParentPalletID + '(exp LIVE) ';
    } else if (result.allocations.length > 0) { detail += 'picked=LIVE_PID OK '; }

  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }
  finally {
    var d = sh.getDataRange().getValues();
    var mi = tlHeaderIdx_(d[0])['Material'];
    for (var i = d.length - 1; i >= 1; i--) {
      if (String(d[i][mi] || '').trim() === MAT) sh.deleteRow(i + 1);
    }
  }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'FIFO', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

/**
 * TEST: Local remaining=2000, SAP qty=500. Want 600 → shortfall (capped totalAvail=500).
 * Want 400 → ok, takeQty=400, remainingAfter=100 (capped, not local 1600).
 */
function TEST_fifo_capsAtSapQty() {
  var fn    = 'TEST_fifo_capsAtSapQty';
  var PID   = 'PL-ZZTEST-SF-CAP';
  var BATCH = 'BCAP001';
  var MAT   = 'ZZTEST-SF-B';
  var SLOC  = 'PW30';

  var sh  = getSpreadsheet_().getSheetByName(PM_SHEET);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = tlHeaderIdx_(hdr);

  var r1 = new Array(hdr.length).fill('');
  r1[idx['PalletID']]        = PID;
  r1[idx['Material']]        = MAT;
  r1[idx['QtyPerPallet']]    = 2000;
  r1[idx['Unit']]            = 'PC';
  r1[idx['Batch']]           = BATCH;
  r1[idx['StorageLocation']] = SLOC;
  r1[idx['ScanStatus']]      = 'CONFIRMED';
  r1[idx['ConfirmedAt']]     = new Date();

  sh.appendRow(r1);
  SpreadsheetApp.flush();

  var pass = true;
  var detail = '';
  try {
    var fakeStock = function() { var m = {}; m[BATCH] = 500; return m; };

    // Want 600 > SAP 500 → shortfall
    var res1 = planFifoPick_(MAT, SLOC, 600, { stockFetchFn: fakeStock });
    if (res1.ok)              { pass = false; detail += 'want600: ok=true(exp false) '; }
    else if (res1.sapCheckError) { pass = false; detail += 'want600: unexpected sapCheckError '; }
    else                      { detail += 'want600: shortfall OK '; }
    if (!res1.ok && res1.totalAvail !== 500) {
      pass = false; detail += 'totalAvail=' + res1.totalAvail + '(exp 500) ';
    } else if (!res1.ok) { detail += 'totalAvail=500 OK '; }

    // Want 400 → ok, capped remaining = 500, remainingAfter = 100
    var res2 = planFifoPick_(MAT, SLOC, 400, { stockFetchFn: fakeStock });
    if (!res2.ok)             { pass = false; detail += 'want400: ok=false '; }
    else                      { detail += 'want400: ok=true OK '; }
    if (res2.ok && res2.allocations[0].takeQty !== 400) {
      pass = false; detail += 'takeQty=' + res2.allocations[0].takeQty + '(exp 400) ';
    } else if (res2.ok) { detail += 'takeQty=400 OK '; }
    if (res2.ok && res2.allocations[0].remainingAfter !== 100) {
      pass = false; detail += 'remainingAfter=' + res2.allocations[0].remainingAfter + '(exp 100) ';
    } else if (res2.ok) { detail += 'remainingAfter=100 OK '; }

  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }
  finally {
    var d = sh.getDataRange().getValues();
    var mi = tlHeaderIdx_(d[0])['Material'];
    for (var i = d.length - 1; i >= 1; i--) {
      if (String(d[i][mi] || '').trim() === MAT) sh.deleteRow(i + 1);
    }
  }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'FIFO', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

/**
 * TEST: When SAP stock check throws, planFifoPick_ returns sapCheckError=true
 * and does NOT return allocations (no silent fallback to stale local data).
 */
function TEST_fifo_sapCheckFailsSafe() {
  var fn   = 'TEST_fifo_sapCheckFailsSafe';
  var PID  = 'PL-ZZTEST-SF-ERR';
  var MAT  = 'ZZTEST-SF-C';
  var SLOC = 'PW30';

  var sh  = getSpreadsheet_().getSheetByName(PM_SHEET);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = tlHeaderIdx_(hdr);

  // Seed one candidate so the SAP call is actually reached
  var r1 = new Array(hdr.length).fill('');
  r1[idx['PalletID']]        = PID;
  r1[idx['Material']]        = MAT;
  r1[idx['QtyPerPallet']]    = 100;
  r1[idx['Unit']]            = 'PC';
  r1[idx['Batch']]           = 'BERR001';
  r1[idx['StorageLocation']] = SLOC;
  r1[idx['ScanStatus']]      = 'CONFIRMED';
  r1[idx['ConfirmedAt']]     = new Date();

  sh.appendRow(r1);
  SpreadsheetApp.flush();

  var pass = true;
  var detail = '';
  try {
    var fakeStock = function() { throw new Error('simulated SAP outage HTTP 503'); };

    var result = planFifoPick_(MAT, SLOC, 50, { stockFetchFn: fakeStock });

    if (result.ok)              { pass = false; detail += 'ok=true (must be false on SAP error) '; }
    else                        { detail += 'ok=false OK '; }
    if (!result.sapCheckError)  { pass = false; detail += 'sapCheckError missing '; }
    else                        { detail += 'sapCheckError=true OK '; }
    if (!result.error || result.error.indexOf('ไม่สามารถตรวจสอบ') === -1) {
      pass = false; detail += 'error msg missing ';
    } else { detail += 'error msg OK '; }
    if (result.allocations && result.allocations.length > 0) {
      pass = false; detail += 'allocations non-empty (must not fall back to local) ';
    } else { detail += 'no allocations OK '; }

  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }
  finally {
    var d = sh.getDataRange().getValues();
    var mi = tlHeaderIdx_(d[0])['Material'];
    for (var i = d.length - 1; i >= 1; i--) {
      if (String(d[i][mi] || '').trim() === MAT) sh.deleteRow(i + 1);
    }
  }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'FIFO', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

/**
 * TEST: Pallet with empty Batch is skipped (cannot validate against SAP).
 * Pallet with a resolved Batch and SAP qty > 0 is included.
 */
function TEST_fifo_unresolvedBatchSkipped() {
  var fn        = 'TEST_fifo_unresolvedBatchSkipped';
  var NO_BATCH  = 'PL-ZZTEST-SF-NOBATCH';
  var OK_PID    = 'PL-ZZTEST-SF-HASBATCH';
  var OK_BATCH  = 'BOKBATCH';
  var MAT  = 'ZZTEST-SF-D';
  var SLOC = 'PW30';

  var sh  = getSpreadsheet_().getSheetByName(PM_SHEET);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = tlHeaderIdx_(hdr);
  var now = new Date();

  var r1 = new Array(hdr.length).fill('');
  r1[idx['PalletID']]        = NO_BATCH;
  r1[idx['Material']]        = MAT;
  r1[idx['QtyPerPallet']]    = 100;
  r1[idx['Unit']]            = 'PC';
  r1[idx['Batch']]           = '';                                    // no batch
  r1[idx['StorageLocation']] = SLOC;
  r1[idx['ScanStatus']]      = 'CONFIRMED';
  r1[idx['ConfirmedAt']]     = new Date(now.getTime() - 86400000);   // older

  var r2 = new Array(hdr.length).fill('');
  r2[idx['PalletID']]        = OK_PID;
  r2[idx['Material']]        = MAT;
  r2[idx['QtyPerPallet']]    = 100;
  r2[idx['Unit']]            = 'PC';
  r2[idx['Batch']]           = OK_BATCH;
  r2[idx['StorageLocation']] = SLOC;
  r2[idx['ScanStatus']]      = 'CONFIRMED';
  r2[idx['ConfirmedAt']]     = now;

  sh.appendRow(r1);
  sh.appendRow(r2);
  SpreadsheetApp.flush();

  var pass = true;
  var detail = '';
  try {
    var fakeStock = function() { var m = {}; m[OK_BATCH] = 100; return m; };

    var result = planFifoPick_(MAT, SLOC, 50, { stockFetchFn: fakeStock });

    if (!result.ok)                       { pass = false; detail += 'ok=false '; }
    else                                  { detail += 'ok=true OK '; }
    if (result.allocations.length !== 1)  { pass = false; detail += 'alloc.length=' + result.allocations.length + '(exp 1) '; }
    else                                  { detail += 'alloc.length=1 OK '; }
    if (result.allocations.length > 0 && result.allocations[0].ParentPalletID !== OK_PID) {
      pass = false; detail += 'picked=' + result.allocations[0].ParentPalletID + '(exp HASBATCH) ';
    } else if (result.allocations.length > 0) { detail += 'picked=HASBATCH OK '; }

  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }
  finally {
    var d = sh.getDataRange().getValues();
    var mi = tlHeaderIdx_(d[0])['Material'];
    for (var i = d.length - 1; i >= 1; i--) {
      if (String(d[i][mi] || '').trim() === MAT) sh.deleteRow(i + 1);
    }
  }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'FIFO', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

/**
 * TEST: Targeted batch query — candidates carry two specific batches; only the
 * one with SAP qty > 0 survives. Reproduces the PL-1000036325-L02 scenario where
 * 0000095389=2000 is live and 0000094815=0 is stale.
 * Also asserts the injectable receives BOTH batches in the query arg.
 */
function TEST_fifo_targetedBatchQuery() {
  var fn         = 'TEST_fifo_targetedBatchQuery';
  var LIVE_PID   = 'PL-ZZTEST-TBQ-LIVE';
  var STALE_PID  = 'PL-ZZTEST-TBQ-STALE';
  var LIVE_BATCH  = '0000095389';
  var STALE_BATCH = '0000094815';
  var MAT  = 'ZZTEST-SF-TBQ';
  var SLOC = 'PW30';

  var sh  = getSpreadsheet_().getSheetByName(PM_SHEET);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = tlHeaderIdx_(hdr);
  var now = new Date();

  var r1 = new Array(hdr.length).fill('');
  r1[idx['PalletID']]        = LIVE_PID;
  r1[idx['Material']]        = MAT;
  r1[idx['QtyPerPallet']]    = 2000;
  r1[idx['Unit']]            = 'PC';
  r1[idx['Batch']]           = LIVE_BATCH;
  r1[idx['StorageLocation']] = SLOC;
  r1[idx['ScanStatus']]      = 'CONFIRMED';
  r1[idx['ConfirmedAt']]     = new Date(now.getTime() - 86400000); // older → FIFO first

  var r2 = new Array(hdr.length).fill('');
  r2[idx['PalletID']]        = STALE_PID;
  r2[idx['Material']]        = MAT;
  r2[idx['QtyPerPallet']]    = 8;
  r2[idx['Unit']]            = 'PC';
  r2[idx['Batch']]           = STALE_BATCH;
  r2[idx['StorageLocation']] = SLOC;
  r2[idx['ScanStatus']]      = 'CONFIRMED';
  r2[idx['ConfirmedAt']]     = now;

  // appendRow() coerces all-digit strings to numbers regardless of pre-set column
  // format ('0000095389' → 95389). Fix: appendRow with batch as '' placeholder,
  // then overwrite the batch cell with setNumberFormat('@') + setValue(string).
  // This is the proven pattern used in updatePalletScanFields_/BACKFILL.
  var batchCol = idx['Batch'] + 1; // 1-based

  r1[idx['Batch']] = '';
  sh.appendRow(r1);
  var row1Num = sh.getLastRow();

  r2[idx['Batch']] = '';
  sh.appendRow(r2);
  var row2Num = sh.getLastRow();

  // Overwrite batch cells as forced-text strings
  sh.getRange(row1Num, batchCol).setNumberFormat('@').setValue(LIVE_BATCH);
  sh.getRange(row2Num, batchCol).setNumberFormat('@').setValue(STALE_BATCH);
  SpreadsheetApp.flush();

  // Verify round-trip before running test logic
  var rb1 = sh.getRange(row1Num, batchCol).getValue();
  var rb2 = sh.getRange(row2Num, batchCol).getValue();
  Logger.log('fixture batch readback: row1=' + rb1 + ' (len=' + String(rb1).length +
    ') row2=' + rb2 + ' (len=' + String(rb2).length + ')');

  var capturedBatches = null;
  var pass = true;
  var detail = '';

  try {
    var fakeStock = function(mat, plant, sloc, batches) {
      capturedBatches = batches ? batches.slice() : [];
      var m = {};
      m[LIVE_BATCH]  = 2000;
      m[STALE_BATCH] = 0;
      return m;
    };

    var result = planFifoPick_(MAT, SLOC, 500, { stockFetchFn: fakeStock });

    if (!capturedBatches || capturedBatches.indexOf(LIVE_BATCH) < 0) {
      pass = false; detail += 'LIVE_BATCH missing from query args ';
    } else { detail += 'LIVE_BATCH in query OK '; }
    if (!capturedBatches || capturedBatches.indexOf(STALE_BATCH) < 0) {
      pass = false; detail += 'STALE_BATCH missing from query args ';
    } else { detail += 'STALE_BATCH in query OK '; }

    if (!result.ok) { pass = false; detail += 'ok=false '; }
    else            { detail += 'ok=true OK '; }
    if (result.allocations.length !== 1) {
      pass = false; detail += 'alloc.length=' + result.allocations.length + '(exp 1) ';
    } else { detail += 'alloc.length=1 OK '; }
    if (result.allocations.length > 0 && result.allocations[0].ParentPalletID !== LIVE_PID) {
      pass = false; detail += 'picked=' + result.allocations[0].ParentPalletID + '(exp LIVE) ';
    } else if (result.allocations.length > 0) { detail += 'picked=LIVE OK '; }
    if (result.totalAvail !== 2000) {
      pass = false; detail += 'totalAvail=' + result.totalAvail + '(exp 2000) ';
    } else { detail += 'totalAvail=2000 OK '; }

  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }
  finally {
    var d = sh.getDataRange().getValues();
    var mi = tlHeaderIdx_(d[0])['Material'];
    for (var i = d.length - 1; i >= 1; i--) {
      if (String(d[i][mi] || '').trim() === MAT) sh.deleteRow(i + 1);
    }
  }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'FIFO', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

/**
 * TEST: SAP OData returns MatlWrhsStkQtyInMatlBaseUnit as a string (e.g. "2000.00").
 * parseFloat must resolve it to the correct number — not NaN, not 0.
 */
function TEST_fifo_qtyParsedAsFloat() {
  var fn   = 'TEST_fifo_qtyParsedAsFloat';
  var pass = true;
  var detail = '';

  var cases = [
    { raw: '2000.00',  expect: 2000 },
    { raw: '3418.000', expect: 3418 },
    { raw: '0.000',    expect: 0 },
    { raw: '1.5',      expect: 1.5 },
    { raw: 2000,       expect: 2000 },
    { raw: null,       expect: 0 },
    { raw: '',         expect: 0 }
  ];

  cases.forEach(function(c) {
    var got = parseFloat(c.raw) || 0;
    if (got !== c.expect) {
      pass = false;
      detail += 'parseFloat(' + JSON.stringify(c.raw) + ')=' + got + '(exp ' + c.expect + ') ';
    }
  });
  if (pass) detail = 'all ' + cases.length + ' cases OK';

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'FIFO', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

/**
 * TEST: >20 candidates → all distinct batches are passed to the stock fn.
 * Verifies there is no truncation at the caller level (chunking is internal
 * to fetchSapBatchStockForBatches_ and tested via the injectable seam).
 */
function TEST_fifo_orFilterChunking() {
  var fn    = 'TEST_fifo_orFilterChunking';
  var MAT   = 'ZZTEST-SF-CHUNK';
  var SLOC  = 'PW30';
  var COUNT = 22; // exceeds 20-batch chunk threshold

  var sh  = getSpreadsheet_().getSheetByName(PM_SHEET);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = tlHeaderIdx_(hdr);
  var now = new Date();

  var seededBatches = [];
  for (var n = 1; n <= COUNT; n++) {
    var batch = 'ZCHUNK' + ('00' + n).slice(-3);
    var pid   = 'PL-ZZTEST-CHUNK-' + ('00' + n).slice(-3);
    seededBatches.push(batch);

    var row = new Array(hdr.length).fill('');
    row[idx['PalletID']]        = pid;
    row[idx['Material']]        = MAT;
    row[idx['QtyPerPallet']]    = 100;
    row[idx['Unit']]            = 'PC';
    row[idx['Batch']]           = batch;
    row[idx['StorageLocation']] = SLOC;
    row[idx['ScanStatus']]      = 'CONFIRMED';
    row[idx['ConfirmedAt']]     = new Date(now.getTime() - n * 60000);
    sh.appendRow(row);
  }
  SpreadsheetApp.flush();

  var capturedBatches = null;
  var pass = true;
  var detail = '';

  try {
    var fakeStock = function(mat, plant, sloc, batches) {
      capturedBatches = batches ? batches.slice() : [];
      var m = {};
      for (var i = 0; i < capturedBatches.length; i++) {
        m[capturedBatches[i]] = 100; // all live
      }
      return m;
    };

    var result = planFifoPick_(MAT, SLOC, 50, { stockFetchFn: fakeStock });

    if (!capturedBatches || capturedBatches.length !== COUNT) {
      pass = false;
      detail += 'batches.length=' + (capturedBatches ? capturedBatches.length : 'null') +
        '(exp ' + COUNT + ') ';
    } else { detail += 'all ' + COUNT + ' batches in query OK '; }

    if (!result.ok) { pass = false; detail += 'ok=false '; }
    else            { detail += 'ok=true OK '; }
    if (result.totalAvail !== COUNT * 100) {
      pass = false; detail += 'totalAvail=' + result.totalAvail + '(exp ' + (COUNT * 100) + ') ';
    } else { detail += 'totalAvail=' + (COUNT * 100) + ' OK '; }

  } catch (e) { pass = false; detail += 'EXCEPTION: ' + e.message; }
  finally {
    var d = sh.getDataRange().getValues();
    var mi = tlHeaderIdx_(d[0])['Material'];
    for (var i = d.length - 1; i >= 1; i--) {
      if (String(d[i][mi] || '').trim() === MAT) sh.deleteRow(i + 1);
    }
  }

  Logger.log(pass ? '✅ ' + fn + ': ' + detail : '❌ ' + fn + ': ' + detail);
  logEvent(fn, 'FIFO', pass ? 'PASS' : 'FAIL', 0, detail);
  return pass;
}

/**
 * Run all 7 SAP batch-stock filter tests. No real SAP calls — all injected.
 */
function TEST_fifo_sapFilter_runAll() {
  var fn = 'TEST_fifo_sapFilter_runAll';
  var t0 = Date.now();
  var tests = [
    { name: 'skipsStaleBatch',        run: TEST_fifo_skipsStaleBatch },
    { name: 'capsAtSapQty',           run: TEST_fifo_capsAtSapQty },
    { name: 'sapCheckFailsSafe',      run: TEST_fifo_sapCheckFailsSafe },
    { name: 'unresolvedBatchSkipped', run: TEST_fifo_unresolvedBatchSkipped },
    { name: 'targetedBatchQuery',     run: TEST_fifo_targetedBatchQuery },
    { name: 'qtyParsedAsFloat',       run: TEST_fifo_qtyParsedAsFloat },
    { name: 'orFilterChunking',       run: TEST_fifo_orFilterChunking }
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
  var elapsed = Date.now() - t0;
  Logger.log(fn + ': ' + (allPass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name + (r.error ? ' — ' + r.error : ''));
  });
  Logger.log('──────────────────────────────────────────');
  logEvent(fn, 'FIFO', allPass ? 'PASS' : 'FAIL', elapsed, results.length + ' tests');

  SpreadsheetApp.getUi().alert(
    'FIFO SAP Filter Test Suite: ' + (allPass ? 'ALL PASS ✅' : 'SOME FAILED ❌') + '\n\n' +
    results.map(function(r) {
      return (r.ok ? '✅ ' : '❌ ') + r.name + (r.error ? ' — ' + r.error : '');
    }).join('\n') + '\n\nDetails in Executions log.');
}

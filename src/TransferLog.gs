/**
 * TransferLog.gs — Phase 3.5 Step 2b
 * ====================================
 * Data layer + FIFO allocator for pallet split-issue transactions.
 * READ-ONLY on PalletMaster. Append-only to TransferLog sheet.
 * No print, no HTML, no web, no menu.
 *
 * Reuses: PM_HEADERS, PM_SHEET (PalletGen.gs), getSpreadsheet_ (SheetSetup.gs),
 *         logEvent (SapClient.gs)
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
 * with remaining qty > 0, sorted FIFO by ConfirmedAt ASC then PalletID ASC.
 *
 * @param {string} material
 * @param {string} storageLocation
 * @return {Array<{PalletID:string, LotNo:string, Unit:string, ConfirmedAt:*,
 *   original:number, issued:number, remaining:number}>}
 */
function getConfirmedStockByMaterial_(material, storageLocation) {
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

  var results = [];
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
    results.push({
      PalletID:    pid,
      LotNo:       batch ? batch : pid,
      Unit:        String(row[idx['Unit']] || '').trim(),
      ConfirmedAt: row[idx['ConfirmedAt']] || null,
      original:    original,
      issued:      issued,
      remaining:   remaining
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
 * @param {string} material
 * @param {string} storageLocation
 * @param {number} wantQty
 * @return {{ok:boolean, totalAvail:number, shortfall?:number,
 *   allocations:Array<{ParentPalletID:string, LotNo:string, Unit:string,
 *     takeQty:number, remainingAfter:number}>}}
 * @throws {Error} if wantQty is not a positive number
 */
function planFifoPick_(material, storageLocation, wantQty) {
  if (typeof wantQty !== 'number' || wantQty <= 0 || isNaN(wantQty)) {
    throw new Error('wantQty must be a positive number, got: ' + wantQty);
  }

  var stock = getConfirmedStockByMaterial_(material, storageLocation);
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

  // Fresh plan at commit time
  var plan = planFifoPick_(material, storageLocation, wantQty);
  if (!plan.ok) {
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
      QCStatus: 'PASS', QCResult: 'PASS', InspectionLot: '', LabelPrintedAt: '',
      UpdatedAt: now, QCResultNote: '', OverrideBy: '', OverrideReason: '', OverrideAt: '' },
    { PalletID: ids[1], ManufacturingOrder: 'ZZTEST-MO-001', Material: 'ZZTEST-FIFO',
      MaterialName: 'TEST FIFO Material', Batch: '', QtyPerPallet: 700, Unit: 'PC',
      PalletSeq: 2, TotalPallets: 2, WorkCenter: 'WC-TEST', ProductionDate: newerDate,
      TotalQuantity: 1300, Plant: '1100', StorageLocation: 'PW30', QRPayload: '',
      Status: 'CONFIRMED', CreatedAt: newerDate, PrintedAt: newerDate,
      ScannedAt: newerDate, ScannedBy: 'TEST', ScanStatus: 'CONFIRMED',
      GRMaterialDocument: '', GRMaterialDocumentYear: '', ConfirmationGroup: '',
      ConfirmationCount: '', ConfirmedAt: newerDate, ConfirmedBy: 'TEST',
      QCStatus: 'PASS', QCResult: 'PASS', InspectionLot: '', LabelPrintedAt: '',
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

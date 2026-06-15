/**
 * PalletGen.gs — Phase 2
 * Split TotalQuantity ของแต่ละ Production Order ตาม MOQ_Per_Pallet → PalletMaster
 *
 * PalletID    = {ManufacturingOrder}-P{seq}  (P001, P002, ...)
 * QR Payload  = PALLET|{PalletID}|{ManufacturingOrder}|{Material}|{Batch}|{Qty}
 * Idempotent  : ข้าม PalletID ที่มีอยู่แล้วใน PalletMaster
 * Safety      : เคารพ CFG.DRY_RUN — โหมด dry run แค่ log ไม่เขียนชีต
 */

var PM_SHEET = 'PalletMaster';
// Must stay in sync with CFG.HEADERS.PALLET_MASTER — setupSheets() uses CFG, ensurePalletMasterSheet_ uses this
// Matches actual PalletMaster sheet column order (27 cols, 0-indexed).
// NEVER reorder — use buildPalletRow_() to write rows by name, not by position.
var PM_HEADERS = [
  'PalletID',            // 0
  'ManufacturingOrder',  // 1
  'Material',            // 2
  'MaterialName',        // 3
  'Batch',               // 4
  'QtyPerPallet',        // 5
  'Unit',                // 6
  'PalletSeq',           // 7
  'TotalPallets',        // 8
  'WorkCenter',          // 9
  'ProductionDate',      // 10
  'QRPayload',           // 11
  'LabelPrintedAt',      // 12
  'ScanStatus',          // 13
  'ScannedAt',           // 14
  'ScannedBy',           // 15
  'GRMaterialDocument',  // 16
  'QCStatus',            // 17
  'InspectionLot',       // 18
  'UpdatedAt',           // 19
  'Plant',               // 20
  'StorageLocation',     // 21
  'TotalQuantity',       // 22
  'Status',              // 23
  'CreatedAt',           // 24
  'PrintedAt',           // 25
  'QCResult'             // 26
];

/**
 * Build a PalletMaster row array aligned to PM_HEADERS.
 * values = object keyed by column name; missing keys get ''.
 * Always use this instead of positional arrays — immune to column reorder.
 */
function buildPalletRow_(values) {
  return PM_HEADERS.map(function(h) {
    return values.hasOwnProperty(h) ? values[h] : '';
  });
}

// Status lifecycle: CREATED → PRINTED → SCANNED(GR) → QC_PASS/QC_HOLD/QC_REJECT

function ensurePalletMasterSheet_() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(PM_SHEET) || ss.insertSheet(PM_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, PM_HEADERS.length).setValues([PM_HEADERS])
      .setFontWeight('bold').setBackground('#0b8043').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  } else {
    // Add TotalQuantity column header if this is an older sheet without it
    var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    if (hdr.indexOf('TotalQuantity') === -1) {
      var col = sh.getLastColumn() + 1;
      sh.getRange(1, col).setValue('TotalQuantity')
        .setFontWeight('bold').setBackground('#0b8043').setFontColor('#ffffff');
    }
  }
  return sh;
}

function ensurePalletMasterColumns_() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(PM_SHEET);
  if (!sh) return;

  var existing = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  // Rename legacy 'ProductionOrder' header → 'ManufacturingOrder' (preserves data in that column)
  existing.forEach(function(h, i) {
    if (h === 'ProductionOrder') {
      sh.getRange(1, i + 1).setValue('ManufacturingOrder')
        .setFontWeight('bold').setBackground('#0b8043').setFontColor('#ffffff');
      Logger.log('Renamed column: ProductionOrder → ManufacturingOrder at position ' + (i + 1));
      existing[i] = 'ManufacturingOrder';
    }
  });

  var required = PM_HEADERS.slice();

  required.forEach(function(col) {
    if (existing.indexOf(col) === -1) {
      var newCol = sh.getLastColumn() + 1;
      sh.getRange(1, newCol).setValue(col)
        .setFontWeight('bold')
        .setBackground('#0b8043')
        .setFontColor('#ffffff');
      Logger.log('Added column: ' + col + ' at position ' + newCol);
    }
  });
}

/**
 * One-time backfill — populate TotalQuantity, MaterialName, Batch, QRPayload
 * for PalletMaster rows where TotalQuantity is empty.
 * Respects CFG.DRY_RUN.
 */
function backfillPalletMaster() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var pmSh = ss.getSheetByName(PM_SHEET);
  if (!pmSh || pmSh.getLastRow() < 2) { Logger.log('backfillPalletMaster: PalletMaster ว่าง'); return; }

  var poSh = ss.getSheetByName('ProductionOrders');
  if (!poSh || poSh.getLastRow() < 2) { Logger.log('backfillPalletMaster: ProductionOrders ว่าง'); return; }

  // Build PO lookup
  var poData = poSh.getDataRange().getValues();
  var poIdx = {};
  poData[0].forEach(function(h, i) { poIdx[h] = i; });
  var poMap = {};
  for (var pr = 1; pr < poData.length; pr++) {
    var moVal = String(poData[pr][poIdx.ManufacturingOrder] || '').trim();
    if (!moVal) continue;
    poMap[moVal] = {
      TotalQuantity: Number(poData[pr][poIdx.TotalQuantity]) || 0,
      Batch:         String(poData[pr][poIdx.Batch] || '').trim(),
      Material:      String(poData[pr][poIdx.Material] || '').trim()
    };
  }

  var mmMap = getMaterialMap();

  var pmData = pmSh.getDataRange().getValues();
  var pmIdx = {};
  pmData[0].forEach(function(h, i) { pmIdx[h] = i; });

  var count = 0;
  var backfilled = 0;

  for (var r = 1; r < pmData.length; r++) {
    var row = pmData[r];
    var tqCurrent = row[pmIdx.TotalQuantity];
    if (tqCurrent !== '' && tqCurrent !== null && Number(tqCurrent) > 0) continue;

    var mo = String(row[pmIdx.ManufacturingOrder] || '').trim();
    if (!mo) { Logger.log('backfillPalletMaster: row ' + (r + 1) + ' ManufacturingOrder ว่าง — skip'); continue; }

    var po = poMap[mo];
    if (!po) { Logger.log('backfillPalletMaster: MO ' + mo + ' ไม่พบใน ProductionOrders'); continue; }

    var mat      = String(row[pmIdx.Material] || '').trim() || po.Material;
    var matName  = (mmMap[mat] && mmMap[mat].name) ? mmMap[mat].name : '';
    var palletId = String(row[pmIdx.PalletID] || '').trim();
    var palletQty = Number(row[pmIdx.QtyPerPallet]) || 0;
    var newQr    = 'PALLET|' + palletId + '|' + mo + '|' + mat + '|' + (po.Batch || '') + '|' + palletQty;

    count++;
    Logger.log('backfillPalletMaster: row ' + (r + 1) + ' ' + palletId +
      ' MO=' + mo + ' TotalQty=' + po.TotalQuantity +
      ' Batch="' + po.Batch + '" MatName="' + matName + '" QR=' + newQr);

    if (!CFG.DRY_RUN) {
      if (pmIdx.MaterialName >= 0 && !String(row[pmIdx.MaterialName] || '').trim()) {
        pmSh.getRange(r + 1, pmIdx.MaterialName + 1).setValue(matName);
      }
      pmSh.getRange(r + 1, pmIdx.Batch        + 1).setValue(po.Batch || '');
      pmSh.getRange(r + 1, pmIdx.TotalQuantity + 1).setValue(po.TotalQuantity);
      pmSh.getRange(r + 1, pmIdx.QRPayload     + 1).setValue(newQr);
      backfilled++;
    }
  }

  if (CFG.DRY_RUN) {
    Logger.log('backfillPalletMaster: [DRY_RUN] would backfill ' + count + ' rows');
  } else {
    Logger.log('backfillPalletMaster: backfilled ' + backfilled + ' rows');
    logEvent('BACKFILL_PM', '-', 'OK', 0, 'backfilled ' + backfilled + ' PalletMaster rows');
  }
}

function getExistingPalletIds_(sh) {
  var ids = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
      .forEach(function (r) { if (r[0]) ids[String(r[0]).trim()] = true; });
  }
  return ids;
}

function buildQrPayload_(palletId, mo, material, batch, qty) {
  return ['PALLET', palletId, mo, material, batch || '', qty].join('|');
}

/**
 * สร้าง pallets สำหรับ MO เดียว — คืน array ของ rows (ยังไม่เขียนชีต)
 */
function splitOrderToPallets_(po, moqCfg, existingIds) {
  var total = Number(po.TotalQuantity) || 0;
  var moq = moqCfg.moq;
  if (total <= 0 || moq <= 0) return { rows: [], skipped: 0, reason: total <= 0 ? 'ZERO_QTY' : 'NO_MOQ' };

  var totalPallets = Math.ceil(total / moq);
  var rows = [], skipped = 0;
  var now = new Date();
  var firstWc = String(po.WorkCenters || '').split(',')[0].trim();

  for (var seq = 1; seq <= totalPallets; seq++) {
    var palletId = po.ManufacturingOrder + '-P' + ('000' + seq).slice(-3);
    if (existingIds[palletId]) { skipped++; continue; }
    var qty = (seq < totalPallets) ? moq : (total - moq * (totalPallets - 1)); // ใบสุดท้าย = เศษ
    rows.push(buildPalletRow_({
      PalletID:           palletId,
      ManufacturingOrder: po.ManufacturingOrder,
      Material:           po.Material,
      MaterialName:       moqCfg.name || '',
      Batch:              po.Batch || '',
      QtyPerPallet:       qty,
      Unit:               moqCfg.unit || po.ProductionUnit,
      PalletSeq:          seq,
      TotalPallets:       totalPallets,
      WorkCenter:         firstWc,
      ProductionDate:     po.MfgOrderPlannedStartDate || '',
      QRPayload:          buildQrPayload_(palletId, po.ManufacturingOrder, po.Material, po.Batch, qty),
      ScanStatus:         'CREATED',
      TotalQuantity:      Number(po.TotalQuantity) || 0,
      Plant:              po.Plant || '',
      StorageLocation:    po.StorageLocation || '',
      Status:             'CREATED',
      CreatedAt:          now
    }));
    existingIds[palletId] = true;
  }
  return { rows: rows, skipped: skipped, reason: '' };
}

/**
 * Main entry — generate pallets จาก ProductionOrders sheet
 * @param {string=} orderFilter — ระบุ MO เดียว (optional); ไม่ระบุ = ทุก order ที่มี MOQ config
 */
function generatePallets(orderFilter) {
  ensurePalletMasterColumns_();
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var poSheet = ss.getSheetByName('ProductionOrders');
  if (!poSheet || poSheet.getLastRow() < 2) throw new Error('ProductionOrders sheet ว่าง — รัน Phase 1 sync ก่อน');

  var pmSheet = ensurePalletMasterSheet_();
  var existingIds = getExistingPalletIds_(pmSheet);
  var moqMap = getMoqMap();
  if (!Object.keys(moqMap).length) throw new Error('MOQ_Config ว่าง — รัน setupMoqConfig() และใส่ค่า MOQ ก่อน');

  // อ่าน ProductionOrders เป็น objects ตาม header
  var data = poSheet.getDataRange().getValues();
  var hdr = data[0];
  var idx = {};
  hdr.forEach(function (h, i) { idx[h] = i; });

  var allRows = [], stats = { orders: 0, pallets: 0, skippedExisting: 0, noMoq: {} };

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var po = {
      ManufacturingOrder: String(row[idx.ManufacturingOrder]).trim(),
      Material: String(row[idx.Material]).trim(),
      TotalQuantity: row[idx.TotalQuantity],
      ProductionUnit: row[idx.ProductionUnit],
      Batch: row[idx.Batch],
      WorkCenters: row[idx.WorkCenters],
      Plant: row[idx.Plant],
      StorageLocation: row[idx.StorageLocation],
      MfgOrderPlannedStartDate: row[idx.MfgOrderPlannedStartDate]
    };
    if (orderFilter && po.ManufacturingOrder !== String(orderFilter)) continue;

    var cfg = moqMap[po.Material];
    if (!cfg || !cfg.moq) { stats.noMoq[po.Material] = true; continue; }

    var res = splitOrderToPallets_(po, cfg, existingIds);
    if (res.rows.length || res.skipped) stats.orders++;
    stats.pallets += res.rows.length;
    stats.skippedExisting += res.skipped;
    allRows = allRows.concat(res.rows);
  }

  var noMoqList = Object.keys(stats.noMoq);
  var summary = 'Orders=' + stats.orders + ' NewPallets=' + allRows.length +
    ' SkippedExisting=' + stats.skippedExisting +
    (noMoqList.length ? ' | Materials ไม่มี MOQ config: ' + noMoqList.length + ' (' + noMoqList.slice(0, 10).join(', ') + (noMoqList.length > 10 ? '...' : '') + ')' : '');

  if (CFG.DRY_RUN) {
    logEvent('PALLET_GEN', 'DRY_RUN', summary);
    Logger.log('[DRY_RUN] ' + summary);
    return { dryRun: true, wouldCreate: allRows.length, summary: summary };
  }

  if (allRows.length) {
    pmSheet.getRange(pmSheet.getLastRow() + 1, 1, allRows.length, PM_HEADERS.length).setValues(allRows);
  }
  logEvent('PALLET_GEN', 'OK', summary);
  return { dryRun: false, created: allRows.length, summary: summary };
}

// ============================================================================
// Schema repair utilities
// ============================================================================

/**
 * One-time fix: remove duplicate ManufacturingOrder column from PalletMaster.
 * Run ONCE from the Apps Script editor after clasp push.
 * Safe to run again — no-op if no duplicate found.
 */
function fixPalletMasterSchema_() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(PM_SHEET);
  if (!sh) { Logger.log('fixPalletMasterSchema_: PalletMaster not found'); return; }

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Logger.log('Before fix (' + headers.length + ' cols): ' + JSON.stringify(headers));

  var moIndexes = [];
  headers.forEach(function(h, i) {
    if (h === 'ManufacturingOrder') moIndexes.push(i);
  });

  if (moIndexes.length <= 1) {
    Logger.log('fixPalletMasterSchema_: no duplicate ManufacturingOrder — schema OK');
  } else {
    // Delete duplicates right-to-left (keep the first at index 1)
    moIndexes.sort(function(a, b) { return b - a; }); // descending
    moIndexes.slice(0, moIndexes.length - 1).forEach(function(idx) {
      sh.deleteColumn(idx + 1); // convert to 1-based
      Logger.log('Deleted duplicate ManufacturingOrder at 1-based col ' + (idx + 1));
    });
  }

  var newHeaders = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Logger.log('After fix (' + newHeaders.length + ' cols): ' + JSON.stringify(newHeaders));
}

/**
 * Fix corrupted PalletMaster rows where TotalQuantity is missing or QRPayload is wrong.
 * Rebuilds each corrupt row entirely from PO + MaterialMaster data using buildPalletRow_().
 * Respects CFG.DRY_RUN.
 */
function backfillCorruptedPalletRows_() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var pmSh = ss.getSheetByName(PM_SHEET);
  if (!pmSh || pmSh.getLastRow() < 2) {
    Logger.log('backfillCorruptedPalletRows_: PalletMaster empty');
    return;
  }

  var poSh = ss.getSheetByName('ProductionOrders');
  if (!poSh || poSh.getLastRow() < 2) {
    Logger.log('backfillCorruptedPalletRows_: ProductionOrders empty');
    return;
  }

  // Build PO lookup
  var poData = poSh.getDataRange().getValues();
  var poHdrIdx = {};
  poData[0].forEach(function(h, i) { poHdrIdx[h] = i; });
  var poMap = {};
  for (var pr = 1; pr < poData.length; pr++) {
    var moVal = String(poData[pr][poHdrIdx.ManufacturingOrder] || '').trim();
    if (!moVal) continue;
    poMap[moVal] = {
      TotalQuantity:            Number(poData[pr][poHdrIdx.TotalQuantity]) || 0,
      Batch:                    String(poData[pr][poHdrIdx.Batch] || '').trim(),
      Material:                 String(poData[pr][poHdrIdx.Material] || '').trim(),
      WorkCenters:              String(poData[pr][poHdrIdx.WorkCenters] || '').trim(),
      Plant:                    String(poData[pr][poHdrIdx.Plant] || '').trim(),
      StorageLocation:          String(poData[pr][poHdrIdx.StorageLocation] || '').trim(),
      MfgOrderPlannedStartDate: poData[pr][poHdrIdx.MfgOrderPlannedStartDate] || '',
      ProductionUnit:           String(poData[pr][poHdrIdx.ProductionUnit] || '').trim()
    };
  }

  var mmMap = getMaterialMap();

  var pmData = pmSh.getDataRange().getValues();
  var pmIdx = {};
  pmData[0].forEach(function(h, i) { pmIdx[h] = i; });

  var detected = 0;
  var fixed = 0;

  for (var r = 1; r < pmData.length; r++) {
    var row = pmData[r];
    var mo  = String(row[pmIdx.ManufacturingOrder] || '').trim();
    var tq  = row[pmIdx.TotalQuantity];
    var qr  = String(row[pmIdx.QRPayload] || '').trim();
    var pid = String(row[pmIdx.PalletID]  || '').trim();

    var tqMissing  = (tq === '' || tq === null || Number(tq) === 0);
    var qrCorrupt  = (qr.indexOf('PALLET|') !== 0);
    if (!tqMissing && !qrCorrupt) continue;
    if (!mo || !pid) {
      Logger.log('Row ' + (r + 1) + ': missing MO/PalletID — skip');
      continue;
    }

    detected++;
    var po = poMap[mo];
    if (!po) {
      Logger.log('Row ' + (r + 1) + ' ' + pid + ': MO ' + mo + ' not in ProductionOrders — skip');
      continue;
    }

    var mat       = String(row[pmIdx.Material] || '').trim() || po.Material;
    var palletQty = Number(row[pmIdx.QtyPerPallet]) || 0;
    var firstWc   = String(po.WorkCenters || '').split(/[;,]/)[0].trim();
    var newQr     = 'PALLET|' + pid + '|' + mo + '|' + mat + '|' + (po.Batch || '') + '|' + palletQty;
    var matName   = (mmMap[mat] && mmMap[mat].name) ? mmMap[mat].name : '';
    var unit      = (mmMap[mat] && mmMap[mat].unit) ? mmMap[mat].unit : po.ProductionUnit;
    var status    = String(row[pmIdx.Status] || '').trim() || 'CREATED';
    var createdAt = row[pmIdx.CreatedAt] || '';
    var printedAt = row[pmIdx.PrintedAt] || '';

    Logger.log('Backfill row ' + (r + 1) + ' ' + pid +
      ': TotalQty=' + po.TotalQuantity + ' QR=' + newQr + ' WorkCenter="' + firstWc + '"');

    if (!CFG.DRY_RUN) {
      var newRow = buildPalletRow_({
        PalletID:           pid,
        ManufacturingOrder: mo,
        Material:           mat,
        MaterialName:       matName,
        Batch:              po.Batch || '',
        QtyPerPallet:       palletQty,
        Unit:               unit,
        PalletSeq:          Number(row[pmIdx.PalletSeq]) || 0,
        TotalPallets:       Number(row[pmIdx.TotalPallets]) || 0,
        WorkCenter:         firstWc,
        ProductionDate:     po.MfgOrderPlannedStartDate || '',
        QRPayload:          newQr,
        ScanStatus:         'CREATED',
        TotalQuantity:      po.TotalQuantity,
        Plant:              po.Plant || '',
        StorageLocation:    po.StorageLocation || '',
        Status:             status,
        CreatedAt:          createdAt,
        PrintedAt:          printedAt
      });
      pmSh.getRange(r + 1, 1, 1, newRow.length).setValues([newRow]);
      fixed++;
    }
  }

  if (CFG.DRY_RUN) {
    Logger.log('backfillCorruptedPalletRows_: [DRY_RUN] would fix ' + detected + ' corrupted rows');
    logEvent('BACKFILL_PM', '-', 'DRY_RUN', 0, 'would fix ' + detected + ' corrupted rows');
  } else {
    Logger.log('backfillCorruptedPalletRows_: fixed ' + fixed + ' of ' + detected + ' detected rows');
    logEvent('BACKFILL_PM', '-', 'OK', 0, 'fixed ' + fixed + ' corrupted PalletMaster rows');
  }
}

// ============================================================================
// Debug utilities
// ============================================================================

/** Run from Editor → paste full output to confirm column names and data. */
function debugPalletMasterSchema() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName('PalletMaster');
  if (!sh) { Logger.log('PalletMaster sheet NOT FOUND'); return; }

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Logger.log('PalletMaster lastRow=' + sh.getLastRow() +
             ' lastCol=' + sh.getLastColumn());
  Logger.log('PalletMaster headers: ' + JSON.stringify(headers));

  if (sh.getLastRow() > 1) {
    var row1 = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
    Logger.log('Row 1 data: ' + JSON.stringify(row1));
    headers.forEach(function(h, i) {
      Logger.log('  [' + i + '] ' + h + ' = "' + row1[i] + '"');
    });
  }
}

/** สะดวกเรียกจากเมนู: gen เฉพาะ order เดียว */
function generatePalletsForOrder() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Generate Pallets', 'ใส่เลข Manufacturing Order:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var result = generatePallets(resp.getResponseText().trim());
  ui.alert(result.summary);
}

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
var PM_HEADERS = [
  'PalletID', 'ManufacturingOrder', 'Material', 'MaterialName', 'Batch',
  'QtyPerPallet', 'Unit', 'PalletSeq', 'TotalPallets',
  'WorkCenter', 'Plant', 'StorageLocation', 'ProductionDate',
  'Status', 'QRPayload', 'CreatedAt', 'PrintedAt', 'ScannedAt', 'QCResult',
  'TotalQuantity'   // Phase 2.5: MO total qty — added at end to avoid shifting existing columns
];

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

  var required = [
    'PalletID', 'ManufacturingOrder', 'Material', 'MaterialName', 'Batch',
    'QtyPerPallet', 'Unit', 'PalletSeq', 'TotalPallets',
    'WorkCenter', 'Plant', 'StorageLocation', 'ProductionDate',
    'TotalQuantity',
    'Status', 'QRPayload', 'CreatedAt', 'PrintedAt', 'ScannedAt', 'QCResult'
  ];

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
    rows.push([
      palletId, po.ManufacturingOrder, po.Material, moqCfg.name || '', po.Batch || '',
      qty, moqCfg.unit || po.ProductionUnit, seq, totalPallets,
      firstWc, po.Plant, po.StorageLocation, po.MfgOrderPlannedStartDate || '',
      'CREATED',
      buildQrPayload_(palletId, po.ManufacturingOrder, po.Material, po.Batch, qty),
      now, '', '', '',
      Number(po.TotalQuantity) || 0  // TotalQuantity of MO — Phase 2.5
    ]);
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

/** สะดวกเรียกจากเมนู: gen เฉพาะ order เดียว */
function generatePalletsForOrder() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Generate Pallets', 'ใส่เลข Manufacturing Order:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var result = generatePallets(resp.getResponseText().trim());
  ui.alert(result.summary);
}

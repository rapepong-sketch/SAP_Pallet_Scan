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
/**
 * 41-col layout — identical to CFG.HEADERS.PALLET_MASTER.
 * Indices 22-26 are Phase 3 SAP writeback columns added in the 28→33 migration.
 * Indices 33-35 are Phase 3.5 override audit columns.
 * Indices 36-39 are Phase 3.5 Gate 2 yield-bucket columns.
 * Index 40 is Phase 4.5 Gate 3a QCInspector column.
 * buildPalletRow_() maps by name, so callers that don't set the new keys
 * automatically get '' for those columns.
 */
var PM_HEADERS = [
  'PalletID',               // 0
  'ManufacturingOrder',      // 1
  'Material',                // 2
  'MaterialName',            // 3
  'Batch',                   // 4
  'QtyPerPallet',            // 5
  'Unit',                    // 6
  'PalletSeq',               // 7
  'TotalPallets',            // 8
  'WorkCenter',              // 9
  'ProductionDate',          // 10
  'TotalQuantity',           // 11
  'Plant',                   // 12
  'StorageLocation',         // 13
  'QRPayload',               // 14
  'Status',                  // 15
  'CreatedAt',               // 16
  'PrintedAt',               // 17
  'ScannedAt',               // 18
  'ScannedBy',               // 19
  'ScanStatus',              // 20
  'GRMaterialDocument',      // 21
  'GRMaterialDocumentYear',  // 22 — Phase 3 writeback
  'ConfirmationGroup',       // 23 — Phase 3 writeback
  'ConfirmationCount',       // 24 — Phase 3 writeback
  'ConfirmedAt',             // 25 — Phase 3 writeback
  'ConfirmedBy',             // 26 — Phase 3 writeback
  'QCStatus',                // 27
  'QCResult',                // 28
  'InspectionLot',           // 29
  'LabelPrintedAt',          // 30
  'UpdatedAt',               // 31
  'QCResultNote',            // 32
  'OverrideBy',              // 33
  'OverrideReason',          // 34
  'OverrideAt',              // 35
  'GoodQty',                 // 36 — Phase 3.5 yield bucket
  'RepairQty',               // 37 — Phase 3.5 yield bucket
  'DefectQty',               // 38 — Phase 3.5 yield bucket
  'AwaitConvQty',            // 39 — Phase 3.5 yield bucket
  'QCInspector'              // 40 — Phase 4.5 Gate 3a
];

/**
 * Build a 41-col PalletMaster row array aligned to PM_HEADERS (= CFG layout).
 * values = object keyed by column name; missing keys get ''.
 * Always use this instead of positional arrays — immune to column reorder.
 */
function buildPalletRow_(values) {
  return PM_HEADERS.map(function(h) {
    return values.hasOwnProperty(h) ? values[h] : '';
  });
}

/**
 * Reconstruct a work center code string from a Date object.
 * Google Sheets auto-parses single WC codes like "0408-02" as dates
 * (year=408, month=Feb). JS Date.getMonth() is 0-indexed so Feb=1, +1=2.
 * This function reverses the parse: year zero-padded to 4 digits + "-" + month.
 *   "0408-02" → stored as Date(year=408, month=1) → getFullYear()=408, getMonth()+1=2 → "0408-02"
 *   "0703-02" → stored as Date(year=703, month=1) → getFullYear()=703, getMonth()+1=2 → "0703-02"
 */
function dateToWorkCenter_(d) {
  if (!(d instanceof Date)) return String(d || '').trim();
  var year  = d.getFullYear();
  var month = d.getMonth() + 1; // getMonth() is 0-indexed
  return ('0000' + year).slice(-4) + '-' + ('00' + month).slice(-2);
}

// Status lifecycle: CREATED → PRINTED → SCANNED(GR) → QC_PASS/QC_HOLD/QC_REJECT

function ensurePalletMasterSheet_() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(PM_SHEET) || ss.insertSheet(PM_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, PM_HEADERS.length).setValues([PM_HEADERS])
      .setFontWeight('bold').setBackground('#0b8043').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  var wcCol = PM_HEADERS.indexOf('WorkCenter') + 1;
  sh.getRange(1, wcCol, sh.getMaxRows(), 1).setNumberFormat('@');
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
    var wcRaw = row[idx.WorkCenters];
    var po = {
      ManufacturingOrder: String(row[idx.ManufacturingOrder]).trim(),
      Material: String(row[idx.Material]).trim(),
      TotalQuantity: row[idx.TotalQuantity],
      ProductionUnit: row[idx.ProductionUnit],
      Batch: row[idx.Batch],
      WorkCenters: dateToWorkCenter_(wcRaw),
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
// 28→33 column migration (run once from Apps Script editor)
// ============================================================================

/**
 * One-time migration: fix 28-col data vs 33-col header desync.
 * Inserts 5 blank writeback columns at position 22 (GRMaterialDocumentYear …
 * ConfirmedBy), shifting QCStatus+ data to its correct CFG position.
 * Idempotent: skips if data already looks migrated.
 * Run from Apps Script editor → select migratePalletMaster33Col → Run.
 */
function migratePalletMaster33Col() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(PM_SHEET);
  if (!sh) throw new Error('PalletMaster sheet not found');

  // ── STEP 0: BACKUP ──────────────────────────────────────────────────────
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd_HHmm');
  var backupName = 'PalletMaster_BACKUP_' + stamp;
  try {
    var backupSh = sh.copyTo(ss);
    backupSh.setName(backupName);
    logEvent('MIGRATE', 'BACKUP', 'OK', 0, backupName);
    Logger.log('STEP 0 BACKUP: created ' + backupName);
  } catch (e) {
    logEvent('MIGRATE', 'BACKUP', 'FAIL', 0, e.message);
    throw new Error('STEP 0 BACKUP FAILED — migration aborted: ' + e.message);
  }

  // ── STEP 1: PRECONDITION RE-CHECK ───────────────────────────────────────
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Logger.log('STEP 1: header length=' + hdr.length + ' header[22]=' + hdr[22]);

  if (hdr.length !== 33 || hdr[22] !== 'GRMaterialDocumentYear') {
    var msg = 'unexpected header: length=' + hdr.length + ' header[22]=' + hdr[22];
    logEvent('MIGRATE', 'PRECONDITION', 'FAIL', 0, msg);
    throw new Error('STEP 1 PRECONDITION FAILED — ' + msg);
  }

  // Check if already migrated: QCResult at CFG idx28 should hold 'PASS' for
  // the known QC rows, AND ConfirmationGroup at idx23 should be blank.
  if (sh.getLastRow() >= 2) {
    var probe = sh.getRange(2, 1, sh.getLastRow() - 1, hdr.length).getValues();
    var alreadyMigrated = probe.every(function(row) {
      var confGroup = String(row[23] || '').trim();
      var qcResult  = String(row[28] || '').trim();
      var oldQcSlot = String(row[22] || '').trim(); // would be QCStatus if unmigrated
      // Migrated = confGroup is blank/numeric AND old QC slot is not a QC status value
      var QC_VALUES = { 'INSPECTED': 1, 'PASS': 1, 'FAIL': 1, 'HOLD': 1, 'REJECT': 1 };
      return !QC_VALUES[oldQcSlot.toUpperCase()];
    });

    if (alreadyMigrated) {
      logEvent('MIGRATE', 'SKIP', 'OK', 0, 'already migrated — no QC data at idx22');
      Logger.log('STEP 1: already migrated — skipping');
      return { status: 'SKIP', message: 'already migrated', backup: backupName };
    }
  }

  Logger.log('STEP 1: precondition passed — data is 28-col aligned, proceeding');

  // ── STEP 2: INSERT 5 COLUMNS ───────────────────────────────────────────
  sh.insertColumnsBefore(23, 5);
  Logger.log('STEP 2: inserted 5 columns before col 23');

  // Overwrite header with the canonical 33-col CFG layout
  var cfgHeaders = CFG.HEADERS.PALLET_MASTER;
  sh.getRange(1, 1, 1, cfgHeaders.length)
    .setValues([cfgHeaders])
    .setFontWeight('bold')
    .setBackground('#0b8043')
    .setFontColor('#ffffff');
  sh.setFrozenRows(1);

  // Delete leftover columns beyond 33 (old header cols shifted right by the insert)
  var totalAfterInsert = sh.getLastColumn();
  if (totalAfterInsert > cfgHeaders.length) {
    sh.deleteColumns(cfgHeaders.length + 1, totalAfterInsert - cfgHeaders.length);
    Logger.log('STEP 2: deleted ' + (totalAfterInsert - cfgHeaders.length) + ' leftover columns');
  }

  // Plain-text format on WorkCenter column to prevent date auto-parse
  var wcCol = cfgHeaders.indexOf('WorkCenter') + 1;
  if (wcCol > 0) {
    sh.getRange(1, wcCol, sh.getMaxRows(), 1).setNumberFormat('@');
  }

  logEvent('MIGRATE', 'SHIFT', 'OK', 0, 'inserted 5 cols at 23, header reset to CFG 33-col');
  Logger.log('STEP 2: header overwritten with CFG.HEADERS.PALLET_MASTER (33 cols)');

  // ── STEP 4: VERIFY ─────────────────────────────────────────────────────
  var verifyIds = ['PL-1000036350-L01', 'PL-1000034813-L02'];
  var newHdr = sh.getRange(1, 1, 1, cfgHeaders.length).getValues()[0];
  var colByName = {};
  newHdr.forEach(function(h, i) { colByName[h] = i; });

  var allPass = true;
  var dataRows = sh.getLastRow() >= 2
    ? sh.getRange(2, 1, sh.getLastRow() - 1, cfgHeaders.length).getValues()
    : [];

  var expectations = {
    ConfirmationGroup:      '',
    ConfirmationCount:      '',
    GRMaterialDocumentYear: '',
    QCStatus:               'INSPECTED',
    QCResult:               'PASS'
  };

  verifyIds.forEach(function(pid) {
    var row = null;
    for (var r = 0; r < dataRows.length; r++) {
      if (String(dataRows[r][0] || '').trim() === pid) { row = dataRows[r]; break; }
    }
    if (!row) {
      Logger.log('STEP 4 VERIFY ' + pid + ': row not found — may not have QC data, skip');
      return;
    }

    Object.keys(expectations).forEach(function(col) {
      var idx = colByName[col];
      var actual   = String(row[idx] || '').trim();
      var expected = expectations[col];
      var ok = (actual === expected);
      if (!ok) allPass = false;
      Logger.log('STEP 4 ' + pid + ' ' + col + '(idx' + idx + '): ' +
        (ok ? 'PASS' : 'FAIL') + ' expected="' + expected + '" actual="' + actual + '"');
    });
  });

  if (allPass) {
    logEvent('MIGRATE', 'VERIFY', 'OK', 0, 'all expectations passed for ' + verifyIds.join(', '));
    Logger.log('STEP 4: ALL PASS');
  } else {
    logEvent('MIGRATE', 'VERIFY', 'FAIL', 0,
      'some expectations failed — backup sheet: ' + backupName);
    Logger.log('STEP 4: SOME CHECKS FAILED — restore from backup: ' + backupName);
  }

  return { status: allPass ? 'OK' : 'VERIFY_FAIL', backup: backupName };
}

// ============================================================================
// Nuclear reset utilities (run once after schema corruption)
// ============================================================================

/** Step 3a: Delete ALL data rows — keeps header row intact. Triggered from Admin menu. */
function hardResetPalletMaster() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(PM_SHEET);
  if (!sh) { Logger.log('hardResetPalletMaster: PalletMaster sheet NOT FOUND'); return; }

  var lastRow  = sh.getLastRow();
  var dataRows = Math.max(0, lastRow - 1);

  var ui   = SpreadsheetApp.getUi();
  var resp = ui.alert(
    '⚠️ Reset PalletMaster',
    'จะลบข้อมูลทั้งหมดใน PalletMaster (' + dataRows + ' rows)\nยืนยัน?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) {
    Logger.log('hardResetPalletMaster: Cancelled by user');
    return;
  }

  if (dataRows > 0) {
    sh.deleteRows(2, dataRows);
    Logger.log('hardResetPalletMaster: Deleted ' + dataRows + ' data rows');
  } else {
    Logger.log('hardResetPalletMaster: No data rows to delete');
  }
  Logger.log('PalletMaster reset complete — header row preserved');
  ui.alert('✅ Done', 'Deleted ' + dataRows + ' rows. Run "Rebuild PM Header" next.', ui.ButtonSet.OK);
}

/** Step 3b: Rebuild header row to match PM_HEADERS exactly. Run from editor. */
function rebuildPalletMasterHeader() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(PM_SHEET);
  if (!sh) { Logger.log('rebuildPalletMasterHeader: PalletMaster sheet NOT FOUND'); return; }

  // Clear entire header row (including any extra columns beyond PM_HEADERS)
  if (sh.getLastColumn() > 0) {
    sh.getRange(1, 1, 1, sh.getLastColumn()).clearContent();
  }

  // Write correct headers
  sh.getRange(1, 1, 1, PM_HEADERS.length)
    .setValues([PM_HEADERS])
    .setFontWeight('bold')
    .setBackground('#0b8043')
    .setFontColor('#ffffff');

  sh.setFrozenRows(1);
  var wcCol = PM_HEADERS.indexOf('WorkCenter') + 1;
  sh.getRange(1, wcCol, sh.getMaxRows(), 1).setNumberFormat('@');
  Logger.log('rebuildPalletMasterHeader: wrote ' + PM_HEADERS.length + ' columns');
  Logger.log(JSON.stringify(PM_HEADERS));
}

// ============================================================================
// Backfill utilities
// ============================================================================

function backfillMaterialName() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var pmSh = ss.getSheetByName('PalletMaster');
  if (!pmSh || pmSh.getLastRow() < 2) {
    Logger.log('PalletMaster empty'); return;
  }

  var matMap = getMaterialMap();
  Logger.log('getMaterialMap keys: ' + Object.keys(matMap).length);
  Logger.log('Sample keys: ' + Object.keys(matMap).slice(0, 3).join(', '));

  var hdrs    = pmSh.getRange(1, 1, 1, pmSh.getLastColumn()).getValues()[0];
  var matIdx  = hdrs.indexOf('Material');
  var nameIdx = hdrs.indexOf('MaterialName');
  Logger.log('Material col: ' + matIdx + ', MaterialName col: ' + nameIdx);
  if (matIdx < 0 || nameIdx < 0) { Logger.log('backfillMaterialName: column not found'); return; }

  var data    = pmSh.getRange(2, 1, pmSh.getLastRow() - 1, pmSh.getLastColumn()).getValues();
  var updated = 0;
  data.forEach(function(row, i) {
    var mat         = String(row[matIdx]  || '').trim();
    var currentName = String(row[nameIdx] || '').trim();
    Logger.log('Row ' + (i + 2) + ': mat=[' + mat + '] name=[' + currentName + ']');

    if (!currentName && mat) {
      var entry = matMap[mat];
      Logger.log('  matMap entry: ' + JSON.stringify(entry));
      var name = (entry && entry.name) ? entry.name : '';
      if (name) {
        if (!CFG.DRY_RUN) {
          pmSh.getRange(i + 2, nameIdx + 1).setValue(name);
        }
        Logger.log('  ' + (CFG.DRY_RUN ? '[DRY]' : '') + 'Filled: ' + name);
        updated++;
      } else {
        Logger.log('  WARNING: no name in MaterialMaster for: ' + mat);
      }
    }
  });
  Logger.log('backfillMaterialName: updated=' + updated + ' DRY_RUN=' + CFG.DRY_RUN);
}

// debugMaterialName → moved to Tests.gs

function backfillWorkCenter() {
  var ss   = SpreadsheetApp.openById(CFG.SHEET_ID);
  var pmSh = ss.getSheetByName('PalletMaster');
  if (!pmSh || pmSh.getLastRow() < 2) { Logger.log('backfillWorkCenter: no data rows'); return; }

  // Ensure column is plain-text format so fixed values are not re-parsed as dates
  var wcCol = PM_HEADERS.indexOf('WorkCenter') + 1;
  pmSh.getRange(1, wcCol, pmSh.getMaxRows(), 1).setNumberFormat('@');

  var hdrs  = pmSh.getRange(1, 1, 1, pmSh.getLastColumn()).getValues()[0];
  var wcIdx = hdrs.indexOf('WorkCenter');
  if (wcIdx < 0) { Logger.log('backfillWorkCenter: WorkCenter column not found'); return; }

  var data  = pmSh.getRange(2, 1, pmSh.getLastRow() - 1, pmSh.getLastColumn()).getValues();
  var fixed = 0;
  data.forEach(function(row, i) {
    var wc = row[wcIdx];
    if (wc instanceof Date) {
      var fixedWc = dateToWorkCenter_(wc);
      pmSh.getRange(i + 2, wcIdx + 1).setValue(fixedWc);
      fixed++;
      Logger.log('Fixed row ' + (i + 2) + ': ' + fixedWc);
    }
  });
  Logger.log('backfillWorkCenter: fixed ' + fixed + ' rows');
}

// debugPalletMasterSchema → moved to Tests.gs

// ============================================================================
// Phase 3.5 schema migration
// ============================================================================

/**
 * Phase 3.5 migration: append OverrideBy/OverrideReason/OverrideAt to the live
 * PalletMaster header row (columns 34-36). Backs up first, idempotent, verifies.
 * Never touches any data row. Reuse existing helpers for the spreadsheet/sheet
 * handle and for logEvent; if a CFG constant holds the PalletMaster tab name,
 * use it instead of a literal.
 * @return {{status:string, backup:string}}
 */
function migrateOverrideColumns() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!sh) throw new Error('migrateOverrideColumns: PalletMaster sheet not found');

  // STEP 0 BACKUP
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  var backupName = 'PalletMaster_bak_' + stamp;
  var bak = sh.copyTo(ss);
  bak.setName(backupName);
  Logger.log('STEP 0: backup created → ' + backupName);

  // STEP 1 IDEMPOTENCY
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (hdr.indexOf('OverrideBy') !== -1) {
    Logger.log('already migrated');
    return { status: 'SKIP', backup: '' };
  }

  // STEP 2 PRECONDITION
  if (hdr.length !== 33 || hdr[32] !== 'QCResultNote') {
    var msg = 'unexpected layout: length=' + hdr.length + ' col33=' + hdr[32];
    logEvent('MIGRATE', 'OVERRIDE_COLS', 'FAIL', 0, msg);
    throw new Error('migrateOverrideColumns PRECONDITION FAILED — ' + msg);
  }

  // STEP 3 WRITE
  var newCols = [['OverrideBy', 'OverrideReason', 'OverrideAt']];
  sh.getRange(1, 34, 1, 3).setValues(newCols);
  Logger.log('STEP 3: wrote 3 override columns at 34-36');

  // STEP 4 VERIFY
  var verified = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var ok = verified.length === 36 &&
           verified[33] === 'OverrideBy' &&
           verified[34] === 'OverrideReason' &&
           verified[35] === 'OverrideAt';
  logEvent('MIGRATE', 'OVERRIDE_COLS', ok ? 'OK' : 'FAIL', 0,
    'len=' + verified.length + ' [33]=' + verified[33] + ' [34]=' + verified[34] + ' [35]=' + verified[35]);
  Logger.log('STEP 4: ' + (ok ? 'PASS' : 'FAIL') + ' — ' + JSON.stringify(verified));

  if (!ok) throw new Error('migrateOverrideColumns VERIFY FAILED');
  return { status: 'OK', backup: backupName };
}

/** สะดวกเรียกจากเมนู: gen เฉพาะ order เดียว */
function generatePalletsForOrder() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Generate Pallets', 'ใส่เลข Manufacturing Order:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var result = generatePallets(resp.getResponseText().trim());
  ui.alert(result.summary);
}

// ============================================================================
// Admin — Delete Test Pallets (PL-TEST-* prefix)
// ============================================================================

/**
 * Delete all PalletMaster rows whose PalletID starts with 'PL-TEST-'
 * (case-insensitive). Backs up the sheet first, skips any row that is
 * already CONFIRMED or has a non-empty ConfirmationGroup, deletes
 * bottom-to-top, verifies postcondition, and logs the operation.
 *
 * @return {{deleted:string[], skipped:string[], backupSheet:string, finalRowCount:number}}
 */
function deleteTestPallets() {
  var ui = SpreadsheetApp.getUi();
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    ui.alert('PalletMaster is empty — nothing to delete.');
    return JSON.parse(JSON.stringify({ deleted: [], skipped: [], backupSheet: '', finalRowCount: 0 }));
  }

  // ---- 1. Backup ----
  var now = new Date();
  var bkk = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyyMMdd_HHmmss');
  var backupName = 'PalletMaster_bak_' + bkk;
  sh.copyTo(ss).setName(backupName);
  SpreadsheetApp.flush();

  // ---- 2. Scan for PL-TEST-* rows ----
  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  var palletIdCol = idx['PalletID'];
  var statusCol   = idx['ScanStatus'];
  var cgCol       = idx['ConfirmationGroup'];

  var toDelete = [];
  var toSkip   = [];

  for (var r = 1; r < data.length; r++) {
    var pid = String(data[r][palletIdCol] || '').trim();
    if (!/^PL-TEST-/i.test(pid)) continue;

    var scanStatus = String(data[r][statusCol] || '').trim();
    var cgVal = (cgCol !== undefined) ? String(data[r][cgCol] || '').trim() : '';

    if (scanStatus === 'CONFIRMED' || cgVal !== '') {
      toSkip.push(pid);
    } else {
      toDelete.push({ palletId: pid, rowNum: r + 1 });
    }
  }

  // ---- Confirm with admin ----
  if (toDelete.length === 0 && toSkip.length === 0) {
    ui.alert('No PL-TEST-* rows found in PalletMaster.');
    return JSON.parse(JSON.stringify({ deleted: [], skipped: [], backupSheet: backupName, finalRowCount: sh.getLastRow() - 1 }));
  }

  var confirmMsg = 'Backup: ' + backupName + '\n\n' +
    'Delete ' + toDelete.length + ' test pallet(s):\n' +
    toDelete.map(function(d) { return '  ' + d.palletId + ' (row ' + d.rowNum + ')'; }).join('\n') +
    (toSkip.length ? '\n\nSkip (confirmed): ' + toSkip.join(', ') : '') +
    '\n\nProceed?';

  var resp = ui.alert('🧹 Delete Test Pallets', confirmMsg, ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) {
    ui.alert('Cancelled.');
    return JSON.parse(JSON.stringify({ deleted: [], skipped: toSkip, backupSheet: backupName, finalRowCount: sh.getLastRow() - 1 }));
  }

  // ---- 3. Delete bottom-to-top ----
  toDelete.sort(function(a, b) { return b.rowNum - a.rowNum; });
  var deletedIds = [];
  for (var d = 0; d < toDelete.length; d++) {
    sh.deleteRow(toDelete[d].rowNum);
    deletedIds.push(toDelete[d].palletId);
  }
  SpreadsheetApp.flush();

  // ---- 4. Postcondition: verify zero PL-TEST-* remain (except skipped) ----
  var postData = sh.getDataRange().getValues();
  var remaining = [];
  for (var p = 1; p < postData.length; p++) {
    var pid2 = String(postData[p][palletIdCol] || '').trim();
    if (/^PL-TEST-/i.test(pid2)) remaining.push(pid2);
  }
  var unexpected = remaining.filter(function(id) { return toSkip.indexOf(id) === -1; });
  var finalRowCount = postData.length - 1;

  // ---- 5. Log ----
  var detail = JSON.stringify({
    deleted: deletedIds,
    skipped: toSkip,
    remaining: remaining,
    backupSheet: backupName,
    finalRowCount: finalRowCount
  });
  logEvent('DELETE_TEST_PALLETS', unexpected.length === 0 ? 'OK' : 'WARN', detail);

  // ---- 6. Report ----
  var summaryMsg = '✅ Deleted ' + deletedIds.length + ' test pallet(s).\n' +
    'Backup: ' + backupName + '\n' +
    (toSkip.length ? 'Skipped (confirmed): ' + toSkip.join(', ') + '\n' : '') +
    (unexpected.length ? '⚠️ Unexpected remaining: ' + unexpected.join(', ') + '\n' : '') +
    'Final row count: ' + finalRowCount;
  ui.alert('🧹 Result', summaryMsg, ui.ButtonSet.OK);

  return JSON.parse(JSON.stringify({
    deleted: deletedIds,
    skipped: toSkip,
    backupSheet: backupName,
    finalRowCount: finalRowCount
  }));
}

/**
 * TransferSlip.gs — Phase 3.5 Step 2a/2c
 * ========================================
 * Half-A4 "ใบกำกับพาเลท" transfer slip for CONFIRMED pallets.
 * Step 2c adds FIFO pick issue slips, remaining slips, and menu UI.
 * Print-only, READ-ONLY on PalletMaster — no status writes.
 *
 * Layout: 2 slips per A4 page (190mm × 135mm each).
 * Reuses: buildPsQrUrl_(payload), esc_(s) from PalletSheet.gs
 *         PM_HEADERS from PalletGen.gs, MM_HEADERS from MaterialMaster.gs
 *         commitFifoPick_, planFifoPick_ from TransferLog.gs
 */

// ============================================================================
// Data loaders
// ============================================================================

/**
 * Read CONFIRMED pallet rows from PalletMaster filtered by mode.
 * Column positions resolved by NAME via PM_HEADERS — never numeric index.
 *
 * @param {{ mode: 'mo'|'palletId'|'todayConfirmed', value: string }} filter
 * @return {Array<{PalletID:string, ManufacturingOrder:string, Material:string,
 *   MaterialName:string, Batch:string, QtyPerPallet:number, Unit:string,
 *   StorageLocation:string, ProductionDate:*, WorkCenter:string,
 *   InspectionLot:string, QCStatus:string, QCResult:string,
 *   PalletSeq:number, TotalPallets:number, ConfirmedAt:*, LotNo:string}>}
 */
function getSlipPalletsByFilter_(filter) {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  var needed = [
    'PalletID', 'ManufacturingOrder', 'Material', 'MaterialName', 'Batch',
    'QtyPerPallet', 'Unit', 'StorageLocation', 'ProductionDate', 'WorkCenter',
    'InspectionLot', 'QCStatus', 'QCResult', 'PalletSeq', 'TotalPallets',
    'ScanStatus', 'ConfirmedAt'
  ];
  for (var k = 0; k < needed.length; k++) {
    if (idx[needed[k]] === undefined) {
      logEvent('SLIP_FILTER', 'PalletMaster', 'ERROR', 0, 'Missing column: ' + needed[k]);
      return [];
    }
  }

  var todayStr = '';
  if (filter.mode === 'todayConfirmed') {
    todayStr = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  }

  var results = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (String(row[idx['ScanStatus']] || '').trim() !== 'CONFIRMED') continue;

    var match = false;
    if (filter.mode === 'mo') {
      match = String(row[idx['ManufacturingOrder']] || '').trim() === filter.value;
    } else if (filter.mode === 'palletId') {
      match = String(row[idx['PalletID']] || '').trim() === filter.value;
    } else if (filter.mode === 'todayConfirmed') {
      var ca = row[idx['ConfirmedAt']];
      if (ca instanceof Date) {
        match = Utilities.formatDate(ca, 'Asia/Bangkok', 'yyyy-MM-dd') === todayStr;
      }
    }
    if (!match) continue;

    var wc    = row[idx['WorkCenter']];
    var batch = String(row[idx['Batch']] || '').trim();
    var pid   = String(row[idx['PalletID']] || '').trim();
    results.push({
      PalletID:           pid,
      ManufacturingOrder: String(row[idx['ManufacturingOrder']] || '').trim(),
      Material:           String(row[idx['Material']] || '').trim(),
      MaterialName:       String(row[idx['MaterialName']] || '').trim(),
      Batch:              batch,
      QtyPerPallet:       Number(row[idx['QtyPerPallet']]) || 0,
      Unit:               String(row[idx['Unit']] || '').trim(),
      StorageLocation:    String(row[idx['StorageLocation']] || '').trim(),
      ProductionDate:     row[idx['ProductionDate']] || null,
      WorkCenter:         (wc instanceof Date) ? dateToWorkCenter_(wc) : String(wc || '').trim(),
      InspectionLot:      String(row[idx['InspectionLot']] || '').trim(),
      QCStatus:           String(row[idx['QCStatus']] || '').trim(),
      QCResult:           String(row[idx['QCResult']] || '').trim(),
      PalletSeq:          Number(row[idx['PalletSeq']]) || 0,
      TotalPallets:       Number(row[idx['TotalPallets']]) || 0,
      ConfirmedAt:        row[idx['ConfirmedAt']] || null,
      LotNo:              batch ? batch : pid
    });
  }

  results.sort(function(a, b) {
    if (a.ManufacturingOrder !== b.ManufacturingOrder) {
      return a.ManufacturingOrder < b.ManufacturingOrder ? -1 : 1;
    }
    return a.PalletSeq - b.PalletSeq;
  });

  return results;
}

/**
 * Read MaterialMaster and return { [Material]: ProductGroup } map.
 * Uses MM_HEADERS for column resolution — does NOT touch getMaterialMap().
 *
 * @return {Object.<string, string>}
 */
function getProductGroupMap_() {
  var sh = getSpreadsheet_().getSheetByName(MM_SHEET);
  if (!sh || sh.getLastRow() < 2) return {};

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  var matCol = idx['Material'];
  var pgCol  = idx['ProductGroup'];
  if (matCol === undefined || pgCol === undefined) return {};

  var map = {};
  for (var r = 1; r < data.length; r++) {
    var mat = String(data[r][matCol] || '').trim();
    if (mat) map[mat] = String(data[r][pgCol] || '').trim();
  }
  return map;
}

/**
 * Stock-driven cascade for AdminSlip Card 2: SLoc → ProductGroup → Material.
 * Material set is IDENTICAL to slipGetMaterialsForSloc (reuses its stock scan).
 * ProductGroup looked up via getMaterialMap(); ungrouped → '(ไม่ระบุกลุ่ม)'.
 *
 * @param {string} sloc — StorageLocation
 * @return {{ productGroups: string[], byGroup: Object.<string, Array<{code:string, name:string, availQty:number}>> }}
 */
function slipGetCascadeForSloc_(sloc) {
  var FALLBACK = '(ไม่ระบุกลุ่ม)';

  var stockResult = slipGetMaterialsForSloc(sloc);
  if (!stockResult.ok) throw new Error(stockResult.error || 'stock query failed');

  var materials = stockResult.materials || [];
  var mmMap = getMaterialMap();

  var byGroup = {};
  for (var i = 0; i < materials.length; i++) {
    var m  = materials[i];
    var mm = mmMap[m.material];
    var group = (mm && mm.productGroup) ? mm.productGroup : FALLBACK;
    var name  = (mm && mm.name) ? mm.name : m.name;

    if (!byGroup[group]) byGroup[group] = [];
    byGroup[group].push({ code: m.material, name: name, availQty: m.availQty });
  }

  var productGroups = Object.keys(byGroup).sort(function(a, b) {
    if (a === FALLBACK) return 1;
    if (b === FALLBACK) return -1;
    return a < b ? -1 : (a > b ? 1 : 0);
  });

  for (var g = 0; g < productGroups.length; g++) {
    byGroup[productGroups[g]].sort(function(a, b) {
      return a.code < b.code ? -1 : (a.code > b.code ? 1 : 0);
    });
  }

  return { productGroups: productGroups, byGroup: byGroup };
}

// ============================================================================
// QR payload
// ============================================================================

/**
 * Build a compact QR payload for the transfer slip.
 * Format: P:{Material}|Q:{Qty}|L:{LotNo}|Loc:{StorageLocation}|
 *
 * @param {{Material:string, QtyPerPallet:number, LotNo:string, StorageLocation:string}} p
 * @return {string}
 */
function slipQrPayload_(p) {
  return 'P:' + p.Material +
    '|Q:' + p.QtyPerPallet +
    '|L:' + p.LotNo +
    '|Loc:' + p.StorageLocation + '|';
}

/**
 * Build QR payload for an issue slip (split-issue TransferLog row).
 * Format: T:{TxnID}|P:{Material}|Q:{IssueQty}|L:{LotNo}|Loc:{SourceSLoc}|
 *
 * @param {{TxnID:string, Material:string, IssueQty:number, LotNo:string, SourceSLoc:string}} row
 * @return {string}
 */
function issueSlipQrPayload_(row) {
  return 'T:' + row.TxnID +
    '|P:' + row.Material +
    '|Q:' + row.IssueQty +
    '|L:' + row.LotNo +
    '|Loc:' + row.SourceSLoc + '|';
}

/**
 * Build QR payload for a remaining-balance slip.
 * Format: P:{Material}|Q:{remaining}|L:{LotNo}|Loc:{StorageLocation}|
 *
 * @param {{Material:string, LotNo:string, StorageLocation:string}} p
 * @param {number} remaining
 * @return {string}
 */
function remainSlipQrPayload_(p, remaining) {
  return 'P:' + p.Material +
    '|Q:' + remaining +
    '|L:' + p.LotNo +
    '|Loc:' + p.StorageLocation + '|';
}

// ============================================================================
// Single slip HTML
// ============================================================================

/**
 * Build one half-A4 slip HTML fragment (190mm × 135mm).
 * Supports badge/QR/qty/lot/refDoc overrides via opts for issue and remaining slips.
 * Default (no opts) renders the original 'รับเข้าผลิตใหม่' slip identically.
 *
 * @param {Object} p — pallet row (from getSlipPalletsByFilter_ or loadParentPalletsForPick_)
 * @param {Object.<string, string>} pgMap — Material → ProductGroup map
 * @param {string} ts — formatted timestamp for print date
 * @param {{badgeText?:string, badgeColor?:string, qrPayload?:string,
 *   qtyOverride?:number, lotOverride?:string, refDoc?:string}} [opts]
 * @return {string} HTML fragment (one .slip div)
 */
function buildOneSlipHtml_(p, pgMap, ts, opts) {
  opts = opts || {};
  var badgeText  = opts.badgeText  || 'รับเข้าผลิตใหม่';
  var badgeColor = opts.badgeColor || '#c0392b';
  var displayQty = opts.qtyOverride != null ? opts.qtyOverride : p.QtyPerPallet;
  var displayLot = opts.lotOverride || p.LotNo;
  var refDocVal  = opts.refDoc || '';

  var mfgDate = '-';
  if (p.ConfirmedAt instanceof Date) {
    mfgDate = Utilities.formatDate(p.ConfirmedAt, 'Asia/Bangkok', 'dd/MM/yyyy');
  }

  var qrPayload = opts.qrPayload || slipQrPayload_(p);
  var qrSrc = buildPsQrUrl_(qrPayload);
  var pg    = pgMap[p.Material] || '-';

  var h = '';
  h += '<div class="slip">';

  // ---- Header row ----
  h += '<div class="slip-hdr">';
  h += '<span class="slip-title">ใบกำกับพาเลท</span>';
  h += '<span class="slip-badge" style="background:' + badgeColor + '">' + esc_(badgeText) + '</span>';
  h += '</div>';

  var transferStampHtml = opts.transferable
    ? '<div style="display:inline-block;padding:4px 12px;border-radius:4px;' +
      'font-size:12px;font-weight:bold;margin-top:6px;margin-left:6px;' +
      'background:#1e8449;color:#fff;">✅ โอนย้ายได้ — สแกน QR เพื่อโอนย้าย</div>'
    : '<div style="display:inline-block;padding:4px 12px;border-radius:4px;' +
      'font-size:12px;font-weight:bold;margin-top:6px;margin-left:6px;' +
      'background:#c0392b;color:#fff;">🚫 ไม่สามารถโอนย้ายได้</div>';
  h += transferStampHtml;

  // ---- Big row: PART NO / QTY / หน่วย ----
  h += '<div class="slip-bigrow">';
  h += '<span class="big-part">PART NO : <b>' + esc_(p.Material) + '</b></span>';
  h += '<span class="big-qty">QTY : <b>' + esc_(String(displayQty)) + '</b></span>';
  h += '<span class="big-unit">หน่วย : <b>' + esc_(p.Unit) + '</b></span>';
  h += '</div>';

  // ---- Body: info grid + QR ----
  h += '<div class="slip-body">';

  // Info grid
  h += '<div class="slip-fields">';
  h += slipRow_('Model', esc_(pg));
  h += slipRow_('DESC.', esc_(p.MaterialName));
  h += slipRow_('LOT NO.', esc_(displayLot));
  h += slipRow_('MFG DATE', esc_(mfgDate));
  h += slipRow_('Shift / Operator', '____________');
  h += slipRow_('Location', esc_(p.StorageLocation));
  h += slipRow_('SAP ORDER', esc_(p.ManufacturingOrder));
  h += slipRow_('Pallet ID', esc_(p.PalletID));
  h += slipRow_('เลขที่ใบเบิก / Ref.Doc', refDocVal ? esc_(refDocVal) : '____________');
  h += '</div>';

  // QR
  h += '<div class="slip-qr">';
  h += '<img src="' + qrSrc + '" width="110" height="110" alt="QR">';
  h += '<div class="slip-qrtxt">' + esc_(p.PalletID) + '</div>';
  h += '</div>';

  h += '</div>'; // slip-body

  // ---- QC warning (soft, does not block) ----
  if (p.QCResult !== 'PASS') {
    h += '<div class="slip-qcwarn">' + esc_('⚠ QC: ' + (p.QCResult || 'ยังไม่ตรวจ')) + '</div>';
  }

  // ---- Checkbox groups ----
  h += '<div class="slip-checks">';
  h += '<div class="chk-group">';
  h += '<b>ออกเพื่อ:</b> ';
  h += '☐ นำส่งผลผลิตตามใบสั่งผลิต ';
  h += '☐ แทนบิลเดิม-แบ่งแยกไม้ ';
  h += '☐ นำส่งไม้จากการแปรสภาพ ';
  h += '☐ กำกับไม้เศษซาก';
  h += '</div>';
  h += '<div class="chk-group">';
  h += '<b>สภาพไม้:</b> ';
  h += '☐ ดี ';
  h += '☐ รอลดขนาด-ทำซ้ำ-ซ่อมเอง ';
  h += '☐ รอแก้ไขส่งคืนให้แผนก ';
  h += '☐ รอแปรสภาพ ';
  h += '☐ รอขอเป็นเศษซาก';
  h += '</div>';
  h += '</div>';

  // ---- Print timestamp ----
  h += '<div class="slip-ts">พิมพ์: ' + esc_(ts) + '</div>';

  h += '</div>'; // slip
  return h;
}

/**
 * Build a single label:value row for the slip info grid.
 * @param {string} label
 * @param {string} value
 * @return {string} HTML
 */
function slipRow_(label, value) {
  return '<div class="sr"><span class="sr-l">' + label + '</span><span class="sr-v">' + value + '</span></div>';
}

// ============================================================================
// CSS
// ============================================================================

/** @const {string} */
var SLIP_CSS_ = '<style>' +
  '@page{size:A4 portrait;margin:7mm}' +
  '*{box-sizing:border-box;margin:0;padding:0}' +
  'body{font-family:"Sarabun",Arial,sans-serif;font-size:9pt;background:#f0f0f0}' +
  '.slip{width:190mm;height:135mm;border:1.5px solid #000;box-sizing:border-box;' +
    'padding:4mm;page-break-inside:avoid;margin:2mm auto;overflow:hidden}' +
  '.slip:nth-child(2n){page-break-after:always}' +
  '@media print{.noprint{display:none!important}body{background:#fff}.slip{border:1.5px solid #000;margin:0 auto}}' +

  // Header
  '.slip-hdr{display:flex;justify-content:space-between;align-items:center;' +
    'border-bottom:2px solid #000;padding-bottom:2mm;margin-bottom:2mm}' +
  '.slip-title{font-size:14pt;font-weight:bold}' +
  '.slip-badge{background:#c0392b;color:#fff;font-size:10pt;font-weight:bold;' +
    'padding:1mm 3mm;border-radius:2px}' +

  // Big row
  '.slip-bigrow{display:flex;gap:4mm;border:1.5px solid #000;padding:2mm 3mm;' +
    'margin-bottom:2mm;font-size:11pt;align-items:baseline}' +
  '.big-part{flex:2}.big-qty{flex:1;text-align:center}.big-unit{flex:1;text-align:right}' +

  // Body: fields + QR side-by-side
  '.slip-body{display:flex;gap:3mm;margin-bottom:1.5mm}' +
  '.slip-fields{flex:1}' +
  '.sr{display:flex;border-bottom:1px solid #ddd;padding:0.8mm 0;font-size:8.5pt}' +
  '.sr-l{width:36mm;font-weight:bold;color:#333;flex-shrink:0}' +
  '.sr-v{flex:1}' +
  '.slip-qr{width:30mm;text-align:center;padding-top:1mm;flex-shrink:0}' +
  '.slip-qrtxt{font-size:7pt;font-family:monospace;margin-top:1mm;word-break:break-all}' +

  // QC warning
  '.slip-qcwarn{font-size:7.5pt;color:#888;font-style:italic;margin-bottom:1mm}' +

  // Checkboxes
  '.slip-checks{border-top:1px solid #999;padding-top:1.5mm;margin-top:1mm}' +
  '.chk-group{font-size:7.5pt;line-height:1.6}' +

  // Timestamp
  '.slip-ts{font-size:6.5pt;color:#999;text-align:right;margin-top:1mm}' +
  '</style>';

// ============================================================================
// Full HTML builder
// ============================================================================

/**
 * Build full HTML document for transfer slip printing.
 * READ-ONLY — does NOT modify PalletMaster.
 *
 * @param {string[]} palletIds — PalletIDs to print
 * @param {string} mode — slip type, currently always 'RECEIVE' (รับเข้าผลิตใหม่)
 * @return {string} full HTML ready for HtmlService.createHtmlOutput
 */
function buildSlipSheetsHtml(palletIds, mode) {
  var idSet = {};
  palletIds.forEach(function(id) { idSet[String(id).trim()] = true; });

  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    logEvent('SLIP_PRINT', PM_SHEET, 'EMPTY', 0, mode);
    return '<html><body><h2>PalletMaster ว่าง</h2></body></html>';
  }

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  var rows = [];
  for (var r = 1; r < data.length; r++) {
    var pid = String(data[r][idx['PalletID']] || '').trim();
    if (!idSet[pid]) continue;
    if (String(data[r][idx['ScanStatus']] || '').trim() !== 'CONFIRMED') continue;

    var wc    = data[r][idx['WorkCenter']];
    var batch = String(data[r][idx['Batch']] || '').trim();
    rows.push({
      PalletID:           pid,
      ManufacturingOrder: String(data[r][idx['ManufacturingOrder']] || '').trim(),
      Material:           String(data[r][idx['Material']] || '').trim(),
      MaterialName:       String(data[r][idx['MaterialName']] || '').trim(),
      Batch:              batch,
      QtyPerPallet:       Number(data[r][idx['QtyPerPallet']]) || 0,
      Unit:               String(data[r][idx['Unit']] || '').trim(),
      StorageLocation:    String(data[r][idx['StorageLocation']] || '').trim(),
      ProductionDate:     data[r][idx['ProductionDate']] || null,
      WorkCenter:         (wc instanceof Date) ? dateToWorkCenter_(wc) : String(wc || '').trim(),
      InspectionLot:      String(data[r][idx['InspectionLot']] || '').trim(),
      QCStatus:           String(data[r][idx['QCStatus']] || '').trim(),
      QCResult:           String(data[r][idx['QCResult']] || '').trim(),
      PalletSeq:          Number(data[r][idx['PalletSeq']]) || 0,
      TotalPallets:       Number(data[r][idx['TotalPallets']]) || 0,
      ConfirmedAt:        data[r][idx['ConfirmedAt']] || null,
      LotNo:              batch ? batch : pid
    });
  }

  rows.sort(function(a, b) {
    if (a.ManufacturingOrder !== b.ManufacturingOrder) {
      return a.ManufacturingOrder < b.ManufacturingOrder ? -1 : 1;
    }
    return a.PalletSeq - b.PalletSeq;
  });

  if (!rows.length) {
    logEvent('SLIP_PRINT', PM_SHEET, 'NO_MATCH', 0, mode + ' ids=' + palletIds.slice(0, 3).join(','));
    return '<html><body><h2>ไม่พบพาเลท CONFIRMED ตาม ID ที่ระบุ</h2></body></html>';
  }

  var pgMap = getProductGroupMap_();
  var ts    = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');

  var slips = rows.map(function(p) { return buildOneSlipHtml_(p, pgMap, ts, { transferable: false }); });

  var html = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
    SLIP_CSS_ +
    '\n</head>\n<body>\n' +
    '<div class="noprint" style="padding:8px;background:#ecf0f1;position:sticky;top:0;z-index:100;border-bottom:2px solid #bdc3c7">' +
    '<button onclick="window.print()" style="font-size:14pt;padding:7px 20px;background:#1a4e8a;color:#fff;border:none;border-radius:4px;cursor:pointer">' +
    '🖨️ พิมพ์ (' + rows.length + ' ใบ)</button>' +
    '<button onclick="google.script.host.close()" style="font-size:14pt;padding:7px 20px;margin-left:8px;background:#95a5a6;color:#fff;border:none;border-radius:4px;cursor:pointer">' +
    '✕ ปิด</button>' +
    '<span style="margin-left:14px;font-size:12pt;color:#555">ใบกำกับพาเลท — รับเข้าผลิตใหม่ — ' + rows.length + ' ใบ</span>' +
    '</div>\n' +
    slips.join('\n') +
    '\n</body>\n</html>';

  logEvent('SLIP_PRINT', PM_SHEET, 'OK', 0, mode + ' x' + rows.length);
  return html;
}

// ============================================================================
// Pick slip builder (Step 2c)
// ============================================================================

/**
 * Batch-load parent pallet data from PalletMaster for a set of PalletIDs.
 * Single read — includes ConfirmedAt and derived LotNo (not in lookupPalletById_).
 * Column resolution by NAME.
 *
 * @param {string[]} parentIds
 * @return {Object.<string, Object>} PalletID → pallet object
 */
function loadParentPalletsForPick_(parentIds) {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return {};

  var idSet = {};
  parentIds.forEach(function(id) { idSet[id] = true; });

  var data = sh.getDataRange().getValues();
  var idx  = {};
  data[0].forEach(function(h, i) { idx[h] = i; });

  var result = {};
  for (var r = 1; r < data.length; r++) {
    var pid = String(data[r][idx['PalletID']] || '').trim();
    if (!idSet[pid]) continue;

    var wc    = data[r][idx['WorkCenter']];
    var batch = String(data[r][idx['Batch']] || '').trim();
    result[pid] = {
      PalletID:           pid,
      ManufacturingOrder: String(data[r][idx['ManufacturingOrder']] || '').trim(),
      Material:           String(data[r][idx['Material']] || '').trim(),
      MaterialName:       String(data[r][idx['MaterialName']] || '').trim(),
      Batch:              batch,
      QtyPerPallet:       Number(data[r][idx['QtyPerPallet']]) || 0,
      Unit:               String(data[r][idx['Unit']] || '').trim(),
      StorageLocation:    String(data[r][idx['StorageLocation']] || '').trim(),
      WorkCenter:         (wc instanceof Date) ? dateToWorkCenter_(wc) : String(wc || '').trim(),
      ConfirmedAt:        data[r][idx['ConfirmedAt']] || null,
      LotNo:              batch ? batch : pid,
      QCResult:           String(data[r][idx['QCResult']] || '').trim(),
      QCStatus:           String(data[r][idx['QCStatus']] || '').trim()
    };
  }
  return result;
}

/**
 * Build full HTML document for FIFO pick slip printing.
 * Renders issue slips (orange badge) + remaining slips (grey badge).
 * READ-ONLY — does NOT modify PalletMaster or TransferLog.
 *
 * @param {{pickId:string, rows:Array, allocations:Array}} pickResult — from commitFifoPick_
 * @return {string} full HTML ready for HtmlService.createHtmlOutput
 */
function buildPickSlipsHtml(pickResult) {
  var pgMap = getProductGroupMap_();
  var ts    = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');

  var parentIds = [];
  pickResult.rows.forEach(function(r) {
    if (parentIds.indexOf(r.ParentPalletID) < 0) parentIds.push(r.ParentPalletID);
  });
  var parents = loadParentPalletsForPick_(parentIds);

  var slips = [];

  // Issue slips
  for (var i = 0; i < pickResult.rows.length; i++) {
    var row    = pickResult.rows[i];
    var parent = parents[row.ParentPalletID];
    if (!parent) continue;

    slips.push(buildOneSlipHtml_(parent, pgMap, ts, {
      badgeText:   'แบ่งเบิกแตกย่อย',
      badgeColor:  '#e67e22',
      qrPayload:   issueSlipQrPayload_(row),
      qtyOverride: row.IssueQty,
      lotOverride: row.LotNo,
      refDoc:      row.RefDoc || '',
      transferable: true
    }));
  }

  // Remaining slips (only for parents with remaining > 0 after pick)
  for (var j = 0; j < pickResult.allocations.length; j++) {
    var alloc = pickResult.allocations[j];
    if (alloc.remainingAfter <= 0) continue;

    var parentR = parents[alloc.ParentPalletID];
    if (!parentR) continue;

    slips.push(buildOneSlipHtml_(parentR, pgMap, ts, {
      badgeText:   'คงเหลือ',
      badgeColor:  '#7f8c8d',
      qrPayload:   remainSlipQrPayload_(parentR, alloc.remainingAfter),
      qtyOverride: alloc.remainingAfter,
      transferable: false
    }));
  }

  var totalSlips = slips.length;
  var html = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
    SLIP_CSS_ +
    '\n</head>\n<body>\n' +
    '<div class="noprint" style="padding:8px;background:#ecf0f1;position:sticky;top:0;z-index:100;border-bottom:2px solid #bdc3c7">' +
    '<button onclick="window.print()" style="font-size:14pt;padding:7px 20px;background:#1a4e8a;color:#fff;border:none;border-radius:4px;cursor:pointer">' +
    '🖨️ พิมพ์ (' + totalSlips + ' ใบ)</button>' +
    '<button onclick="google.script.host.close()" style="font-size:14pt;padding:7px 20px;margin-left:8px;background:#95a5a6;color:#fff;border:none;border-radius:4px;cursor:pointer">' +
    '✕ ปิด</button>' +
    '<span style="margin-left:14px;font-size:12pt;color:#555">ใบแบ่งเบิก — ' + esc_(pickResult.pickId) + ' — ' + totalSlips + ' ใบ</span>' +
    '</div>\n' +
    slips.join('\n') +
    '\n</body>\n</html>';

  logEvent('PICK_SLIP_PRINT', 'TransferSlip', 'OK', 0,
    pickResult.pickId + ' issue=' + pickResult.rows.length);
  return html;
}

// ============================================================================
// Menu handlers
// ============================================================================

/**
 * Menu entry: prompt for SAP Order, Pallet ID, or blank (today's confirmed).
 * Resolves input to a filter, loads matching CONFIRMED pallets, opens modal.
 */
function slipPrintDialog() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt(
    '🖨️ พิมพ์ใบกำกับพาเลท (รับเข้าผลิตใหม่)',
    'ใส่ SAP Order, Pallet ID, หรือเว้นว่าง = พาเลทที่ Confirm วันนี้ทั้งหมด',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var input = resp.getResponseText().trim();
  logEvent('SLIP_DIALOG', 'UI', 'OPEN', 0, 'input="' + input + '"');

  var filter;
  if (!input) {
    filter = { mode: 'todayConfirmed', value: '' };
  } else if (/^PL-/.test(input)) {
    filter = { mode: 'palletId', value: input };
  } else {
    filter = { mode: 'mo', value: input };
  }

  var pallets = getSlipPalletsByFilter_(filter);
  if (!pallets.length) {
    logEvent('SLIP_DIALOG', 'UI', 'EMPTY', 0, 'filter=' + filter.mode + ':' + filter.value);
    ui.alert('ไม่พบพาเลท CONFIRMED ตามเงื่อนไข\n\n' +
      'ตรวจสอบ:\n' +
      '- ScanStatus ต้องเป็น CONFIRMED\n' +
      '- กรณีเว้นว่าง: ConfirmedAt ต้องเป็นวันนี้ (Asia/Bangkok)');
    return;
  }

  var ids = pallets.map(function(p) { return p.PalletID; });
  var html = buildSlipSheetsHtml(ids, 'RECEIVE');
  var out  = HtmlService.createHtmlOutput(html).setWidth(1100).setHeight(840);
  ui.showModalDialog(out, 'ใบกำกับพาเลท — รับเข้าผลิตใหม่ (' + pallets.length + ' ใบ)');
}

/**
 * Menu entry: FIFO split-issue pick dialog.
 * Prompt for Material, StorageLocation, Qty, RefDoc.
 * Pre-validates via planFifoPick_, shows allocation preview, then commits.
 */
function pickDialog() {
  var ui = SpreadsheetApp.getUi();

  // Step 1: Material & StorageLocation
  var r1 = ui.prompt(
    '✂️ แบ่งเบิกแตกย่อย (FIFO)',
    'ใส่ Material, StorageLocation คั่นด้วยจุลภาค\nเช่น FG-001,PW30',
    ui.ButtonSet.OK_CANCEL
  );
  if (r1.getSelectedButton() !== ui.Button.OK) return;

  var parts = r1.getResponseText().split(',');
  var material = (parts[0] || '').trim();
  var sloc     = (parts[1] || '').trim();
  if (!material || !sloc) {
    ui.alert('กรุณาระบุ Material และ StorageLocation คั่นด้วย ,');
    return;
  }

  // Step 2: Qty
  var r2 = ui.prompt(
    '✂️ จำนวนที่ต้องการเบิก',
    'Material: ' + material + '\nSLoc: ' + sloc + '\n\nใส่จำนวน (ตัวเลข):',
    ui.ButtonSet.OK_CANCEL
  );
  if (r2.getSelectedButton() !== ui.Button.OK) return;

  var wantQty = Number(r2.getResponseText().trim());
  if (!wantQty || wantQty <= 0 || isNaN(wantQty)) {
    ui.alert('จำนวนต้องเป็นตัวเลขมากกว่า 0');
    return;
  }

  // Step 3: RefDoc (optional)
  var r3 = ui.prompt(
    '✂️ เลขที่ใบเบิก / Ref.Doc (ไม่บังคับ)',
    'เว้นว่างได้ หรือใส่เลขอ้างอิง:',
    ui.ButtonSet.OK_CANCEL
  );
  if (r3.getSelectedButton() !== ui.Button.OK) return;
  var refDoc = r3.getResponseText().trim();

  logEvent('PICK_DIALOG', 'UI', 'OPEN', 0,
    material + ',' + sloc + ',' + wantQty + ',ref=' + refDoc);

  // Pre-validate
  var plan = planFifoPick_(material, sloc, wantQty);
  if (!plan.ok) {
    logEvent('PICK_DIALOG', 'UI', 'SHORTFALL', 0,
      'want=' + wantQty + ' avail=' + plan.totalAvail + ' short=' + plan.shortfall);
    ui.alert('เบิกไม่ได้: ต้องการ ' + wantQty + ' มี ' + plan.totalAvail +
      ' ขาด ' + plan.shortfall);
    return;
  }

  // Build preview
  var preview = 'แผนเบิก FIFO — ' + material + ' @ ' + sloc + '\n';
  preview += 'ต้องการ: ' + wantQty + '  |  มีทั้งหมด: ' + plan.totalAvail + '\n\n';
  for (var i = 0; i < plan.allocations.length; i++) {
    var a = plan.allocations[i];
    preview += (i + 1) + '. ' + a.ParentPalletID +
      '  Lot: ' + a.LotNo +
      '  เบิก: ' + a.takeQty +
      '  คงเหลือ: ' + a.remainingAfter + '\n';
  }
  preview += '\nยืนยันเบิก?';

  var confirm = ui.alert('ยืนยันแบ่งเบิก', preview, ui.ButtonSet.OK_CANCEL);
  if (confirm !== ui.Button.OK) {
    logEvent('PICK_DIALOG', 'UI', 'CANCELLED', 0, material + ' x' + wantQty);
    return;
  }

  // Commit
  var email  = Session.getActiveUser().getEmail();
  var result = commitFifoPick_(material, sloc, wantQty, {
    refDoc:         refDoc,
    idempotencyKey: Utilities.getUuid(),
    createdBy:      email
  });

  if (!result.ok) {
    logEvent('PICK_DIALOG', 'UI', 'COMMIT_FAIL', 0,
      'shortfall=' + result.shortfall);
    ui.alert('เบิกไม่สำเร็จ: สต็อกเปลี่ยนแปลงระหว่างยืนยัน\n' +
      'ต้องการ ' + wantQty + ' มี ' + result.totalAvail);
    return;
  }

  logEvent('PICK_DIALOG', 'UI', 'COMMITTED', 0,
    result.pickId + ' ' + material + ' x' + wantQty);

  var html = buildPickSlipsHtml(result);
  var out  = HtmlService.createHtmlOutput(html).setWidth(1100).setHeight(840);
  ui.showModalDialog(out,
    'ใบแบ่งเบิก — ' + result.pickId + ' (' + result.rows.length + ' ใบ)');
}

/**
 * Menu entry: reprint receive slip by SAP Order or Pallet ID.
 * Reuses getSlipPalletsByFilter_ + buildSlipSheetsHtml — no duplicated logic.
 */
function reprintReceiveDialog() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt(
    '🔁 พิมพ์ซ้ำใบกำกับ (รับเข้า)',
    'ใส่ SAP Order หรือ Pallet ID',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var input = resp.getResponseText().trim();
  if (!input) {
    ui.alert('กรุณาใส่ SAP Order หรือ Pallet ID');
    return;
  }

  var filter = /^PL-/i.test(input)
    ? { mode: 'palletId', value: input }
    : { mode: 'mo', value: input };

  var rows = getSlipPalletsByFilter_(filter);
  if (!rows.length) {
    ui.alert('ไม่พบพาเลท CONFIRMED สำหรับ: ' + input);
    return;
  }

  var ids  = rows.map(function(p) { return p.PalletID; });
  var html = buildSlipSheetsHtml(ids, 'RECEIVE');
  var out  = HtmlService.createHtmlOutput(html).setWidth(1100).setHeight(840);
  ui.showModalDialog(out, 'พิมพ์ซ้ำใบกำกับ — รับเข้า (' + rows.length + ' ใบ)');
  logEvent('REPRINT_RECEIVE', 'TransferSlip', 'OK', 0, input + ' x' + rows.length);
}

// ============================================================================
// Test harness
// ============================================================================

/**
 * Editor test — hardcoded PalletIDs to verify buildSlipSheetsHtml runs without error.
 * Run from Apps Script Editor → select TEST_buildReceiveSlip_ → Run.
 */
function TEST_buildReceiveSlip_() {
  var ids = ['PL-1000035952-L01', 'PL-1000035952-L02'];
  var html = buildSlipSheetsHtml(ids, 'RECEIVE');
  Logger.log('buildSlipSheetsHtml returned ' + html.length + ' chars');
  Logger.log('First 500 chars: ' + html.substring(0, 500));
}

/**
 * Editor test — seed FIFO test pallets, commit a pick, render pick slips, then cleanup.
 * Self-cleaning: removes all ZZTEST-FIFO data on completion.
 */
function TEST_pickSlipsRender_() {
  TEST_seedFifoPallets_();

  var result = commitFifoPick_('ZZTEST-FIFO', 'PW30', 1000, {
    idempotencyKey: Utilities.getUuid()
  });
  Logger.log('commitFifoPick_ ok=' + result.ok + ' pickId=' + result.pickId +
    ' rows=' + result.rows.length);

  if (result.ok) {
    var html = buildPickSlipsHtml(result);
    Logger.log('buildPickSlipsHtml returned ' + html.length + ' chars');
    Logger.log('Issue slips: ' + result.rows.length +
      ', Remaining slips expected for pallets with remainingAfter > 0');
  }

  TEST_cleanupFifoPallets_();
  Logger.log('TEST_pickSlipsRender_ complete — ZZTEST data cleaned up');
}

/**
 * Self-cleaning test for slipGetCascadeForSloc_.
 * Seeds PL-TEST-CASCADE-* CONFIRMED pallets at SLoc PW30, then asserts:
 *   (a) returned material-code set === set from slipGetMaterialsForSloc
 *   (b) each material's group matches getMaterialMap() lookup
 *   (c) ungrouped materials land under '(ไม่ระบุกลุ่ม)'
 *   (d) result is JSON-safe (round-trips through JSON.parse/stringify)
 * Cleans up all seeded rows on completion.
 */
function TEST_slipCascadeForSloc() {
  var fn = 'TEST_slipCascadeForSloc';
  var t0 = Date.now();
  var SLOC = 'PW30';
  var TEST_MAT  = 'ZZTEST-CASCADE';
  var TEST_PID1 = 'PL-TEST-CASCADE-L01';
  var TEST_PID2 = 'PL-TEST-CASCADE-L02';

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

  // ---- Seed CONFIRMED pallets in PalletMaster ----
  var sh  = getSheet_(PM_SHEET);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  var now = new Date();
  var seeds = [
    { PalletID: TEST_PID1, ManufacturingOrder: 'ZZTEST-MO-CASCADE', Material: TEST_MAT,
      MaterialName: 'Test Cascade Material', Batch: '', QtyPerPallet: 500, Unit: 'PC',
      PalletSeq: 1, TotalPallets: 2, WorkCenter: '', ProductionDate: '',
      TotalQuantity: 1000, Plant: '1100', StorageLocation: SLOC, QRPayload: '',
      Status: 'CONFIRMED', ScanStatus: 'CONFIRMED', CreatedAt: now, ConfirmedAt: now },
    { PalletID: TEST_PID2, ManufacturingOrder: 'ZZTEST-MO-CASCADE', Material: TEST_MAT,
      MaterialName: 'Test Cascade Material', Batch: '', QtyPerPallet: 500, Unit: 'PC',
      PalletSeq: 2, TotalPallets: 2, WorkCenter: '', ProductionDate: '',
      TotalQuantity: 1000, Plant: '1100', StorageLocation: SLOC, QRPayload: '',
      Status: 'CONFIRMED', ScanStatus: 'CONFIRMED', CreatedAt: now, ConfirmedAt: now }
  ];

  var seedRows = seeds.map(function(s) {
    return hdr.map(function(h) { return s.hasOwnProperty(h) ? s[h] : ''; });
  });
  sh.getRange(sh.getLastRow() + 1, 1, seedRows.length, hdr.length).setValues(seedRows);
  SpreadsheetApp.flush();
  Logger.log('Seeded ' + seedRows.length + ' test pallets');

  try {
    // ---- (a) Material-code set equality ----
    var cascade = slipGetCascadeForSloc_(SLOC);
    var stockResult = slipGetMaterialsForSloc(SLOC);
    var stockCodes = (stockResult.materials || []).map(function(m) { return m.material; }).sort();

    var cascadeCodes = [];
    cascade.productGroups.forEach(function(g) {
      cascade.byGroup[g].forEach(function(m) {
        cascadeCodes.push(m.code);
      });
    });
    cascadeCodes.sort();

    assert('(a) material-code set matches slipGetMaterialsForSloc',
      JSON.stringify(cascadeCodes) === JSON.stringify(stockCodes),
      'cascade=' + cascadeCodes.length + ' stock=' + stockCodes.length);

    assert('(a) test material present in cascade',
      cascadeCodes.indexOf(TEST_MAT) >= 0,
      TEST_MAT);

    // ---- (b) ProductGroup matches getMaterialMap() ----
    var mmMap = getMaterialMap();
    var groupMismatch = [];
    cascade.productGroups.forEach(function(g) {
      cascade.byGroup[g].forEach(function(m) {
        var mm = mmMap[m.code];
        var expectedGroup = (mm && mm.productGroup) ? mm.productGroup : '(ไม่ระบุกลุ่ม)';
        if (g !== expectedGroup) {
          groupMismatch.push(m.code + ': got=' + g + ' expected=' + expectedGroup);
        }
      });
    });
    assert('(b) ProductGroup matches getMaterialMap()',
      groupMismatch.length === 0,
      groupMismatch.length ? groupMismatch.join('; ') : 'all match');

    // ---- (c) Ungrouped materials land under fallback ----
    var testMatInMap = mmMap[TEST_MAT];
    var testMatHasGroup = testMatInMap && testMatInMap.productGroup;
    if (!testMatHasGroup) {
      var foundInFallback = false;
      if (cascade.byGroup['(ไม่ระบุกลุ่ม)']) {
        cascade.byGroup['(ไม่ระบุกลุ่ม)'].forEach(function(m) {
          if (m.code === TEST_MAT) foundInFallback = true;
        });
      }
      assert('(c) ungrouped test material in fallback group',
        foundInFallback,
        TEST_MAT + ' not in getMaterialMap or has no productGroup → should be in (ไม่ระบุกลุ่ม)');
    } else {
      assert('(c) test material has group in MaterialMaster, skip fallback check',
        true,
        'group=' + testMatInMap.productGroup);
    }

    // ---- (d) JSON-safe round-trip ----
    var jsonSafe = true;
    try {
      var rt = JSON.parse(JSON.stringify(cascade));
      jsonSafe = Array.isArray(rt.productGroups) && typeof rt.byGroup === 'object';
    } catch (e) {
      jsonSafe = false;
    }
    assert('(d) result is JSON-safe (round-trip)',
      jsonSafe,
      'JSON.parse(JSON.stringify) succeeded');

  } finally {
    // ---- Cleanup: delete seeded rows ----
    var pmData = sh.getDataRange().getValues();
    var pidCol = idx['PalletID'];
    var delCount = 0;
    for (var r = pmData.length - 1; r >= 1; r--) {
      var pid = String(pmData[r][pidCol] || '').trim();
      if (pid === TEST_PID1 || pid === TEST_PID2) {
        sh.deleteRow(r + 1);
        delCount++;
      }
    }
    Logger.log('Cleaned up ' + delCount + ' test pallet rows');
  }

  var elapsed = Date.now() - t0;
  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  Logger.log(fn + ': ' + (pass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name);
  });
  Logger.log('──────────────────────────────────────────');

  logEvent('TEST_CASCADE', 'TransferSlip', pass ? 'PASS' : 'FAIL', elapsed,
    results.length + ' assertions, ' + (pass ? 'all pass' : 'some failed'));
}

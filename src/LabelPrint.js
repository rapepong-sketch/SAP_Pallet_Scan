/**
 * LabelPrint.gs — Phase 2 (DEPRECATED as of Phase 2.5)
 * ======================================================
 * เดิม: A5 pallet labels (2 ใบต่อ A4)
 * ใช้แทนด้วย: PalletSheet.gs (A4 one-page Pallet Tracking Sheet)
 *
 * ยังคงไฟล์นี้ไว้เพื่อ backward compatibility — เมนู "Print Old Labels" ยังเรียกได้
 *
 * NOTE: chart.googleapis.com QR API ถูก Google ปิดไปแล้ว
 *       → ใช้ CFG.QR_API (default: api.qrserver.com)
 */

var QR_API_DEFAULT = 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=';

function qrUrl_(payload) {
  var base = (typeof CFG !== 'undefined' && CFG.QR_API) ? CFG.QR_API : QR_API_DEFAULT;
  return base + encodeURIComponent(payload);
}

/** อ่าน pallet rows จาก PalletMaster ตามเงื่อนไข */
function getPalletRows_(filterFn) {
  var sh = SpreadsheetApp.openById(CFG.SHEET_ID).getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var hdr = data[0], idx = {};
  hdr.forEach(function (h, i) { idx[h] = i; });
  var out = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var p = {
      rowNum: r + 1,
      PalletID: row[idx.PalletID],
      ManufacturingOrder: row[idx.ManufacturingOrder],
      Material: row[idx.Material],
      MaterialName: row[idx.MaterialName],
      Batch: row[idx.Batch],
      QtyPerPallet: row[idx.QtyPerPallet],
      Unit: row[idx.Unit],
      PalletSeq: row[idx.PalletSeq],
      TotalPallets: row[idx.TotalPallets],
      WorkCenter: row[idx.WorkCenter],
      ProductionDate: row[idx.ProductionDate],
      Status: row[idx.Status],
      QRPayload: row[idx.QRPayload]
    };
    if (!filterFn || filterFn(p)) out.push(p);
  }
  return out;
}

function fmtDate_(d) {
  if (!d) return '-';
  if (d instanceof Date) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  return String(d);
}

function labelHtml_(p) {
  return '' +
    '<div class="label">' +
    '  <div class="hdr"><span class="pid">' + p.PalletID + '</span>' +
    '     <span class="seq">Pallet ' + p.PalletSeq + ' / ' + p.TotalPallets + '</span></div>' +
    '  <div class="body">' +
    '    <div class="fields">' +
    '      <div><b>Production Order</b><span>' + p.ManufacturingOrder + '</span></div>' +
    '      <div><b>Material</b><span>' + p.Material + '</span></div>' +
    '      <div><b>Description</b><span>' + (p.MaterialName || '-') + '</span></div>' +
    '      <div><b>Batch</b><span>' + (p.Batch || '-') + '</span></div>' +
    '      <div><b>Qty / Pallet</b><span class="qty">' + p.QtyPerPallet + ' ' + p.Unit + '</span></div>' +
    '      <div><b>Work Center</b><span>' + (p.WorkCenter || '-') + '</span></div>' +
    '      <div><b>Production Date</b><span>' + fmtDate_(p.ProductionDate) + '</span></div>' +
    '    </div>' +
    '    <div class="qr"><img src="' + qrUrl_(p.QRPayload) + '" width="150" height="150">' +
    '       <div class="qrtxt">' + p.PalletID + '</div></div>' +
    '  </div>' +
    '</div>';
}

var LABEL_CSS = '' +
  '<style>' +
  '@page { size: A4; margin: 8mm; }' +
  '* { box-sizing: border-box; font-family: Arial, "Sarabun", sans-serif; }' +
  'body { margin: 0; }' +
  '.label { width: 100%; height: 138mm; border: 2px solid #000; margin-bottom: 6mm;' +
  '  padding: 6mm; page-break-inside: avoid; }' +
  '.label:nth-child(2n) { page-break-after: always; }' +
  '.hdr { display: flex; justify-content: space-between; border-bottom: 2px solid #000;' +
  '  padding-bottom: 3mm; margin-bottom: 4mm; }' +
  '.pid { font-size: 22pt; font-weight: bold; }' +
  '.seq { font-size: 14pt; align-self: center; }' +
  '.body { display: flex; gap: 6mm; }' +
  '.fields { flex: 1; }' +
  '.fields div { display: flex; border-bottom: 1px solid #999; padding: 2mm 0; }' +
  '.fields b { width: 42mm; font-size: 10pt; color: #333; }' +
  '.fields span { font-size: 12pt; }' +
  '.fields .qty { font-size: 16pt; font-weight: bold; }' +
  '.qr { text-align: center; }' +
  '.qrtxt { font-size: 9pt; margin-top: 2mm; font-family: monospace; }' +
  '@media print { .noprint { display: none; } }' +
  '</style>';

/**
 * พิมพ์ labels ของ MO เดียว (ทุก pallet) หรือ pallet เดียว
 * @param {string} key — ManufacturingOrder หรือ PalletID
 */
function buildLabelsHtml(key) {
  key = String(key).trim();
  var isPallet = /-P\d{3}$/.test(key);
  var pallets = getPalletRows_(function (p) {
    return isPallet ? p.PalletID === key : String(p.ManufacturingOrder) === key;
  });
  if (!pallets.length) throw new Error('ไม่พบ pallet สำหรับ "' + key + '" — รัน generatePallets ก่อน');

  var html = '<!DOCTYPE html><html><head>' + LABEL_CSS + '</head><body>' +
    '<div class="noprint" style="padding:8px;background:#eee">' +
    '  <button onclick="window.print()" style="font-size:14pt;padding:6px 18px">🖨️ Print (' + pallets.length + ' labels)</button>' +
    '</div>' +
    pallets.map(labelHtml_).join('') +
    '</body></html>';

  // Mark printed (เคารพ DRY_RUN)
  if (!CFG.DRY_RUN) markPalletsPrinted_(pallets);
  logEvent('LABEL_PRINT', CFG.DRY_RUN ? 'DRY_RUN' : 'OK', key + ' → ' + pallets.length + ' labels');
  return html;
}

function markPalletsPrinted_(pallets) {
  var sh = SpreadsheetApp.openById(CFG.SHEET_ID).getSheetByName(PM_SHEET);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var colStatus = hdr.indexOf('Status') + 1;
  var colPrinted = hdr.indexOf('PrintedAt') + 1;
  var now = new Date();
  pallets.forEach(function (p) {
    if (p.Status === 'CREATED') sh.getRange(p.rowNum, colStatus).setValue('PRINTED');
    sh.getRange(p.rowNum, colPrinted).setValue(now);
  });
}

/** เมนู: prompt → เปิด popup labels */
function printLabelsDialog() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Print Pallet Labels',
    'ใส่ Manufacturing Order (พิมพ์ทุก pallet) หรือ PalletID (ใบเดียว):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var html = buildLabelsHtml(resp.getResponseText());
  var out = HtmlService.createHtmlOutput(html).setWidth(900).setHeight(700);
  ui.showModalDialog(out, 'Pallet Labels');
}

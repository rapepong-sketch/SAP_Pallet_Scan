/**
 * PalletSheet.gs — Phase 2.5
 * ===========================
 * A4 one-page Pallet Tracking Sheet (ใบติดตามพาเลท) — modeled on PJ Wood real document.
 *
 * One-page constraint: height:283mm overflow:hidden + compact CSS modes by op count.
 * QR: api.qrserver.com (220×220 requested, 110×110 displayed) — NEVER chart.googleapis.com
 *
 * Final operation only is confirmed in SAP (Phase 3). All other ops logged outside SAP.
 */

// ============================================================================
// Public API
// ============================================================================

/**
 * Build full HTML for one or more pallet tracking sheets.
 * @param {string[]} palletIds
 * @param {boolean}  isReprint — if true: no status change, log REPRINT only
 * @return {string} full HTML ready for HtmlService
 */
function buildPalletSheetsHtml(palletIds, isReprint) {
  const ss       = getSpreadsheet_();
  const pallets  = getPalletRowsByIds_(palletIds, ss);
  if (!pallets.length) {
    throw new Error('ไม่พบ pallet IDs: ' + palletIds.slice(0, 3).join(', '));
  }

  const poMap     = getPoMapForSheets_(ss);
  const mmMap     = getMaterialMap(); // name fallback
  const timestamp = fmtDate_(new Date());

  const sheets = pallets.map(p => buildOneSheetHtml_(p, poMap, mmMap, timestamp));

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${PALLET_SHEET_CSS_}
</head>
<body>
<div class="noprint" style="padding:8px;background:#ecf0f1;position:sticky;top:0;z-index:100;border-bottom:2px solid #bdc3c7">
  <button onclick="window.print()" style="font-size:14pt;padding:7px 20px;background:#1a4e8a;color:#fff;border:none;border-radius:4px;cursor:pointer">
    🖨️ Print (${pallets.length} ใบ)
  </button>
  <span style="margin-left:14px;font-size:12pt;color:#555">จำนวน ${pallets.length} ใบ${isReprint ? ' — REPRINT' : ''}</span>
</div>
${sheets.join('\n')}
</body>
</html>`;

  if (!isReprint) {
    if (!CFG.DRY_RUN) markPalletsAsPrinted_(pallets, ss);
    logEvent('PALLET_SHEET', CFG.DRY_RUN ? 'DRY_RUN' : 'PRINTED',
      palletIds.length + ' pallets: ' + palletIds.slice(0, 3).join(',') + (palletIds.length > 3 ? '...' : ''));
  } else {
    logEvent('PALLET_SHEET', 'REPRINT',
      palletIds.length + ' pallets: ' + palletIds.slice(0, 3).join(','));
  }

  return html;
}

/** Menu: prompt for MO or PalletID → reprint (no status change) */
function reprintDialog() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.prompt(
    '🖨️ พิมพ์ซ้ำ (Reprint)',
    'ใส่ Manufacturing Order (ทุก pallet) หรือ PalletID เดียว:',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const key = resp.getResponseText().trim();
  if (!key) return;

  const ss   = getSpreadsheet_();
  const sh   = ss.getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) { ui.alert('PalletMaster ว่าง'); return; }

  const data = sh.getDataRange().getValues();
  const hdr  = data[0];
  const idx  = {};
  hdr.forEach((h, i) => { idx[h] = i; });

  // Support both new PL-{MO}-L{nn} and old {MO}-P{nnn} formats
  const isPallet = /PL-\d+-L\d+$/.test(key) || /-P\d{3}$/.test(key);
  const ids      = [];
  for (let r = 1; r < data.length; r++) {
    const pid = String(data[r][idx.PalletID] || '').trim();
    const mo  = String(data[r][idx.ManufacturingOrder] || '').trim();
    if (isPallet ? pid === key : mo === key) ids.push(pid);
  }

  if (!ids.length) { ui.alert(`ไม่พบ pallet สำหรับ "${key}"`); return; }

  const html = buildPalletSheetsHtml(ids, true);
  const out  = HtmlService.createHtmlOutput(html).setWidth(1100).setHeight(840);
  ui.showModalDialog(out, `Reprint — ${ids.length} ใบ`);
}

// ============================================================================
// Internal: one sheet HTML
// ============================================================================

function buildOneSheetHtml_(p, poMap, mmMap, timestamp) {
  // mo MUST be resolved before ops-fetch and poMap lookup — fallback extracts MO from PalletID
  // so the sheet still renders correctly even when ManufacturingOrder column was renamed/empty.
  const mo = p.ManufacturingOrder ||
    (String(p.PalletID || '').match(/^PL-(\d+)-L/) || [])[1] || '?';

  const po  = poMap[String(mo)] || {};

  // Ops: lazy-fetch from SAP (CacheService 30 min — same MO across pallets is instant)
  Logger.log('fetchOps: mo="' + mo + '" p.ManufacturingOrder="' + p.ManufacturingOrder + '" PalletID=' + p.PalletID);
  const ops      = fetchOperationsForMO_(mo !== '?' ? mo : '');
  const opCount  = ops.length;
  const compactCls = opCount <= 10 ? '' : opCount <= 15 ? ' compact-11' : ' compact-16';
  const finalIdx = opCount - 1;

  // Parse seq from PalletID (new format PL-...-L{nn})
  const mSeq  = String(p.PalletID || '').match(/L(\d+)$/);
  const seq   = mSeq ? parseInt(mSeq[1], 10) : (p.PalletSeq || 1);
  const total = p.TotalPallets || '?';

  const matName     = p.MaterialName || (mmMap[p.Material] || {}).name || '';
  const dueDate     = po.startDate ? fmtDate_(po.startDate) : '—';
  const totalQtyVal = p.TotalQuantity || po.totalQty || 0;
  const totalQty    = totalQtyVal > 0
    ? String(totalQtyVal) + ' ' + (p.Unit || po.unit || '').trim()
    : '—';

  // Header block
  let h = `<div class="sheet${compactCls}">`;

  h += `<div class="hdr-block">`;
  h += `<div class="hdr-info">`;
  h += `<div class="company-row">`;
  h += `<span class="company-name">${esc_(CFG.FACTORY_NAME)}</span>`;
  h += `<span class="doc-title">Pallet Tracking Sheet</span>`;
  h += `</div>`;
  h += `<div class="mat-code">${esc_(p.Material)}</div>`;
  h += `<div class="mat-name">${esc_(matName)}</div>`;
  h += `<div class="sap-order">SAP Order: ${esc_(mo)}</div>`;
  h += `<div class="pallet-info">Pallet ID: <b>${esc_(p.PalletID)}</b>&nbsp;|&nbsp;พาเลทที่: <b>${seq}/${total}</b>&nbsp;|&nbsp;พิมพ์: PC&nbsp;|&nbsp;${timestamp}</div>`;
  h += `</div>`;
  h += `<div class="hdr-qr"><img src="${buildPsQrUrl_(p.QRPayload)}" width="110" height="110" alt="QR"></div>`;
  h += `</div>`;

  // Info bar
  h += `<table class="info-bar">`;
  h += `<tr><th>พาเลทที่</th><th>จำนวน/พาเลท</th><th>จำนวนทั้งหมด</th><th>SAP Order</th><th>Due Date</th></tr>`;
  h += `<tr>`;
  h += `<td><b>${seq}/${total}</b></td>`;
  h += `<td><b>${esc_(String(p.QtyPerPallet))}</b> ${esc_(p.Unit || '')}</td>`;
  h += `<td>${esc_(totalQty)}</td>`;
  h += `<td>${esc_(mo)}</td>`;
  h += `<td>${dueDate}</td>`;
  h += `</tr></table>`;

  // Routing confirmation table
  h += `<div class="routing-section">`;
  h += `<div class="routing-hdr">การยืนยันงานแต่ละจุด | Routing Confirmation</div>`;
  h += `<table class="rt">`;
  h += `<tr>`;
  h += `<th class="c-no">#</th>`;
  h += `<th class="c-name">ชื่องาน/ขั้นตอน</th>`;
  h += `<th class="c-res">Resource</th>`;
  h += `<th class="c-num">OP: ดี(PCS)</th>`;
  h += `<th class="c-num">OP: เสีย(PCS)</th>`;
  h += `<th class="c-time">OP: เวลาเสร็จ</th>`;
  h += `<th class="c-sig">OP: ลายมือชื่อ</th>`;
  h += `<th class="c-pass">PD: Pass/Fail</th>`;
  h += `<th class="c-sig">PD: ลายมือชื่อ</th>`;
  h += `<th class="c-pass">QC: Pass/Fail</th>`;
  h += `<th class="c-sig">QC: ลายมือชื่อ</th>`;
  h += `</tr>`;

  if (ops.length === 0) {
    h += `<tr><td colspan="11" style="text-align:center;color:#999;font-style:italic;padding:4mm">— ไม่พบ Operation ใน SAP — ตรวจสอบ Comm Arrangement —</td></tr>`;
  } else {
    ops.forEach((op, i) => {
      const isFinal   = (i === finalIdx);
      const rowCls    = isFinal ? ' class="row-final"' : '';
      const finalMark = isFinal ? ` <span class="final-mark">★ Final OP — Confirm SAP</span>` : '';
      h += `<tr${rowCls}>`;
      h += `<td class="c-no">${esc_(op.opNo)}</td>`;
      h += `<td class="c-name">${esc_(op.opText || op.text || op.opNo)}${finalMark}</td>`;
      h += `<td class="c-res">${esc_(op.workCenter)}</td>`;
      h += `<td class="c-num"></td><td class="c-num"></td>`;
      h += `<td class="c-time"></td><td class="c-sig"></td>`;
      h += `<td class="c-pass"></td><td class="c-sig"></td>`;
      h += `<td class="c-pass"></td><td class="c-sig"></td>`;
      h += `</tr>`;
    });
  }

  // Rework row
  h += `<tr class="row-rework">`;
  h += `<td class="c-no">—</td><td class="c-name">ว่าง / Rework</td>`;
  h += `<td class="c-res"></td><td class="c-num"></td><td class="c-num"></td>`;
  h += `<td class="c-time"></td><td class="c-sig"></td>`;
  h += `<td class="c-pass"></td><td class="c-sig"></td>`;
  h += `<td class="c-pass"></td><td class="c-sig"></td>`;
  h += `</tr>`;

  h += `</table></div>`; // rt, routing-section

  // Footer
  h += `<div class="footer">`;
  h += `<table class="footer-tbl">`;
  h += `<tr>`;
  h += `<td class="f-lbl">GR</td><td class="f-date">วันที่: ___________</td>`;
  h += `<td>S1 → PW30 ส่ง-รับ วัสดุสำเร็จรูป</td>`;
  h += `<td>ตรวจสอบโดย Admin SAP: _____________________</td>`;
  h += `<td class="f-sign">PC: ___________</td>`;
  h += `</tr><tr>`;
  h += `<td class="f-lbl">ST39</td><td class="f-date">วันที่: ___________</td>`;
  h += `<td>PW39 → PW30 ส่ง-โอนย้ายจัดเก็บ</td>`;
  h += `<td>ตรวจสอบโดย Admin SAP: _____________________</td>`;
  h += `<td class="f-sign">PC: ___________</td>`;
  h += `</tr></table>`;
  h += `<div class="rules-row">`;
  h += `<div class="rule"><b>กฎ1:</b> ตรวจสอบก่อนยืนยัน — Admin ตรวจ qty/batch ก่อนทำ GR</div>`;
  h += `<div class="rule"><b>กฎ2:</b> Admin scan SAP ยืนยัน GR ก่อนย้ายสินค้าออกจากพื้นที่</div>`;
  h += `<div class="rule"><b>กฎ3:</b> ส่งคืน PC เมื่อเสร็จ — ทุก 5 ใบ/วัน ไม่เกิน 40 ใบ</div>`;
  h += `</div>`;
  h += `</div>`; // footer

  h += `</div>`; // sheet
  return h;
}

// ============================================================================
// CSS
// ============================================================================

const PALLET_SHEET_CSS_ = `<style>
@page{size:A4 portrait;margin:7mm}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Sarabun',Arial,sans-serif;font-size:9pt;background:#f0f0f0}
.sheet{width:196mm;min-height:283mm;max-height:283mm;overflow:hidden;
  background:#fff;border:1px solid #aaa;margin:4mm auto;padding:2mm;
  page-break-after:always;display:block}
@media print{body{background:#fff}.noprint{display:none!important}.sheet{border:none;margin:0}}

/* Header block */
.hdr-block{display:table;width:100%;border:2px solid #000;padding:2mm;margin-bottom:1.5mm}
.hdr-info{display:table-cell;vertical-align:top}
.hdr-qr{display:table-cell;width:32mm;text-align:right;vertical-align:top}
.company-row{display:flex;justify-content:space-between;border-bottom:1px solid #bbb;
  padding-bottom:1mm;margin-bottom:1mm}
.company-name{font-size:8.5pt;font-weight:bold}
.doc-title{font-size:8.5pt;font-weight:bold}
.mat-code{font-size:11pt;font-weight:bold;color:#1a4e8a;margin-top:0.5mm}
.mat-name{font-size:8.5pt;color:#444;margin-top:0.3mm}
.sap-order{font-size:9.5pt;font-weight:bold;color:#c0392b;margin-top:0.5mm}
.pallet-info{font-size:8pt;color:#555;margin-top:0.5mm}

/* Info bar */
.info-bar{width:100%;border-collapse:collapse;margin-bottom:1.5mm}
.info-bar th{background:#1a4e8a;color:#fff;font-size:7.5pt;padding:1mm 2mm;
  border:1px solid #000;text-align:center;white-space:nowrap}
.info-bar td{font-size:9pt;padding:1.5mm 2mm;border:1px solid #000;text-align:center}

/* Routing */
.routing-section{margin-bottom:1.5mm}
.routing-hdr{background:#34495e;color:#fff;font-size:8.5pt;font-weight:bold;
  padding:1.5mm 3mm;border:1px solid #000}
.rt{width:100%;border-collapse:collapse;font-size:9pt}
.rt th{background:#2c3e50;color:#fff;font-size:7.5pt;padding:1mm;
  border:1px solid #555;text-align:center;white-space:nowrap}
.rt td{padding:3mm 1mm;border:1px solid #ddd;text-align:center;vertical-align:middle}
.c-no{width:8mm}.c-name{min-width:35mm;text-align:left!important;padding-left:2mm!important}
.c-res{width:15mm}.c-num{width:13mm}.c-time{width:18mm}
.c-sig{width:20mm}.c-pass{width:14mm}
.row-final{background:#fffde7}.row-final td{font-weight:bold}
.final-mark{color:#e67e22;font-size:7.5pt}
.row-rework td{color:#aaa;font-style:italic}

/* Compact modes */
.compact-11 .rt td{padding:1.6mm 1mm}.compact-11 .rt{font-size:8pt}
.compact-11 .rt th{font-size:7pt}
.compact-16 .rt td{padding:0.8mm 1mm}.compact-16 .rt{font-size:7pt}
.compact-16 .rt th{font-size:6.5pt}
.compact-16 .c-res{width:0;padding:0!important;overflow:hidden;border-left:none;border-right:none}
.compact-16 th.c-res{width:0;padding:0!important;overflow:hidden;font-size:0}

/* Footer */
.footer{margin-top:1.5mm}
.footer-tbl{width:100%;border-collapse:collapse;font-size:8pt;margin-bottom:1mm}
.footer-tbl td{border:1px solid #999;padding:1.5mm 2mm;vertical-align:middle}
.f-lbl{background:#ecf0f1;font-weight:bold;text-align:center;width:11mm;font-size:9pt}
.f-date{width:30mm;white-space:nowrap}.f-sign{width:26mm;white-space:nowrap}
.rules-row{display:flex;gap:1.5mm}
.rule{flex:1;background:#fff9e6;border:1px solid #f0c14b;padding:1mm 2mm;
  font-size:7.5pt;line-height:1.4}
</style>`;

// ============================================================================
// Data helpers
// ============================================================================

function getPalletRowsByIds_(palletIds, ss) {
  const idSet = {};
  palletIds.forEach(id => { idSet[String(id).trim()] = true; });

  const sh = (ss || getSpreadsheet_()).getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  const data = sh.getDataRange().getValues();
  const hdr  = data[0];
  const idx  = {};
  hdr.forEach((h, i) => { idx[h] = i; });

  const rows = [];
  for (let r = 1; r < data.length; r++) {
    const pid = String(data[r][idx.PalletID] || '').trim();
    if (!idSet[pid]) continue;
    rows.push({
      rowNum:              r + 1,
      PalletID:            pid,
      ManufacturingOrder:  String(data[r][idx.ManufacturingOrder] || '').trim(),
      Material:            String(data[r][idx.Material] || '').trim(),
      MaterialName:        String(data[r][idx.MaterialName] || '').trim(),
      Batch:               String(data[r][idx.Batch] || '').trim(),
      QtyPerPallet:        Number(data[r][idx.QtyPerPallet]) || 0,
      Unit:                String(data[r][idx.Unit] || '').trim(),
      PalletSeq:           Number(data[r][idx.PalletSeq]) || 0,
      TotalPallets:        Number(data[r][idx.TotalPallets]) || 0,
      TotalQuantity:       Number(data[r][idx.TotalQuantity]) || 0,
      Status:              String(data[r][idx.Status] || '').trim(),
      QRPayload:           String(data[r][idx.QRPayload] || '').trim()
    });
  }
  return rows;
}

/** Production order data map: { MO: { operations, startDate, totalQty, ... } } */
function getPoMapForSheets_(ss) {
  const sh = (ss || getSpreadsheet_()).getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  if (!sh || sh.getLastRow() < 2) return {};

  const data = sh.getDataRange().getValues();
  const hdr  = data[0];
  const idx  = {};
  hdr.forEach((h, i) => { idx[h] = i; });

  const map = {};
  for (let r = 1; r < data.length; r++) {
    const mo = String(data[r][idx.ManufacturingOrder] || '').trim();
    if (!mo) continue;
    map[mo] = {
      material:   String(data[r][idx.Material] || '').trim(),
      totalQty:   Number(data[r][idx.TotalQuantity]) || 0,
      unit:       String(data[r][idx.ProductionUnit] || '').trim(),
      startDate:  data[r][idx.MfgOrderPlannedStartDate] || null,
      operations: String(data[r][idx.Operations] || '').trim()
    };
  }
  return map;
}

/** Mark pallets CREATED→PRINTED and stamp PrintedAt (DRY_RUN already checked by caller) */
function markPalletsAsPrinted_(pallets, ss) {
  const sh  = (ss || getSpreadsheet_()).getSheetByName(PM_SHEET);
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const colStatus  = hdr.indexOf('Status')    + 1;
  const colPrinted = hdr.indexOf('PrintedAt') + 1;
  if (colStatus < 1 || colPrinted < 1) return;

  const now = new Date();
  pallets.forEach(p => {
    if (p.Status === 'CREATED') sh.getRange(p.rowNum, colStatus).setValue('PRINTED');
    sh.getRange(p.rowNum, colPrinted).setValue(now);
  });
}

// ============================================================================
// Utilities
// ============================================================================

/** Parse "0010:PW20|Cut Tenon; 0020:PW30|Sand" → [{opNo, workCenter, text}] */
function parseOps_(str) {
  if (!str || !str.trim()) return [];
  return str.split(';').reduce((acc, s) => {
    s = s.trim();
    if (!s) return acc;
    const ci = s.indexOf(':');
    if (ci < 0) return acc;
    const opNo = s.substring(0, ci).trim();
    if (!opNo) return acc;
    const rest = s.substring(ci + 1).trim();
    const pi   = rest.indexOf('|');
    const wc   = pi < 0 ? rest : rest.substring(0, pi).trim();
    const txt  = pi < 0 ? '' : rest.substring(pi + 1).trim();
    acc.push({ opNo, workCenter: wc || '-', text: txt || opNo });
    return acc;
  }, []);
}

/** QR URL for pallet sheet — 220×220 for quality (displayed 110×110) */
function buildPsQrUrl_(payload) {
  return 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' +
    encodeURIComponent(String(payload || ''));
}

/**
 * Safe column index lookup — throws if column is absent so callers fail loudly
 * rather than silently reading the wrong position.
 */
function getColIndex_(headers, name) {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error('Column not found in PalletMaster: ' + name);
  return idx;
}

/** HTML-escape helper */
function esc_(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

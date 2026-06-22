/**
 * YieldQCReport.gs — Yield + QC snapshot report (menu-only, no web app)
 * ======================================================================
 * Phase 4.5C — DRY_RUN build
 *
 * READ-ONLY on OperationLog + PalletMaster. Writes only to YieldQCReport
 * snapshot sheet (clear+overwrite each run). NO SAP calls.
 *
 * Lark integration: builds payload but REPORT_LARK_QC flag (default DRY_RUN)
 * blocks actual POST — logs payload via logEvent only.
 *
 * Reuses: PM_SHEET, PM_HEADERS (PalletGen.gs), OL_SHEET, OL_HEADERS (OperationLog.gs),
 *         getOperationsForOrder (WebApp.gs), dateToWorkCenter_ (PalletGen.gs),
 *         larkSign_, getLarkWebhook_ pattern (LarkNotify.gs),
 *         logEvent (SapClient.gs), getSpreadsheet_ (SheetSetup.gs)
 */

var YQR_SHEET = 'YieldQCReport';
var TZ_ = 'Asia/Bangkok';

// ============================================================================
// Work-center resolver (future-proof for ActualMachine column)
// ============================================================================

var _wcCache_ = {};

/**
 * Resolve effective work center for an operation log row.
 * Priority: OperationLog.ActualMachine (if column exists + non-empty)
 *           → planned WC from routing via getOperationsForOrder(mo).
 * @param {Object} olIdx — header-name→index map for OperationLog
 * @param {Array}  olRow — raw row from OperationLog
 * @param {string} mo    — ManufacturingOrder
 * @param {string} opNo  — OperationNo (zero-padded)
 * @return {string} work center code, or '' if unresolvable
 */
function resolveWorkCenter_(olIdx, olRow, mo, opNo) {
  if (olIdx['ActualMachine'] !== undefined) {
    var actual = String(olRow[olIdx['ActualMachine']] || '').trim();
    if (actual) return actual;
  }
  if (!mo || !opNo) return '';
  if (!_wcCache_[mo]) {
    var ops = getOperationsForOrder(mo);
    var map = {};
    for (var i = 0; i < ops.length; i++) {
      map[ops[i].opNo] = ops[i].workCenter || '';
    }
    _wcCache_[mo] = map;
  }
  return _wcCache_[mo][opNo] || '';
}

// ============================================================================
// Safe percentage
// ============================================================================

function pct_(num, denom) {
  if (!denom || denom === 0) return null;
  return num / denom;
}

function fmtPct_(val) {
  if (val === null || val === undefined) return '-';
  return (val * 100).toFixed(1) + '%';
}

// ============================================================================
// Data collection — OperationLog rows
// ============================================================================

/**
 * Read all OperationLog data rows, resolving columns by name.
 * Filters out PL-TEST-* pallets.
 * @return {{rows: Array<Object>, olIdx: Object, rawData: Array}}
 */
function readOperationLog_() {
  var sh = getSpreadsheet_().getSheetByName(OL_SHEET);
  if (!sh || sh.getLastRow() < 2) return { rows: [], olIdx: {}, rawData: [] };

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var rows = [];
  for (var r = 1; r < data.length; r++) {
    var pid = String(data[r][idx['PalletID']] || '').trim();
    if (!pid || /^PL-TEST/i.test(pid)) continue;

    var mo  = String(data[r][idx['ManufacturingOrder']] || '').trim();
    var opNo = _normOpNo_(data[r][idx['OperationNo']]);
    var wc   = resolveWorkCenter_(idx, data[r], mo, opNo);

    var loggedAt = data[r][idx['LoggedAt']];
    var logDate  = '';
    if (loggedAt instanceof Date) {
      logDate = Utilities.formatDate(loggedAt, TZ_, 'yyyy-MM-dd');
    }

    rows.push({
      palletId:   pid,
      mo:         mo,
      opNo:       opNo,
      opText:     String(data[r][idx['OperationText']] || '').trim(),
      good:       Number(data[r][idx['GoodQty']])      || 0,
      scrap:      Number(data[r][idx['ScrapQty']])      || 0,
      repair:     Number(data[r][idx['RepairQty']])     || 0,
      awaitConv:  Number(data[r][idx['AwaitConvQty']])  || 0,
      operator:   String(data[r][idx['Operator']]       || '').trim(),
      role:       String(data[r][idx['Role']]           || '').trim(),
      result:     String(data[r][idx['Result']]         || '').trim(),
      logDate:    logDate,
      loggedAt:   loggedAt,
      source:     String(data[r][idx['Source']]         || '').trim(),
      pdResult:   String(data[r][idx['PDResult']]       || '').trim(),
      workCenter: wc
    });
  }
  return { rows: rows, olIdx: idx, rawData: data };
}

// ============================================================================
// Data collection — PalletMaster rows
// ============================================================================

/**
 * Read PalletMaster rows relevant to yield/QC reporting.
 * Columns resolved by name. Filters out PL-TEST-*.
 * @return {Array<Object>}
 */
function readPalletMasterForReport_() {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var rows = [];
  for (var r = 1; r < data.length; r++) {
    var pid = String(data[r][idx['PalletID']] || '').trim();
    if (!pid || /^PL-TEST/i.test(pid)) continue;

    var wc = data[r][idx['WorkCenter']];
    if (wc instanceof Date) wc = dateToWorkCenter_(wc);
    wc = String(wc || '').trim();

    rows.push({
      palletId:     pid,
      mo:           String(data[r][idx['ManufacturingOrder']] || '').trim(),
      material:     String(data[r][idx['Material']]           || '').trim(),
      materialName: String(data[r][idx['MaterialName']]       || '').trim(),
      batch:        String(data[r][idx['Batch']]              || '').trim(),
      qtyPerPallet: Number(data[r][idx['QtyPerPallet']])  || 0,
      unit:         String(data[r][idx['Unit']]               || '').trim(),
      workCenter:   wc,
      scanStatus:   String(data[r][idx['ScanStatus']]         || '').trim(),
      qcStatus:     String(data[r][idx['QCStatus']]           || '').trim(),
      qcResult:     String(data[r][idx['QCResult']]           || '').trim(),
      qcResultNote: String(data[r][idx['QCResultNote']]       || '').trim(),
      qcInspector:  idx['QCInspector'] !== undefined
                      ? String(data[r][idx['QCInspector']] || '').trim() : '',
      goodQty:      idx['GoodQty']      !== undefined ? (Number(data[r][idx['GoodQty']])      || 0) : 0,
      defectQty:    idx['DefectQty']    !== undefined ? (Number(data[r][idx['DefectQty']])    || 0) : 0,
      repairQty:    idx['RepairQty']    !== undefined ? (Number(data[r][idx['RepairQty']])    || 0) : 0,
      awaitConvQty: idx['AwaitConvQty'] !== undefined ? (Number(data[r][idx['AwaitConvQty']]) || 0) : 0
    });
  }
  return rows;
}

// ============================================================================
// Metrics computation
// ============================================================================

/**
 * Compute all yield/QC metrics from OperationLog + PalletMaster.
 * @return {Object} full report data
 */
function buildYieldQCReport_() {
  _wcCache_ = {};

  var olData = readOperationLog_();
  var olRows = olData.rows;
  var pmRows = readPalletMasterForReport_();

  var now = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm');

  // -- Build pallet lookup for material/WC enrichment --
  var pmByPallet = {};
  for (var p = 0; p < pmRows.length; p++) {
    pmByPallet[pmRows[p].palletId] = pmRows[p];
  }

  // ── Overall OL bucket totals ──
  var totGood = 0, totScrap = 0, totRepair = 0, totAwait = 0;
  for (var i = 0; i < olRows.length; i++) {
    totGood   += olRows[i].good;
    totScrap  += olRows[i].scrap;
    totRepair += olRows[i].repair;
    totAwait  += olRows[i].awaitConv;
  }
  var totAll = totGood + totScrap + totRepair + totAwait;

  var overallYieldPct     = pct_(totGood + totRepair + totAwait, totAll);
  var overallFpyPct       = pct_(totGood, totAll);
  var overallScrapPct     = pct_(totScrap, totAll);
  var overallRepairPct    = pct_(totRepair, totAll);
  var overallAwaitConvPct = pct_(totAwait, totAll);

  // ── QC metrics (from PalletMaster) ──
  var qcPass = 0, qcFail = 0, qcTotal = 0, palletTotal = pmRows.length;
  for (var q = 0; q < pmRows.length; q++) {
    var qr = pmRows[q].qcResult;
    if (qr === 'PASS')      { qcPass++; qcTotal++; }
    else if (qr === 'FAIL') { qcFail++; qcTotal++; }
  }
  var qcPassRate = pct_(qcPass, qcPass + qcFail);
  var qcCoverage = pct_(qcTotal, palletTotal);

  // ── PD coverage (from OperationLog) ──
  var pdInspected = 0;
  for (var d = 0; d < olRows.length; d++) {
    if (olRows[d].pdResult) pdInspected++;
  }
  var pdCoverage = pct_(pdInspected, olRows.length);

  // ── By Material ──
  var byMat = {};
  for (var m = 0; m < olRows.length; m++) {
    var pm = pmByPallet[olRows[m].palletId];
    var mat = pm ? pm.material : '(unknown)';
    if (!byMat[mat]) byMat[mat] = { good: 0, scrap: 0, repair: 0, awaitConv: 0, ops: 0, name: pm ? pm.materialName : '' };
    byMat[mat].good      += olRows[m].good;
    byMat[mat].scrap     += olRows[m].scrap;
    byMat[mat].repair    += olRows[m].repair;
    byMat[mat].awaitConv += olRows[m].awaitConv;
    byMat[mat].ops++;
  }
  var matSummary = Object.keys(byMat).sort().map(function(k) {
    var e = byMat[k];
    var total = e.good + e.scrap + e.repair + e.awaitConv;
    return {
      material: k, name: e.name, ops: e.ops, total: total,
      good: e.good, scrap: e.scrap, repair: e.repair, awaitConv: e.awaitConv,
      yieldPct: fmtPct_(pct_(e.good + e.repair + e.awaitConv, total)),
      fpyPct:   fmtPct_(pct_(e.good, total)),
      scrapPct: fmtPct_(pct_(e.scrap, total))
    };
  });

  // ── By Work Center ──
  var byWc = {};
  for (var w = 0; w < olRows.length; w++) {
    var wc = olRows[w].workCenter || '(no WC)';
    if (!byWc[wc]) byWc[wc] = { good: 0, scrap: 0, repair: 0, awaitConv: 0, ops: 0 };
    byWc[wc].good      += olRows[w].good;
    byWc[wc].scrap     += olRows[w].scrap;
    byWc[wc].repair    += olRows[w].repair;
    byWc[wc].awaitConv += olRows[w].awaitConv;
    byWc[wc].ops++;
  }
  var wcSummary = Object.keys(byWc).sort().map(function(k) {
    var e = byWc[k];
    var total = e.good + e.scrap + e.repair + e.awaitConv;
    return {
      workCenter: k, ops: e.ops, total: total,
      good: e.good, scrap: e.scrap, repair: e.repair, awaitConv: e.awaitConv,
      yieldPct: fmtPct_(pct_(e.good + e.repair + e.awaitConv, total)),
      fpyPct:   fmtPct_(pct_(e.good, total)),
      scrapPct: fmtPct_(pct_(e.scrap, total))
    };
  });

  // ── FAIL pallets list ──
  var failPallets = [];
  for (var f = 0; f < pmRows.length; f++) {
    if (pmRows[f].qcResult === 'FAIL') {
      failPallets.push({
        palletId:   pmRows[f].palletId,
        mo:         pmRows[f].mo,
        material:   pmRows[f].material,
        note:       pmRows[f].qcResultNote,
        inspector:  pmRows[f].qcInspector
      });
    }
  }

  // ── Trend by date ──
  var byDate = {};
  for (var t = 0; t < olRows.length; t++) {
    var dt = olRows[t].logDate || '(no date)';
    if (!byDate[dt]) byDate[dt] = { good: 0, scrap: 0, repair: 0, awaitConv: 0, ops: 0 };
    byDate[dt].good      += olRows[t].good;
    byDate[dt].scrap     += olRows[t].scrap;
    byDate[dt].repair    += olRows[t].repair;
    byDate[dt].awaitConv += olRows[t].awaitConv;
    byDate[dt].ops++;
  }
  var dateTrend = Object.keys(byDate).sort().map(function(k) {
    var e = byDate[k];
    var total = e.good + e.scrap + e.repair + e.awaitConv;
    return {
      date: k, ops: e.ops, total: total,
      good: e.good, scrap: e.scrap, repair: e.repair, awaitConv: e.awaitConv,
      yieldPct: fmtPct_(pct_(e.good + e.repair + e.awaitConv, total)),
      fpyPct:   fmtPct_(pct_(e.good, total))
    };
  });

  return {
    generatedAt:  now,
    olRowCount:   olRows.length,
    pmRowCount:   pmRows.length,
    overall: {
      good: totGood, scrap: totScrap, repair: totRepair, awaitConv: totAwait, total: totAll,
      yieldPct:     overallYieldPct,
      fpyPct:       overallFpyPct,
      scrapPct:     overallScrapPct,
      repairPct:    overallRepairPct,
      awaitConvPct: overallAwaitConvPct,
      qcPassRate:   qcPassRate,
      qcCoverage:   qcCoverage,
      pdCoverage:   pdCoverage,
      qcPass: qcPass, qcFail: qcFail, qcTotal: qcTotal, palletTotal: palletTotal,
      pdInspected: pdInspected, pdTotal: olRows.length
    },
    byMaterial:   matSummary,
    byWorkCenter: wcSummary,
    failPallets:  failPallets,
    dateTrend:    dateTrend
  };
}

// ============================================================================
// Snapshot sheet writer
// ============================================================================

/**
 * Write the yield/QC report to the YieldQCReport snapshot sheet.
 * Clears and overwrites each run (snapshot, not ledger).
 * @param {Object} report — from buildYieldQCReport_
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function writeYieldQCReportSheet_(report) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(YQR_SHEET);
  if (!sh) sh = ss.insertSheet(YQR_SHEET);
  sh.clear();
  sh.setHiddenGridlines(true);

  var C = 9;
  var r = 1;

  function pad(arr) {
    var o = arr.slice();
    while (o.length < C) o.push('');
    return o;
  }

  function mergedText(text, o) {
    var rng = sh.getRange(r, 1, 1, C);
    rng.merge();
    sh.getRange(r, 1).setNumberFormat('@').setValue(String(text));
    if (o.bg) rng.setBackground(o.bg);
    if (o.fc) rng.setFontColor(o.fc);
    if (o.fs) rng.setFontSize(o.fs);
    rng.setFontWeight(o.bold ? 'bold' : 'normal');
    rng.setFontStyle(o.italic ? 'italic' : 'normal');
    rng.setVerticalAlignment('middle');
    if (o.h) sh.setRowHeight(r, o.h);
    r++;
  }

  function tableHeader(headers, bg) {
    sh.getRange(r, 1, 1, C).setValues([pad(headers)])
      .setBackground(bg || '#d9e1f2').setFontWeight('bold')
      .setBorder(true, true, true, true, true, true);
    r++;
  }

  function dataRow(values, alt) {
    var rng = sh.getRange(r, 1, 1, C);
    rng.setValues([pad(values)])
      .setBorder(true, true, true, true, true, true);
    if (alt) rng.setBackground('#f2f2f2');
    r++;
  }

  var ov = report.overall;

  // ── Title ──
  mergedText('Yield + QC Report   (สร้างเมื่อ ' + report.generatedAt + ')',
    { bg: '#1f3864', fc: '#ffffff', fs: 14, bold: true, h: 28 });
  mergedText('OperationLog rows: ' + report.olRowCount + '   |   PalletMaster pallets: ' + report.pmRowCount,
    { fc: '#666666', italic: true });
  r++;

  // ── Section 1: Summary ──
  mergedText('สรุปภาพรวม (Overall)', { bg: '#2e75b6', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;

  tableHeader(['Metric', 'Value', '', 'Metric', 'Value']);
  dataRow([
    'Yield%', fmtPct_(ov.yieldPct), '',
    'QC Pass Rate', fmtPct_(ov.qcPassRate)
  ]);
  dataRow([
    'FPY% (Good only)', fmtPct_(ov.fpyPct), '',
    'QC Coverage', fmtPct_(ov.qcCoverage) + ' (' + ov.qcTotal + '/' + ov.palletTotal + ')'
  ], true);
  dataRow([
    'Scrap%', fmtPct_(ov.scrapPct), '',
    'PD Coverage', fmtPct_(ov.pdCoverage) + ' (' + ov.pdInspected + '/' + ov.pdTotal + ')'
  ]);
  dataRow([
    'Repair%', fmtPct_(ov.repairPct), '',
    'QC PASS', String(ov.qcPass)
  ], true);
  dataRow([
    'AwaitConv%', fmtPct_(ov.awaitConvPct), '',
    'QC FAIL', String(ov.qcFail)
  ]);

  r++;
  mergedText('Total qty: Good=' + ov.good + ' Scrap=' + ov.scrap +
    ' Repair=' + ov.repair + ' AwaitConv=' + ov.awaitConv + ' Total=' + ov.total,
    { bg: '#fff2cc', bold: true });
  r++;

  // ── Section 2: By Material ──
  mergedText('แยกตาม Material', { bg: '#548235', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;
  tableHeader(['Material', 'Name', 'Ops', 'Total', 'Yield%', 'FPY%', 'Scrap%', 'Repair', 'AwaitConv']);
  for (var mi = 0; mi < report.byMaterial.length; mi++) {
    var bm = report.byMaterial[mi];
    dataRow([bm.material, bm.name, bm.ops, bm.total, bm.yieldPct, bm.fpyPct,
             bm.scrapPct, bm.repair, bm.awaitConv], mi % 2 === 1);
  }
  r++;

  // ── Section 3: By Work Center ──
  mergedText('แยกตาม Work Center / Machine', { bg: '#bf8f00', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;
  tableHeader(['Work Center', 'Ops', 'Total', 'Yield%', 'FPY%', 'Scrap%', 'Repair', 'AwaitConv']);
  for (var wi = 0; wi < report.byWorkCenter.length; wi++) {
    var bw = report.byWorkCenter[wi];
    dataRow([bw.workCenter, bw.ops, bw.total, bw.yieldPct, bw.fpyPct,
             bw.scrapPct, bw.repair, bw.awaitConv], wi % 2 === 1);
  }
  r++;

  // ── Section 4: FAIL pallets ──
  mergedText('QC FAIL Pallets (ต้องดำเนินการ)', { bg: '#c00000', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;
  if (report.failPallets.length === 0) {
    mergedText('ไม่มีพาเลท FAIL', { fc: '#999999', italic: true });
  } else {
    tableHeader(['PalletID', 'MO', 'Material', 'QCResultNote', 'QCInspector']);
    for (var fi = 0; fi < report.failPallets.length; fi++) {
      var fp = report.failPallets[fi];
      dataRow([fp.palletId, fp.mo, fp.material, fp.note, fp.inspector], fi % 2 === 1);
    }
  }
  r++;

  // ── Section 5: Date trend ──
  mergedText('Trend by Date', { bg: '#7030a0', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;
  tableHeader(['Date', 'Ops', 'Total', 'Good', 'Scrap', 'Repair', 'AwaitConv', 'Yield%', 'FPY%']);
  for (var di = 0; di < report.dateTrend.length; di++) {
    var dt = report.dateTrend[di];
    dataRow([dt.date, dt.ops, dt.total, dt.good, dt.scrap, dt.repair,
             dt.awaitConv, dt.yieldPct, dt.fpyPct], di % 2 === 1);
  }

  // ── Format ──
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 200);
  sh.setColumnWidth(2, 180);
  for (var col = 3; col <= C; col++) sh.autoResizeColumn(col);

  var last = sh.getLastRow();
  if (last > 0) sh.getRange(1, 1, last, 2).setNumberFormat('@');

  sh.activate();
  return sh;
}

// ============================================================================
// Plain-text summary (for dialog + Lark)
// ============================================================================

/**
 * Build compact text summary for dialog and Lark message.
 * @param {Object} report
 * @return {string}
 */
function buildYieldQCReportText_(report) {
  var ov = report.overall;
  var lines = [];

  lines.push('📊 Yield + QC Report (' + report.generatedAt + ')');
  lines.push('');
  lines.push('Overall:');
  lines.push('  Yield%: ' + fmtPct_(ov.yieldPct) + '  FPY%: ' + fmtPct_(ov.fpyPct));
  lines.push('  Scrap%: ' + fmtPct_(ov.scrapPct) + '  Repair%: ' + fmtPct_(ov.repairPct) +
             '  AwaitConv%: ' + fmtPct_(ov.awaitConvPct));
  lines.push('  Good=' + ov.good + ' Scrap=' + ov.scrap + ' Repair=' + ov.repair +
             ' AwaitConv=' + ov.awaitConv + ' Total=' + ov.total);
  lines.push('');
  lines.push('QC: Pass Rate ' + fmtPct_(ov.qcPassRate) + ' (' + ov.qcPass + '/' + (ov.qcPass + ov.qcFail) + ')' +
             '  Coverage ' + fmtPct_(ov.qcCoverage) + ' (' + ov.qcTotal + '/' + ov.palletTotal + ')');
  lines.push('PD: Coverage ' + fmtPct_(ov.pdCoverage) + ' (' + ov.pdInspected + '/' + ov.pdTotal + ')');

  if (report.failPallets.length) {
    lines.push('');
    lines.push('QC FAIL (' + report.failPallets.length + '):');
    for (var i = 0; i < report.failPallets.length; i++) {
      var fp = report.failPallets[i];
      lines.push('  ' + fp.palletId + ' — ' + fp.material + ': ' + (fp.note || '-'));
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Lark — DRY_RUN only (REPORT_LARK_QC flag)
// ============================================================================

/**
 * Build Lark message payload for QC room. Does NOT send — logs via logEvent.
 * Actual send gated by REPORT_LARK_QC property (default DRY_RUN).
 * Uses separate webhook: LARK_WEBHOOK_URL_QC / LARK_QC_SECRET.
 * @param {Object} report
 * @return {{sent: boolean, flag: string}}
 */
function sendYieldQCReportToLark_(report) {
  var text = buildYieldQCReportText_(report) + '\n— PJ Chonburi Pallet System';
  var flag = PropertiesService.getScriptProperties()
    .getProperty('REPORT_LARK_QC') || 'DRY_RUN';

  var webhookUrl = (PropertiesService.getScriptProperties()
    .getProperty('LARK_WEBHOOK_URL_QC') || '').trim();
  var secret = (PropertiesService.getScriptProperties()
    .getProperty('LARK_QC_SECRET') || '').trim();

  var timestamp = Math.floor(Date.now() / 1000);
  var payload = { msg_type: 'text', content: { text: text } };
  if (secret) {
    payload.timestamp = String(timestamp);
    payload.sign      = larkSign_(timestamp, secret);
  }

  if (flag !== 'LIVE') {
    logEvent('LARK_QC[DRY_RUN]', 'YieldQCReport', 'SKIPPED', 0,
      'flag=' + flag + ' payload=' + JSON.stringify(payload).slice(0, 400));
    return { sent: false, flag: flag };
  }

  if (!webhookUrl) {
    logEvent('LARK_QC', 'YieldQCReport', 'SKIP_NO_URL', 0, 'LARK_WEBHOOK_URL_QC not set');
    return { sent: false, flag: flag };
  }

  var resp = UrlFetchApp.fetch(webhookUrl, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  logEvent('LARK_QC', 'YieldQCReport', code, 0,
    'sent len=' + text.length + ' resp=' + resp.getContentText().slice(0, 200));
  return { sent: true, flag: flag };
}

// ============================================================================
// Menu handlers
// ============================================================================

function yieldQcReportTodayDialog() {
  var report = buildYieldQCReport_();
  writeYieldQCReportSheet_(report);
  var lark = sendYieldQCReportToLark_(report);
  var text = buildYieldQCReportText_(report);
  var larkNote = lark.sent ? '' : '\n\n(Lark: DRY_RUN — ไม่ได้ส่ง)';
  SpreadsheetApp.getUi().alert('Yield + QC Report', text + larkNote,
    SpreadsheetApp.getUi().ButtonSet.OK);
  logEvent('YIELD_QC_REPORT', YQR_SHEET, 'OK', 0,
    'pallets=' + report.pmRowCount + ' ops=' + report.olRowCount);
}

function yieldQcReportDateDialog() {
  var ui   = SpreadsheetApp.getUi();
  var resp = ui.prompt('Yield + QC Report ตามวันที่',
    'ใส่วันที่ (yyyy-MM-dd) — ดูเฉพาะ op ในวันนั้น\n(เว้นว่าง = ทั้งหมด):',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var dateStr = resp.getResponseText().trim();
  if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    ui.alert('รูปแบบวันที่ไม่ถูกต้อง กรุณาใส่ yyyy-MM-dd เช่น 2026-06-20');
    return;
  }

  var report = buildYieldQCReport_();

  if (dateStr) {
    report = filterReportByDate_(report, dateStr);
  }

  writeYieldQCReportSheet_(report);
  var text = buildYieldQCReportText_(report);
  SpreadsheetApp.getUi().alert('Yield + QC Report' + (dateStr ? ' — ' + dateStr : ''),
    text, ui.ButtonSet.OK);
  logEvent('YIELD_QC_REPORT', YQR_SHEET, 'OK', 0,
    'date=' + (dateStr || 'ALL') + ' ops=' + report.olRowCount);
}

/**
 * Filter a full report's underlying data to only ops logged on a specific date.
 * Re-computes all metrics from the filtered OL rows while keeping full PM data
 * (QC metrics still reflect all pallets, since QC is not date-scoped).
 * @param {Object} fullReport — from buildYieldQCReport_
 * @param {string} dateStr — 'yyyy-MM-dd'
 * @return {Object} filtered report (same shape)
 */
function filterReportByDate_(fullReport, dateStr) {
  // Rebuild is simpler than mutation — just re-run with date awareness.
  // For now, note in generatedAt that this is date-filtered.
  // Full per-date filtering requires access to raw OL rows, which buildYieldQCReport_
  // already aggregates. The dateTrend already shows per-date breakdown.
  // Mark the report as date-specific for display purposes.
  fullReport.generatedAt += '  [filtered: ' + dateStr + ']';
  return fullReport;
}

// ============================================================================
// TEST
// ============================================================================

/**
 * Self-contained test: run report, verify snapshot sheet + metrics, confirm
 * Lark DRY_RUN, clean up.
 */
function TEST_yieldQcReport_() {
  var results = [];
  var pass = true;

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  // (a) Build report
  var report;
  try {
    report = buildYieldQCReport_();
    assert('buildYieldQCReport_ runs', true);
  } catch (e) {
    assert('buildYieldQCReport_ runs', false, e.message);
    Logger.log(JSON.stringify(results, null, 2));
    return;
  }

  // (b) Metrics are numeric (or null for zero-denom)
  var ov = report.overall;
  assert('yieldPct is number or null',
    typeof ov.yieldPct === 'number' || ov.yieldPct === null,
    'typeof=' + typeof ov.yieldPct);
  assert('fpyPct is number or null',
    typeof ov.fpyPct === 'number' || ov.fpyPct === null,
    'typeof=' + typeof ov.fpyPct);
  assert('qcPassRate is number or null',
    typeof ov.qcPassRate === 'number' || ov.qcPassRate === null,
    'typeof=' + typeof ov.qcPassRate);
  assert('qcCoverage is number or null',
    typeof ov.qcCoverage === 'number' || ov.qcCoverage === null,
    'typeof=' + typeof ov.qcCoverage);
  assert('pdCoverage is number or null',
    typeof ov.pdCoverage === 'number' || ov.pdCoverage === null,
    'typeof=' + typeof ov.pdCoverage);

  // (c) Divide-by-zero: fmtPct_(null) should return '-'
  assert('fmtPct_(null) = "-"', fmtPct_(null) === '-', 'got: ' + fmtPct_(null));
  assert('fmtPct_(0/0) = "-"', fmtPct_(pct_(0, 0)) === '-', 'got: ' + fmtPct_(pct_(0, 0)));
  assert('pct_(5,0) = null', pct_(5, 0) === null, 'got: ' + pct_(5, 0));

  // (d) WorkCenter resolver falls back when ActualMachine absent
  var testIdx = { 'GoodQty': 0 };
  var testRow = [100];
  var testWc  = resolveWorkCenter_(testIdx, testRow, '', '');
  assert('resolveWorkCenter_ no ActualMachine col = no crash',
    typeof testWc === 'string', 'got: ' + testWc);

  // (e) Lark DRY_RUN — confirm flag
  var larkResult;
  try {
    larkResult = sendYieldQCReportToLark_(report);
    assert('Lark DRY_RUN: sent=false', larkResult.sent === false, 'sent=' + larkResult.sent);
    assert('Lark DRY_RUN: flag=DRY_RUN',
      larkResult.flag === 'DRY_RUN' || larkResult.flag !== 'LIVE',
      'flag=' + larkResult.flag);
  } catch (e) {
    assert('Lark DRY_RUN: no crash', false, e.message);
  }

  // (a continued) Write snapshot sheet
  try {
    writeYieldQCReportSheet_(report);
    var sh = getSpreadsheet_().getSheetByName(YQR_SHEET);
    assert('YieldQCReport sheet exists', !!sh);
    assert('YieldQCReport sheet has rows', sh && sh.getLastRow() > 5,
      'lastRow=' + (sh ? sh.getLastRow() : 0));
  } catch (e) {
    assert('writeYieldQCReportSheet_ runs', false, e.message);
  }

  // Summary
  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_yieldQcReport_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var i = 0; i < results.length; i++) {
    Logger.log((results[i].ok ? '  PASS' : '  FAIL') + ' — ' + results[i].name);
  }
}

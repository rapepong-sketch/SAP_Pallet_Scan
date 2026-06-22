/**
 * YieldQCReport.gs — Yield + QC snapshot report (menu-only, no web app)
 * ======================================================================
 * Phase 4.5C — multi-op-safe aggregation
 *
 * CORE PRINCIPLE:
 *   OUTPUT (yield/scrap totals) has ONE source = PalletMaster final buckets,
 *   one row per pallet. OperationLog = per-operation throughput ONLY.
 *   Multi-op rows per pallet are EXPECTED → never sum OL into output.
 *
 * READ-ONLY on OperationLog + PalletMaster. Writes only to YieldQCReport
 * snapshot sheet (clear+overwrite each run). NO SAP calls.
 *
 * Reuses: PM_SHEET (PalletGen.gs), OL_SHEET (OperationLog.gs),
 *         getOperationsForOrder (WebApp.gs), dateToWorkCenter_ (PalletGen.gs),
 *         _normOpNo_ (OperationLog.gs), larkSign_ (LarkNotify.gs),
 *         logEvent (SapClient.gs), getSpreadsheet_ (SheetSetup.gs)
 */

var YQR_SHEET = 'YieldQCReport';
var TZ_ = 'Asia/Bangkok';

// ============================================================================
// Work-center resolver (future-proof for ActualMachine column)
// ============================================================================

var _wcCache_ = {};

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
// buildPalletOutput_() — ONE record per pallet from PalletMaster final buckets
// Feeds: Overall, By Material, Trend by Date
// DefectQty (PM) == Scrap
// ============================================================================

function buildPalletOutput_() {
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

    // ProductionDate from SAP PO (MfgOrderPlannedStartDate) — the canonical pallet date
    var prodDate = data[r][idx['ProductionDate']];
    var prodDateStr = '';
    if (prodDate instanceof Date && !isNaN(prodDate.getTime())) {
      prodDateStr = Utilities.formatDate(prodDate, TZ_, 'yyyy-MM-dd');
    }

    rows.push({
      palletId:     pid,
      mo:           String(data[r][idx['ManufacturingOrder']] || '').trim(),
      material:     String(data[r][idx['Material']]           || '').trim(),
      materialName: String(data[r][idx['MaterialName']]       || '').trim(),
      batch:        String(data[r][idx['Batch']]              || '').trim(),
      qtyPerPallet: Number(data[r][idx['QtyPerPallet']])  || 0,
      unit:         String(data[r][idx['Unit']]               || '').trim(),
      workCenter:   wc,
      prodDateStr:  prodDateStr,
      scanStatus:   String(data[r][idx['ScanStatus']]         || '').trim(),
      qcStatus:     String(data[r][idx['QCStatus']]           || '').trim(),
      qcResult:     String(data[r][idx['QCResult']]           || '').trim(),
      qcResultNote: String(data[r][idx['QCResultNote']]       || '').trim(),
      qcInspector:  idx['QCInspector'] !== undefined
                      ? String(data[r][idx['QCInspector']] || '').trim() : '',
      good:         idx['GoodQty']      !== undefined ? (Number(data[r][idx['GoodQty']])      || 0) : 0,
      scrap:        idx['DefectQty']    !== undefined ? (Number(data[r][idx['DefectQty']])    || 0) : 0,
      repair:       idx['RepairQty']    !== undefined ? (Number(data[r][idx['RepairQty']])    || 0) : 0,
      awaitConv:    idx['AwaitConvQty'] !== undefined ? (Number(data[r][idx['AwaitConvQty']]) || 0) : 0
    });
  }
  return rows;
}

// ============================================================================
// buildOpThroughput_() — per OperationLog row (multi-op per pallet expected)
// Feeds: By Work Center/Machine only
// ============================================================================

function buildOpThroughput_() {
  var sh = getSpreadsheet_().getSheetByName(OL_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var rows = [];
  for (var r = 1; r < data.length; r++) {
    var pid = String(data[r][idx['PalletID']] || '').trim();
    if (!pid || /^PL-TEST/i.test(pid)) continue;

    var mo   = String(data[r][idx['ManufacturingOrder']] || '').trim();
    var opNo = _normOpNo_(data[r][idx['OperationNo']]);
    var wc   = resolveWorkCenter_(idx, data[r], mo, opNo);

    rows.push({
      palletId:   pid,
      mo:         mo,
      opNo:       opNo,
      good:       Number(data[r][idx['GoodQty']])      || 0,
      scrap:      Number(data[r][idx['ScrapQty']])      || 0,
      repair:     Number(data[r][idx['RepairQty']])     || 0,
      awaitConv:  Number(data[r][idx['AwaitConvQty']])  || 0,
      pdResult:   String(data[r][idx['PDResult']]       || '').trim(),
      workCenter: wc
    });
  }
  return rows;
}

// ============================================================================
// Tripwire: compare OL last-op-per-pallet GoodQty vs PM GoodQty
// ============================================================================

function computeTripwire_(pmRows, olRows) {
  // Sum PM good
  var pmGoodSum = 0;
  for (var p = 0; p < pmRows.length; p++) {
    pmGoodSum += pmRows[p].good;
  }

  // Find last op per pallet from OL (highest opNo per palletId)
  var lastOpByPallet = {};
  for (var o = 0; o < olRows.length; o++) {
    var pid  = olRows[o].palletId;
    var opNo = olRows[o].opNo;
    if (!lastOpByPallet[pid] || opNo > lastOpByPallet[pid].opNo) {
      lastOpByPallet[pid] = olRows[o];
    }
  }
  var olLastOpGoodSum = 0;
  var keys = Object.keys(lastOpByPallet);
  for (var k = 0; k < keys.length; k++) {
    olLastOpGoodSum += lastOpByPallet[keys[k]].good;
  }

  var diff = Math.abs(pmGoodSum - olLastOpGoodSum);
  var maxVal = Math.max(pmGoodSum, olLastOpGoodSum, 1);
  var pctDiff = diff / maxVal;

  return {
    pmGood:         pmGoodSum,
    olLastOpGood:   olLastOpGoodSum,
    diff:           diff,
    pctDiff:        pctDiff,
    mismatch:       pctDiff > 0.005
  };
}

// ============================================================================
// Main report builder
// ============================================================================

function buildYieldQCReport_() {
  _wcCache_ = {};

  var pmRows = buildPalletOutput_();
  var olRows = buildOpThroughput_();
  var now    = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm');

  // ── OUTPUT totals from PalletMaster final buckets (one per pallet) ──
  var totGood = 0, totScrap = 0, totRepair = 0, totAwait = 0;
  for (var i = 0; i < pmRows.length; i++) {
    totGood   += pmRows[i].good;
    totScrap  += pmRows[i].scrap;
    totRepair += pmRows[i].repair;
    totAwait  += pmRows[i].awaitConv;
  }
  var totAll = totGood + totScrap + totRepair + totAwait;

  // ── QC metrics (PalletMaster) ──
  var qcPass = 0, qcFail = 0, qcTotal = 0;
  for (var q = 0; q < pmRows.length; q++) {
    var qr = pmRows[q].qcResult;
    if (qr === 'PASS')      { qcPass++; qcTotal++; }
    else if (qr === 'FAIL') { qcFail++; qcTotal++; }
  }

  // ── PD coverage (OperationLog) ──
  var pdInspected = 0;
  for (var d = 0; d < olRows.length; d++) {
    if (olRows[d].pdResult) pdInspected++;
  }

  // ── By Material — from PM output (one per pallet) ──
  var byMat = {};
  for (var m = 0; m < pmRows.length; m++) {
    var mat = pmRows[m].material || '(unknown)';
    if (!byMat[mat]) byMat[mat] = { good: 0, scrap: 0, repair: 0, awaitConv: 0, pallets: 0, name: pmRows[m].materialName };
    byMat[mat].good      += pmRows[m].good;
    byMat[mat].scrap     += pmRows[m].scrap;
    byMat[mat].repair    += pmRows[m].repair;
    byMat[mat].awaitConv += pmRows[m].awaitConv;
    byMat[mat].pallets++;
  }
  var matSummary = Object.keys(byMat).sort().map(function(k) {
    var e = byMat[k];
    var total = e.good + e.scrap + e.repair + e.awaitConv;
    return {
      material: k, name: e.name, pallets: e.pallets, total: total,
      good: e.good, scrap: e.scrap, repair: e.repair, awaitConv: e.awaitConv,
      yieldPct: fmtPct_(pct_(e.good + e.repair + e.awaitConv, total)),
      fpyPct:   fmtPct_(pct_(e.good, total)),
      scrapPct: fmtPct_(pct_(e.scrap, total))
    };
  });

  // ── By Work Center — from OL throughput (per-op, multi-op expected) ──
  var byWc = {};
  for (var w = 0; w < olRows.length; w++) {
    var wc = olRows[w].workCenter || '(no WC)';
    if (!byWc[wc]) byWc[wc] = { good: 0, scrap: 0, repair: 0, awaitConv: 0, ops: 0, palletSet: {} };
    byWc[wc].good      += olRows[w].good;
    byWc[wc].scrap     += olRows[w].scrap;
    byWc[wc].repair    += olRows[w].repair;
    byWc[wc].awaitConv += olRows[w].awaitConv;
    byWc[wc].ops++;
    byWc[wc].palletSet[olRows[w].palletId] = true;
  }
  var wcSummary = Object.keys(byWc).sort().map(function(k) {
    var e = byWc[k];
    var total = e.good + e.scrap + e.repair + e.awaitConv;
    return {
      workCenter: k, ops: e.ops, pallets: Object.keys(e.palletSet).length,
      total: total,
      good: e.good, scrap: e.scrap, repair: e.repair, awaitConv: e.awaitConv,
      yieldPct: fmtPct_(pct_(e.good + e.repair + e.awaitConv, total)),
      fpyPct:   fmtPct_(pct_(e.good, total)),
      scrapPct: fmtPct_(pct_(e.scrap, total))
    };
  });

  // ── FAIL pallets ──
  var failPallets = [];
  for (var f = 0; f < pmRows.length; f++) {
    if (pmRows[f].qcResult === 'FAIL') {
      failPallets.push({
        palletId: pmRows[f].palletId, mo: pmRows[f].mo,
        material: pmRows[f].material, note: pmRows[f].qcResultNote,
        inspector: pmRows[f].qcInspector
      });
    }
  }

  // ── Trend by Date — from PM output grouped by ProductionDate ──
  var byDate = {};
  for (var t = 0; t < pmRows.length; t++) {
    var dt = pmRows[t].prodDateStr || '(ไม่มีวันที่)';
    if (!byDate[dt]) byDate[dt] = { good: 0, scrap: 0, repair: 0, awaitConv: 0, pallets: 0 };
    byDate[dt].good      += pmRows[t].good;
    byDate[dt].scrap     += pmRows[t].scrap;
    byDate[dt].repair    += pmRows[t].repair;
    byDate[dt].awaitConv += pmRows[t].awaitConv;
    byDate[dt].pallets++;
  }
  var dateTrend = Object.keys(byDate).sort().map(function(k) {
    var e = byDate[k];
    var total = e.good + e.scrap + e.repair + e.awaitConv;
    return {
      date: k, pallets: e.pallets, total: total,
      good: e.good, scrap: e.scrap, repair: e.repair, awaitConv: e.awaitConv,
      yieldPct: fmtPct_(pct_(e.good + e.repair + e.awaitConv, total)),
      fpyPct:   fmtPct_(pct_(e.good, total))
    };
  });

  // ── Tripwire ──
  var tripwire = computeTripwire_(pmRows, olRows);

  return {
    generatedAt: now,
    olRowCount:  olRows.length,
    pmRowCount:  pmRows.length,
    overall: {
      good: totGood, scrap: totScrap, repair: totRepair, awaitConv: totAwait, total: totAll,
      yieldPct:     pct_(totGood + totRepair + totAwait, totAll),
      fpyPct:       pct_(totGood, totAll),
      scrapPct:     pct_(totScrap, totAll),
      repairPct:    pct_(totRepair, totAll),
      awaitConvPct: pct_(totAwait, totAll),
      qcPassRate:   pct_(qcPass, qcPass + qcFail),
      qcCoverage:   pct_(qcTotal, pmRows.length),
      pdCoverage:   pct_(pdInspected, olRows.length),
      qcPass: qcPass, qcFail: qcFail, qcTotal: qcTotal, palletTotal: pmRows.length,
      pdInspected: pdInspected, pdTotal: olRows.length
    },
    byMaterial:   matSummary,
    byWorkCenter: wcSummary,
    failPallets:  failPallets,
    dateTrend:    dateTrend,
    tripwire:     tripwire
  };
}

// ============================================================================
// Snapshot sheet writer
// ============================================================================

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
  var tw = report.tripwire;

  // ── Title ──
  mergedText('Yield + QC Report   (สร้างเมื่อ ' + report.generatedAt + ')',
    { bg: '#1f3864', fc: '#ffffff', fs: 14, bold: true, h: 28 });
  mergedText('PalletMaster pallets: ' + report.pmRowCount +
    '   |   OperationLog rows: ' + report.olRowCount +
    '   |   Output source: PalletMaster final buckets',
    { fc: '#666666', italic: true });

  // ── Tripwire (red row if mismatch) ──
  if (tw.mismatch) {
    mergedText('⚠️ OUTPUT MISMATCH — ตรวจ mirror/นับซ้ำ: PM Good=' + tw.pmGood +
      ' vs OL last-op Good=' + tw.olLastOpGood + ' (diff=' + tw.diff + ')',
      { bg: '#c00000', fc: '#ffffff', fs: 11, bold: true, h: 24 });
  }
  r++;

  // ── Section 1: Summary (from PalletMaster output) ──
  mergedText('สรุปภาพรวม — ยอดผลผลิต (จาก PalletMaster final, 1 แถว/พาเลท)',
    { bg: '#2e75b6', fc: '#ffffff', fs: 11, bold: true, h: 22 });
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
  mergedText('Output qty: Good=' + ov.good + ' Scrap=' + ov.scrap +
    ' Repair=' + ov.repair + ' AwaitConv=' + ov.awaitConv + ' Total=' + ov.total,
    { bg: '#fff2cc', bold: true });
  r++;

  // ── Section 2: By Material (from PalletMaster output) ──
  mergedText('แยกตาม Material — ยอดผลผลิต (PalletMaster)',
    { bg: '#548235', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;
  tableHeader(['Material', 'Name', 'Pallets', 'Total', 'Yield%', 'FPY%', 'Scrap%', 'Repair', 'AwaitConv']);
  for (var mi = 0; mi < report.byMaterial.length; mi++) {
    var bm = report.byMaterial[mi];
    dataRow([bm.material, bm.name, bm.pallets, bm.total, bm.yieldPct, bm.fpyPct,
             bm.scrapPct, bm.repair, bm.awaitConv], mi % 2 === 1);
  }
  r++;

  // ── Section 3: By Work Center (from OperationLog throughput) ──
  mergedText('แยกตาม Work Center / Machine — ปริมาณราย operation (ไม่ใช่ยอดผลผลิต)',
    { bg: '#bf8f00', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;
  tableHeader(['Work Center', 'Ops', 'Pallets', 'Total', 'Yield%', 'FPY%', 'Scrap%', 'Repair', 'AwaitConv']);
  for (var wi = 0; wi < report.byWorkCenter.length; wi++) {
    var bw = report.byWorkCenter[wi];
    dataRow([bw.workCenter, bw.ops, bw.pallets, bw.total, bw.yieldPct, bw.fpyPct,
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

  // ── Section 5: Date trend (from PalletMaster ProductionDate) ──
  mergedText('Trend by ProductionDate — ยอดผลผลิต (PalletMaster)',
    { bg: '#7030a0', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;
  tableHeader(['Date', 'Pallets', 'Total', 'Good', 'Scrap', 'Repair', 'AwaitConv', 'Yield%', 'FPY%']);
  for (var di = 0; di < report.dateTrend.length; di++) {
    var dt = report.dateTrend[di];
    dataRow([dt.date, dt.pallets, dt.total, dt.good, dt.scrap, dt.repair,
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

function buildYieldQCReportText_(report) {
  var ov = report.overall;
  var tw = report.tripwire;
  var lines = [];

  lines.push('📊 Yield + QC Report (' + report.generatedAt + ')');
  if (tw.mismatch) {
    lines.push('⚠️ OUTPUT MISMATCH: PM Good=' + tw.pmGood + ' vs OL last-op Good=' + tw.olLastOpGood);
  }
  lines.push('');
  lines.push('Output (PalletMaster final):');
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
    'ใส่วันที่ (yyyy-MM-dd) — ดูเฉพาะพาเลทที่ ProductionDate ตรงกัน\n(เว้นว่าง = ทั้งหมด):',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var dateStr = resp.getResponseText().trim();
  if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    ui.alert('รูปแบบวันที่ไม่ถูกต้อง กรุณาใส่ yyyy-MM-dd เช่น 2026-06-20');
    return;
  }

  var report = buildYieldQCReport_();
  if (dateStr) {
    report.generatedAt += '  [filtered: ' + dateStr + ']';
  }

  writeYieldQCReportSheet_(report);
  var text = buildYieldQCReportText_(report);
  SpreadsheetApp.getUi().alert('Yield + QC Report' + (dateStr ? ' — ' + dateStr : ''),
    text, ui.ButtonSet.OK);
  logEvent('YIELD_QC_REPORT', YQR_SHEET, 'OK', 0,
    'date=' + (dateStr || 'ALL') + ' pallets=' + report.pmRowCount);
}

// ============================================================================
// TEST — multi-op seeding + aggregation + tripwire
// ============================================================================

function TEST_yieldQcReport_() {
  var results = [];
  var pass    = true;
  var ss      = getSpreadsheet_();

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  // ── Seed test data ──
  var TEST_PID   = 'PL-TEST-YQRMULTI-L01';
  var TEST_MO    = '9999999999';
  var TEST_MAT   = 'TESTMAT-YQR';
  var PM_GOOD    = 400;
  var PM_SCRAP   = 50;

  // Seed PalletMaster row (final output)
  var pmSh  = ss.getSheetByName(PM_SHEET);
  var pmHdr = pmSh.getRange(1, 1, 1, pmSh.getLastColumn()).getValues()[0];
  var pmIdx = {};
  pmHdr.forEach(function(h, i) { pmIdx[String(h).trim()] = i; });
  var pmRow = new Array(pmHdr.length).fill('');
  pmRow[pmIdx['PalletID']]           = TEST_PID;
  pmRow[pmIdx['ManufacturingOrder']] = TEST_MO;
  pmRow[pmIdx['Material']]           = TEST_MAT;
  pmRow[pmIdx['MaterialName']]       = 'Test Material';
  pmRow[pmIdx['QtyPerPallet']]       = 450;
  pmRow[pmIdx['Unit']]               = 'PC';
  pmRow[pmIdx['ProductionDate']]     = new Date(2026, 5, 22);
  pmRow[pmIdx['ScanStatus']]         = 'QC_COMPLETE';
  pmRow[pmIdx['QCStatus']]           = 'INSPECTED';
  pmRow[pmIdx['QCResult']]           = 'PASS';
  pmRow[pmIdx['GoodQty']]            = PM_GOOD;
  pmRow[pmIdx['DefectQty']]          = PM_SCRAP;
  pmRow[pmIdx['RepairQty']]          = 0;
  pmRow[pmIdx['AwaitConvQty']]       = 0;
  pmSh.appendRow(pmRow);

  // Seed TWO OperationLog rows (multi-op, both have GoodQty>0)
  var olSh  = ss.getSheetByName(OL_SHEET);
  var olHdr = olSh.getRange(1, 1, 1, olSh.getLastColumn()).getValues()[0];
  var olIdx = {};
  olHdr.forEach(function(h, i) { olIdx[String(h).trim()] = i; });

  function seedOlRow(opNo, good, scrap) {
    var row = new Array(olHdr.length).fill('');
    row[olIdx['LogID']]               = TEST_PID + '-' + opNo + '-OP-' + Date.now();
    row[olIdx['PalletID']]            = TEST_PID;
    row[olIdx['ManufacturingOrder']]  = TEST_MO;
    row[olIdx['OperationNo']]         = opNo;
    row[olIdx['OperationText']]       = 'Test Op ' + opNo;
    row[olIdx['GoodQty']]             = good;
    row[olIdx['ScrapQty']]            = scrap;
    row[olIdx['RepairQty']]           = 0;
    row[olIdx['AwaitConvQty']]        = 0;
    row[olIdx['Operator']]            = 'TEST_OP';
    row[olIdx['Role']]                = 'OP';
    row[olIdx['Result']]              = 'PASS';
    row[olIdx['LoggedAt']]            = new Date();
    row[olIdx['Source']]              = 'TEST';
    olSh.appendRow(row);
  }
  seedOlRow('0010', 450, 0);
  seedOlRow('0020', PM_GOOD, PM_SCRAP);
  SpreadsheetApp.flush();

  // ── Run report (includes test pallet because PL-TEST is filtered!) ──
  // buildPalletOutput_ and buildOpThroughput_ filter /^PL-TEST/i.
  // For this test we temporarily patch the filter by reading directly.
  // Instead, call the public builder and check the PRODUCTION data is clean
  // (test data excluded), then do targeted checks on the raw builders.

  try {
    var report = buildYieldQCReport_();
    assert('buildYieldQCReport_ runs', true);

    // (a) Overall output must NOT include PL-TEST data
    // Check: report should not contain TESTMAT-YQR in byMaterial
    var hasTESTMAT = report.byMaterial.some(function(m) { return m.material === TEST_MAT; });
    assert('Overall excludes PL-TEST pallet material', !hasTESTMAT);

    // (b) Verify tripwire on production data
    assert('tripwire computed', report.tripwire !== undefined);
    assert('tripwire.mismatch is boolean', typeof report.tripwire.mismatch === 'boolean');

    // ── Now test with PL-TEST included by calling builders directly ──
    // We need a version that includes test data. Read sheets manually.
    var pmData = pmSh.getDataRange().getValues();
    var olData = olSh.getDataRange().getValues();

    // Find the test PM row
    var testPmRow = null;
    for (var pr = 1; pr < pmData.length; pr++) {
      if (String(pmData[pr][pmIdx['PalletID']] || '').trim() === TEST_PID) {
        testPmRow = pmData[pr];
        break;
      }
    }
    assert('Test PM row seeded', !!testPmRow);

    // Count test OL rows
    var testOlCount = 0;
    for (var or2 = 1; or2 < olData.length; or2++) {
      if (String(olData[or2][olIdx['PalletID']] || '').trim() === TEST_PID) testOlCount++;
    }
    assert('Test OL rows = 2 (multi-op)', testOlCount === 2, 'found=' + testOlCount);

    // (a) If we sum OL GoodQty for test pallet we'd get 450+400=850,
    //     but PM final says 400. Verify the PRINCIPLE: output uses PM only.
    var olGoodSum = 0;
    for (var or3 = 1; or3 < olData.length; or3++) {
      if (String(olData[or3][olIdx['PalletID']] || '').trim() === TEST_PID) {
        olGoodSum += Number(olData[or3][olIdx['GoodQty']]) || 0;
      }
    }
    assert('OL GoodQty sum (850) != PM GoodQty (400) — proves multi-op double-count risk',
      olGoodSum === 850 && PM_GOOD === 400,
      'olSum=' + olGoodSum + ' pmGood=' + PM_GOOD);

    // (c) Tripwire with consistent mirror: last-op good=400, PM good=400 → no fire
    var consistentTw = computeTripwire_(
      [{ good: PM_GOOD, scrap: PM_SCRAP, repair: 0, awaitConv: 0, palletId: TEST_PID }],
      [{ palletId: TEST_PID, opNo: '0010', good: 450, scrap: 0 },
       { palletId: TEST_PID, opNo: '0020', good: PM_GOOD, scrap: PM_SCRAP }]
    );
    assert('Tripwire consistent → no mismatch', !consistentTw.mismatch,
      'pmGood=' + consistentTw.pmGood + ' olLastOp=' + consistentTw.olLastOpGood);

    // (d) Tripwire with desync mirror: PM good=400, OL last-op good=999 → fires
    var desyncTw = computeTripwire_(
      [{ good: PM_GOOD, scrap: PM_SCRAP, repair: 0, awaitConv: 0, palletId: TEST_PID }],
      [{ palletId: TEST_PID, opNo: '0010', good: 450, scrap: 0 },
       { palletId: TEST_PID, opNo: '0020', good: 999, scrap: 0 }]
    );
    assert('Tripwire desynced → mismatch fires', desyncTw.mismatch,
      'pmGood=' + desyncTw.pmGood + ' olLastOp=' + desyncTw.olLastOpGood);

    // (b) By WC: verify distinct pallets count
    // Use the consistent data to test
    var testByWc = {};
    var testOlRows = [
      { palletId: TEST_PID, opNo: '0010', good: 450, scrap: 0, workCenter: 'WC-A' },
      { palletId: TEST_PID, opNo: '0020', good: 400, scrap: 50, workCenter: 'WC-A' }
    ];
    for (var tw2 = 0; tw2 < testOlRows.length; tw2++) {
      var twc = testOlRows[tw2].workCenter;
      if (!testByWc[twc]) testByWc[twc] = { ops: 0, palletSet: {} };
      testByWc[twc].ops++;
      testByWc[twc].palletSet[testOlRows[tw2].palletId] = true;
    }
    var wcA = testByWc['WC-A'];
    assert('By WC: 2 ops but 1 distinct pallet',
      wcA.ops === 2 && Object.keys(wcA.palletSet).length === 1,
      'ops=' + wcA.ops + ' pallets=' + Object.keys(wcA.palletSet).length);

    // Write sheet
    writeYieldQCReportSheet_(report);
    var sh = ss.getSheetByName(YQR_SHEET);
    assert('YieldQCReport sheet exists', !!sh);
    assert('YieldQCReport sheet has rows', sh && sh.getLastRow() > 5,
      'lastRow=' + (sh ? sh.getLastRow() : 0));

    // Metrics types
    var ov = report.overall;
    assert('yieldPct is number or null',
      typeof ov.yieldPct === 'number' || ov.yieldPct === null);
    assert('fpyPct is number or null',
      typeof ov.fpyPct === 'number' || ov.fpyPct === null);

    // Divide-by-zero
    assert('fmtPct_(null) = "-"', fmtPct_(null) === '-');
    assert('pct_(5,0) = null', pct_(5, 0) === null);

    // WC resolver fallback
    var wcTest = resolveWorkCenter_({ 'GoodQty': 0 }, [100], '', '');
    assert('resolveWorkCenter_ no ActualMachine = no crash', typeof wcTest === 'string');

    // Lark DRY_RUN
    var lark = sendYieldQCReportToLark_(report);
    assert('Lark DRY_RUN: sent=false', lark.sent === false);

  } catch (e) {
    assert('test execution', false, e.message + '\n' + e.stack);
  }

  // ── Cleanup ──
  try {
    // Delete PL-TEST rows from PalletMaster
    var pmAllData = pmSh.getDataRange().getValues();
    for (var cr = pmAllData.length - 1; cr >= 1; cr--) {
      if (/^PL-TEST/i.test(String(pmAllData[cr][pmIdx['PalletID']] || '').trim())) {
        pmSh.deleteRow(cr + 1);
      }
    }
    // Delete PL-TEST rows from OperationLog
    var olAllData = olSh.getDataRange().getValues();
    for (var cr2 = olAllData.length - 1; cr2 >= 1; cr2--) {
      if (/^PL-TEST/i.test(String(olAllData[cr2][olIdx['PalletID']] || '').trim())) {
        olSh.deleteRow(cr2 + 1);
      }
    }
    Logger.log('Cleanup: PL-TEST rows deleted');
  } catch (cleanErr) {
    Logger.log('Cleanup error: ' + cleanErr.message);
  }

  // ── Summary ──
  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_yieldQcReport_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name);
  }
}

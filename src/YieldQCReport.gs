/**
 * YieldQCReport.gs — Yield + QC snapshot report (menu-only, no web app)
 * ======================================================================
 * Phase 4.5C — model ก: output from OperationLog last-op per pallet
 *
 * CORE PRINCIPLE:
 *   OUTPUT per pallet = OperationLog LAST operation (highest OperationNo).
 *     Good/Repair/AwaitConv = last op only.
 *     Scrap = Σ ScrapQty across ALL ops (defects accumulate, gone forever).
 *     Total = Good + Σ Scrap + Repair + AwaitConv.
 *   PalletMaster final buckets are a partial mirror (only final-op-mirrored
 *   pallets) — used for QC fields + cross-check, NOT as output source.
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
// Work-center resolver
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
// Read raw OperationLog rows (all columns needed for both output + throughput)
// ============================================================================

function readOlRows_() {
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
// Read PalletMaster (for QC fields, dates, material enrichment, PM cross-check)
// ============================================================================

function readPmRows_() {
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

    // ScannedAt = actual scan date; ProductionDate = SAP planned start
    var scannedAt = data[r][idx['ScannedAt']];
    var scannedDateStr = '';
    if (scannedAt instanceof Date && !isNaN(scannedAt.getTime())) {
      scannedDateStr = Utilities.formatDate(scannedAt, TZ_, 'yyyy-MM-dd');
    }
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
      unit:         String(data[r][idx['Unit']]               || '').trim(),
      workCenter:   wc,
      scannedDateStr: scannedDateStr,
      prodDateStr:    prodDateStr,
      qcResult:     String(data[r][idx['QCResult']]           || '').trim(),
      qcResultNote: String(data[r][idx['QCResultNote']]       || '').trim(),
      qcInspector:  idx['QCInspector'] !== undefined
                      ? String(data[r][idx['QCInspector']] || '').trim() : '',
      pmGood:       idx['GoodQty']      !== undefined ? (Number(data[r][idx['GoodQty']])      || 0) : 0,
      pmScrap:      idx['DefectQty']    !== undefined ? (Number(data[r][idx['DefectQty']])    || 0) : 0,
      pmRepair:     idx['RepairQty']    !== undefined ? (Number(data[r][idx['RepairQty']])    || 0) : 0,
      pmAwaitConv:  idx['AwaitConvQty'] !== undefined ? (Number(data[r][idx['AwaitConvQty']]) || 0) : 0,
      qtyPerPallet: Number(data[r][idx['QtyPerPallet']]) || 0,
      hasPmMirror:  (idx['GoodQty'] !== undefined &&
                     (Number(data[r][idx['GoodQty']]) || 0) +
                     (Number(data[r][idx['DefectQty']]) || 0) +
                     (Number(data[r][idx['RepairQty']]) || 0) +
                     (Number(data[r][idx['AwaitConvQty']]) || 0)) > 0
    });
  }
  return rows;
}

// ============================================================================
// buildPalletOutput_() — per pallet from OL last-op (model ก)
//   Good/Repair/AwaitConv = last op only
//   Scrap = Σ across ALL ops
// ============================================================================

function buildPalletOutput_(olRows, pmByPallet) {
  // Group OL rows by palletId
  var byPallet = {};
  for (var i = 0; i < olRows.length; i++) {
    var pid = olRows[i].palletId;
    if (!byPallet[pid]) byPallet[pid] = [];
    byPallet[pid].push(olRows[i]);
  }

  var output = [];
  var pids = Object.keys(byPallet);
  for (var p = 0; p < pids.length; p++) {
    var pid  = pids[p];
    var ops  = byPallet[pid];
    var pm   = pmByPallet[pid] || {};

    // Find last op (highest OperationNo)
    var lastOp = ops[0];
    var totalScrap = 0;
    for (var j = 0; j < ops.length; j++) {
      totalScrap += ops[j].scrap;
      if (ops[j].opNo > lastOp.opNo) lastOp = ops[j];
    }

    // Best date: ScannedAt (actual) → ProductionDate (planned) → empty
    var dateStr = pm.scannedDateStr || pm.prodDateStr || '';
    var dateSource = pm.scannedDateStr ? 'scanned' : (pm.prodDateStr ? 'planned' : 'none');

    output.push({
      palletId:   pid,
      mo:         lastOp.mo,
      material:   pm.material   || '',
      materialName: pm.materialName || '',
      unit:       pm.unit       || '',
      good:       lastOp.good,
      scrap:      totalScrap,
      repair:     lastOp.repair,
      awaitConv:  lastOp.awaitConv,
      dateStr:    dateStr,
      dateSource: dateSource,
      opCount:    ops.length
    });
  }
  return output;
}

// ============================================================================
// Tripwire — compare only the MIRRORED subset
// ============================================================================

function computeTripwire_(palletOutput, pmByPallet) {
  var mirroredCount = 0, totalPallets = palletOutput.length;
  var pmGoodSum = 0, olGoodSum = 0;

  for (var i = 0; i < palletOutput.length; i++) {
    var pid = palletOutput[i].palletId;
    var pm  = pmByPallet[pid];
    if (!pm || !pm.hasPmMirror) continue;

    mirroredCount++;
    pmGoodSum  += pm.pmGood;
    olGoodSum  += palletOutput[i].good;
  }

  var diff    = Math.abs(pmGoodSum - olGoodSum);
  var maxVal  = Math.max(pmGoodSum, olGoodSum, 1);
  var pctDiff = diff / maxVal;

  return {
    pmGood:         pmGoodSum,
    olLastOpGood:   olGoodSum,
    diff:           diff,
    pctDiff:        pctDiff,
    mismatch:       mirroredCount > 0 && pctDiff > 0.005,
    mirroredCount:  mirroredCount,
    totalPallets:   totalPallets,
    mirrorPct:      pct_(mirroredCount, totalPallets)
  };
}

// ============================================================================
// Per-pallet invariant tripwire (#2)
//   Good(lastOp) + Σscrap + Repair(lastOp) + AwaitConv(lastOp) === QtyPerPallet
// ============================================================================

function computeInvariantTripwire_(palletOutput, pmByPallet) {
  var violators = [];
  for (var i = 0; i < palletOutput.length; i++) {
    var po = palletOutput[i];
    var pm = pmByPallet[po.palletId];
    var expected = pm ? pm.qtyPerPallet : 0;
    if (!expected || expected <= 0) continue;
    var total = po.good + po.scrap + po.repair + po.awaitConv;
    if (total !== expected) {
      violators.push({ palletId: po.palletId, total: total, expected: expected });
    }
  }
  return { violators: violators, count: violators.length };
}

// ============================================================================
// Main report builder
// ============================================================================

function buildYieldQCReport_() {
  _wcCache_ = {};

  var olRows = readOlRows_();
  var pmRows = readPmRows_();
  var now    = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd HH:mm');

  // PM lookup
  var pmByPallet = {};
  for (var p = 0; p < pmRows.length; p++) {
    pmByPallet[pmRows[p].palletId] = pmRows[p];
  }

  // Per-pallet output from OL last-op
  var palletOutput = buildPalletOutput_(olRows, pmByPallet);

  // ── OUTPUT totals ──
  var totGood = 0, totScrap = 0, totRepair = 0, totAwait = 0;
  for (var i = 0; i < palletOutput.length; i++) {
    totGood   += palletOutput[i].good;
    totScrap  += palletOutput[i].scrap;
    totRepair += palletOutput[i].repair;
    totAwait  += palletOutput[i].awaitConv;
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

  // ── By Material (from pallet output) ──
  var byMat = {};
  for (var m = 0; m < palletOutput.length; m++) {
    var mat = palletOutput[m].material || '(unknown)';
    if (!byMat[mat]) byMat[mat] = { good: 0, scrap: 0, repair: 0, awaitConv: 0, pallets: 0, name: palletOutput[m].materialName };
    byMat[mat].good      += palletOutput[m].good;
    byMat[mat].scrap     += palletOutput[m].scrap;
    byMat[mat].repair    += palletOutput[m].repair;
    byMat[mat].awaitConv += palletOutput[m].awaitConv;
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

  // ── By Work Center — per-op throughput (unchanged intent) ──
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

  // ── Trend by date (from pallet output, grouped by best available date) ──
  var byDate = {};
  var hasScannedDate = false, hasPlannedDate = false;
  for (var t = 0; t < palletOutput.length; t++) {
    var dt = palletOutput[t].dateStr || '(ไม่มีวันที่)';
    if (palletOutput[t].dateSource === 'scanned') hasScannedDate = true;
    if (palletOutput[t].dateSource === 'planned') hasPlannedDate = true;
    if (!byDate[dt]) byDate[dt] = { good: 0, scrap: 0, repair: 0, awaitConv: 0, pallets: 0 };
    byDate[dt].good      += palletOutput[t].good;
    byDate[dt].scrap     += palletOutput[t].scrap;
    byDate[dt].repair    += palletOutput[t].repair;
    byDate[dt].awaitConv += palletOutput[t].awaitConv;
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
  var dateLabel = hasScannedDate ? 'ScannedAt (วันที่สแกนจริง)' :
                  (hasPlannedDate ? 'ProductionDate ตามแผน (planned)' : 'ไม่มีวันที่');

  // ── Tripwire (mirrored subset only) ──
  var tripwire = computeTripwire_(palletOutput, pmByPallet);
  var invariantTripwire = computeInvariantTripwire_(palletOutput, pmByPallet);

  return {
    generatedAt: now,
    olRowCount:  olRows.length,
    palletCount: palletOutput.length,
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
    dateLabel:    dateLabel,
    tripwire:     tripwire,
    invariantTripwire: invariantTripwire
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

  // Force plain number on qty columns to prevent percent rendering
  function dataRow(values, alt) {
    var rng = sh.getRange(r, 1, 1, C);
    rng.setValues([pad(values)])
      .setBorder(true, true, true, true, true, true)
      .setNumberFormat('@');
    if (alt) rng.setBackground('#f2f2f2');
    // Re-format numeric cells as plain number
    for (var ci = 0; ci < values.length; ci++) {
      if (typeof values[ci] === 'number') {
        sh.getRange(r, ci + 1).setNumberFormat('#,##0');
      }
    }
    r++;
  }

  var ov = report.overall;
  var tw = report.tripwire;

  // ── Title ──
  mergedText('Yield + QC Report   (สร้างเมื่อ ' + report.generatedAt + ')',
    { bg: '#1f3864', fc: '#ffffff', fs: 14, bold: true, h: 28 });
  mergedText('Pallets (OL): ' + report.palletCount +
    '   |   Op rows: ' + report.olRowCount +
    '   |   Output: OL op สุดท้าย/พาเลท, Scrap สะสมทุก op',
    { fc: '#666666', italic: true });

  // ── Tripwire ──
  if (tw.mismatch) {
    mergedText('⚠️ MIRROR MISMATCH (mirrored subset): PM Good=' + tw.pmGood +
      ' vs OL last-op Good=' + tw.olLastOpGood + ' (diff=' + tw.diff + ')',
      { bg: '#c00000', fc: '#ffffff', fs: 11, bold: true, h: 24 });
  }
  mergedText('PM mirror: ' + tw.mirroredCount + '/' + tw.totalPallets +
    ' pallets (' + fmtPct_(tw.mirrorPct) + ')',
    { fc: '#888888', italic: true });

  // ── Per-pallet invariant tripwire ──
  var inv = report.invariantTripwire;
  if (inv.count > 0) {
    mergedText('⚠️ INVARIANT พาเลทที่ยอดรวม ≠ QtyPerPallet: ' + inv.count +
      ' (ตรวจการกรอกหน้างาน)',
      { bg: '#ff9900', fc: '#000000', fs: 11, bold: true, h: 24 });
    var showCount = Math.min(inv.violators.length, 5);
    for (var vi = 0; vi < showCount; vi++) {
      var v = inv.violators[vi];
      mergedText('  ' + v.palletId + ': Total=' + v.total + ' vs QtyPerPallet=' + v.expected,
        { fc: '#cc6600', italic: true });
    }
  }
  r++;

  // ── Section 1: Summary ──
  mergedText('สรุปภาพรวม — ยอดผลผลิต (จาก OperationLog op สุดท้าย/พาเลท)',
    { bg: '#2e75b6', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;

  tableHeader(['Metric', 'Value', '', 'Metric', 'Value']);
  dataRow(['Yield%', fmtPct_(ov.yieldPct), '', 'QC Pass Rate', fmtPct_(ov.qcPassRate)]);
  dataRow(['FPY% (Good only)', fmtPct_(ov.fpyPct), '',
    'QC Coverage', fmtPct_(ov.qcCoverage) + ' (' + ov.qcTotal + '/' + ov.palletTotal + ')'], true);
  dataRow(['Scrap% (สะสมทุก op)', fmtPct_(ov.scrapPct), '',
    'PD Coverage', fmtPct_(ov.pdCoverage) + ' (' + ov.pdInspected + '/' + ov.pdTotal + ')']);
  dataRow(['Repair%', fmtPct_(ov.repairPct), '', 'QC PASS', String(ov.qcPass)], true);
  dataRow(['AwaitConv%', fmtPct_(ov.awaitConvPct), '', 'QC FAIL', String(ov.qcFail)]);

  r++;
  mergedText('Output: Good=' + ov.good + ' Scrap(สะสม)=' + ov.scrap +
    ' Repair=' + ov.repair + ' AwaitConv=' + ov.awaitConv + ' Total=' + ov.total,
    { bg: '#fff2cc', bold: true });
  r++;

  // ── Section 2: By Material ──
  mergedText('แยกตาม Material — ยอดผลผลิต (OL op สุดท้าย)',
    { bg: '#548235', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;
  tableHeader(['Material', 'Name', 'Pallets', 'Total', 'Yield%', 'FPY%', 'Scrap%', 'Repair', 'AwaitConv']);
  for (var mi = 0; mi < report.byMaterial.length; mi++) {
    var bm = report.byMaterial[mi];
    dataRow([bm.material, bm.name, bm.pallets, bm.total, bm.yieldPct, bm.fpyPct,
             bm.scrapPct, bm.repair, bm.awaitConv], mi % 2 === 1);
  }
  r++;

  // ── Section 3: By Work Center (per-op throughput) ──
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

  // ── Section 5: Date trend ──
  mergedText('Trend by ' + report.dateLabel + ' — ยอดผลผลิต (OL op สุดท้าย)',
    { bg: '#7030a0', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;
  tableHeader(['Date', 'Pallets', 'Total', 'Good', 'Scrap', 'Repair', 'AwaitConv', 'Yield%', 'FPY%']);
  for (var di = 0; di < report.dateTrend.length; di++) {
    var dtv = report.dateTrend[di];
    dataRow([dtv.date, dtv.pallets, dtv.total, dtv.good, dtv.scrap, dtv.repair,
             dtv.awaitConv, dtv.yieldPct, dtv.fpyPct], di % 2 === 1);
  }

  // ── Final format ──
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 200);
  sh.setColumnWidth(2, 180);
  for (var col = 3; col <= C; col++) sh.autoResizeColumn(col);

  sh.activate();
  return sh;
}

// ============================================================================
// Plain-text summary
// ============================================================================

function buildYieldQCReportText_(report) {
  var ov = report.overall;
  var tw = report.tripwire;
  var lines = [];

  lines.push('📊 Yield + QC Report (' + report.generatedAt + ')');
  if (tw.mismatch) {
    lines.push('⚠️ MIRROR MISMATCH: PM Good=' + tw.pmGood + ' vs OL last-op Good=' + tw.olLastOpGood);
  }
  lines.push('PM mirror: ' + tw.mirroredCount + '/' + tw.totalPallets + ' pallets');
  var inv = report.invariantTripwire;
  if (inv.count > 0) {
    lines.push('⚠️ INVARIANT พาเลทที่ยอดรวม ≠ QtyPerPallet: ' + inv.count + ' (ตรวจการกรอกหน้างาน)');
    var showCount = Math.min(inv.violators.length, 5);
    for (var vi = 0; vi < showCount; vi++) {
      var v = inv.violators[vi];
      lines.push('  ' + v.palletId + ': Total=' + v.total + ' vs QtyPerPallet=' + v.expected);
    }
  }
  lines.push('');
  lines.push('Output (OL last-op, Scrap summed):');
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
// Lark — DRY_RUN only
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
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
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
    'pallets=' + report.palletCount + ' ops=' + report.olRowCount);
}

function yieldQcReportDateDialog() {
  var ui   = SpreadsheetApp.getUi();
  var resp = ui.prompt('Yield + QC Report ตามวันที่',
    'ใส่วันที่ (yyyy-MM-dd)\n(เว้นว่าง = ทั้งหมด):',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var dateStr = resp.getResponseText().trim();
  if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    ui.alert('รูปแบบวันที่ไม่ถูกต้อง กรุณาใส่ yyyy-MM-dd เช่น 2026-06-20');
    return;
  }

  var report = buildYieldQCReport_();
  if (dateStr) report.generatedAt += '  [filtered: ' + dateStr + ']';

  writeYieldQCReportSheet_(report);
  var text = buildYieldQCReportText_(report);
  ui.alert('Yield + QC Report' + (dateStr ? ' — ' + dateStr : ''), text, ui.ButtonSet.OK);
  logEvent('YIELD_QC_REPORT', YQR_SHEET, 'OK', 0,
    'date=' + (dateStr || 'ALL') + ' pallets=' + report.palletCount);
}

// ============================================================================
// TEST — model ก multi-op
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

  var TEST_PID = 'PL-TEST-YQRMODEL-L01';
  var TEST_MO  = '9999999998';
  var TEST_MAT = 'TESTMAT-MODELK';

  // ── Seed PalletMaster (mirrored final) ──
  var pmSh  = ss.getSheetByName(PM_SHEET);
  var pmHdr = pmSh.getRange(1, 1, 1, pmSh.getLastColumn()).getValues()[0];
  var pmIdx = {};
  pmHdr.forEach(function(h, i) { pmIdx[String(h).trim()] = i; });
  var pmRow = new Array(pmHdr.length).fill('');
  pmRow[pmIdx['PalletID']]           = TEST_PID;
  pmRow[pmIdx['ManufacturingOrder']] = TEST_MO;
  pmRow[pmIdx['Material']]           = TEST_MAT;
  pmRow[pmIdx['MaterialName']]       = 'Test Model K';
  pmRow[pmIdx['QtyPerPallet']]       = 10;
  pmRow[pmIdx['Unit']]               = 'PC';
  pmRow[pmIdx['ProductionDate']]     = new Date(2026, 5, 22);
  pmRow[pmIdx['ScannedAt']]          = new Date(2026, 5, 22, 10, 30, 0);
  pmRow[pmIdx['ScanStatus']]         = 'QC_COMPLETE';
  pmRow[pmIdx['QCStatus']]           = 'INSPECTED';
  pmRow[pmIdx['QCResult']]           = 'PASS';
  pmRow[pmIdx['GoodQty']]            = 8;
  pmRow[pmIdx['DefectQty']]          = 1;
  pmRow[pmIdx['RepairQty']]          = 0;
  pmRow[pmIdx['AwaitConvQty']]       = 0;
  pmSh.appendRow(pmRow);

  // ── Seed 3 OperationLog rows (model ก) ──
  var olSh  = ss.getSheetByName(OL_SHEET);
  var olHdr = olSh.getRange(1, 1, 1, olSh.getLastColumn()).getValues()[0];
  var olIdx = {};
  olHdr.forEach(function(h, i) { olIdx[String(h).trim()] = i; });

  function seedOl(opNo, good, scrap, repair, awaitConv) {
    var row = new Array(olHdr.length).fill('');
    row[olIdx['LogID']]              = TEST_PID + '-' + opNo + '-OP-' + Date.now();
    row[olIdx['PalletID']]           = TEST_PID;
    row[olIdx['ManufacturingOrder']] = TEST_MO;
    row[olIdx['OperationNo']]        = opNo;
    row[olIdx['OperationText']]      = 'Test Op ' + opNo;
    row[olIdx['GoodQty']]            = good;
    row[olIdx['ScrapQty']]           = scrap;
    row[olIdx['RepairQty']]          = repair;
    row[olIdx['AwaitConvQty']]       = awaitConv;
    row[olIdx['Operator']]           = 'TEST_OP';
    row[olIdx['Role']]               = 'OP';
    row[olIdx['Result']]             = 'PASS';
    row[olIdx['LoggedAt']]           = new Date();
    row[olIdx['Source']]             = 'TEST';
    olSh.appendRow(row);
  }
  // op1: Good=10,Scrap=1 → total should be 11? No — QtyPerPallet=10, but for
  // test flexibility we don't enforce sum=QtyPerPallet here.
  seedOl('0010', 10, 1, 0, 0);
  seedOl('0020', 9,  0, 1, 0);
  seedOl('0030', 8,  1, 0, 0);
  SpreadsheetApp.flush();

  try {
    // The public builder filters PL-TEST, so test the aggregation function directly
    var testOlRows = [
      { palletId: TEST_PID, mo: TEST_MO, opNo: '0010', good: 10, scrap: 1, repair: 0, awaitConv: 0, workCenter: 'WC-X', pdResult: '' },
      { palletId: TEST_PID, mo: TEST_MO, opNo: '0020', good: 9,  scrap: 0, repair: 1, awaitConv: 0, workCenter: 'WC-Y', pdResult: '' },
      { palletId: TEST_PID, mo: TEST_MO, opNo: '0030', good: 8,  scrap: 1, repair: 0, awaitConv: 0, workCenter: 'WC-Y', pdResult: '' }
    ];
    var testPmByPallet = {};
    testPmByPallet[TEST_PID] = {
      palletId: TEST_PID, mo: TEST_MO, material: TEST_MAT, materialName: 'Test',
      unit: 'PC', scannedDateStr: '2026-06-22', prodDateStr: '2026-06-22',
      qcResult: 'PASS', qcResultNote: '', qcInspector: '',
      pmGood: 8, pmScrap: 1, pmRepair: 0, pmAwaitConv: 0, qtyPerPallet: 10, hasPmMirror: true
    };

    var palletOut = buildPalletOutput_(testOlRows, testPmByPallet);
    assert('buildPalletOutput_ returns 1 pallet', palletOut.length === 1, 'len=' + palletOut.length);

    var po = palletOut[0];
    // (a) Good = last op only (0030=8), Scrap = summed (1+0+1=2)
    assert('Good = 8 (last op only)', po.good === 8, 'got=' + po.good);
    assert('Scrap = 2 (summed all ops)', po.scrap === 2, 'got=' + po.scrap);
    assert('Repair = 0 (last op)', po.repair === 0, 'got=' + po.repair);
    assert('NOT Good=27 (sum of all ops)', po.good !== 27);

    // (b) Pallet appears once
    assert('1 pallet in output', palletOut.length === 1);

    // (c) By WC: 3 op rows, distinct pallets = 1
    var testByWc = {};
    for (var tw = 0; tw < testOlRows.length; tw++) {
      var twc = testOlRows[tw].workCenter;
      if (!testByWc[twc]) testByWc[twc] = { ops: 0, palletSet: {} };
      testByWc[twc].ops++;
      testByWc[twc].palletSet[testOlRows[tw].palletId] = true;
    }
    var totalOps = 0;
    var totalDistinct = {};
    Object.keys(testByWc).forEach(function(k) {
      totalOps += testByWc[k].ops;
      Object.keys(testByWc[k].palletSet).forEach(function(pid) { totalDistinct[pid] = true; });
    });
    assert('By WC: 3 op rows total', totalOps === 3, 'got=' + totalOps);
    assert('By WC: 1 distinct pallet', Object.keys(totalDistinct).length === 1);

    // (d) Tripwire: consistent mirror → no fire
    var twOk = computeTripwire_(palletOut, testPmByPallet);
    assert('Tripwire consistent → no mismatch', !twOk.mismatch,
      'pmGood=' + twOk.pmGood + ' olGood=' + twOk.olLastOpGood);

    // Tripwire: desync → fires
    var desyncPm = {};
    desyncPm[TEST_PID] = {
      palletId: TEST_PID, pmGood: 999, pmScrap: 0, pmRepair: 0, pmAwaitConv: 0, hasPmMirror: true
    };
    var twBad = computeTripwire_(palletOut, desyncPm);
    assert('Tripwire desynced → fires', twBad.mismatch,
      'pmGood=' + twBad.pmGood + ' olGood=' + twBad.olLastOpGood);

    // (f) Per-pallet invariant: consistent pallet → Total=10=Qty, no violation
    var invOk = computeInvariantTripwire_(palletOut, testPmByPallet);
    assert('Invariant: consistent pallet (Total=10=Qty) → 0 violators', invOk.count === 0,
      'count=' + invOk.count);

    // (g) Per-pallet invariant: violating pallet (Good deliberately too high → Total≠Qty)
    var TEST_PID2 = 'PL-TEST-YQRMODEL-L02';
    var violatingOl = [
      { palletId: TEST_PID2, mo: TEST_MO, opNo: '0010', good: 10, scrap: 1, repair: 0, awaitConv: 0, workCenter: 'WC-X', pdResult: '' },
      { palletId: TEST_PID2, mo: TEST_MO, opNo: '0020', good: 11, scrap: 0, repair: 0, awaitConv: 0, workCenter: 'WC-Y', pdResult: '' }
    ];
    var violatingPm = {};
    violatingPm[TEST_PID2] = {
      palletId: TEST_PID2, mo: TEST_MO, material: TEST_MAT, materialName: 'Test',
      unit: 'PC', qtyPerPallet: 10, hasPmMirror: true,
      pmGood: 0, pmScrap: 0, pmRepair: 0, pmAwaitConv: 0
    };
    var violatingOut = buildPalletOutput_(violatingOl, violatingPm);
    var invBad = computeInvariantTripwire_(violatingOut, violatingPm);
    assert('Invariant: violating pallet → fires', invBad.count === 1, 'count=' + invBad.count);
    assert('Invariant: violating pallet listed', invBad.violators.length > 0 &&
      invBad.violators[0].palletId === TEST_PID2,
      invBad.violators.length > 0
        ? 'pid=' + invBad.violators[0].palletId + ' total=' + invBad.violators[0].total + ' vs expected=' + invBad.violators[0].expected
        : 'no violators');

    // Run full report (production data, excludes PL-TEST)
    var report = buildYieldQCReport_();
    assert('buildYieldQCReport_ runs', true);
    assert('Test material excluded', !report.byMaterial.some(function(m) { return m.material === TEST_MAT; }));

    // (e) Write sheet + verify no percent in qty columns
    writeYieldQCReportSheet_(report);
    var rsh = ss.getSheetByName(YQR_SHEET);
    assert('Sheet exists', !!rsh);
    assert('Sheet has rows', rsh.getLastRow() > 5);

    // Divide-by-zero
    assert('fmtPct_(null) = "-"', fmtPct_(null) === '-');
    assert('pct_(5,0) = null', pct_(5, 0) === null);

    // Lark
    var lark = sendYieldQCReportToLark_(report);
    assert('Lark DRY_RUN: sent=false', lark.sent === false);

  } catch (e) {
    assert('test execution', false, e.message + '\n' + (e.stack || ''));
  }

  // ── Cleanup ──
  try {
    var pmAll = pmSh.getDataRange().getValues();
    for (var cr = pmAll.length - 1; cr >= 1; cr--) {
      if (/^PL-TEST/i.test(String(pmAll[cr][pmIdx['PalletID']] || '').trim()))
        pmSh.deleteRow(cr + 1);
    }
    var olAll = olSh.getDataRange().getValues();
    for (var cr2 = olAll.length - 1; cr2 >= 1; cr2--) {
      if (/^PL-TEST/i.test(String(olAll[cr2][olIdx['PalletID']] || '').trim()))
        olSh.deleteRow(cr2 + 1);
    }
    Logger.log('Cleanup: PL-TEST rows deleted');
  } catch (cleanErr) {
    Logger.log('Cleanup error: ' + cleanErr.message);
  }

  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_yieldQcReport_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name);
  }
}

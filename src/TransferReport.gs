/**
 * TransferReport.gs — Phase 3.5 Step 2e
 * ========================================
 * Daily Transfer/Receive Report — snapshot sheet + plain-text summary.
 * READ-ONLY on PalletMaster & TransferLog.
 * Writes only to the TransferReport snapshot sheet (clear+overwrite each run).
 *
 * Reuses: PM_HEADERS, PM_SHEET (PalletGen.gs), TL_HEADERS, TL_SHEET (TransferLog.gs),
 *         getProductGroupMap_ (TransferSlip.gs), esc_ (PalletSheet.gs),
 *         logEvent (SapClient.gs), getSpreadsheet_ (SheetSetup.gs)
 */

// ============================================================================
// Constants
// ============================================================================

/** @const {string} */
var TR_SHEET = 'TransferReport';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Return day boundaries for a date string or today (Asia/Bangkok).
 *
 * @param {string|null} dateStr — 'yyyy-MM-dd' or null for today
 * @return {{label:string, start:Date, end:Date}}
 */
function dayBounds_(dateStr) {
  var tz = 'Asia/Bangkok';
  var label;
  if (dateStr) {
    label = dateStr;
  } else {
    label = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  }
  var parts = label.split('-');
  var year  = Number(parts[0]);
  var month = Number(parts[1]) - 1;
  var day   = Number(parts[2]);

  var start = new Date(year, month, day, 0, 0, 0, 0);
  var end   = new Date(year, month, day + 1, 0, 0, 0, 0);

  var offsetMs = start.getTimezoneOffset() * 60000;
  var bangkokOffsetMs = -7 * 3600000;
  var adjust = offsetMs + bangkokOffsetMs;

  start = new Date(start.getTime() + adjust);
  end   = new Date(end.getTime() + adjust);

  return { label: label, start: start, end: end };
}

/**
 * Get received (CONFIRMED) pallets for a given day from PalletMaster.
 * Column resolution by NAME via PM_HEADERS.
 *
 * @param {{label:string, start:Date, end:Date}} bounds
 * @return {Array<{Material:string, ProductGroup:string, Qty:number, Unit:string,
 *   StorageLocation:string, PalletID:string, ConfirmedAt:Date}>}
 */
function getReceivedForDay_(bounds) {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  var needed = ['PalletID', 'Material', 'QtyPerPallet', 'Unit',
                'StorageLocation', 'ScanStatus', 'ConfirmedAt'];
  for (var k = 0; k < needed.length; k++) {
    if (idx[needed[k]] === undefined) return [];
  }

  var pgMap = getProductGroupMap_();
  var results = [];

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (String(row[idx['ScanStatus']] || '').trim() !== 'CONFIRMED') continue;

    var ca = row[idx['ConfirmedAt']];
    if (!(ca instanceof Date)) continue;
    if (ca.getTime() < bounds.start.getTime() || ca.getTime() >= bounds.end.getTime()) continue;

    var mat = String(row[idx['Material']] || '').trim();
    results.push({
      Material:        mat,
      ProductGroup:    pgMap[mat] || '-',
      Qty:             Number(row[idx['QtyPerPallet']]) || 0,
      Unit:            String(row[idx['Unit']] || '').trim(),
      StorageLocation: String(row[idx['StorageLocation']] || '').trim(),
      PalletID:        String(row[idx['PalletID']] || '').trim(),
      ConfirmedAt:     ca
    });
  }

  return results;
}

/**
 * Get issued (SPLIT_ISSUE) rows for a given day from TransferLog.
 * Column resolution by NAME via TL_HEADERS.
 *
 * @param {{label:string, start:Date, end:Date}} bounds
 * @return {Array<{PickID:string, Material:string, ProductGroup:string, LotNo:string,
 *   IssueQty:number, SourceSLoc:string, DestSLoc:string, RefDoc:string,
 *   CreatedBy:string, CreatedAt:Date}>}
 */
function getIssuedForDay_(bounds) {
  var sh = getSpreadsheet_().getSheetByName(TL_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  var needed = ['PickID', 'Material', 'LotNo', 'IssueQty', 'SourceSLoc',
                'DestSLoc', 'RefDoc', 'CreatedBy', 'CreatedAt', 'TxnType'];
  for (var k = 0; k < needed.length; k++) {
    if (idx[needed[k]] === undefined) return [];
  }

  var pgMap = getProductGroupMap_();
  var results = [];

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (String(row[idx['TxnType']] || '').trim() !== 'SPLIT_ISSUE') continue;

    var ca = row[idx['CreatedAt']];
    var caDate;
    if (ca instanceof Date) {
      caDate = ca;
    } else {
      caDate = new Date(ca);
      if (isNaN(caDate.getTime())) continue;
    }
    if (caDate.getTime() < bounds.start.getTime() || caDate.getTime() >= bounds.end.getTime()) continue;

    var mat = String(row[idx['Material']] || '').trim();
    results.push({
      PickID:      String(row[idx['PickID']] || '').trim(),
      Material:    mat,
      ProductGroup: pgMap[mat] || '-',
      LotNo:       String(row[idx['LotNo']] || '').trim(),
      IssueQty:    Number(row[idx['IssueQty']]) || 0,
      SourceSLoc:  String(row[idx['SourceSLoc']] || '').trim(),
      DestSLoc:    String(row[idx['DestSLoc']] || '').trim(),
      RefDoc:      String(row[idx['RefDoc']] || '').trim(),
      CreatedBy:   String(row[idx['CreatedBy']] || '').trim(),
      CreatedAt:   caDate
    });
  }

  return results;
}

/**
 * Group rows by ProductGroup then Material, returning ordered summary.
 *
 * @param {Array<Object>} rows
 * @param {string} qtyField — field name to sum ('Qty' or 'IssueQty')
 * @return {Array<{productGroup:string, materials:Array<{material:string,
 *   totalQty:number, unit:string, count:number}>, pgTotalQty:number}>}
 */
function summarize_(rows, qtyField) {
  var pgMap = {};
  for (var i = 0; i < rows.length; i++) {
    var r  = rows[i];
    var pg = r.ProductGroup || '-';
    var mat = r.Material || '-';

    if (!pgMap[pg]) pgMap[pg] = {};
    if (!pgMap[pg][mat]) pgMap[pg][mat] = { totalQty: 0, unit: r.Unit || '', count: 0 };
    pgMap[pg][mat].totalQty += Number(r[qtyField]) || 0;
    pgMap[pg][mat].count += 1;
  }

  var result = [];
  var pgKeys = Object.keys(pgMap).sort();
  for (var p = 0; p < pgKeys.length; p++) {
    var pg = pgKeys[p];
    var matKeys = Object.keys(pgMap[pg]).sort();
    var materials = [];
    var pgTotal = 0;
    for (var m = 0; m < matKeys.length; m++) {
      var entry = pgMap[pg][matKeys[m]];
      materials.push({
        material: matKeys[m],
        totalQty: entry.totalQty,
        unit:     entry.unit,
        count:    entry.count
      });
      pgTotal += entry.totalQty;
    }
    result.push({
      productGroup: pg,
      materials:    materials,
      pgTotalQty:   pgTotal
    });
  }

  return result;
}

// ============================================================================
// Main
// ============================================================================

/**
 * Build a daily report data object for a given date.
 *
 * @param {string|null} dateStr — 'yyyy-MM-dd' or null for today
 * @return {{label:string, received:Array, issued:Array, recvSummary:Array,
 *   issueSummary:Array, totals:{recvCount:number, recvQty:number,
 *   issueCount:number, issueQty:number}}}
 */
function buildDailyReport_(dateStr) {
  var bounds   = dayBounds_(dateStr);
  var received = getReceivedForDay_(bounds);
  var issued   = getIssuedForDay_(bounds);

  var recvQty = 0;
  for (var i = 0; i < received.length; i++) recvQty += received[i].Qty;

  var issueQty = 0;
  var pickIdSet = {};
  for (var j = 0; j < issued.length; j++) {
    issueQty += issued[j].IssueQty;
    pickIdSet[issued[j].PickID] = true;
  }

  return {
    label:        bounds.label,
    received:     received,
    issued:       issued,
    recvSummary:  summarize_(received, 'Qty'),
    issueSummary: summarize_(issued, 'IssueQty'),
    totals: {
      recvCount:  received.length,
      recvQty:    recvQty,
      issueCount: Object.keys(pickIdSet).length,
      issueQty:   issueQty
    }
  };
}

/**
 * Write report data to the TransferReport snapshot sheet with formatted layout.
 * Clears and overwrites each run (snapshot view, not a ledger).
 * Defensively forces plain-text format on label columns to prevent
 * formula injection (#ERROR!) from strings starting with '=' or '+'.
 *
 * @param {{label:string, received:Array, issued:Array, recvSummary:Array,
 *   issueSummary:Array, totals:Object}} report
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function writeReportToSheet_(report) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(TR_SHEET);
  if (!sh) sh = ss.insertSheet(TR_SHEET);
  sh.clear();
  sh.setHiddenGridlines(true);

  var tz  = 'Asia/Bangkok';
  var now = Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy HH:mm');
  var C   = 9;
  var r   = 1;

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

  // ── Title ──
  mergedText('รายงานสรุปประจำวัน ' + report.label + '   (สร้างเมื่อ ' + now + ')',
    { bg: '#1f3864', fc: '#ffffff', fs: 14, bold: true, h: 28 });
  r++;

  // ── Section A: รับเข้า ──
  mergedText('รับเข้าผลิตใหม่ (CONFIRMED วันนี้)',
    { bg: '#2e75b6', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;

  if (report.recvSummary.length === 0) {
    mergedText('ไม่มีรายการ', { fc: '#999999', italic: true });
  } else {
    tableHeader(['กลุ่มสินค้า', 'รหัสสินค้า', 'จำนวนรวม', 'หน่วย', 'จำนวนพาเลท']);
    sh.getRange(r - 1, 3).setHorizontalAlignment('center');
    sh.getRange(r - 1, 5).setHorizontalAlignment('center');

    var si = 0;
    for (var a = 0; a < report.recvSummary.length; a++) {
      var pg = report.recvSummary[a];
      for (var b = 0; b < pg.materials.length; b++) {
        var mat = pg.materials[b];
        var rng = sh.getRange(r, 1, 1, C);
        rng.setValues([pad([pg.productGroup, mat.material, mat.totalQty, mat.unit, mat.count])])
          .setBorder(true, true, true, true, true, true);
        if (si % 2 === 1) rng.setBackground('#f2f2f2');
        sh.getRange(r, 3).setNumberFormat('#,##0').setHorizontalAlignment('right');
        sh.getRange(r, 5).setNumberFormat('#,##0').setHorizontalAlignment('right');
        si++; r++;
      }
    }

    r++;

    tableHeader(['PalletID', 'Material', 'Qty', 'StorageLocation', 'ConfirmedAt'], '#ededed');
    sh.getRange(r - 1, 3).setHorizontalAlignment('center');

    for (var c = 0; c < report.received.length; c++) {
      var rv  = report.received[c];
      var ca  = rv.ConfirmedAt instanceof Date
        ? Utilities.formatDate(rv.ConfirmedAt, tz, 'dd/MM/yyyy HH:mm')
        : String(rv.ConfirmedAt || '');
      var rng = sh.getRange(r, 1, 1, C);
      rng.setValues([pad([rv.PalletID, rv.Material, rv.Qty, rv.StorageLocation, ca])])
        .setBorder(true, true, true, true, true, true);
      if (c % 2 === 1) rng.setBackground('#f2f2f2');
      sh.getRange(r, 3).setNumberFormat('#,##0').setHorizontalAlignment('right');
      r++;
    }
  }

  r++;
  mergedText('รวมรับเข้า: ' + report.totals.recvCount + ' พาเลท / ' + report.totals.recvQty + ' ชิ้น',
    { bg: '#fff2cc', bold: true });
  r++;

  // ── Section B: โอนออก ──
  mergedText('โอนย้ายออก — แบ่งเบิก (วันนี้)',
    { bg: '#c55a11', fc: '#ffffff', fs: 11, bold: true, h: 22 });
  r++;

  if (report.issueSummary.length === 0) {
    mergedText('ไม่มีรายการ', { fc: '#999999', italic: true });
  } else {
    tableHeader(['กลุ่มสินค้า', 'รหัสสินค้า', 'จำนวนรวม', 'หน่วย', 'จำนวนรายการ']);
    sh.getRange(r - 1, 3).setHorizontalAlignment('center');
    sh.getRange(r - 1, 5).setHorizontalAlignment('center');

    var si2 = 0;
    for (var d = 0; d < report.issueSummary.length; d++) {
      var pgI = report.issueSummary[d];
      for (var e = 0; e < pgI.materials.length; e++) {
        var matI = pgI.materials[e];
        var rng = sh.getRange(r, 1, 1, C);
        rng.setValues([pad([pgI.productGroup, matI.material, matI.totalQty, matI.unit, matI.count])])
          .setBorder(true, true, true, true, true, true);
        if (si2 % 2 === 1) rng.setBackground('#f2f2f2');
        sh.getRange(r, 3).setNumberFormat('#,##0').setHorizontalAlignment('right');
        sh.getRange(r, 5).setNumberFormat('#,##0').setHorizontalAlignment('right');
        si2++; r++;
      }
    }

    r++;

    tableHeader(['PickID', 'Material', 'LotNo', 'IssueQty', 'SourceSLoc', 'DestSLoc', 'RefDoc', 'CreatedBy', 'Time'], '#ededed');
    sh.getRange(r - 1, 4).setHorizontalAlignment('center');

    for (var f = 0; f < report.issued.length; f++) {
      var iss = report.issued[f];
      var tm  = iss.CreatedAt instanceof Date
        ? Utilities.formatDate(iss.CreatedAt, tz, 'dd/MM/yyyy HH:mm')
        : String(iss.CreatedAt || '');
      var rng = sh.getRange(r, 1, 1, C);
      rng.setValues([pad([iss.PickID, iss.Material, iss.LotNo, iss.IssueQty, iss.SourceSLoc,
                          iss.DestSLoc, iss.RefDoc, iss.CreatedBy, tm])])
        .setBorder(true, true, true, true, true, true);
      if (f % 2 === 1) rng.setBackground('#f2f2f2');
      sh.getRange(r, 4).setNumberFormat('#,##0').setHorizontalAlignment('right');
      r++;
    }
  }

  r++;
  mergedText('รวมโอนออก: ' + report.issued.length + ' รายการ (' +
    report.totals.issueCount + ' ใบเบิก) / ' + report.totals.issueQty + ' ชิ้น',
    { bg: '#fff2cc', bold: true });

  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 220);
  sh.setColumnWidth(2, 180);
  for (var col = 3; col <= C; col++) sh.autoResizeColumn(col);

  var last = sh.getLastRow();
  if (last > 0) sh.getRange(1, 1, last, 2).setNumberFormat('@');

  sh.activate();
  return sh;
}

/**
 * Build a compact plain-text summary string (for future Lark webhook in step 2g).
 *
 * @param {{label:string, recvSummary:Array, issueSummary:Array, totals:Object}} report
 * @return {string}
 */
function buildDailyReportText_(report) {
  var lines = [];
  lines.push('📋 สรุปประจำวัน ' + report.label);

  lines.push('▼ รับเข้า: ' + report.totals.recvCount + ' พาเลท / ' + report.totals.recvQty + ' ชิ้น');
  for (var a = 0; a < report.recvSummary.length; a++) {
    var pg = report.recvSummary[a];
    for (var b = 0; b < pg.materials.length; b++) {
      var mat = pg.materials[b];
      lines.push('  • [' + pg.productGroup + '] ' + mat.material + ': ' + mat.totalQty + ' ' + mat.unit);
    }
  }

  lines.push('▼ โอนออก: ' + report.totals.issueCount + ' ใบเบิก / ' + report.totals.issueQty + ' ชิ้น');
  for (var c = 0; c < report.issueSummary.length; c++) {
    var pgI = report.issueSummary[c];
    for (var d = 0; d < pgI.materials.length; d++) {
      var matI = pgI.materials[d];
      lines.push('  • [' + pgI.productGroup + '] ' + matI.material + ': ' + matI.totalQty + ' ' + matI.unit);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Menu handlers
// ============================================================================

/**
 * Menu handler: generate today's daily report, write to sheet, show summary.
 */
function reportTodayDialog() {
  var report = buildDailyReport_(null);
  writeReportToSheet_(report);
  var text = buildDailyReportText_(report);
  SpreadsheetApp.getUi().alert('สรุปรายงานประจำวัน', text, SpreadsheetApp.getUi().ButtonSet.OK);
  logEvent('DAILY_REPORT', TR_SHEET, 'OK', 0, report.label);
}

/**
 * Menu handler: prompt for a date, generate report for that date.
 */
function reportPickDateDialog() {
  var ui   = SpreadsheetApp.getUi();
  var resp = ui.prompt(
    'รายงานสรุปตามวันที่',
    'ใส่วันที่ (yyyy-MM-dd):',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var dateStr = resp.getResponseText().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    ui.alert('รูปแบบวันที่ไม่ถูกต้อง กรุณาใส่ yyyy-MM-dd เช่น 2026-06-20');
    return;
  }

  var report = buildDailyReport_(dateStr);
  writeReportToSheet_(report);
  var text = buildDailyReportText_(report);
  ui.alert('สรุปรายงานวันที่ ' + dateStr, text, ui.ButtonSet.OK);
  logEvent('DAILY_REPORT', TR_SHEET, 'OK', 0, report.label);
}

// ============================================================================
// Test
// ============================================================================

/**
 * Editor test — verify buildDailyReport_ runs without error for today.
 */
function TEST_reportToday_() {
  var report = buildDailyReport_(null);
  Logger.log(JSON.stringify(report.totals));
}

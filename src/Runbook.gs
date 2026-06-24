/**
 * Runbook.gs — Phase 5 Sprint 1 item 3: production-day checklist + live status
 * ==============================================================================
 * Read-only status panel. No SAP writes. No doGet change.
 * Reuses: getSpreadsheet_ (SheetSetup.gs), getSystemStatus_ (SystemStatus.gs),
 *         logEvent (SapClient.gs)
 */

var RB_SHEET_ = 'Runbook';

var RB_EXPECTED_FLAGS_ = {
  DRY_RUN:             'false',
  SAP_WRITE_ENABLED:   'true',
  FEATURE_TRANSFER311: 'DRY_RUN',
  FEATURE_QM_UD:       'OFF',
  REPORT_LARK_QC:      'LIVE'
};

// ============================================================================
// Sheet bootstrap
// ============================================================================

function ensureRunbookSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(RB_SHEET_);
  if (!sh) {
    sh = ss.insertSheet(RB_SHEET_);
  }

  sh.clear();
  sh.setColumnWidth(1, 280);
  sh.setColumnWidth(2, 320);

  var r = 1;

  // ── Section A ──
  sh.getRange(r, 1, 1, 2).merge()
    .setValue('A. สถานะระบบ (สด)')
    .setFontWeight('bold').setFontSize(12)
    .setBackground('#1a4e8a').setFontColor('#fff');
  r++;

  var signals = [
    'DRY_RUN', 'SAP_WRITE_ENABLED', 'FEATURE_TRANSFER311',
    'FEATURE_QM_UD', 'REPORT_LARK_QC',
    '',
    'DeadLetter OPEN', 'DeadLetter Total',
    '',
    'Last Redeploy Stamp', 'Last Redeploy Build',
    'Last Status Refresh'
  ];
  signals.forEach(function(s) {
    if (!s) { r++; return; }
    sh.getRange(r, 1).setValue(s).setFontWeight('bold');
    r++;
  });

  r++;

  // ── Section B ──
  sh.getRange(r, 1, 1, 2).merge()
    .setValue('B. ลำดับเปิดใช้งานวันผลิต')
    .setFontWeight('bold').setFontSize(12)
    .setBackground('#0b5394').setFontColor('#fff');
  r++;

  var checklist = [
    '1. ตรวจ SAP connection (เมนู System Status)',
    '2. เปิด SAP_WRITE_ENABLED → true (เมนู SAP Toggle → เปิด)',
    '3. ปิด DRY_RUN → false (เมนู SAP Toggle → ปิด DRY_RUN)',
    '4. ตรวจ DeadLetter OPEN = 0 (Refresh Runbook)',
    '5. ทดสอบ confirm 1 พาเลท → ตรวจ ConfirmationGroup ใน PM',
    '6. รัน 🔁 Stamp Redeploy หลังทำ New Version',
    '   (ถ้า stamp ไม่ขยับ = ยังไม่ได้ redeploy)',
    '7. Refresh Runbook → ตรวจสถานะ flag ทั้งหมด'
  ];
  checklist.forEach(function(item) {
    sh.getRange(r, 1, 1, 2).merge().setValue(item).setFontSize(10);
    r++;
  });

  r++;

  // ── Section C ──
  sh.getRange(r, 1, 1, 2).merge()
    .setValue('C. เช็คปิดวัน')
    .setFontWeight('bold').setFontSize(12)
    .setBackground('#7f6000').setFontColor('#fff');
  r++;

  var closing = [
    '1. ตั้ง DRY_RUN → true (เมนู SAP Toggle → เปิด DRY_RUN)',
    '2. ตรวจ DeadLetter OPEN = 0',
    '3. ตรวจ EventLog ไม่มี ERROR ใหม่',
    '4. ส่ง Lark รายงานสรุปวันนี้'
  ];
  closing.forEach(function(item) {
    sh.getRange(r, 1, 1, 2).merge().setValue(item).setFontSize(10);
    r++;
  });

  sh.setFrozenRows(1);
  return sh;
}

// ============================================================================
// Live refresh
// ============================================================================

function refreshRunbookStatus() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(RB_SHEET_);
  if (!sh) return;

  var data = sh.getDataRange().getValues();
  var labelToRow = {};
  for (var r = 0; r < data.length; r++) {
    var label = String(data[r][0] || '').trim();
    if (label) labelToRow[label] = r + 1;
  }

  var status = getSystemStatus_();
  var flags = status.flags;
  var props = PropertiesService.getScriptProperties().getProperties();

  // ---- Flags ----
  var flagKeys = ['DRY_RUN', 'SAP_WRITE_ENABLED', 'FEATURE_TRANSFER311', 'FEATURE_QM_UD', 'REPORT_LARK_QC'];
  flagKeys.forEach(function(key) {
    var row = labelToRow[key];
    if (!row) return;
    var val = flags[key] || '(unset)';
    var expected = RB_EXPECTED_FLAGS_[key] || '';
    var mark = (val === expected) ? '✅' : '⚠️';
    sh.getRange(row, 2).setValue(mark + ' ' + val + '  (go-live: ' + expected + ')')
      .setBackground(val === expected ? '#d4edda' : '#fff3cd');
  });

  // ---- DeadLetter ----
  var dlOpen = 0, dlTotal = 0;
  var dlSh = ss.getSheetByName('DeadLetter');
  if (dlSh && dlSh.getLastRow() >= 2) {
    var dlData = dlSh.getDataRange().getValues();
    var dlIdx = {};
    dlData[0].forEach(function(h, i) { dlIdx[String(h).trim()] = i; });
    var rsCol = dlIdx['ReplayStatus'];
    for (var d = 1; d < dlData.length; d++) {
      dlTotal++;
      if (rsCol !== undefined && String(dlData[d][rsCol] || '').trim() === 'OPEN') dlOpen++;
    }
  }
  if (labelToRow['DeadLetter OPEN']) {
    sh.getRange(labelToRow['DeadLetter OPEN'], 2)
      .setValue(dlOpen)
      .setBackground(dlOpen > 0 ? '#f8d7da' : '#d4edda');
  }
  if (labelToRow['DeadLetter Total']) {
    sh.getRange(labelToRow['DeadLetter Total'], 2).setValue(dlTotal);
  }

  // ---- Last redeploy ----
  var lastStamp = props['LAST_REDEPLOY_AT'] || 'ยังไม่ได้ stamp';
  var lastBuild = props['LAST_REDEPLOY_BUILD'] || '-';
  if (labelToRow['Last Redeploy Stamp']) {
    sh.getRange(labelToRow['Last Redeploy Stamp'], 2).setValue(lastStamp);
  }
  if (labelToRow['Last Redeploy Build']) {
    sh.getRange(labelToRow['Last Redeploy Build'], 2).setValue(lastBuild);
  }

  // ---- Timestamp ----
  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
  if (labelToRow['Last Status Refresh']) {
    sh.getRange(labelToRow['Last Status Refresh'], 2).setValue(now);
  }

  logEvent('RUNBOOK', 'REFRESH', 'OK', 0,
    'flags=' + flagKeys.length + ' dlOpen=' + dlOpen);
}

// ============================================================================
// Stamp redeploy
// ============================================================================

function stampRedeploy() {
  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");
  var props = PropertiesService.getScriptProperties();

  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt(
    '🔁 Stamp Redeploy',
    'ใส่ build label (เช่น p5s1-2d) หรือเว้นว่าง:',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var buildLabel = resp.getResponseText().trim() || now;

  props.setProperty('LAST_REDEPLOY_AT', now);
  props.setProperty('LAST_REDEPLOY_BUILD', buildLabel);

  refreshRunbookStatus();

  logEvent('RUNBOOK', 'STAMP_REDEPLOY', 'OK', 0, 'build=' + buildLabel);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Redeploy stamped: ' + buildLabel + ' @ ' + now, 'Runbook', 5);
}

// ============================================================================
// Menu handlers
// ============================================================================

function openRunbookSheet() {
  var sh = ensureRunbookSheet_();
  refreshRunbookStatus();
  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sh);
}

// ============================================================================
// Cheap partial refresh for onOpen (no network calls)
// ============================================================================

function refreshRunbookOnOpen_() {
  try {
    var ss = getSpreadsheet_();
    if (!ss.getSheetByName(RB_SHEET_)) return;
    refreshRunbookStatus();
  } catch (_) {}
}

// ============================================================================
// TEST
// ============================================================================

function TEST_runbookRefresh() {
  var fn = 'TEST_runbookRefresh';
  var t0 = Date.now();

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

  // ---- (1) ensureRunbookSheet_ creates section labels ----
  var sh = ensureRunbookSheet_();
  assert('(1) sheet created', !!sh, 'name=' + sh.getName());

  var data = sh.getDataRange().getValues();
  var labels = data.map(function(row) { return String(row[0] || '').trim(); });
  var requiredLabels = [
    'A. สถานะระบบ (สด)', 'DRY_RUN', 'SAP_WRITE_ENABLED', 'DeadLetter OPEN',
    'Last Redeploy Stamp', 'Last Status Refresh',
    'B. ลำดับเปิดใช้งานวันผลิต', 'C. เช็คปิดวัน'
  ];
  requiredLabels.forEach(function(lbl) {
    assert('(1) label: ' + lbl, labels.indexOf(lbl) >= 0);
  });

  // ---- (2) Seed fake DeadLetter row ----
  var dlSh = ensureDeadLetterSheet_();
  var dlHdr = dlSh.getRange(1, 1, 1, dlSh.getLastColumn()).getValues()[0];
  var dlIdx = {};
  dlHdr.forEach(function(h, i) { dlIdx[String(h).trim()] = i; });
  var seedRow = dlHdr.map(function() { return ''; });
  seedRow[dlIdx['DLID']] = 'DL-TEST-RB-001';
  seedRow[dlIdx['PalletID']] = 'PL-TEST-DL-RB-001';
  seedRow[dlIdx['ReplayStatus']] = 'OPEN';
  seedRow[dlIdx['Outcome']] = 'RETRY_EXHAUSTED';
  dlSh.appendRow(seedRow);
  SpreadsheetApp.flush();

  // ---- (3) Refresh + check cells ----
  refreshRunbookStatus();

  var refreshedData = sh.getDataRange().getValues();
  var labelToRow = {};
  for (var r = 0; r < refreshedData.length; r++) {
    labelToRow[String(refreshedData[r][0] || '').trim()] = r;
  }

  var dlOpenVal = String(refreshedData[labelToRow['DeadLetter OPEN']][1] || '').trim();
  assert('(3a) DeadLetter OPEN reflects seed',
    parseInt(dlOpenVal, 10) >= 1,
    'cellValue=' + dlOpenVal);

  var dryRunVal = String(refreshedData[labelToRow['DRY_RUN']][1] || '').trim();
  var status = getSystemStatus_();
  assert('(3b) DRY_RUN flag matches SystemStatus',
    dryRunVal.indexOf(status.flags.DRY_RUN) >= 0,
    'cell=' + dryRunVal + ' flag=' + status.flags.DRY_RUN);

  var lsrVal = String(refreshedData[labelToRow['Last Status Refresh']][1] || '').trim();
  assert('(3c) Last Status Refresh is date string',
    /^\d{4}-\d{2}-\d{2}/.test(lsrVal),
    'cellValue=' + lsrVal);

  var hasRawDate = false;
  for (var c = 0; c < refreshedData.length; c++) {
    if (refreshedData[c][1] instanceof Date) { hasRawDate = true; break; }
  }
  assert('(3d) no raw Date objects in col B', !hasRawDate);

  // ---- (4) stampRedeploy (programmatic, no UI prompt) ----
  var props = PropertiesService.getScriptProperties();
  var testStamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");
  props.setProperty('LAST_REDEPLOY_AT', testStamp);
  props.setProperty('LAST_REDEPLOY_BUILD', 'test-build');
  refreshRunbookStatus();

  var stampData = sh.getDataRange().getValues();
  var stampLabelToRow = {};
  for (var s = 0; s < stampData.length; s++) {
    stampLabelToRow[String(stampData[s][0] || '').trim()] = s;
  }
  var stampVal = String(stampData[stampLabelToRow['Last Redeploy Stamp']][1] || '').trim();
  assert('(4) Last Redeploy Stamp surfaced',
    stampVal === testStamp,
    'cellValue=' + stampVal);

  // ---- Cleanup ----
  var dlFresh = dlSh.getDataRange().getValues();
  for (var d2 = dlFresh.length - 1; d2 >= 1; d2--) {
    if (/^PL-TEST-DL-RB-/i.test(String(dlFresh[d2][dlIdx['PalletID']] || '').trim())) {
      dlSh.deleteRow(d2 + 1);
    }
  }
  props.deleteProperty('LAST_REDEPLOY_AT');
  props.deleteProperty('LAST_REDEPLOY_BUILD');
  Logger.log('Cleaned up test rows + properties');

  var elapsed = Date.now() - t0;
  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  Logger.log(fn + ': ' + (pass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name);
  });
  Logger.log('──────────────────────────────────────────');

  logEvent('TEST_RUNBOOK', 'Runbook', pass ? 'PASS' : 'FAIL', elapsed,
    results.length + ' assertions');
}

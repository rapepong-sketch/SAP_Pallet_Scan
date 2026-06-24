/**
 * Runbook.gs — Phase 5 Sprint 1 item 3: production-day checklist + live status
 * ==============================================================================
 * Read-only status panel. No SAP writes.
 * Reuses: getSpreadsheet_ (SheetSetup.gs), getSystemStatus_ (SystemStatus.gs),
 *         logEvent (SapClient.gs), CFG (Config.gs)
 */

var RB_SHEET_ = 'Runbook';

// Expected go-live flag values for ⚠ marking
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

  // ── Section A: สถานะระบบ (สด) ──
  sh.getRange(r, 1, 1, 2).merge()
    .setValue('A. สถานะระบบ (สด)')
    .setFontWeight('bold').setFontSize(12)
    .setBackground('#1a4e8a').setFontColor('#fff');
  r++;

  var signals = [
    'DRY_RUN', 'SAP_WRITE_ENABLED', 'FEATURE_TRANSFER311',
    'FEATURE_QM_UD', 'REPORT_LARK_QC',
    '', // spacer
    'DeadLetter OPEN', 'DeadLetter Total',
    '', // spacer
    'Build State', 'HEAD Build', 'Deployed Build',
    'Last Redeploy', 'Last Status Refresh'
  ];
  signals.forEach(function(s) {
    if (!s) { r++; return; }
    sh.getRange(r, 1).setValue(s).setFontWeight('bold');
    r++;
  });

  r++;

  // ── Section B: ลำดับเปิดใช้งานวันผลิต ──
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
    '7. Refresh Runbook → Build State = IN SYNC'
  ];
  checklist.forEach(function(item) {
    sh.getRange(r, 1, 1, 2).merge().setValue(item).setFontSize(10);
    r++;
  });

  r++;

  // ── Section C: เช็คปิดวัน ──
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

/**
 * Refresh all live-status cells in section A of the Runbook sheet.
 * @param {boolean} [skipBuildDrift] — if true, skip the self-fetch (for onOpen speed)
 */
function refreshRunbookStatus(skipBuildDrift) {
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

  // ---- Build drift ----
  var headBuild = CFG.WEBAPP_BUILD || '(unset)';
  if (labelToRow['HEAD Build']) {
    sh.getRange(labelToRow['HEAD Build'], 2).setValue(headBuild);
  }

  var deployedBuild = props['LAST_REDEPLOY_BUILD'] || '(unknown)';
  if (labelToRow['Deployed Build']) {
    sh.getRange(labelToRow['Deployed Build'], 2).setValue(deployedBuild);
  }

  var lastRedeploy = props['LAST_REDEPLOY_AT'] || '(never)';
  if (labelToRow['Last Redeploy']) {
    sh.getRange(labelToRow['Last Redeploy'], 2).setValue(lastRedeploy);
  }

  var buildState = 'UNKNOWN';
  if (!skipBuildDrift) {
    var execUrl = (props['WEBAPP_EXEC_URL'] || '').trim();
    if (execUrl) {
      try {
        var resp = UrlFetchApp.fetch(execUrl + '?probe=build', {
          muteHttpExceptions: true,
          followRedirects: true,
          validateHttpsCertificates: true
        });
        if (resp.getResponseCode() === 200) {
          var served = resp.getContentText().trim();
          buildState = (served === headBuild) ? 'IN SYNC' : 'REDEPLOY PENDING (served=' + served + ')';
        } else {
          buildState = 'UNKNOWN (HTTP ' + resp.getResponseCode() + ')';
        }
      } catch (e) {
        buildState = 'UNKNOWN (fetch error)';
      }
    } else {
      buildState = 'UNKNOWN (WEBAPP_EXEC_URL not set)';
    }
  }
  if (labelToRow['Build State']) {
    var bsColor = buildState === 'IN SYNC' ? '#d4edda' :
      (buildState.indexOf('REDEPLOY') === 0 ? '#fff3cd' : '#f0f0f0');
    sh.getRange(labelToRow['Build State'], 2).setValue(buildState).setBackground(bsColor);
  }

  // ---- Timestamp ----
  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
  if (labelToRow['Last Status Refresh']) {
    sh.getRange(labelToRow['Last Status Refresh'], 2).setValue(now);
  }

  logEvent('RUNBOOK', 'REFRESH', 'OK', 0,
    'flags=' + flagKeys.length + ' dlOpen=' + dlOpen + ' build=' + buildState.slice(0, 30));
}

// ============================================================================
// Stamp redeploy
// ============================================================================

function stampRedeploy() {
  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");
  var props = PropertiesService.getScriptProperties();
  props.setProperty('LAST_REDEPLOY_AT', now);
  props.setProperty('LAST_REDEPLOY_BUILD', CFG.WEBAPP_BUILD);

  refreshRunbookStatus();

  logEvent('RUNBOOK', 'STAMP_REDEPLOY', 'OK', 0, 'build=' + CFG.WEBAPP_BUILD);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Redeploy stamped: ' + CFG.WEBAPP_BUILD + ' @ ' + now, 'Runbook', 5);
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
// Cheap partial refresh for onOpen (no self-fetch)
// ============================================================================

function refreshRunbookOnOpen_() {
  try {
    var ss = getSpreadsheet_();
    if (!ss.getSheetByName(RB_SHEET_)) return;
    refreshRunbookStatus(true);
  } catch (_) {}
}

// ============================================================================
// TEST
// ============================================================================

/**
 * Self-cleaning test for Runbook sheet + refresh.
 * Seeds a fake DeadLetter row, refreshes, checks cell values, cleans up.
 */
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
    'Build State', 'HEAD Build', 'Last Status Refresh',
    'B. ลำดับเปิดใช้งานวันผลิต', 'C. เช็คปิดวัน'
  ];
  requiredLabels.forEach(function(lbl) {
    assert('(1) label exists: ' + lbl, labels.indexOf(lbl) >= 0);
  });

  // ---- (2) Seed a fake DeadLetter row ----
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

  // ---- (3) Refresh (skip build drift to avoid network) ----
  var savedUrl = PropertiesService.getScriptProperties().getProperty('WEBAPP_EXEC_URL');
  PropertiesService.getScriptProperties().deleteProperty('WEBAPP_EXEC_URL');

  refreshRunbookStatus(false);

  var refreshedData = sh.getDataRange().getValues();
  var labelToRow = {};
  for (var r = 0; r < refreshedData.length; r++) {
    labelToRow[String(refreshedData[r][0] || '').trim()] = r;
  }

  // Check DL OPEN count reflects seed
  var dlOpenVal = String(refreshedData[labelToRow['DeadLetter OPEN']][1] || '').trim();
  assert('(3a) DeadLetter OPEN reflects seed',
    parseInt(dlOpenVal, 10) >= 1,
    'cellValue=' + dlOpenVal);

  // Check Build State = UNKNOWN (exec URL unset)
  var buildVal = String(refreshedData[labelToRow['Build State']][1] || '').trim();
  assert('(3b) Build State = UNKNOWN (no exec URL)',
    buildVal.indexOf('UNKNOWN') >= 0,
    'cellValue=' + buildVal);

  // Check flags populated
  var dryRunVal = String(refreshedData[labelToRow['DRY_RUN']][1] || '').trim();
  assert('(3c) DRY_RUN flag populated',
    dryRunVal.length > 0 && dryRunVal !== '(unset)',
    'cellValue=' + dryRunVal);

  // Check Last Status Refresh is a date string
  var lsrVal = String(refreshedData[labelToRow['Last Status Refresh']][1] || '').trim();
  assert('(3d) Last Status Refresh populated',
    /^\d{4}-\d{2}-\d{2}/.test(lsrVal),
    'cellValue=' + lsrVal);

  // Check no raw Date objects (all cells should be string/number)
  var hasRawDate = false;
  for (var c = 0; c < refreshedData.length; c++) {
    if (refreshedData[c][1] instanceof Date) { hasRawDate = true; break; }
  }
  assert('(3e) no raw Date objects in col B', !hasRawDate);

  // ---- Cleanup ----
  if (savedUrl) {
    PropertiesService.getScriptProperties().setProperty('WEBAPP_EXEC_URL', savedUrl);
  }
  var dlFresh = dlSh.getDataRange().getValues();
  for (var d = dlFresh.length - 1; d >= 1; d--) {
    if (/^PL-TEST-DL-RB-/i.test(String(dlFresh[d][dlIdx['PalletID']] || '').trim())) {
      dlSh.deleteRow(d + 1);
    }
  }
  Logger.log('Cleaned up test DeadLetter rows');

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

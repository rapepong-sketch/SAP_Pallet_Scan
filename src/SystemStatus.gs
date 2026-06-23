/**
 * SystemStatus.gs — System health dashboard + flag visibility
 * =============================================================
 * Read-only. No SAP writes. Menu-only.
 * Reuses: getSpreadsheet_ (SheetSetup.gs), getSapCredentials_ (Config.gs),
 *         buildSapUrl_ (SapClient.gs), logEvent (SapClient.gs)
 */

// ============================================================================
// Core data collector
// ============================================================================

function getSystemStatus_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var ss    = getSpreadsheet_();
  var now   = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');

  // ── Flags ──
  var flags = {
    DRY_RUN:             props[CFG.FLAG_KEYS.DRY_RUN] !== 'false' ? 'true' : 'false',
    SAP_WRITE_ENABLED:   props[CFG.FLAG_KEYS.SAP_WRITE] === 'true' ? 'true' : 'false',
    FEATURE_TRANSFER311: props['FEATURE_TRANSFER311'] || 'DRY_RUN',
    FEATURE_QM_UD:       props['FEATURE_QM_UD']       || 'OFF',
    REPORT_LARK_QC:      props['REPORT_LARK_QC']      || 'DRY_RUN'
  };

  // ── SAP connection test ──
  var sapTest = { status: 'UNTESTED', baseUrl: CFG.SAP_BASE_URL, user: '' };
  try {
    var creds = getSapCredentials_();
    sapTest.user = creds.user || '';
    var url = buildSapUrl_(CFG.ENDPOINTS.PRODUCTION_ORDERS, { '$top': '1', '$select': 'ManufacturingOrder', '$format': 'json' });
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass), 'Accept': 'application/json' },
      muteHttpExceptions: true
    });
    sapTest.status = (resp.getResponseCode() >= 200 && resp.getResponseCode() < 300) ? 'OK' : 'FAIL_HTTP_' + resp.getResponseCode();
  } catch (e) {
    sapTest.status = 'FAIL_' + e.message.slice(0, 80);
  }

  // ── Sheet row counts ──
  var sheets = {};

  // PalletMaster
  var pmSh = ss.getSheetByName(PM_SHEET);
  var pm = { total: 0, confirmed: 0, qcComplete: 0, printed: 0 };
  if (pmSh && pmSh.getLastRow() >= 2) {
    var pmData = pmSh.getDataRange().getValues();
    var pmIdx = {};
    pmData[0].forEach(function(h, i) { pmIdx[String(h).trim()] = i; });
    var ssCol = pmIdx['ScanStatus'];
    for (var r = 1; r < pmData.length; r++) {
      pm.total++;
      var st = ssCol !== undefined ? String(pmData[r][ssCol] || '').trim() : '';
      if (st === 'CONFIRMED') pm.confirmed++;
      else if (st === 'QC_COMPLETE') pm.qcComplete++;
      else if (st === 'PRINTED') pm.printed++;
    }
  }
  sheets.PalletMaster = pm;

  // OperationLog
  var olSh = ss.getSheetByName(OL_SHEET);
  var ol = { total: 0, withActualMachine: 0 };
  if (olSh && olSh.getLastRow() >= 2) {
    var olData = olSh.getDataRange().getValues();
    var olIdx = {};
    olData[0].forEach(function(h, i) { olIdx[String(h).trim()] = i; });
    var amCol = olIdx['ActualMachine'];
    for (var r2 = 1; r2 < olData.length; r2++) {
      ol.total++;
      if (amCol !== undefined) {
        var am = String(olData[r2][amCol] == null ? '' : olData[r2][amCol]).trim();
        if (am) ol.withActualMachine++;
      }
    }
  }
  sheets.OperationLog = ol;

  // MachineMaster
  var mchSh = ss.getSheetByName(MCH_SHEET);
  var mch = { total: 0, active: 0 };
  if (mchSh && mchSh.getLastRow() >= 2) {
    var mchData = mchSh.getDataRange().getValues();
    var mchIdx = {};
    mchData[0].forEach(function(h, i) { mchIdx[String(h).trim()] = i; });
    for (var r3 = 1; r3 < mchData.length; r3++) {
      mch.total++;
      var act = mchData[r3][mchIdx['Active']];
      if (act !== false && String(act || '').trim().toUpperCase() !== 'FALSE') mch.active++;
    }
  }
  sheets.MachineMaster = mch;

  // TransferLog
  var tlSh = ss.getSheetByName('TransferLog');
  var tl = { total: 0, pending: 0 };
  if (tlSh && tlSh.getLastRow() >= 2) {
    var tlData = tlSh.getDataRange().getValues();
    var tlIdx = {};
    tlData[0].forEach(function(h, i) { tlIdx[String(h).trim()] = i; });
    var txCol = tlIdx['TxnStatus'];
    for (var r4 = 1; r4 < tlData.length; r4++) {
      tl.total++;
      if (txCol !== undefined && String(tlData[r4][txCol] || '').trim() === 'PENDING') tl.pending++;
    }
  }
  sheets.TransferLog = tl;

  // InspectionLots
  var ilSh = ss.getSheetByName('InspectionLots');
  sheets.InspectionLots = { total: (ilSh && ilSh.getLastRow() >= 2) ? ilSh.getLastRow() - 1 : 0 };

  return JSON.parse(JSON.stringify({
    timestamp: now,
    sapConnection: sapTest,
    flags: flags,
    sheets: sheets,
    deployNote: 'clasp push updates HEAD only. Web app runs pinned deployment. Always REDEPLOY after .gs or HTML changes.'
  }));
}

// ============================================================================
// Dialog
// ============================================================================

function showSystemStatusDialog() {
  var status = getSystemStatus_();

  var sapIcon = status.sapConnection.status === 'OK' ? '✅' : '❌';
  var sapColor = status.sapConnection.status === 'OK' ? '#d4edda' : '#f8d7da';

  var flagRows = [
    { key: 'DRY_RUN',             label: 'DRY_RUN (global safety)',     meaning: { 'true': '🧪 build+log เท่านั้น', 'false': '⚠️ POST จริง' } },
    { key: 'SAP_WRITE_ENABLED',   label: 'SAP_WRITE_ENABLED',           meaning: { 'true': '🟢 เปิดเขียน SAP', 'false': '🔴 ปิด (local only)' } },
    { key: 'FEATURE_TRANSFER311', label: 'FEATURE_TRANSFER311 (โอน)',   meaning: { 'DRY_RUN': '🧪 log เท่านั้น', 'LIVE': '🟢 POST จริง', 'OFF': '🔴 ปิด' } },
    { key: 'FEATURE_QM_UD',       label: 'FEATURE_QM_UD (QM)',         meaning: { 'OFF': '🔴 parked (ไม่มี lot)', 'DRY_RUN': '🧪 log', 'LIVE': '🟢 POST' } },
    { key: 'REPORT_LARK_QC',      label: 'REPORT_LARK_QC (Lark QC)',   meaning: { 'DRY_RUN': '🧪 log เท่านั้น', 'LIVE': '🟢 ส่งห้อง QC' } }
  ];

  var flagHtml = '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '<tr style="background:#e9ecef"><th style="padding:6px;text-align:left">Flag</th><th style="padding:6px">Value</th><th style="padding:6px;text-align:left">Meaning</th></tr>';
  flagRows.forEach(function(f) {
    var val = status.flags[f.key] || '(unset)';
    var desc = (f.meaning[val] || val);
    flagHtml += '<tr style="border-bottom:1px solid #eee"><td style="padding:5px">' + f.label +
      '</td><td style="padding:5px;text-align:center;font-weight:bold">' + val +
      '</td><td style="padding:5px">' + desc + '</td></tr>';
  });
  flagHtml += '</table>';

  var sh = status.sheets;
  var sheetHtml = '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '<tr style="background:#e9ecef"><th style="padding:6px;text-align:left">Sheet</th><th style="padding:6px">Rows</th><th style="padding:6px;text-align:left">Detail</th></tr>' +
    '<tr><td style="padding:5px">PalletMaster</td><td style="padding:5px;text-align:center">' + sh.PalletMaster.total + '</td><td style="padding:5px">CONFIRMED=' + sh.PalletMaster.confirmed + ' QC_COMPLETE=' + sh.PalletMaster.qcComplete + ' PRINTED=' + sh.PalletMaster.printed + '</td></tr>' +
    '<tr style="background:#f8f9fa"><td style="padding:5px">OperationLog</td><td style="padding:5px;text-align:center">' + sh.OperationLog.total + '</td><td style="padding:5px">ActualMachine set: ' + sh.OperationLog.withActualMachine + '</td></tr>' +
    '<tr><td style="padding:5px">MachineMaster</td><td style="padding:5px;text-align:center">' + sh.MachineMaster.total + '</td><td style="padding:5px">Active: ' + sh.MachineMaster.active + '</td></tr>' +
    '<tr style="background:#f8f9fa"><td style="padding:5px">TransferLog</td><td style="padding:5px;text-align:center">' + sh.TransferLog.total + '</td><td style="padding:5px">Pending: ' + sh.TransferLog.pending + '</td></tr>' +
    '<tr><td style="padding:5px">InspectionLots</td><td style="padding:5px;text-align:center">' + sh.InspectionLots.total + '</td><td style="padding:5px">(parked)</td></tr>' +
    '</table>';

  var html = '<div style="font-family:Sarabun,Arial,sans-serif;font-size:14px;padding:12px">' +
    '<h2 style="margin:0 0 12px">📊 System Status</h2>' +
    '<div style="font-size:12px;color:#888;margin-bottom:12px">' + status.timestamp + '</div>' +

    '<div style="background:' + sapColor + ';border-radius:6px;padding:10px 14px;margin-bottom:12px">' +
    '<strong>' + sapIcon + ' SAP Connection</strong><br>' +
    '<span style="font-size:12px">' + status.sapConnection.baseUrl + ' | user: ' + status.sapConnection.user + ' | ' + status.sapConnection.status + '</span></div>' +

    '<h3 style="margin:14px 0 6px">Feature Flags</h3>' + flagHtml +

    '<h3 style="margin:14px 0 6px">Sheet Health</h3>' + sheetHtml +

    '<div style="background:#f8d7da;border:2px solid #dc3545;border-radius:6px;padding:10px 14px;margin-top:14px;font-size:12px">' +
    '<strong>⚠️ Deployment</strong><br>' + status.deployNote + '</div>' +

    '<h3 style="margin:14px 0 6px;font-size:13px">วิธี flip flags วันผลิตจริง</h3>' +
    '<ul style="font-size:12px;margin:0;padding-left:18px;color:#555">' +
    '<li>FEATURE_TRANSFER311 → LIVE: เมนู Transfer → เปิดใช้งานจริง</li>' +
    '<li>DRY_RUN → false: เมนู SAP Toggle → ปิด DRY_RUN</li>' +
    '<li>FEATURE_QM_UD: stays OFF until SAP QM configured</li>' +
    '</ul>' +
    '</div>';

  var output = HtmlService.createHtmlOutput(html)
    .setWidth(640).setHeight(580)
    .setTitle('System Status');
  SpreadsheetApp.getUi().showModelessDialog(output, '📊 System Status — PJ Chonburi');
}

// ============================================================================
// TEST
// ============================================================================

function TEST_systemStatus_() {
  var results = [];
  var pass    = true;

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  var status = getSystemStatus_();

  // (a) all top-level keys present
  assert('(a) has timestamp', typeof status.timestamp === 'string');
  assert('(a) has sapConnection', status.sapConnection !== undefined);
  assert('(a) has flags', status.flags !== undefined);
  assert('(a) has sheets', status.sheets !== undefined);
  assert('(a) has deployNote', typeof status.deployNote === 'string');

  // (b) FEATURE_QM_UD = OFF
  assert('(b) FEATURE_QM_UD=OFF', status.flags.FEATURE_QM_UD === 'OFF',
    'got=' + status.flags.FEATURE_QM_UD);

  // (c) PalletMaster total > 0
  assert('(c) PalletMaster.total > 0', status.sheets.PalletMaster.total > 0,
    'total=' + status.sheets.PalletMaster.total);

  // (d) JSON serializable
  var serialized = JSON.parse(JSON.stringify(status));
  assert('(d) JSON round-trip OK', serialized.timestamp === status.timestamp);

  Logger.log('');
  Logger.log('Full status: ' + JSON.stringify(status, null, 2));
  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_systemStatus_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name +
      (results[si].detail ? ' (' + results[si].detail + ')' : ''));
  }
}

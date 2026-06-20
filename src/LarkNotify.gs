/**
 * LarkNotify.gs — Phase 3.5 Step 2g
 * ====================================
 * Lark (Feishu) custom-bot webhook integration for daily report notifications.
 * Credential stored in ScriptProperties — never hardcoded, never in Config sheet.
 *
 * Reuses: buildDailyReport_, buildDailyReportText_ (TransferReport.gs),
 *         logEvent (SapClient.gs), isAdminUser_ (WebApp.gs)
 */

// ============================================================================
// Config — ScriptProperties
// ============================================================================

/**
 * Read Lark webhook config from ScriptProperties.
 *
 * @return {{url:string, secret:string}}
 * @throws {Error} if LARK_WEBHOOK_URL is not set
 */
function getLarkWebhook_() {
  var props = PropertiesService.getScriptProperties();
  var url   = (props.getProperty('LARK_WEBHOOK_URL') || '').trim();
  if (!url) {
    throw new Error('ยังไม่ได้ตั้งค่า Lark Webhook (เมนู ตั้งค่า Lark Webhook)');
  }
  return { url: url, secret: (props.getProperty('LARK_WEBHOOK_SECRET') || '').trim() };
}

/**
 * Menu handler: prompt admin to set Lark webhook URL in ScriptProperties.
 * Admin-gated. Validates URL prefix before saving.
 */
function setLarkWebhookDialog() {
  var ui = SpreadsheetApp.getUi();
  if (!isAdminUser_()) {
    ui.alert('admin เท่านั้น');
    return;
  }

  var resp = ui.prompt(
    '⚙️ ตั้งค่า Lark Webhook',
    'วาง Lark Webhook URL:',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  var url = resp.getResponseText().trim();
  if (url.indexOf('https://open.larksuite.com/') !== 0 &&
      url.indexOf('https://open.feishu.cn/') !== 0) {
    ui.alert('URL ไม่ถูกต้อง — ต้องขึ้นต้นด้วย https://open.larksuite.com/ หรือ https://open.feishu.cn/');
    return;
  }

  PropertiesService.getScriptProperties().setProperty('LARK_WEBHOOK_URL', url);
  ui.alert('บันทึกแล้ว');
  logEvent('LARK_CONFIG', 'LarkNotify', 'OK', 0, 'webhook set');
}

// ============================================================================
// Signing (optional signed-bot)
// ============================================================================

/**
 * Compute Lark custom-bot HMAC-SHA256 signature.
 * Algorithm: key = (timestamp + "\n" + secret), data = "", then Base64.
 *
 * @param {number} timestamp — unix seconds
 * @param {string} secret — LARK_WEBHOOK_SECRET
 * @return {string} base64 signature
 */
function larkSign_(timestamp, secret) {
  var stringToSign = String(timestamp) + '\n' + secret;
  var key  = Utilities.newBlob(stringToSign).getBytes();
  var data = Utilities.newBlob('').getBytes();
  var hmac = Utilities.computeHmacSha256Signature(data, key);
  return Utilities.base64Encode(hmac);
}

// ============================================================================
// Send
// ============================================================================

/**
 * Send a plain-text message to the configured Lark webhook.
 * Validates both HTTP 200 and Lark body.code === 0.
 *
 * @param {string} text — message body
 * @return {{ok:true}}
 * @throws {Error} on webhook misconfiguration or Lark API error
 */
function sendLarkText_(text) {
  var cfg       = getLarkWebhook_();
  var timestamp = Math.floor(Date.now() / 1000);

  var payload = { msg_type: 'text', content: { text: text } };
  if (cfg.secret) {
    payload.timestamp = String(timestamp);
    payload.sign      = larkSign_(timestamp, cfg.secret);
  }

  var resp = UrlFetchApp.fetch(cfg.url, {
    method:              'post',
    contentType:         'application/json',
    payload:             JSON.stringify(payload),
    muteHttpExceptions:  true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();
  var json;
  try { json = JSON.parse(body); } catch (_) { json = {}; }

  var larkCode = json.code != null ? json.code : json.StatusCode;
  if (code !== 200 || (larkCode !== 0 && larkCode !== undefined)) {
    var errMsg = 'Lark error ' + code + ': ' + (json.msg || json.StatusMessage || body).substring(0, 300);
    logEvent('LARK_SEND', 'LarkNotify', 'ERROR', 0, code + ':' + body.substring(0, 400));
    throw new Error(errMsg);
  }

  logEvent('LARK_SEND', 'LarkNotify', 'OK', 0, 'len=' + text.length);
  return { ok: true };
}

// ============================================================================
// Send handlers
// ============================================================================

/**
 * Build and send the daily report to Lark. Reusable by menu and trigger.
 *
 * @param {string|null} dateStr — 'yyyy-MM-dd' or null for today
 * @return {{ok:true}}
 */
function sendDailyReportToLark(dateStr) {
  var report = buildDailyReport_(dateStr || null);
  var text   = buildDailyReportText_(report) + '\n— PJ Chonburi Pallet System';
  return sendLarkText_(text);
}

/**
 * Menu handler: send today's report to Lark (admin-gated, with confirmation).
 */
function sendTodayReportLarkDialog() {
  var ui = SpreadsheetApp.getUi();
  if (!isAdminUser_()) {
    ui.alert('admin เท่านั้น');
    return;
  }

  var confirm = ui.alert('ส่งสรุปเข้า Lark', 'ส่งสรุปวันนี้เข้า Lark?', ui.ButtonSet.OK_CANCEL);
  if (confirm !== ui.Button.OK) return;

  try {
    sendDailyReportToLark(null);
    ui.alert('ส่งแล้ว');
    logEvent('LARK_DAILY', 'LarkNotify', 'OK', 0, 'manual send');
  } catch (e) {
    ui.alert('ส่งไม่สำเร็จ: ' + e.message);
    logEvent('LARK_DAILY', 'LarkNotify', 'ERROR', 0, String(e));
  }
}

// ============================================================================
// Auto trigger (18:00 daily)
// ============================================================================

/**
 * Menu handler: install daily 18:00 trigger for Lark report (admin-gated, idempotent).
 * Removes any existing trigger for the same handler before creating a new one.
 */
function installLarkDailyTrigger() {
  var ui = SpreadsheetApp.getUi();
  if (!isAdminUser_()) {
    ui.alert('admin เท่านั้น');
    return;
  }

  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'larkDailyTriggerHandler') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('larkDailyTriggerHandler')
    .timeBased()
    .atHour(18)
    .everyDays(1)
    .inTimezone('Asia/Bangkok')
    .create();

  ui.alert('ตั้งส่งอัตโนมัติ 18:00 ทุกวันแล้ว');
  logEvent('LARK_TRIGGER', 'LarkNotify', 'OK', 0, 'installed 18:00');
}

/**
 * Menu handler: remove daily Lark trigger (admin-gated).
 */
function removeLarkDailyTrigger() {
  var ui = SpreadsheetApp.getUi();
  if (!isAdminUser_()) {
    ui.alert('admin เท่านั้น');
    return;
  }

  var removed = 0;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'larkDailyTriggerHandler') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }

  ui.alert(removed ? 'ลบ trigger แล้ว (' + removed + ' รายการ)' : 'ไม่พบ trigger ที่ต้องลบ');
  logEvent('LARK_TRIGGER', 'LarkNotify', 'OK', 0, 'removed ' + removed);
}

/**
 * Headless trigger handler — called by time-driven trigger at 18:00.
 * Must never throw (trigger context). No SpreadsheetApp.getUi calls.
 */
function larkDailyTriggerHandler() {
  var today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  try {
    sendDailyReportToLark(null);
    logEvent('LARK_DAILY_AUTO', 'LarkNotify', 'OK', 0, today);
  } catch (e) {
    logEvent('LARK_DAILY_AUTO', 'LarkNotify', 'ERROR', 0, today + ' ' + String(e));
  }
}

// ============================================================================
// Test
// ============================================================================

/**
 * Editor test — sends today's report to the configured Lark webhook.
 * Run from Apps Script Editor → select TEST_larkSendToday_ → Run.
 */
function TEST_larkSendToday_() {
  Logger.log(JSON.stringify(sendDailyReportToLark(null)));
}

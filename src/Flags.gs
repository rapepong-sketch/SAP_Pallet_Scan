/**
 * Flags.gs — Feature flag helpers for Phase 3+
 * =============================================
 * Phase 3 — Step 1
 *
 * Flags live in Script Properties so they persist across executions and
 * can be toggled via the ⚙️ Pallet SAP Toggle menu without touching code.
 *
 * Behaviour matrix:
 *  SAP_WRITE_ENABLED=false  → UI full, log local, NO SAP call (Step 1 mode)
 *  SAP_WRITE_ENABLED=true, DRY_RUN=true  → build+log payload, no POST
 *  SAP_WRITE_ENABLED=true, DRY_RUN=false → POST live to SAP (Step 2+)
 */

// ============================================================================
// Readers — used by WebApp.gs and SapClient.gs
// ============================================================================

/** @return {boolean} true when SAP write is enabled (master switch) */
function sapWriteEnabled_() {
  return PropertiesService.getScriptProperties()
    .getProperty(CFG.FLAG_KEYS.SAP_WRITE) === 'true';
}

/**
 * @return {boolean} true = dry-run (no POST).
 * Defaults to true (safe) when property has never been set.
 */
function isDryRun_() {
  const v = PropertiesService.getScriptProperties()
    .getProperty(CFG.FLAG_KEYS.DRY_RUN);
  return v !== 'false'; // unset → safe default true
}

/**
 * @return {boolean} true = cumulative/partial SAP confirmation rounds enabled
 * (Phase 6.5 Gate 2 Part 1). Defaults to false (safe) when the property has
 * never been set — existing 6.2-REV exact-match-only behavior stays in force
 * everywhere until Kor explicitly flips this on for controlled testing.
 */
function isCumulativeConfirmEnabled_() {
  return PropertiesService.getScriptProperties()
    .getProperty(CFG.FLAG_KEYS.CUMULATIVE_CONFIRM) === 'true'; // unset → safe default false
}

// ============================================================================
// Setters — bound to menu items; every setter ends with an alert()
// ============================================================================

/** 🟢 เปิด SAP write */
function flagEnableSapWrite() {
  PropertiesService.getScriptProperties().setProperty(CFG.FLAG_KEYS.SAP_WRITE, 'true');
  logEvent('FLAG', CFG.FLAG_KEYS.SAP_WRITE, 'SET_TRUE', 0, 'via menu');
  SpreadsheetApp.getUi().alert(
    '✅ SAP_WRITE_ENABLED = true\n\n' +
    'SAP write เปิดแล้ว\n' +
    'ตรวจสอบ DRY_RUN ก่อน — ถ้า DRY_RUN=false จะ POST เข้า SAP จริง'
  );
}

/** 🔴 ปิด SAP write (กลับโหมดทดสอบ) */
function flagDisableSapWrite() {
  PropertiesService.getScriptProperties().setProperty(CFG.FLAG_KEYS.SAP_WRITE, 'false');
  logEvent('FLAG', CFG.FLAG_KEYS.SAP_WRITE, 'SET_FALSE', 0, 'via menu');
  SpreadsheetApp.getUi().alert(
    '🔴 SAP_WRITE_ENABLED = false\n\n' +
    'SAP write ปิดแล้ว — โหมดทดสอบ UI\n' +
    'บันทึก local (OperationLog/EventLog) ทำงานปกติ'
  );
}

/** 🧪 DRY_RUN เปิด — build payload + log แต่ไม่ POST */
function flagDryRunOn() {
  PropertiesService.getScriptProperties().setProperty(CFG.FLAG_KEYS.DRY_RUN, 'true');
  logEvent('FLAG', CFG.FLAG_KEYS.DRY_RUN, 'SET_TRUE', 0, 'via menu');
  SpreadsheetApp.getUi().alert(
    '🧪 DRY_RUN = true\n\n' +
    'ระบบจะ build SAP payload + log แต่ไม่ POST เข้า SAP\n' +
    'ใช้สำหรับทดสอบ SAP payload ก่อน go-live'
  );
}

/** ⚠️ DRY_RUN ปิด — POST จริง (มี alert เตือนสีแดง) */
function flagDryRunOff() {
  PropertiesService.getScriptProperties().setProperty(CFG.FLAG_KEYS.DRY_RUN, 'false');
  logEvent('FLAG', CFG.FLAG_KEYS.DRY_RUN, 'SET_FALSE', 0, 'via menu — LIVE MODE');
  SpreadsheetApp.getUi().alert(
    '⛔ คำเตือน: DRY_RUN = false\n\n' +
    '⚠️  ระบบจะ POST จริงเข้า SAP!\n\n' +
    'ใช้เฉพาะเมื่อต้องการ verify การส่งข้อมูลจริงเท่านั้น\n' +
    'เสร็จแล้วกด "↩️ รีเซ็ตเป็น default ปลอดภัย" ทันที'
  );
}

/** 📊 แสดงสถานะ flag ปัจจุบัน */
function flagShowStatus() {
  const p        = PropertiesService.getScriptProperties();
  const sapWrite = p.getProperty(CFG.FLAG_KEYS.SAP_WRITE) || '(ยังไม่ตั้ง → default false)';
  const dryRun   = p.getProperty(CFG.FLAG_KEYS.DRY_RUN)   || '(ยังไม่ตั้ง → default true)';
  const cumConf  = p.getProperty(CFG.FLAG_KEYS.CUMULATIVE_CONFIRM) || '(ยังไม่ตั้ง → default false)';

  const sapIcon = sapWrite === 'true' ? '🟢' : '🔴';
  const drIcon  = dryRun  === 'false' ? '⚠️' : '🧪';
  const ccIcon  = cumConf === 'true'  ? '🟢' : '🔴';

  SpreadsheetApp.getUi().alert(
    '📊 สถานะ Feature Flags\n\n' +
    sapIcon + ' SAP_WRITE_ENABLED = ' + sapWrite + '\n' +
    drIcon  + ' DRY_RUN           = ' + dryRun   + '\n' +
    ccIcon  + ' CUMULATIVE_CONFIRM_ENABLED = ' + cumConf + '\n\n' +
    _flagModeDesc_(sapWrite, dryRun)
  );
}

/** ↩️ รีเซ็ตเป็น default ปลอดภัย */
function flagSetDefaults() {
  const p = PropertiesService.getScriptProperties();
  p.setProperty(CFG.FLAG_KEYS.SAP_WRITE, 'false');
  p.setProperty(CFG.FLAG_KEYS.DRY_RUN,   'true');
  p.setProperty(CFG.FLAG_KEYS.CUMULATIVE_CONFIRM, 'false');
  logEvent('FLAG', 'DEFAULTS', 'RESET', 0, 'SAP_WRITE=false DRY_RUN=true CUMULATIVE_CONFIRM=false via menu');
  SpreadsheetApp.getUi().alert(
    '↩️ รีเซ็ตเป็น default ปลอดภัยแล้ว\n\n' +
    '🔴 SAP_WRITE_ENABLED = false (ปิด SAP)\n' +
    '🧪 DRY_RUN           = true\n' +
    '🔴 CUMULATIVE_CONFIRM_ENABLED = false\n\n' +
    'โหมด: UI ทำงานเต็ม — บันทึก local เท่านั้น ไม่มี SAP call'
  );
}

/** 🟢 เปิด Cumulative/Partial Confirm (Phase 6.5 Gate 2 Part 1) */
function flagEnableCumulativeConfirm() {
  PropertiesService.getScriptProperties().setProperty(CFG.FLAG_KEYS.CUMULATIVE_CONFIRM, 'true');
  logEvent('FLAG', CFG.FLAG_KEYS.CUMULATIVE_CONFIRM, 'SET_TRUE', 0, 'via menu');
  SpreadsheetApp.getUi().alert(
    '✅ CUMULATIVE_CONFIRM_ENABLED = true\n\n' +
    'อนุญาตยืนยัน SAP แบบแบ่งรอบ (สูงสุด ' + CFG.MAX_CONFIRM_ROUNDS + ' รอบ) ต่อพาเลท\n' +
    'ใช้เฉพาะช่วงทดสอบที่ตรวจสอบแล้วเท่านั้น — ยังไม่มี UI รองรับ (Gate 2 Part 2)'
  );
}

/** 🔴 ปิด Cumulative/Partial Confirm (กลับสู่ exact-match เดิม — 6.2-REV) */
function flagDisableCumulativeConfirm() {
  PropertiesService.getScriptProperties().setProperty(CFG.FLAG_KEYS.CUMULATIVE_CONFIRM, 'false');
  logEvent('FLAG', CFG.FLAG_KEYS.CUMULATIVE_CONFIRM, 'SET_FALSE', 0, 'via menu');
  SpreadsheetApp.getUi().alert(
    '🔴 CUMULATIVE_CONFIRM_ENABLED = false\n\n' +
    'กลับสู่พฤติกรรมเดิม (6.2-REV) — ต้องยืนยันครบจำนวนต่อพาเลทในครั้งเดียว'
  );
}

// ============================================================================
// Internal
// ============================================================================

function _flagModeDesc_(sapWrite, dryRun) {
  if (sapWrite !== 'true') return 'โหมด: UI ทำงานเต็ม — บันทึก local เท่านั้น (ปลอดภัย)';
  if (dryRun !== 'false')  return 'โหมด: SAP เปิด + DRY_RUN — build payload เท่านั้น ไม่ POST';
  return '⛔ โหมด LIVE — POST จริงเข้า SAP!';
}

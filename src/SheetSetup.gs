/**
 * SheetSetup.gs — สร้าง/ซ่อมโครงสร้าง 7 sheets (idempotent — รันซ้ำได้ ไม่ลบข้อมูลเดิม)
 * ================================================================================
 * Sheets: Config, ProductionOrders, PalletMaster, MOQ_Config,
 *         InspectionLots, EventLog, ErrorLog
 */

/** สร้าง custom menu เมื่อเปิด Spreadsheet */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏭 Pallet Tracker')
    .addItem('🔧 Setup Sheets',              'setupSheets')
    .addItem('🔌 Test SAP Connection',        'testSapConnection')
    .addItem('📥 Pull Production Orders',     'pullProductionOrders')
    .addItem('🗑️  Clear Old Orders',          'clearOldOrders')
    .addSeparator()
    .addItem('⚙️ Setup MOQ Config',          'setupMoqConfig')
    .addItem('📦 Generate Pallets (ALL)',     'generatePallets')
    .addItem('📦 Generate Pallets (1 Order)', 'generatePalletsForOrder')
    .addItem('🖨️  Print Pallet Labels',       'printLabelsDialog')
    .addToUi();
}

let _ss_ = null;

/** เปิด spreadsheet ครั้งเดียวต่อ execution */
function getSpreadsheet_() {
  if (!_ss_) _ss_ = SpreadsheetApp.openById(CFG.SHEET_ID);
  return _ss_;
}

/** ดึง sheet ตามชื่อ — โยน error ถ้ายังไม่ได้ setupSheets() */
function getSheet_(name) {
  const sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" not found — รัน setupSheets() ก่อน');
  return sh;
}

/**
 * MAIN — รันฟังก์ชันนี้เป็นอันดับแรก (Test Gate ข้อ 1)
 * สร้าง 7 sheets พร้อม header แถวแรก (bold + freeze) — รันซ้ำได้ปลอดภัย
 */
function setupSheets() {
  const ss = getSpreadsheet_();
  const created = [];
  const repaired = [];

  Object.keys(CFG.SHEETS).forEach(function (key) {
    const name = CFG.SHEETS[key];
    const headers = CFG.HEADERS[key];
    if (!headers) throw new Error('No headers defined in CFG.HEADERS for ' + key);

    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      created.push(name);
    } else {
      repaired.push(name);
    }

    // เขียน header ทับเฉพาะแถว 1 — ไม่แตะ data rows
    sh.getRange(1, 1, 1, headers.length)
      .setValues([headers])
      .setFontWeight('bold')
      .setFontColor('#ffffff')
      .setBackground('#1a4e8a');
    sh.setFrozenRows(1);

    // ขยายความกว้าง column แรก ๆ ให้อ่าน key ง่าย
    sh.setColumnWidth(1, 160);
  });

  seedConfigSheet_();
  // ลบ Sheet1 default ถ้าว่างเปล่าและมี sheet อื่นครบแล้ว
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 7) {
    ss.deleteSheet(def);
  }

  const note = 'created=[' + created.join(',') + '] verified=[' + repaired.join(',') + ']';
  logEvent('setupSheets', '-', 'OK', 0, note);
  console.log('setupSheets done: ' + note);
}

/**
 * Seed ค่าอ้างอิงลง Config sheet (เฉพาะตอนยังว่าง) — ใช้เป็น documentation ในตัว
 * source of truth จริงคือ CFG ใน Config.gs
 */
function seedConfigSheet_() {
  const sh = getSheet_(CFG.SHEETS.CONFIG);
  if (sh.getLastRow() > 1) return; // มีข้อมูลแล้ว ไม่ทับ

  const rows = [
    ['DRY_RUN',        String(CFG.DRY_RUN), 'แก้ค่าใน Config.gs เท่านั้น — true = log only ไม่เขียน SAP/sheet'],
    ['SAP_BASE_URL',   CFG.SAP_BASE_URL,    'SAP S/4HANA Cloud API tenant'],
    ['PLANT',          CFG.PLANT,           'Plant filter สำหรับทุก pull'],
    ['PULL_DAYS_BACK', String(CFG.PULL_DAYS_BACK), 'ดึง PO ย้อนหลังกี่วัน (0 = ทั้งหมด)'],
    ['CREDENTIALS',    '(Script Properties)', 'SAP_USER / SAP_PASS / SAP_CLIENT — ห้ามใส่ในไฟล์ code'],
    ['SCRIPT_VERSION', 'Phase 1 v1.0',      'Foundation: setup + SapClient + pullProductionOrders']
  ];
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
}

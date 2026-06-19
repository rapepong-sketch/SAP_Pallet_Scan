/**
 * MOQConfigSetup.gs — Phase 2
 * สร้างชีต MOQ_Config + seed ตัวอย่าง (แก้ค่า MOQ จริงได้ในชีตโดยตรง)
 * Idempotent: ไม่ insert material ซ้ำ, ไม่ทำลายข้อมูลที่ user แก้ไว้
 */

var MOQ_SHEET = 'MOQ_Config';
var MOQ_HEADERS = ['Material', 'MaterialName', 'MaterialType', 'MOQ_Per_Pallet', 'Unit', 'MaxPalletQty', 'Remark'];

// Seed ตัวอย่าง — ปรับ MOQ จริงตามหน้างาน
var MOQ_SEED = [
  // PDSM (SEMI)
  ['STB7001', 'Semi Tube 700-1',    'SEMI', 200, 'PC',  240, 'PDSM seed'],
  ['STB7002', 'Semi Tube 700-2',    'SEMI', 200, 'PC',  240, 'PDSM seed'],
  ['STT1001', 'Semi Top 100-1',     'SEMI', 100, 'PC',  120, 'PDSM seed'],
  ['SCH1001', 'Semi Chassis 100-1', 'SEMI',  50, 'PC',   60, 'PDSM seed'],
  ['SST7001', 'Semi Seat 700-1',    'SEMI', 100, 'SET', 120, 'PDSM seed'],
  // PDFG (FG)
  ['FCH10011', 'FG Chair 1001-1',   'FG',    40, 'PC',   48, 'PDFG seed'],
  ['FTB10061', 'FG Table 1006-1',   'FG',    20, 'PC',   24, 'PDFG seed'],
  ['FHW20011', 'FG Hardware 2001-1','FG',   500, 'SET', 600, 'PDFG seed']
];

function setupMoqConfig() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(MOQ_SHEET) || ss.insertSheet(MOQ_SHEET);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, MOQ_HEADERS.length).setValues([MOQ_HEADERS])
      .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }

  var existing = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
      .forEach(function (r) { if (r[0]) existing[String(r[0]).trim()] = true; });
  }

  var toAdd = MOQ_SEED.filter(function (r) { return !existing[r[0]]; });
  if (toAdd.length) {
    sh.getRange(sh.getLastRow() + 1, 1, toAdd.length, MOQ_HEADERS.length).setValues(toAdd);
  }
  logEvent('MOQ_SETUP', 'OK', 'Seeded ' + toAdd.length + ' rows (skipped ' + (MOQ_SEED.length - toAdd.length) + ' existing)');
}

/** อ่าน MOQ_Config เป็น map: { Material: {moq, unit, maxQty, name, type} } */
function getMoqMap() {
  var sh = SpreadsheetApp.openById(CFG.SHEET_ID).getSheetByName(MOQ_SHEET);
  if (!sh || sh.getLastRow() < 2) return {};
  var map = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, MOQ_HEADERS.length).getValues().forEach(function (r) {
    var mat = String(r[0]).trim();
    if (!mat) return;
    map[mat] = {
      name: r[1], type: r[2],
      moq: Number(r[3]) || 0,
      unit: r[4],
      maxQty: Number(r[5]) || 0
    };
  });
  return map;
}

/**
 * MaterialMaster.gs — Phase 2.5
 * ==============================
 * จัดการ MaterialMaster sheet: sync จาก ProductionOrders + migrate จาก MOQ_Config
 *
 * PRESERVE RULE (critical): แถวที่มีอยู่แล้ว ห้ามแก้ไขค่าใด ๆ
 *   ยกเว้น Status: ถ้า Status ว่างและ MOQ_Per_Pallet มีค่า → set CONFIRMED
 */

const MM_SHEET = 'MaterialMaster';
const MM_HEADERS = [
  'Material', 'MaterialName', 'OrderType', 'ProductGroup', 'MOQ_Per_Pallet',
  'Unit', 'MaxPalletQty', 'Status', 'Remark'
];
// Column indices (1-based) for targeted updates
const MM_COL = { MAT:1, NAME:2, ORDER_TYPE:3, PROD_GROUP:4, MOQ:5, UNIT:6, MAX_QTY:7, STATUS:8, REMARK:9 };

// ============================================================================
// Sheet bootstrap
// ============================================================================

function ensureMaterialMasterSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(MM_SHEET);
  if (!sh) {
    sh = ss.insertSheet(MM_SHEET);
    sh.getRange(1, 1, 1, MM_HEADERS.length)
      .setValues([MM_HEADERS])
      .setFontWeight('bold')
      .setBackground('#1a4e8a')
      .setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 200);
  }
  return sh;
}

// ============================================================================
// Main sync
// ============================================================================

/**
 * Sync MaterialMaster from ProductionOrders.
 * Rules:
 *  1. NEVER modify existing rows (MOQ, ProductGroup, MaxPalletQty, Remark untouched)
 *  2. Insert materials not already present (Status=NEW, MOQ empty)
 *  3. Existing rows with MOQ>0 + blank Status → set Status=CONFIRMED
 *  4. Migrate from MOQ_Config once (skip duplicates, leave MOQ_Config in place)
 */
function syncMaterialMaster() {
  const t0 = Date.now();
  const ss = getSpreadsheet_();
  const sh = ensureMaterialMasterSheet_();

  // ---- Build PO material map -----------------------------------------------
  const poSheet = ss.getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  const poMaterialMap = {}; // { material: { orderType, unit } }
  if (poSheet && poSheet.getLastRow() > 1) {
    const data = poSheet.getDataRange().getValues();
    const hdr = data[0];
    const idx = {};
    hdr.forEach((h, i) => { idx[h] = i; });
    for (let r = 1; r < data.length; r++) {
      const mat = String(data[r][idx.Material] || '').trim();
      if (!mat || poMaterialMap[mat]) continue;
      poMaterialMap[mat] = {
        orderType: String(data[r][idx.ManufacturingOrderType] || '').trim(),
        unit:      String(data[r][idx.ProductionUnit] || '').trim()
      };
    }
  }

  // ---- Load existing MaterialMaster rows ------------------------------------
  const existingRows = {}; // { material: rowNum (1-based) }
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    const vals = sh.getRange(2, 1, lastRow - 1, MM_HEADERS.length).getValues();
    vals.forEach((row, i) => {
      const mat = String(row[0] || '').trim();
      if (mat) existingRows[mat] = i + 2;
    });
  }

  // ---- Step 1: Migrate from MOQ_Config (once, skip duplicates) --------------
  let migrated = 0;
  const moqSheet = ss.getSheetByName(CFG.SHEETS.MOQ_CONFIG);
  if (moqSheet && moqSheet.getLastRow() > 1) {
    const moqData = moqSheet.getRange(2, 1, moqSheet.getLastRow() - 1, 7).getValues();
    moqData.forEach(row => {
      const mat = String(row[0] || '').trim();
      if (!mat || existingRows[mat]) return;
      const moq = Number(row[3]) || 0;
      const poInfo = poMaterialMap[mat] || {};
      const mmRow = [
        mat,
        String(row[1] || '').trim(),
        poInfo.orderType || String(row[2] || '').trim(), // orderType from PO or MOQ_Config type
        '',
        moq,
        String(row[4] || '').trim() || poInfo.unit || '',
        Number(row[5]) || 0,
        moq > 0 ? 'CONFIRMED' : 'NEW',
        String(row[6] || '').trim()
      ];
      sh.appendRow(mmRow);
      existingRows[mat] = sh.getLastRow();
      migrated++;
    });
  }

  // ---- Step 2: Insert new materials from ProductionOrders -------------------
  let inserted = 0;
  const toInsert = [];
  Object.keys(poMaterialMap).forEach(mat => {
    if (existingRows[mat]) return;
    const po = poMaterialMap[mat];
    toInsert.push([mat, '', po.orderType, '', '', po.unit, '', 'NEW', '⚠️ ต้องแก้ไข MOQ']);
  });
  if (toInsert.length) {
    const startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, toInsert.length, MM_HEADERS.length).setValues(toInsert);
    // Add cell notes to Material column for new rows
    toInsert.forEach((_, i) => {
      sh.getRange(startRow + i, MM_COL.MAT).setNote('เพิ่มจาก sync — กรุณากำหนด MOQ');
      existingRows[toInsert[i][0]] = startRow + i;
    });
    inserted = toInsert.length;
  }

  // ---- Step 3: Update Status=CONFIRMED for rows with MOQ>0 + blank Status ---
  let confirmed = 0;
  const currentLastRow = sh.getLastRow();
  if (currentLastRow > 1) {
    const allVals = sh.getRange(2, 1, currentLastRow - 1, MM_HEADERS.length).getValues();
    allVals.forEach((row, i) => {
      const moq = Number(row[MM_COL.MOQ - 1]) || 0;
      const status = String(row[MM_COL.STATUS - 1] || '').trim();
      if (moq > 0 && status === '') {
        sh.getRange(i + 2, MM_COL.STATUS).setValue('CONFIRMED');
        confirmed++;
      }
    });
  }

  const summary = `migrated=${migrated} inserted=${inserted} confirmed=${confirmed} skipped=${Object.keys(existingRows).length - migrated - inserted}`;
  logEvent('MM_SYNC', '-', 'OK', Date.now() - t0, summary);
  SpreadsheetApp.getUi().alert(`✅ Sync MaterialMaster เสร็จ\n${summary}`);
}

// ============================================================================
// Read API
// ============================================================================

/**
 * Returns MOQ info for a single material — used by the print dialog for live preview.
 * Returns null when the material is not found, Status ≠ CONFIRMED, or MOQ = 0.
 * Also returns remainingQty (sum of unprinted qty across all open MOs) for warn logic.
 *
 * @param {string} material
 * @return {{moq, unit, name, status, remainingQty}|null}
 */
function getMoqForMaterial(material) {
  const sh = getSpreadsheet_().getSheetByName(MM_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, MM_HEADERS.length).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (String(row[0] || '').trim() !== material) continue;

    const moq    = Number(row[MM_COL.MOQ - 1]) || 0;
    const status = String(row[MM_COL.STATUS - 1] || '').trim();
    if (status !== 'CONFIRMED' || moq <= 0) return null;

    // Compute unprinted qty across open MOs for this material
    const poList    = getReleasedPoData_();
    const pmSummary = getExistingPmSummary_();
    let remainingQty = 0;
    poList.filter(po => po.Material === material).forEach(po => {
      const pmInfo = pmSummary[po.ManufacturingOrder] || { sumQty: 0 };
      const rem    = po.TotalQuantity - pmInfo.sumQty;
      if (rem > 0) remainingQty += rem;
    });

    return {
      moq:          moq,
      unit:         String(row[MM_COL.UNIT - 1] || '').trim(),
      name:         String(row[MM_COL.NAME - 1] || '').trim(),
      status:       status,
      remainingQty: remainingQty
    };
  }
  return null;
}

// ============================================================================
// MaterialName sync from SAP API_PRODUCT_SRV
// ============================================================================

/**
 * Fetch MaterialName (Thai/English) from SAP for every row with a blank name.
 * Batches 50 materials per request. Respects DRY_RUN gate.
 */
function syncMaterialNames() {
  const t0 = Date.now();
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(MM_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('MaterialMaster empty'); return; }

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, MM_HEADERS.length).getValues();
  const toFetch = [];
  data.forEach(function(row, i) {
    const mat  = String(row[MM_COL.MAT  - 1] || '').trim();
    const name = String(row[MM_COL.NAME - 1] || '').trim();
    if (mat && !name) toFetch.push({ rowNum: i + 2, material: mat });
  });
  Logger.log('Materials needing name: ' + toFetch.length);
  if (!toFetch.length) { Logger.log('All names already filled'); return; }

  const BATCH = 50;
  let filled = 0;
  for (let b = 0; b < toFetch.length; b += BATCH) {
    const batch  = toFetch.slice(b, b + BATCH);
    const filter = batch.map(x => "Material eq '" + x.material + "'").join(' or ');

    // Thai first, fallback English
    const names = fetchProductDescriptions_(filter, 'TH');
    if (Object.keys(names).length < batch.length) {
      const enNames = fetchProductDescriptions_(filter, 'EN');
      Object.keys(enNames).forEach(m => { if (!names[m]) names[m] = enNames[m]; });
    }

    batch.forEach(function(item) {
      const name = names[item.material] || '';
      if (!name) return;
      if (!CFG.DRY_RUN) {
        sh.getRange(item.rowNum, MM_COL.NAME).setValue(name);
        filled++;
      } else {
        Logger.log('[DRY] Would fill ' + item.material + ' = ' + name);
        filled++;
      }
    });
    Utilities.sleep(200);
  }

  const note = 'filled=' + filled + '/' + toFetch.length;
  Logger.log('syncMaterialNames: ' + note + ' DRY_RUN=' + CFG.DRY_RUN);
  logEvent('MM_NAMES_SYNC', '-', CFG.DRY_RUN ? 'DRY_RUN' : 'OK', Date.now() - t0, note);
  SpreadsheetApp.getUi().alert('✅ Sync Material Names\n' + note + (CFG.DRY_RUN ? '\n(DRY_RUN — ไม่ได้เขียนจริง)' : ''));
}

/**
 * Fetch material descriptions from SAP API_PRODUCT_SRV for a given $filter and language.
 * @param {string} filter — OData $filter fragment (Material eq '...' or ...)
 * @param {string} lang   — 'TH' or 'EN'
 * @return {Object} { 'MATCODE': 'description', ... }
 */
function fetchProductDescriptions_(filter, lang) {
  const path   = '/sap/opu/odata/sap/API_PRODUCT_SRV/A_ProductDescription';
  const result = {};
  try {
    const json  = sapGet(path, {
      '$filter': "Language eq '" + lang + "' and (" + filter + ')',
      '$select': 'Material,MaterialName'
    }, 'fetchProductDescriptions_[' + lang + ']');
    const items = (json.d && json.d.results) ? json.d.results : [];
    items.forEach(function(item) {
      if (item.MaterialName) result[item.Material] = item.MaterialName;
    });
  } catch (e) {
    Logger.log('fetchProductDescriptions_ [' + lang + '] error: ' + e.message);
  }
  return result;
}

// ============================================================================
// Read API
// ============================================================================

/**
 * Returns usable material map (only rows where MOQ_Per_Pallet > 0).
 * @return {Object} { 'MATCODE': { name, orderType, productGroup, moq, unit, maxQty, status } }
 */
function getMaterialMap() {
  const sh = getSpreadsheet_().getSheetByName(MM_SHEET);
  if (!sh || sh.getLastRow() < 2) return {};

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, MM_HEADERS.length).getValues();
  const map = {};
  data.forEach(row => {
    const mat = String(row[0] || '').trim();
    const moq = Number(row[4]) || 0;
    if (!mat || moq <= 0) return;
    map[mat] = {
      name:         String(row[1] || '').trim(),
      orderType:    String(row[2] || '').trim(),
      productGroup: String(row[3] || '').trim(),
      moq:          moq,
      unit:         String(row[5] || '').trim(),
      maxQty:       Number(row[6]) || 0,
      status:       String(row[7] || '').trim()
    };
  });
  return map;
}

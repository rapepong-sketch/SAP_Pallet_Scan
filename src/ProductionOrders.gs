/**
 * ProductionOrders.gs — pullProductionOrders()
 * =============================================
 * ดึง Production Orders จาก API_PRODUCTION_ORDERS_SRV (OData V2)
 *  - Server-side filter: Plant = CFG.PLANT (+ PlannedStartDate ย้อนหลัง PULL_DAYS_BACK วัน)
 *  - Client-side filter: เฉพาะ order ที่ Released (system status I0002 / "REL")
 *    เหตุผล: header ของ A_ProductionOrder ไม่มี status field ให้ $filter ตรง ๆ
 *  - $expand: to_ProductionOrderOperation, to_ProductionOrderItem, to_ProductionOrderStatus
 *    หมายเหตุ: service นี้เป็น OData V2 — nested select แบบ to_X($select=...) เป็น V4 syntax
 *    จึงใช้รูปแบบ V2 ที่ถูกต้อง: $select=to_X/Field (ได้ field ชุดเดียวกัน)
 *  - Idempotent: key = ProductionOrder → มีอยู่แล้ว update, ไม่มี insert
 *  - DRY_RUN: log จำนวน + ตัวอย่าง 3 รายการลง console, ไม่เขียน sheet
 */

const PO_SELECT_ = [
  // Header — verified field names from A_ProductionOrder_2 EDMX (81 properties)
  'ManufacturingOrder', 'Material', 'ManufacturingOrderType',
  'TotalQuantity', 'ProductionUnit',
  'MfgOrderPlannedStartDate', 'Plant', 'StorageLocation',
  'MfgOrderConfirmedYieldQty', 'OrderIsReleased',
  // Navigation (OData V2 style: entitySet/field)
  'to_ProductionOrderOperation/WorkCenter',
  'to_ProductionOrderOperation/ManufacturingOrderOperation',
  'to_ProductionOrderOperation/MfgOrderOperationText',
  'to_ProductionOrderItem/Batch',
  'to_ProductionOrderItem/MfgOrderItemPlannedTotalQty',
  'to_ProductionOrderItem/StorageLocation',
  'to_ProductionOrderStatus/StatusCode',
  'to_ProductionOrderStatus/StatusShortName'
];

/**
 * MAIN — Test Gate ข้อ 3-4
 * @return {number} จำนวน released orders ที่ประมวลผล
 */
function pullProductionOrders() {
  const fn = 'pullProductionOrders';
  const endpoint = CFG.ENDPOINTS.PRODUCTION_ORDERS;
  const t0 = Date.now();

  try {
    const filterStr = buildPoFilter_();
    console.log('[DEBUG] $filter = ' + filterStr);
    console.log('[DEBUG] PULL_DAYS_BACK = ' + CFG.PULL_DAYS_BACK);
    console.log('[DEBUG] ORDER_TYPES = ' + JSON.stringify(CFG.ORDER_TYPES));

    const params = {
      '$filter': filterStr,
      '$orderby': 'MfgOrderPlannedStartDate desc',
      '$expand': 'to_ProductionOrderOperation,to_ProductionOrderItem,to_ProductionOrderStatus',
      '$select': PO_SELECT_.join(',')
    };

    const raw = sapGetAllResults(endpoint, params, fn);
    console.log('[DEBUG] raw fetched = ' + raw.length);
    if (raw.length > 0) {
      const s = raw[0];
      console.log('[DEBUG] first order = ' + s.ManufacturingOrder +
        ' | type=' + s.ManufacturingOrderType +
        ' | startDate=' + s.MfgOrderPlannedStartDate);
    }
    const released = raw.filter(isReleasedOrder_);
    const rows = released.map(mapPoToRow_);

    if (CFG.DRY_RUN) {
      logEvent(fn, endpoint, 'DRY_RUN', Date.now() - t0,
        'fetched=' + raw.length + ' released=' + released.length + ' — sheet NOT written');
      console.log('[DRY_RUN] fetched=' + raw.length + ', released=' + released.length);
      // Show date range of fetched orders
      const dates = raw.map(function(r){ return r.MfgOrderPlannedStartDate || ''; })
                       .filter(Boolean).sort();
      if (dates.length) console.log('[DRY_RUN] date range: ' + dates[0] + ' ~ ' + dates[dates.length-1]);
      // Show order number range
      const orders = raw.map(function(r){ return r.ManufacturingOrder || ''; }).sort();
      if (orders.length) console.log('[DRY_RUN] order range: ' + orders[0] + ' ~ ' + orders[orders.length-1]);
      console.log('[DRY_RUN] sample rows:\n' + JSON.stringify(rows.slice(0, 3), null, 2));
      return released.length;
    }

    const stats = upsertProductionOrders_(rows);
    logEvent(fn, endpoint, 'OK', Date.now() - t0,
      'fetched=' + raw.length + ' released=' + released.length +
      ' inserted=' + stats.inserted + ' updated=' + stats.updated);
    console.log('Done: inserted=' + stats.inserted + ', updated=' + stats.updated);
    return released.length;

  } catch (e) {
    logError(fn, endpoint, e.message, '');
    throw e; // โยนต่อให้เห็นใน Script Editor — อย่ากลืน error
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Plant filter + optional date window + order type filter (OData V2 datetime literal) */
function buildPoFilter_() {
  let f = "Plant eq '" + CFG.PLANT + "'";

  // Date window — must cover 2026 orders (Basic start date 2026-01 to 2026-11)
  if (CFG.PULL_DAYS_BACK > 0) {
    const since = new Date(Date.now() - CFG.PULL_DAYS_BACK * 24 * 3600 * 1000);
    const lit = Utilities.formatDate(since, 'UTC', "yyyy-MM-dd'T'00:00:00");
    f += " and MfgOrderPlannedStartDate ge datetime'" + lit + "'";
  }

  // Order type filter — include PDFG (Finished Goods) + PDSM (Semi-finished)
  const types = CFG.ORDER_TYPES || [];
  if (types.length === 1) {
    f += " and ManufacturingOrderType eq '" + types[0] + "'";
  } else if (types.length > 1) {
    const typeParts = types.map(function(t) {
      return "ManufacturingOrderType eq '" + t + "'";
    });
    f += " and (" + typeParts.join(' or ') + ")";
  }

  return f;
}

/**
 * Open/Active order filter — ตรงกับ SAP export filter "Status = REL"
 *
 * SAP Status lifecycle: CRTD → REL → (PCNF) → CNF → DLV → TECO
 * Export กรอง "REL" = order ที่ Released แล้วแต่ยังไม่ปิด
 * วิเคราะห์จากข้อมูลจริง:
 *   Open order  = มี I0002(REL) + ไม่มี I0009(CNF), I0012(DLV), I0045(TECO)
 *   Closed order = มี CNF หรือ DLV หรือ TECO (production เสร็จแล้ว)
 *   Deleted order = มี I0043(DLFL)
 *
 * ผล: ~554 open PDFG orders ≈ 594 ใน SAP export ✅
 */
function isReleasedOrder_(po) {
  const sts = (po.to_ProductionOrderStatus && po.to_ProductionOrderStatus.results) || [];

  // ถ้าไม่มี status expand — reject (กัน garbage data เข้า sheet)
  if (sts.length === 0) return false;

  const codes = {};
  sts.forEach(function(s) { if (s.StatusCode) codes[s.StatusCode] = true; });

  // ตัดทิ้ง: ยังไม่ Release หรือถูก flag ลบ
  if (!codes['I0002']) return false;          // ยังไม่ REL
  if (codes['I0043']) return false;           // DLFL — marked for deletion

  // ตัดทิ้ง: เสร็จแล้ว (CNF, DLV, TECO)
  if (codes['I0009']) return false;           // CNF — confirmed
  if (codes['I0012']) return false;           // DLV — delivered
  if (codes['I0045']) return false;           // TECO — technically completed

  // ผ่าน: REL แต่ยังไม่ CNF/DLV/TECO = open order ที่ต้องการ
  return true;
}

/** Flatten 1 PO (header + expands) → 1 row ตาม CFG.HEADERS.PRODUCTION_ORDERS */
function mapPoToRow_(po) {
  const ops = (po.to_ProductionOrderOperation && po.to_ProductionOrderOperation.results) || [];
  const items = (po.to_ProductionOrderItem && po.to_ProductionOrderItem.results) || [];
  const sts = (po.to_ProductionOrderStatus && po.to_ProductionOrderStatus.results) || [];

  // Work centers: unique, เรียงตาม operation
  const wcSeen = {};
  const workCenters = [];
  ops.forEach(function (op) {
    if (op.WorkCenter && !wcSeen[op.WorkCenter]) {
      wcSeen[op.WorkCenter] = true;
      workCenters.push(op.WorkCenter);
    }
  });

  const operations = ops.map(function (op) {
    return op.ManufacturingOrderOperation + ':' + (op.WorkCenter || '-') +
      (op.MfgOrderOperationText ? '|' + op.MfgOrderOperationText : '');
  }).join('; ');

  // Batch: เอาตัวแรกที่มีค่า (FG header item) — ถ้าหลาย batch รวมเป็น list
  const batches = [];
  items.forEach(function (it) {
    if (it.Batch && batches.indexOf(it.Batch) === -1) batches.push(it.Batch);
  });

  const statusCodes = sts.map(function (s) {
    return s.StatusCode + (s.StatusName ? '(' + s.StatusName + ')' : '');
  }).join('; ');

  return [
    String(po.ManufacturingOrder || ''),
    po.Material || '',
    po.ManufacturingOrderType || '',
    Number(po.TotalQuantity || 0),
    po.ProductionUnit || '',
    parseSapDate_(po.MfgOrderPlannedStartDate),
    po.Plant || '',
    po.StorageLocation || '',
    Number(po.MfgOrderConfirmedYieldQty || 0),
    batches.join('; '),
    workCenters.join('; '),
    operations,
    statusCodes,
    true,        // IsReleased — ผ่าน filter แล้ว
    new Date()   // LastSyncAt
  ];
}

/**
 * Idempotent upsert ลง ProductionOrders sheet
 * key = column A (ProductionOrder): มีแล้ว → overwrite ทั้ง row, ไม่มี → append
 */
function upsertProductionOrders_(rows) {
  const sh = getSheet_(CFG.SHEETS.PRODUCTION_ORDERS);
  const width = CFG.HEADERS.PRODUCTION_ORDERS.length;

  // index ของ key ที่มีอยู่: ManufacturingOrder → row number (1-based)
  const existing = {};
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    const keys = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    keys.forEach(function (r, i) {
      const k = String(r[0]).trim();
      if (k) existing[k] = i + 2;
    });
  }

  const toAppend = [];
  let updated = 0;

  rows.forEach(function (row) {
    const key = String(row[0]);
    if (existing[key]) {
      sh.getRange(existing[key], 1, 1, width).setValues([row]);
      updated++;
    } else {
      toAppend.push(row);
      existing[key] = -1; // กัน duplicate ภายใน batch เดียวกัน
    }
  });

  if (toAppend.length > 0) {
    sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, width).setValues(toAppend);
  }
  return { inserted: toAppend.length, updated: updated };
}

/**
 * ล้าง old PDSM series (1000000xxx, StartDate 2025) ออกจาก ProductionOrders sheet
 * รัน 1 ครั้งหลัง pullProductionOrders() ครั้งแรกสำเร็จ
 * เงื่อนไขลบ: ManufacturingOrder ขึ้นต้น "1000000" หรือ StartDate ปี 2025
 */
function clearOldOrders() {
  const sh = getSheet_(CFG.SHEETS.PRODUCTION_ORDERS);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) { console.log('clearOldOrders: sheet empty'); return; }

  const data = sh.getRange(2, 1, lastRow - 1, 6).getValues(); // col A=Order, col F=StartDate
  const toDelete = [];

  data.forEach(function(row, i) {
    const orderStr = String(row[0] || '');
    const startDate = row[5]; // MfgOrderPlannedStartDate = col F (index 5)
    const isOldSeries = orderStr.startsWith('1000000') && orderStr.length <= 13;
    const isYear2025 = startDate instanceof Date && startDate.getFullYear() === 2025;
    if (isOldSeries || isYear2025) toDelete.push(i + 2); // 1-based row number
  });

  console.log('clearOldOrders: found ' + toDelete.length + ' old rows to delete');
  if (CFG.DRY_RUN) {
    logEvent('clearOldOrders', '-', 'DRY_RUN', 0, 'would delete ' + toDelete.length + ' old rows');
    return;
  }

  // ลบจากล่างขึ้นบน (กัน row index เลื่อน)
  for (let i = toDelete.length - 1; i >= 0; i--) {
    sh.deleteRow(toDelete[i]);
  }
  logEvent('clearOldOrders', '-', 'OK', 0, 'deleted ' + toDelete.length + ' old rows (2025/1000000xxx series)');
  console.log('clearOldOrders: deleted ' + toDelete.length + ' rows');
}

/**
 * Debug — ดู StatusCode จริงจาก to_ProductionOrderStatus expand
 * รัน 1 ครั้ง แล้วลบทิ้ง
 */
function debugOrderStatus() {
  const params = {
    '$top': '5',
    '$filter': "Plant eq '" + CFG.PLANT + "'",
    '$expand': 'to_ProductionOrderStatus',
    '$select': [
      'ManufacturingOrder',
      'Material',
      'OrderIsReleased',
      'to_ProductionOrderStatus/StatusCode',
      'to_ProductionOrderStatus/StatusShortName'
    ].join(',')
  };
  const data = sapGet(CFG.ENDPOINTS.PRODUCTION_ORDERS, params, 'debugOrderStatus');
  const results = (data.d || {}).results || [];
  console.log('Returned: ' + results.length + ' orders');
  results.forEach(function(r) {
    const sts = (r.to_ProductionOrderStatus && r.to_ProductionOrderStatus.results) || [];
    const stsList = sts.map(function(s) {
      return '[' + s.StatusCode + '|' + s.StatusShortName + ']';
    }).join(' ');
    console.log(
      'PO=' + r.ManufacturingOrder +
      ' | OrderIsReleased="' + r.OrderIsReleased + '"' +
      ' | Statuses=' + (stsList || '(empty)')
    );
  });
}

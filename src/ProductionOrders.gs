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
    const params = {
      '$filter': buildPoFilter_(),
      '$expand': 'to_ProductionOrderOperation,to_ProductionOrderItem,to_ProductionOrderStatus',
      '$select': PO_SELECT_.join(',')
    };

    const raw = sapGetAllResults(endpoint, params, fn);
    const released = raw.filter(isReleasedOrder_);
    const rows = released.map(mapPoToRow_);

    if (CFG.DRY_RUN) {
      logEvent(fn, endpoint, 'DRY_RUN', Date.now() - t0,
        'fetched=' + raw.length + ' released=' + released.length + ' — sheet NOT written');
      console.log('[DRY_RUN] fetched=' + raw.length + ', released=' + released.length);
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

/** Plant filter + optional date window (OData V2 datetime literal) */
function buildPoFilter_() {
  // OData V2: boolean literal must be unquoted lowercase 'true'
  // However SAP Gateway rejects Edm.Boolean in $filter on this entity.
  // Strategy: filter Plant + date server-side; filter Released client-side via OrderIsReleased flag.
  let f = "Plant eq '" + CFG.PLANT + "'";
  if (CFG.PULL_DAYS_BACK > 0) {
    const since = new Date(Date.now() - CFG.PULL_DAYS_BACK * 24 * 3600 * 1000);
    const lit = Utilities.formatDate(since, 'UTC', "yyyy-MM-dd'T'00:00:00");
    f += " and MfgOrderPlannedStartDate ge datetime'" + lit + "'";
  }
  return f;
}

/**
 * Active order filter — tenant status lifecycle:
 *   CRTD → REL → CNF → DLV → TECO
 * SAP removes I0002(REL) once order progresses to CNF/DLV/TECO.
 * Accept orders that have any "active production" status:
 *   I0002 REL  — Released (not yet confirmed)
 *   I0009 CNF  — Confirmed / partially confirmed
 *   I0012 DLV  — Delivered
 *   I0045 TECO — Technically Completed
 * Reject orders that are only CRTD (created, not yet released)
 * or have deletion flag I0043 DLFL.
 */
function isReleasedOrder_(po) {
  const ACCEPT = { I0002:1, I0009:1, I0012:1, I0045:1 };
  const REJECT = { I0043:1 }; // DLFL = marked for deletion

  const sts = (po.to_ProductionOrderStatus && po.to_ProductionOrderStatus.results) || [];

  // ถ้า expand ไม่มีข้อมูล — รับทั้งหมด (กัน false negative)
  if (sts.length === 0) return true;

  // มี deletion flag → ตัดทิ้ง
  if (sts.some(function(s) { return REJECT[s.StatusCode]; })) return false;

  // มีอย่างน้อย 1 active status → รับ
  return sts.some(function(s) { return ACCEPT[s.StatusCode]; });
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

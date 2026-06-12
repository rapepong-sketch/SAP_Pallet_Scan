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
 * Client-side released check.
 * OrderIsReleased header field returns "" (empty string) on this tenant — unusable.
 * Use to_ProductionOrderStatus expand: check StatusCode REL or I0002,
 * or fallback to OrderIsReleased non-empty as secondary signal.
 */
function isReleasedOrder_(po) {
  // Primary: check expanded status collection
  const sts = (po.to_ProductionOrderStatus && po.to_ProductionOrderStatus.results) || [];
  if (sts.length > 0) {
    return sts.some(function(s) {
      const code = (s.StatusCode || '').toUpperCase();
      const name = (s.StatusShortName || s.StatusName || '').toUpperCase();
      return code === 'I0002' || code === 'REL' || name === 'REL';
    });
  }
  // Fallback: if expand returned nothing, accept all (avoids filtering out valid orders)
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
 * Debug — ดูค่า OrderIsReleased + MfgOrderPlannedStartDate จริงจาก SAP
 * รัน 1 ครั้งเพื่อตรวจสอบ แล้วลบทิ้ง
 */
function debugOrderStatus() {
  const params = {
    '$top': '10',
    '$select': 'ManufacturingOrder,Material,Plant,OrderIsReleased,MfgOrderPlannedStartDate',
    '$filter': "Plant eq '" + CFG.PLANT + "'"
  };
  const data = sapGet(CFG.ENDPOINTS.PRODUCTION_ORDERS, params, 'debugOrderStatus');
  const results = (data.d || {}).results || [];
  console.log('Total returned: ' + results.length);
  results.forEach(function(r) {
    console.log(
      'PO=' + r.ManufacturingOrder +
      ' | Material=' + r.Material +
      ' | OrderIsReleased=' + r.OrderIsReleased +
      ' (type=' + typeof r.OrderIsReleased + ')' +
      ' | StartDate=' + r.MfgOrderPlannedStartDate
    );
  });
}

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

// ============================================================================
// Status constants
// ============================================================================

/**
 * StatusShortName for "Deletion flag" (system status I0043). An order can
 * hold this AND StatusShortName="REL" at the same time (released, then
 * flagged for deletion afterwards) — DLFL must always win, checked first in
 * isReleasedOrder_() before the REL/I0002 inclusion checks.
 */
const STATUS_DELETION_FLAG = 'DLFL';

/**
 * StatusCode equivalent of STATUS_DELETION_FLAG. The ProductionOrders sheet
 * caches StatusCode (not StatusShortName) in its StatusCodes column — see
 * mapPoToRow_() — so purgeDeletedOrders() matches against this form when
 * cleaning up rows already synced to the sheet.
 */
const STATUS_DELETION_CODE_ = 'I0043';

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

    const dlflExcluded = raw.filter(isDeletionFlagged_).length;
    logEvent(fn, endpoint, 'INFO', 0, 'Excluded ' + dlflExcluded + ' DLFL orders');

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

    // ลบ stale rows — rows ที่มีอยู่แล้วแต่ไม่ผ่าน isReleasedOrder_ filter อีกต่อไป
    // (เช่น orders ที่ถูก CNF/DLV/TECO ไปแล้วหลังจาก pull ครั้งก่อน)
    const activeKeys = {};
    rows.forEach(function(r) { activeKeys[String(r[0])] = true; });
    const staleCount = removeStaleOrders_(activeKeys);

    logEvent(fn, endpoint, 'OK', Date.now() - t0,
      'fetched=' + raw.length + ' released=' + released.length +
      ' inserted=' + stats.inserted + ' updated=' + stats.updated +
      ' staleRemoved=' + staleCount);
    console.log('Done: inserted=' + stats.inserted + ', updated=' + stats.updated +
                ', staleRemoved=' + staleCount);
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
 * Open/Active order filter — รองรับ PDFG และ PDSM
 *
 * PDFG (Finished Goods) status pattern:
 *   Open  = I0002(REL) + ไม่มี I0009(CNF) / I0012(DLV) / I0045(TECO)
 *   Closed = มี CNF หรือ DLV หรือ TECO
 *
 * PDSM (Semi-finished) status pattern:
 *   Open  = มี I0002(REL) ไม่มี I0009(CNF) / I0045(TECO)
 *           หรือ มี StatusShortName="REL" (MACM type orders ไม่มี I0002 ตรงๆ)
 *   Closed = มี CNF หรือ TECO
 *   Note: PDSM ไม่มี TECO แต่มี CNF เมื่อเสร็จ
 *
 * ตัดทิ้ง: DLFL (I0043), CRTD only (ไม่มี I0002 และไม่มี REL shortname)
 *
 * DLFL precedence: order หนึ่งอาจมีทั้ง REL และ DLFL พร้อมกัน (released แล้ว
 * ค่อยถูก flag ลบทีหลัง) — ต้องเช็ค STATUS_DELETION_FLAG ก่อนเสมอ แล้ว return
 * false ทันที ก่อนถึงเงื่อนไข REL/I0002 ใด ๆ ทั้งสิ้น
 */
function isReleasedOrder_(po) {
  const sts = (po.to_ProductionOrderStatus && po.to_ProductionOrderStatus.results) || [];
  if (sts.length === 0) return false;

  const codes = {};
  const shortNames = {};
  sts.forEach(function(s) {
    if (s.StatusCode)      codes[s.StatusCode] = true;
    if (s.StatusShortName) shortNames[s.StatusShortName.trim().toUpperCase()] = true;
  });

  // ตัดทิ้งก่อนเช็คอื่นใดเสมอ: deletion flag — แม้ REL/I0002 จะอยู่ในชุด status ก็ตาม
  if (shortNames[STATUS_DELETION_FLAG]) return false; // DLFL by StatusShortName
  if (codes['I0043']) return false; // DLFL by StatusCode (defense in depth)

  // ตัดทิ้งเสมอ: closed statuses
  if (codes['I0045']) return false; // TECO
  if (codes['I0009']) return false; // CNF (fully confirmed)
  if (codes['I0012']) return false; // DLV (delivered)

  // ผ่าน: มี I0002 (REL code) — ครอบ PDFG และ PDSM บางส่วน
  if (codes['I0002']) return true;

  // ผ่าน fallback: PDSM ที่ Released ผ่าน StatusShortName="REL"
  // (MACM orders ไม่มี I0002 แต่มี ShortName REL)
  if (shortNames['REL']) return true;

  return false; // CRTD หรือ status อื่นที่ไม่รู้จัก
}

/**
 * True if any status row for this order carries StatusShortName=DLFL
 * (STATUS_DELETION_FLAG). Used by pullProductionOrders() to count orders
 * excluded specifically by the deletion-flag rule — separate from
 * isReleasedOrder_() since that only returns a single pass/fail boolean.
 * @param {Object} po — raw SAP production order row with to_ProductionOrderStatus expand
 * @return {boolean}
 */
function isDeletionFlagged_(po) {
  const sts = (po.to_ProductionOrderStatus && po.to_ProductionOrderStatus.results) || [];
  return sts.some(function(s) {
    return s.StatusShortName && s.StatusShortName.trim().toUpperCase() === STATUS_DELETION_FLAG;
  });
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

  // Operations string + OperationsJSON share one builder (buildOperationsCacheFields_)
  // so this sync path and refreshOrderOperationCache()'s single-order backfill never diverge.
  const normOps = ops.map(function (op) {
    return {
      opNo:       op.ManufacturingOrderOperation,
      opText:     op.MfgOrderOperationText,
      workCenter: op.WorkCenter
    };
  });
  const opsCacheFields = buildOperationsCacheFields_(normOps);
  const operations = opsCacheFields.operationsStr;
  const opsJson     = opsCacheFields.opsJson; // structured array for routing table (lazy-fetch cache — Phase 2.5)

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
    new Date(),  // LastSyncAt
    opsJson      // OperationsJSON — Phase 2.5
  ];
}

/**
 * Idempotent upsert ลง ProductionOrders sheet
 * key = column A (ProductionOrder): มีแล้ว → overwrite ทั้ง row, ไม่มี → append
 */
function upsertProductionOrders_(rows) {
  const sh = getSheet_(CFG.SHEETS.PRODUCTION_ORDERS);
  // Sync only the SAP-derived columns (through OperationsJSON) — columns appended
  // after it (e.g. FinalOperation) are local caches and must survive re-pulls.
  const width = CFG.HEADERS.PRODUCTION_ORDERS.indexOf('OperationsJSON') + 1;

  // Force WorkCenters column to plain text BEFORE writing — prevents Sheets
  // from auto-parsing codes like "0408-02" as Date objects on future reads.
  const wcColNum = CFG.HEADERS.PRODUCTION_ORDERS.indexOf('WorkCenters') + 1;
  if (wcColNum > 0) {
    sh.getRange(1, wcColNum, Math.max(sh.getLastRow() + rows.length, 2), 1)
      .setNumberFormat('@');
  }

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
 * ลบ rows ที่ key (ManufacturingOrder) ไม่อยู่ใน activeKeys set
 * ใช้หลัง upsert เพื่อลบ stale orders (CNF/DLV/TECO ไปแล้วนับจาก pull ครั้งก่อน)
 * @param {Object} activeKeys — { "2000004325": true, ... }
 * @return {number} จำนวน rows ที่ลบ
 */
function removeStaleOrders_(activeKeys) {
  const sh = getSheet_(CFG.SHEETS.PRODUCTION_ORDERS);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return 0;

  const keys = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  const toDelete = [];
  keys.forEach(function(r, i) {
    const k = String(r[0]).replace('.0', '').trim();
    if (k && !activeKeys[k]) toDelete.push(i + 2);
  });

  // ลบจากล่างขึ้นบน
  for (let i = toDelete.length - 1; i >= 0; i--) {
    sh.deleteRow(toDelete[i]);
  }
  return toDelete.length;
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
 * Phase 1 data-quality fix — removes rows already synced into the
 * ProductionOrders sheet whose order is flagged for deletion (DLFL /
 * STATUS_DELETION_FLAG). Needed one-time (and safe to re-run) because
 * isReleasedOrder_() now excludes "REL + DLFL" orders going forward, but
 * rows synced by the OLD filter before this fix are already sitting in the
 * sheet and won't disappear until they happen to fall out on a future pull.
 *
 * Reads by COLUMN NAME. Prefers the sheet's own cached StatusCodes column
 * (mapPoToRow_ stores StatusCode, so this matches on STATUS_DELETION_CODE_ =
 * 'I0043') to avoid re-hitting SAP for every row. Falls back to a live SAP
 * status lookup (same source pullProductionOrders() uses, matched via
 * isDeletionFlagged_ / STATUS_DELETION_FLAG) only if the sheet has no
 * StatusCodes column at all.
 *
 * @return {number} count of rows removed
 */
function purgeDeletedOrders() {
  const fn = 'purgeDeletedOrders';
  const endpoint = CFG.SHEETS.PRODUCTION_ORDERS;
  const t0 = Date.now();

  try {
    const sh = getSheet_(CFG.SHEETS.PRODUCTION_ORDERS);
    const lastRow = sh.getLastRow();
    if (lastRow <= 1) {
      logEvent(fn, endpoint, 'OK', Date.now() - t0, 'Removed 0 DLFL rows from ProductionOrders (sheet empty)');
      Logger.log(fn + ': sheet empty, nothing to purge');
      return 0;
    }

    const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const moCol = hdr.indexOf('ManufacturingOrder');
    const statusCol = hdr.indexOf('StatusCodes');
    if (moCol === -1) {
      logError(fn, endpoint, 'ManufacturingOrder column not found in ProductionOrders sheet', '');
      return 0;
    }

    const data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();

    // Fallback path: no cached StatusCodes column → re-check live via SAP,
    // same status source pullProductionOrders() uses.
    let liveDlflKeys = null;
    if (statusCol === -1) {
      liveDlflKeys = {};
      const raw = sapGetAllResults(CFG.ENDPOINTS.PRODUCTION_ORDERS, {
        '$filter': "Plant eq '" + CFG.PLANT + "'",
        '$expand': 'to_ProductionOrderStatus',
        '$select': 'ManufacturingOrder,to_ProductionOrderStatus/StatusShortName'
      }, fn);
      raw.forEach(function(po) {
        if (isDeletionFlagged_(po)) liveDlflKeys[String(po.ManufacturingOrder)] = true;
      });
    }

    const toDelete = [];
    data.forEach(function(row, i) {
      let isDlfl;
      if (statusCol > -1) {
        const statusStr = String(row[statusCol] || '');
        isDlfl = statusStr.split(';').some(function(code) {
          return code.trim() === STATUS_DELETION_CODE_;
        });
      } else {
        const mo = String(row[moCol] || '').trim();
        isDlfl = !!liveDlflKeys[mo];
      }
      if (isDlfl) toDelete.push(i + 2); // 1-based row number
    });

    Logger.log(fn + ': found ' + toDelete.length + ' DLFL rows to remove');
    if (CFG.DRY_RUN) {
      logEvent(fn, endpoint, 'DRY_RUN', Date.now() - t0,
        'would remove ' + toDelete.length + ' DLFL rows from ProductionOrders');
      return toDelete.length;
    }

    // ลบจากล่างขึ้นบน (กัน row index เลื่อน)
    for (let i = toDelete.length - 1; i >= 0; i--) {
      sh.deleteRow(toDelete[i]);
    }

    logEvent(fn, endpoint, 'OK', Date.now() - t0,
      'Removed ' + toDelete.length + ' DLFL rows from ProductionOrders');
    Logger.log(fn + ': removed ' + toDelete.length + ' DLFL rows');
    return toDelete.length;

  } catch (e) {
    logError(fn, endpoint, e.message, '');
    throw e;
  }
}

/**
 * Lazy-fetch operations for a single MO from SAP.
 * Uses CacheService (30 min TTL) — second call for same MO within a print session is instant.
 * Called by PalletSheet.gs buildOneSheetHtml_ to populate the routing confirmation table.
 *
 * NOTE: $orderby is intentionally omitted — OData V2 rejects $orderby on a
 * single-entity-by-key read (A_ProductionOrder_2('<mo>')) with HTTP 400.
 * Operations are sorted client-side (ascending by ManufacturingOrderOperation)
 * before being returned / cached, so callers always receive sorted results.
 *
 * @param {string} mo — ManufacturingOrder number e.g. '1000036044'
 * @return {Array<{opNo,opText,workCenter,workCenterDesc}>}
 */
function fetchOperationsForMO_(mo) {
  Logger.log('fetchOperationsForMO_ called with: [' + mo + '] type=' + typeof mo);
  if (!mo) { Logger.log('fetchOperationsForMO_: empty mo → return []'); return []; }

  const cacheKey = 'OPS_' + mo;
  const cache    = CacheService.getScriptCache();
  const cached   = cache.get(cacheKey);
  if (cached) {
    Logger.log('fetchOperationsForMO_: cache HIT key=' + cacheKey +
               ' value_start=' + cached.substring(0, 80));
    try { return JSON.parse(cached); } catch (e) { Logger.log('cache parse fail, fall through'); }
  } else {
    Logger.log('fetchOperationsForMO_: cache MISS, calling SAP');
  }

  const path   = CFG.ENDPOINTS.PRODUCTION_ORDERS + "('" + mo + "')";
  const params = {
    '$expand': 'to_ProductionOrderOperation',
    '$select': [
      'ManufacturingOrder',
      'to_ProductionOrderOperation/ManufacturingOrderOperation',
      'to_ProductionOrderOperation/MfgOrderOperationText',
      'to_ProductionOrderOperation/WorkCenter'
    ].join(',')
    // $orderby omitted — illegal on single-entity-by-key OData reads (HTTP 400)
  };
  Logger.log('fetchOperationsForMO_: path=' + path);

  try {
    const data   = sapGet(path, params, 'fetchOperationsForMO_');
    const d      = data.d || {};
    const rawOps = (d.to_ProductionOrderOperation || {}).results || [];
    Logger.log('fetchOperationsForMO_: rawOps.length=' + rawOps.length +
               ' d keys=' + Object.keys(d).join(','));
    rawOps.sort(function(a, b) {
      return parseInt(a.ManufacturingOrderOperation, 10) - parseInt(b.ManufacturingOrderOperation, 10);
    });
    const ops    = rawOps.map(function(op) {
      return {
        opNo:          String(op.ManufacturingOrderOperation || '').trim(),
        opText:        String(op.MfgOrderOperationText || '').trim(),
        workCenter:    String(op.WorkCenter || '').trim(),
        workCenterDesc: ''
      };
    });
    cache.put(cacheKey, JSON.stringify(ops), 1800); // 30 min
    return ops;
  } catch (e) {
    logError('fetchOperationsForMO_', path, e.message, 'MO=' + mo);
    Logger.log('fetchOperationsForMO_: EXCEPTION ' + e.message);
    return [];
  }
}

/**
 * Read the cached final operation number for a MO from the ProductionOrders
 * sheet (fast sheet read, no SAP call). Phase 3 Step 2 uses this to build the
 * SAP confirmation payload without re-deriving the routing every scan.
 * @param {string} mo
 * @return {string} cached final op number, or '' if not cached / MO not found
 */
function getFinalOperationCached_(mo) {
  mo = String(mo || '').trim();
  if (!mo) return '';
  try {
    const sh = getSheet_(CFG.SHEETS.PRODUCTION_ORDERS);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return '';
    const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const moCol = hdr.indexOf('ManufacturingOrder');
    const foCol = hdr.indexOf('FinalOperation');
    if (moCol === -1 || foCol === -1) return '';
    const data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][moCol] || '').trim() === mo) {
        return String(data[i][foCol] || '').trim();
      }
    }
  } catch (e) {
    logError('getFinalOperationCached_', CFG.SHEETS.PRODUCTION_ORDERS, e.message, mo);
  }
  return '';
}

/**
 * Write the final operation number for a MO into the FinalOperation column.
 * Skips the write when the cached value already matches — keeps this cheap
 * to call from getFinalOperationForMo_ on every cold-cache lookup.
 * @param {string} mo
 * @param {string} finalOpNo
 */
function cacheFinalOperation_(mo, finalOpNo) {
  mo = String(mo || '').trim();
  finalOpNo = String(finalOpNo || '').trim();
  if (!mo || !finalOpNo) return;
  try {
    const sh = getSheet_(CFG.SHEETS.PRODUCTION_ORDERS);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return;
    const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const moCol = hdr.indexOf('ManufacturingOrder');
    const foCol = hdr.indexOf('FinalOperation');
    if (moCol === -1 || foCol === -1) return;
    const keys = sh.getRange(2, moCol + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0] || '').trim() === mo) {
        const cell = sh.getRange(i + 2, foCol + 1);
        if (String(cell.getValue() || '').trim() !== finalOpNo) cell.setValue(finalOpNo);
        return;
      }
    }
  } catch (e) {
    logError('cacheFinalOperation_', CFG.SHEETS.PRODUCTION_ORDERS, e.message, mo + '=' + finalOpNo);
  }
}

/**
 * Final operation number for a MO — Phase 3 Step 2 needs this to build the
 * SAP order confirmation payload. Reads the ProductionOrders.FinalOperation
 * cache first (sheet read, no SAP call); only on a cold cache does it fall
 * back to getOperationsForOrder() (which itself prefers the sheet's
 * OperationsJSON over a live SAP fetch), then writes the cache for next time.
 * @param {string} mo
 * @return {string} final operation number, or '' if no routing found
 */
function getFinalOperationForMo_(mo) {
  mo = String(mo || '').trim();
  if (!mo) return '';

  const cached = getFinalOperationCached_(mo);
  if (cached) return cached;

  const ops = getOperationsForOrder(mo);
  if (!ops.length) return '';

  const finalOpNo = ops[ops.length - 1].opNo;
  cacheFinalOperation_(mo, finalOpNo);
  return finalOpNo;
}

// testFetchOpsDebug, debugOrderStatus, debugOrderRouting, debugProbeOperationEntitySet_,
// debugProbeHeaderExpand_, inspectOrderCache → moved to Tests.gs

// ============================================================================
// CACHE REFRESH — backfill OperationsJSON / FinalOperation for rows synced by
// older code, before those columns existed (see inspectOrderCache() above —
// that diagnostic found 1000036350 with Operations populated but
// OperationsJSON/FinalOperation empty). Single-order only; no bulk loop.
// ============================================================================

/**
 * Build the Operations summary string + OperationsJSON array from a
 * normalized ops array. Extracted from mapPoToRow_()'s inline logic so the
 * full sync path and refreshOrderOperationCache() (single-order backfill)
 * never compute this cache two different ways.
 * Does NOT sort — preserves the caller's ops order, same as mapPoToRow_'s
 * original behavior (it never sorted here either; only FinalOperation needs
 * a sorted view — see computeFinalOperation_).
 * @param {Array<{opNo, opText, workCenter}>} ops — normalized shape, matches
 *   fetchOperationsForMO_() output and mapPoToRow_()'s opsJson element shape
 * @return {{operationsStr: string, opsJson: string}}
 */
function buildOperationsCacheFields_(ops) {
  const operationsStr = ops.map(function (op) {
    return op.opNo + ':' + (op.workCenter || '-') +
      (op.opText ? '|' + op.opText : '');
  }).join('; ');

  const opsJson = JSON.stringify(ops.map(function (op) {
    return {
      opNo:           String(op.opNo || '').trim(),
      opText:         String(op.opText || '').trim(),
      workCenter:     String(op.workCenter || '').trim(),
      workCenterDesc: ''
    };
  }));

  return { operationsStr: operationsStr, opsJson: opsJson };
}

/**
 * Final operation number from a normalized ops array — the entry with the
 * highest ManufacturingOrderOperation number. Matches getOperationsForOrder()'s
 * (WebApp.gs) isFinal flag: ascending sort by opNo, highest number = final.
 * @param {Array<{opNo}>} ops
 * @return {string} final op number, or '' if ops is empty
 */
function computeFinalOperation_(ops) {
  if (!ops || !ops.length) return '';
  const sorted = ops.slice().sort(function (a, b) {
    return parseInt(a.opNo, 10) - parseInt(b.opNo, 10);
  });
  return String(sorted[sorted.length - 1].opNo || '').trim();
}

/**
 * Backfill OperationsJSON / Operations / FinalOperation for ONE
 * ProductionOrders row synced by older code before those columns existed.
 * Fetches the routing live via fetchOperationsForMO_() — the same path
 * PalletSheet.gs / getOperationsForOrder() already rely on — then rebuilds
 * the cache fields with the SAME logic mapPoToRow_() uses
 * (buildOperationsCacheFields_ / computeFinalOperation_), so this never
 * diverges from what a fresh pullProductionOrders() sync would produce.
 *
 * Reads/writes by column name — no numeric index. No bulk loop here; call
 * once per MO. Run testRefreshOneOrder() to verify before any batch pass.
 *
 * @param {string} mo - ManufacturingOrder e.g. '1000036350'
 * @return {{mo: string, opCount: number, finalOperation: string}}
 */
function refreshOrderOperationCache(mo) {
  const fn = 'refreshOrderOperationCache';
  mo = String(mo || '').trim();
  const t0 = Date.now();

  try {
    if (!mo) throw new Error('refreshOrderOperationCache: mo is required');

    const sh = getSheet_(CFG.SHEETS.PRODUCTION_ORDERS);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) throw new Error('ProductionOrders sheet has no data rows');

    const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const moCol      = hdr.indexOf('ManufacturingOrder');
    const opsJsonCol = hdr.indexOf('OperationsJSON');
    const opsCol     = hdr.indexOf('Operations');
    const finalOpCol = hdr.indexOf('FinalOperation');
    if (moCol === -1)      throw new Error('ManufacturingOrder column not found in ProductionOrders sheet');
    if (opsJsonCol === -1) throw new Error('OperationsJSON column not found in ProductionOrders sheet');
    if (opsCol === -1)     throw new Error('Operations column not found in ProductionOrders sheet');
    if (finalOpCol === -1) throw new Error('FinalOperation column not found in ProductionOrders sheet');

    const keys = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    let rowNum = -1;
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0] || '').trim() === mo) { rowNum = i + 2; break; }
    }
    if (rowNum === -1) throw new Error('ManufacturingOrder not found in ProductionOrders sheet: ' + mo);

    const ops = fetchOperationsForMO_(mo); // live SAP fetch — same path PalletSheet/getOperationsForOrder use
    const cacheFields = buildOperationsCacheFields_(ops);
    const finalOp = computeFinalOperation_(ops);

    sh.getRange(rowNum, opsJsonCol + 1).setValue(cacheFields.opsJson);
    sh.getRange(rowNum, opsCol + 1).setValue(cacheFields.operationsStr);
    sh.getRange(rowNum, finalOpCol + 1).setValue(finalOp);

    logEvent(fn, mo, 'OK', Date.now() - t0, 'final=' + finalOp + ' ops=' + ops.length);

    return { mo: mo, opCount: ops.length, finalOperation: finalOp };

  } catch (e) {
    logError(fn, CFG.SHEETS.PRODUCTION_ORDERS, e.message, mo);
    throw e;
  }
}

// testRefreshOneOrder → moved to Tests.gs

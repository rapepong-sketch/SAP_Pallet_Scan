/**
 * @fileoverview Phase 3 — Pallet allocation preview + commit engine.
 *
 * previewPalletAllocation(requests) — READ-ONLY preview: computes how a
 * requested quantity splits across released production orders into pallets,
 * using FIFO (oldest planned-start first). Does NOT create pallets.
 *
 * commitPalletAllocation(requests) — WRITE: re-runs the preview server-side,
 * creates PalletMaster rows via buildPalletRow_(), logs to PrintQueue.
 * Idempotent: skips PalletIDs that already exist.
 *
 * Reuses: getMaterialMap() (MaterialMaster.gs), getSpreadsheet_/getSheet_
 * (SheetSetup.gs), logEvent() (SapClient.gs), buildPalletRow_/PM_HEADERS/
 * ensurePalletMasterSheet_/ensurePalletMasterColumns_ (PalletGen.gs),
 * getReleasedPoData_ (PrintEngine.gs), ensurePrintQueueSheet_ (PrintEngine.gs).
 *
 * Performance: _allocCache_ is an execution-scope cache that ensures each
 * sheet (MaterialMaster, ProductionOrders, PalletMaster) is read at most once
 * per google.script.run call. PalletMaster uses a narrow column read (4 of 33
 * cols). Preview emits a single summary logEvent instead of per-material appends.
 *
 * Minimum-remainder merge: if the final leftover after MOQ split is below
 * REMAINDER_THRESHOLD and at least one full pallet exists, the leftover is
 * merged into the last pallet (which then exceeds MOQ) instead of creating
 * a tiny pallet. This avoids impractical small pallets on the factory floor.
 *
 * Entry points: previewPalletAllocation(requests)
 *               commitPalletAllocation(requests)
 * Test runner:  testPreviewAllocation()
 */

// Below this quantity, a final remainder pallet is merged into the preceding pallet
const REMAINDER_THRESHOLD = 100;

// ============================================================================
// Execution-scope cache
// ============================================================================

/**
 * Per-execution sheet-data cache. Each google.script.run call starts a fresh
 * GAS execution with module-level variables re-initialized, so no cross-call
 * leakage. Within one execution (e.g. commitPalletAllocation calling
 * previewPalletAllocation internally), cached results are reused so each
 * sheet is read at most once.
 *
 * Keys: materialMap, poListPreview, pmSummary, existingPalletIds
 * @private
 */
var _allocCache_ = {};

/** Reset cache — called at the top of each top-level entry point. */
function clearAllocCache_() { _allocCache_ = {}; }

/**
 * Cached wrapper for getMaterialMap() (MaterialMaster.gs).
 * @return {Object} Same result as getMaterialMap().
 * @private
 */
function getCachedMaterialMap_() {
  if (_allocCache_.materialMap) return _allocCache_.materialMap;
  _allocCache_.materialMap = getMaterialMap();
  return _allocCache_.materialMap;
}

// ============================================================================
// Private helpers
// ============================================================================

/**
 * Read released PO data with fields needed for preview (includes confirmed yield).
 * Same column-name indexing and IsReleased filter as PrintEngine's
 * getReleasedPoData_(), plus MfgOrderConfirmedYieldQty for the preview calc.
 * Sorted FIFO: MfgOrderPlannedStartDate ASC, ManufacturingOrder ASC.
 * Uses execution-scope cache — sheet read at most once per execution.
 * @return {Array<Object>}
 * @private
 */
function getReleasedPoDataForPreview_() {
  if (_allocCache_.poListPreview) return _allocCache_.poListPreview;

  const sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  if (!sh || sh.getLastRow() < 2) {
    _allocCache_.poListPreview = [];
    return [];
  }

  const data = sh.getDataRange().getValues();
  const hdr  = data[0];
  const idx  = {};
  hdr.forEach((h, i) => { idx[h] = i; });

  const orders = [];
  for (let r = 1; r < data.length; r++) {
    const row  = data[r];
    const isRel = row[idx.IsReleased];
    if (!isRel && isRel !== 'TRUE' && isRel !== true) continue;
    orders.push({
      ManufacturingOrder:        String(row[idx.ManufacturingOrder] || '').trim(),
      Material:                  String(row[idx.Material] || '').trim(),
      TotalQuantity:             Number(row[idx.TotalQuantity]) || 0,
      MfgOrderConfirmedYieldQty: Number(row[idx.MfgOrderConfirmedYieldQty]) || 0,
      MfgOrderPlannedStartDate:  row[idx.MfgOrderPlannedStartDate] || null,
      Plant:                     String(row[idx.Plant] || '').trim()
    });
  }

  orders.sort((a, b) => {
    const da = a.MfgOrderPlannedStartDate ? new Date(a.MfgOrderPlannedStartDate).getTime() : 0;
    const db = b.MfgOrderPlannedStartDate ? new Date(b.MfgOrderPlannedStartDate).getTime() : 0;
    if (da !== db) return da - db;
    return a.ManufacturingOrder < b.ManufacturingOrder ? -1 : 1;
  });
  _allocCache_.poListPreview = orders;
  return orders;
}

/**
 * Build PalletMaster summary per MO, split by ScanStatus.
 * Narrow read: resolves column indexes by name from the header row, then reads
 * only columns 1..maxNeededCol (4 of 33) to reduce Sheets API data transfer.
 * Also collects the full set of existing PalletIDs into _allocCache_.existingPalletIds
 * so commitPalletAllocation can skip its separate full-sheet read.
 * Uses execution-scope cache — sheet read at most once per execution.
 * @return {Object} { [mo]: { confirmedPalletQty, nonConfirmedPalletQty, maxSeq } }
 * @private
 */
function getPmPreviewSummary_() {
  if (_allocCache_.pmSummary) return _allocCache_.pmSummary;

  const sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!sh || sh.getLastRow() < 2) {
    _allocCache_.pmSummary = {};
    _allocCache_.existingPalletIds = {};
    return {};
  }

  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const needed = ['PalletID', 'ManufacturingOrder', 'QtyPerPallet', 'ScanStatus'];
  const ci = {};
  needed.forEach(function(name) {
    var i = hdr.indexOf(name);
    if (i < 0) throw new Error('PalletMaster missing column: ' + name);
    ci[name] = i;
  });

  var maxCol = 0;
  needed.forEach(function(n) { if (ci[n] > maxCol) maxCol = ci[n]; });
  maxCol += 1;

  const lastRow = sh.getLastRow();
  const data = sh.getRange(2, 1, lastRow - 1, maxCol).getValues();

  const result = {};
  const existingIds = {};
  for (let r = 0; r < data.length; r++) {
    const row        = data[r];
    const pid        = String(row[ci.PalletID] || '').trim();
    const mo         = String(row[ci.ManufacturingOrder] || '').trim();
    const qty        = Number(row[ci.QtyPerPallet]) || 0;
    const scanStatus = String(row[ci.ScanStatus] || '').trim().toUpperCase();

    if (pid) existingIds[pid] = true;
    if (!mo) continue;

    if (!result[mo]) result[mo] = { confirmedPalletQty: 0, nonConfirmedPalletQty: 0, maxSeq: 0 };

    if (scanStatus === 'CONFIRMED') {
      result[mo].confirmedPalletQty += qty;
    } else {
      result[mo].nonConfirmedPalletQty += qty;
    }

    const m = pid.match(/PL-[^-]+-L(\d+)$/);
    if (m) {
      const seq = parseInt(m[1], 10);
      if (seq > result[mo].maxSeq) result[mo].maxSeq = seq;
    }
  }
  _allocCache_.pmSummary = result;
  _allocCache_.existingPalletIds = existingIds;
  return result;
}

// ============================================================================
// PO selector — list available POs for a material
// ============================================================================

/**
 * Return released POs for a material with remaining qty > 0.
 * Called by AdminPrint.html PO selector dropdown after material selection.
 * @param {string} material
 * @return {{orders: Array<{mo,material,plannedQty,remainingQty,productionDate,batch}>, message: string}}
 */
function getProductionOrdersForMaterial(material) {
  material = String(material || '').trim();
  if (!material) return { orders: [], message: 'ไม่ระบุรหัสสินค้า' };

  clearAllocCache_();
  var poList    = getReleasedPoDataForPreview_();
  var pmSummary = getPmPreviewSummary_();

  var candidates = poList.filter(function(po) { return po.Material === material; });
  var result = [];

  candidates.forEach(function(po) {
    var moKey = po.ManufacturingOrder;
    var pm    = pmSummary[moKey] || { confirmedPalletQty: 0, nonConfirmedPalletQty: 0 };
    var effectiveConfirmed = Math.max(po.MfgOrderConfirmedYieldQty, pm.confirmedPalletQty);
    var alreadyPrinted     = pm.nonConfirmedPalletQty;
    var remainingQty       = Math.max(0, po.TotalQuantity - effectiveConfirmed - alreadyPrinted);
    if (remainingQty <= 0) return;

    var dateStr = '';
    if (po.MfgOrderPlannedStartDate instanceof Date) {
      dateStr = po.MfgOrderPlannedStartDate.toISOString();
    } else if (po.MfgOrderPlannedStartDate) {
      dateStr = String(po.MfgOrderPlannedStartDate);
    }

    result.push({
      mo:             moKey,
      material:       material,
      plannedQty:     po.TotalQuantity,
      remainingQty:   remainingQty,
      productionDate: dateStr,
      batch:          ''
    });
  });

  if (result.length > 20) result = result.slice(0, 20);

  return JSON.parse(JSON.stringify({
    orders:  result,
    message: result.length === 0 ? 'ไม่พบ Production Order ที่ REL สำหรับรหัสนี้' : ''
  }));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Preview pallet allocation for one or more material requests.
 * READ-ONLY — does not create pallets, print, or write to any sheet.
 *
 * @param {Array<{material: string, requestedQty: number}>} requests
 * @return {Array<Object>} Per-material result:
 *   { material, requestedQty, allocatedQty, shortfall,
 *     orders: [{ manufacturingOrder, plannedStartDate, totalQuantity,
 *                confirmedQty, alreadyPrintedQty, availableQty,
 *                allocatedFromThisOrder,
 *                pallets: [{ palletSeq, qty }] }] }
 */

function previewPalletAllocation(requests) {
  clearAllocCache_();

  const materialMap = getCachedMaterialMap_();
  const poList      = getReleasedPoDataForPreview_();
  const pmSummary   = getPmPreviewSummary_();

  const results = [];
  var invariantErrors = [];

  requests.forEach(req => {
    const mat          = String(req.material || '').trim();
    const requestedQty = Number(req.requestedQty) || 0;

    const mmData = materialMap[mat];
    if (!mmData || !(mmData.moq > 0)) {
      results.push({
        material: mat, requestedQty, allocatedQty: 0,
        shortfall: requestedQty, orders: [], error: 'NO_MOQ'
      });
      return;
    }

    if (requestedQty <= 0) {
      results.push({
        material: mat, requestedQty: 0, allocatedQty: 0,
        shortfall: 0, orders: [], error: 'ZERO_QTY'
      });
      return;
    }

    const moq        = mmData.moq;
    const selectedMO = String(req.selectedMO || '').trim();
    var candidates   = poList.filter(po => po.Material === mat);
    if (selectedMO && selectedMO !== 'AUTO') {
      candidates = candidates.filter(po => po.ManufacturingOrder === selectedMO);
    }

    let remaining    = requestedQty;
    let allocatedQty = 0;
    const orderResults = [];

    // Track sequence numbers within this preview so multiple orders don't collide
    const seqTracker = {};

    candidates.forEach(po => {
      if (remaining <= 0) return;

      const moKey = po.ManufacturingOrder;
      const pm    = pmSummary[moKey] || { confirmedPalletQty: 0, nonConfirmedPalletQty: 0, maxSeq: 0 };

      const sapConfirmedQty    = po.MfgOrderConfirmedYieldQty;
      const confirmedPalletQty = pm.confirmedPalletQty;

      // Use max(SAP confirmed yield, sum of CONFIRMED pallets) so we never
      // double-count between SAP's yield figure and our local pallet
      // confirmations — whichever source reports more is the truth floor.
      const effectiveConfirmed = Math.max(sapConfirmedQty, confirmedPalletQty);

      // Non-confirmed pallets: already created/printed but not yet confirmed.
      // Subtract separately so we don't reprint pallets that already exist.
      const alreadyPrintedQty = pm.nonConfirmedPalletQty;

      const availableQty = Math.max(0,
        po.TotalQuantity - effectiveConfirmed - alreadyPrintedQty);

      if (availableQty <= 0) return;

      const toAllocate = Math.min(remaining, availableQty);

      // Pallet seq continues after existing highest for this MO
      if (!(moKey in seqTracker)) seqTracker[moKey] = pm.maxSeq;
      let nextSeq = seqTracker[moKey] + 1;

      const pallets = [];
      const fullCount = Math.floor(toAllocate / moq);
      const rem       = toAllocate % moq;

      if (rem === 0) {
        for (let i = 0; i < fullCount; i++) {
          pallets.push({ palletSeq: nextSeq++, qty: moq });
        }
      } else if (rem >= REMAINDER_THRESHOLD || fullCount === 0) {
        for (let i = 0; i < fullCount; i++) {
          pallets.push({ palletSeq: nextSeq++, qty: moq });
        }
        pallets.push({ palletSeq: nextSeq++, qty: rem });
      } else {
        for (let i = 0; i < fullCount - 1; i++) {
          pallets.push({ palletSeq: nextSeq++, qty: moq });
        }
        pallets.push({ palletSeq: nextSeq++, qty: moq + rem });
      }

      const palletSum = pallets.reduce((s, p) => s + p.qty, 0);
      if (palletSum !== toAllocate) {
        invariantErrors.push(moKey + ':sum=' + palletSum + '/alloc=' + toAllocate);
      }
      seqTracker[moKey] = nextSeq - 1;

      orderResults.push({
        manufacturingOrder:    moKey,
        plannedStartDate:      po.MfgOrderPlannedStartDate,
        totalQuantity:         po.TotalQuantity,
        confirmedQty:          effectiveConfirmed,
        alreadyPrintedQty:     alreadyPrintedQty,
        availableQty:          availableQty,
        allocatedFromThisOrder: toAllocate,
        pallets:               pallets
      });

      allocatedQty += toAllocate;
      remaining    -= toAllocate;
    });

    const shortfall = Math.max(0, remaining);

    results.push({
      material:     mat,
      requestedQty: requestedQty,
      allocatedQty: allocatedQty,
      shortfall:    shortfall,
      orders:       orderResults
    });
  });

  // Single summary logEvent for the entire preview (replaces per-material appends)
  var hasError     = results.some(function(r) { return r.error; });
  var hasShortfall = results.some(function(r) { return r.shortfall > 0; });
  var summaryParts = results.map(function(r) {
    return r.material + ':' + r.allocatedQty + '/' + r.requestedQty +
      (r.shortfall > 0 ? '(short=' + r.shortfall + ')' : '') +
      (r.error ? '(err=' + r.error + ')' : '');
  });
  var note = summaryParts.join('; ');
  if (invariantErrors.length) note += ' INVARIANT_ERR:[' + invariantErrors.join(',') + ']';
  logEvent('PRINT_PREVIEW', '-',
    invariantErrors.length ? 'ERROR' : hasError ? 'ERROR' : hasShortfall ? 'SHORTFALL' : 'OK',
    0, note);

  // Sanitize for google.script.run: raw Java Date objects from getValues()
  // cause "[Ljava.lang.Object;@..." serialization failure on the client side.
  results.forEach(function(r) {
    r.requestedQty = Number(r.requestedQty) || 0;
    r.allocatedQty = Number(r.allocatedQty) || 0;
    r.shortfall    = Number(r.shortfall) || 0;
    r.material     = String(r.material || '');
    if (r.error) r.error = String(r.error);
    (r.orders || []).forEach(function(o) {
      o.manufacturingOrder    = String(o.manufacturingOrder || '');
      o.plannedStartDate      = o.plannedStartDate instanceof Date
        ? o.plannedStartDate.toISOString() : String(o.plannedStartDate || '');
      o.totalQuantity          = Number(o.totalQuantity) || 0;
      o.confirmedQty           = Number(o.confirmedQty) || 0;
      o.alreadyPrintedQty      = Number(o.alreadyPrintedQty) || 0;
      o.availableQty           = Number(o.availableQty) || 0;
      o.allocatedFromThisOrder = Number(o.allocatedFromThisOrder) || 0;
      (o.pallets || []).forEach(function(p) {
        p.palletSeq = Number(p.palletSeq) || 0;
        p.qty       = Number(p.qty) || 0;
      });
    });
  });
  return JSON.parse(JSON.stringify(results));
}

// ============================================================================
// Commit — create PalletMaster rows from a fresh preview recomputation
// ============================================================================

/**
 * Commit pallet allocation: re-run the preview server-side, create PalletMaster
 * rows via buildPalletRow_(), write PrintQueue audit row.
 * Idempotent: per-order PalletSeq continues after existing max seq; if a target
 * PalletID already exists, it is SKIPPED (never duplicated).
 *
 * @param {Array<{material: string, requestedQty: number}>} requests
 * @return {{ created: Array<{palletId,mo,qty}>, skipped: Array<{palletId,mo,qty}>,
 *            totalCreated: number, totalSkipped: number,
 *            perMaterial: Array, dryRun: boolean }}
 */
function commitPalletAllocation(requests) {
  clearAllocCache_();
  var t0 = Date.now();

  // 1. Fresh preview (never trust client pallet numbers).
  //    Populates _allocCache_: materialMap, poListPreview, pmSummary, existingPalletIds
  var preview = previewPalletAllocation(requests);

  // 2. Full PO data — need Batch, WorkCenters, StorageLocation for pallet rows
  var poData = getReleasedPoData_();
  var poMap  = {};
  poData.forEach(function (po) { poMap[po.ManufacturingOrder] = po; });

  // 3. Existing PalletIDs — reuse set collected by getPmPreviewSummary_ (no re-read)
  var existingIds = _allocCache_.existingPalletIds || {};

  // 4. Build pallet rows from preview results
  var materialMap = getCachedMaterialMap_();
  var now         = new Date();
  var allNewRows  = [];
  var created     = [];
  var skipped     = [];
  var perMaterial  = [];

  preview.forEach(function (matResult) {
    if (matResult.error) {
      perMaterial.push({ material: matResult.material, created: 0, skipped: 0, error: matResult.error });
      return;
    }

    var mmData     = materialMap[matResult.material];
    var matCreated = 0;
    var matSkipped = 0;

    matResult.orders.forEach(function (orderResult) {
      var po = poMap[orderResult.manufacturingOrder];
      if (!po) return;

      var moq          = mmData ? mmData.moq : 0;
      var totalPallets = moq > 0 ? Math.ceil(po.TotalQuantity / moq) : 0;
      var firstWc      = String(po.WorkCenters || '').split(/[;,]/)[0].trim();

      orderResult.pallets.forEach(function (pallet) {
        var seqStr   = pallet.palletSeq < 10 ? '0' + pallet.palletSeq : String(pallet.palletSeq);
        var palletId = 'PL-' + orderResult.manufacturingOrder + '-L' + seqStr;

        if (existingIds[palletId]) {
          skipped.push({ palletId: palletId, mo: orderResult.manufacturingOrder, qty: pallet.qty });
          matSkipped++;
          return;
        }

        var qrPayload = 'PALLET|' + palletId + '|' + orderResult.manufacturingOrder + '|' +
                         matResult.material + '|' + (po.Batch || '') + '|' + pallet.qty;

        allNewRows.push(buildPalletRow_({
          PalletID:           palletId,
          ManufacturingOrder: orderResult.manufacturingOrder,
          Material:           matResult.material,
          MaterialName:       mmData ? (mmData.name || '') : '',
          Batch:              po.Batch || '',
          QtyPerPallet:       pallet.qty,
          Unit:               mmData ? (mmData.unit || po.ProductionUnit) : (po.ProductionUnit || ''),
          PalletSeq:          pallet.palletSeq,
          TotalPallets:       totalPallets,
          WorkCenter:         firstWc,
          ProductionDate:     po.MfgOrderPlannedStartDate || '',
          TotalQuantity:      Number(po.TotalQuantity) || 0,
          Plant:              po.Plant || '',
          StorageLocation:    po.StorageLocation || '',
          QRPayload:          qrPayload,
          Status:             'CREATED',
          ScanStatus:         'CREATED',
          CreatedAt:          now
        }));

        created.push({ palletId: palletId, mo: orderResult.manufacturingOrder, qty: pallet.qty });
        existingIds[palletId] = true;
        matCreated++;
      });
    });

    perMaterial.push({
      material:     matResult.material,
      created:      matCreated,
      skipped:      matSkipped,
      allocatedQty: matResult.allocatedQty,
      shortfall:    matResult.shortfall
    });
  });

  // 5. Batch write to PalletMaster
  if (allNewRows.length > 0) {
    if (CFG.DRY_RUN) {
      logEvent('PRINT_COMMIT', 'PalletMaster', 'DRY_RUN', Date.now() - t0,
        'would create ' + allNewRows.length + ' pallets');
    } else {
      ensurePalletMasterColumns_();
      var pmSheet = ensurePalletMasterSheet_();
      pmSheet.getRange(pmSheet.getLastRow() + 1, 1, allNewRows.length, PM_HEADERS.length)
             .setValues(allNewRows);
    }
  }

  // 6. Log
  logEvent('PRINT_COMMIT', 'PalletMaster', CFG.DRY_RUN ? 'DRY_RUN' : 'OK', Date.now() - t0,
    'created=' + created.length + ' skipped=' + skipped.length);

  // 7. PrintQueue audit row
  if (!CFG.DRY_RUN && created.length > 0) {
    var pqSheet = ensurePrintQueueSheet_();
    var email   = getActiveUserSafe_();
    var tsStr   = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMddHHmmss');
    var idsStr  = created.map(function (c) { return c.palletId; }).slice(0, 30).join(',') +
      (created.length > 30 ? '... (+' + (created.length - 30) + ')' : '');

    pqSheet.appendRow([
      tsStr + '-COMMIT', now, email,
      perMaterial.map(function (pm) { return pm.material; }).join(','),
      requests.reduce(function (s, r) { return s + (Number(r.requestedQty) || 0); }, 0),
      created.reduce(function (s, c) { return s + c.qty; }, 0),
      perMaterial.reduce(function (s, pm) { return s + (pm.shortfall || 0); }, 0),
      created.length, 'COMMITTED', idsStr
    ]);
  }

  var commitResult = {
    created:      created,
    skipped:      skipped,
    totalCreated: created.length,
    totalSkipped: skipped.length,
    perMaterial:  perMaterial,
    dryRun:       !!CFG.DRY_RUN
  };
  return JSON.parse(JSON.stringify(commitResult));
}

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Test harness — run previewPalletAllocation with a sample material.
 * Picks a real material from the ProductionOrders sheet that has REL orders.
 */
function testPreviewAllocation() {
  const poList = getReleasedPoDataForPreview_();
  if (poList.length === 0) {
    Logger.log('No released orders found — cannot test preview');
    return;
  }

  const testMat = poList[0].Material;
  Logger.log('Testing preview with material: ' + testMat);

  const result = previewPalletAllocation([
    { material: testMat, requestedQty: 2000 }
  ]);

  result.forEach(r => {
    Logger.log('--- Material: ' + r.material +
      ' | requested=' + r.requestedQty +
      ' | allocated=' + r.allocatedQty +
      ' | shortfall=' + r.shortfall);
    r.orders.forEach(o => {
      const palletSum = o.pallets.reduce((s, p) => s + p.qty, 0);
      const ok = palletSum === o.allocatedFromThisOrder ? 'OK' : 'MISMATCH';
      Logger.log('  MO ' + o.manufacturingOrder +
        ' | pallets=' + o.pallets.length +
        ' | sum of pallet qty = ' + palletSum +
        ' (expected allocatedFromThisOrder=' + o.allocatedFromThisOrder + ') ' + ok);
      o.pallets.forEach(p => {
        Logger.log('    L' + String(p.palletSeq).padStart(2, '0') + ' qty=' + p.qty);
      });
    });
  });

  Logger.log(JSON.stringify(result, null, 2));
}

// ============================================================================
// TEST — PO selector
// ============================================================================

function TEST_poSelector() {
  var results = [];
  var pass    = true;

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  // (a) getProductionOrdersForMaterial with a known material
  var matMap = getMaterialMap();
  var testMat = Object.keys(matMap)[0] || '';
  Logger.log('Test material: ' + testMat);

  var res = getProductionOrdersForMaterial(testMat);
  assert('(a) returns object', res && typeof res === 'object');
  assert('(a) orders is array', Array.isArray(res.orders), 'type=' + typeof res.orders);

  if (res.orders.length > 0) {
    var first = res.orders[0];
    assert('(a) has mo', typeof first.mo === 'string' && first.mo.length > 0, 'mo=' + first.mo);
    assert('(a) has plannedQty', typeof first.plannedQty === 'number', 'qty=' + first.plannedQty);
    assert('(a) has remainingQty', typeof first.remainingQty === 'number', 'rem=' + first.remainingQty);
    assert('(a) productionDate is string', typeof first.productionDate === 'string',
      'type=' + typeof first.productionDate);

    var serialized = JSON.parse(JSON.stringify(res));
    assert('(a) JSON serializable', serialized.orders.length === res.orders.length);
  } else {
    Logger.log('  (a) no POs for ' + testMat + ' — skipping field checks');
  }

  // (b) AUTO selection → FIFO (no MO filter)
  if (res.orders.length > 0) {
    var previewAuto = previewPalletAllocation([{
      material: testMat, requestedQty: 1, selectedMO: 'AUTO'
    }]);
    assert('(b) AUTO preview runs', previewAuto && previewAuto.length > 0);
    if (previewAuto[0].orders && previewAuto[0].orders.length > 0) {
      assert('(b) AUTO picks FIFO first MO', previewAuto[0].orders[0].manufacturingOrder === res.orders[0].mo,
        'got=' + previewAuto[0].orders[0].manufacturingOrder + ' expected=' + res.orders[0].mo);
    }
  }

  // (c) specific MO → only that MO appears
  if (res.orders.length >= 2) {
    var secondMo = res.orders[1].mo;
    var previewMo = previewPalletAllocation([{
      material: testMat, requestedQty: 1, selectedMO: secondMo
    }]);
    assert('(c) specific MO preview runs', previewMo && previewMo.length > 0);
    if (previewMo[0].orders) {
      var allMatch = previewMo[0].orders.every(function(o) { return o.manufacturingOrder === secondMo; });
      assert('(c) only selected MO in result', allMatch,
        'MOs=' + previewMo[0].orders.map(function(o) { return o.manufacturingOrder; }).join(','));
    }
  } else {
    Logger.log('  (c) only 1 PO available — cannot test specific MO filter');
  }

  // (d) invalid MO → zero allocation
  var previewBad = previewPalletAllocation([{
    material: testMat, requestedQty: 100, selectedMO: '0000000000'
  }]);
  assert('(d) invalid MO → 0 orders', previewBad && previewBad.length > 0 &&
    previewBad[0].orders.length === 0,
    'orders=' + (previewBad[0] ? previewBad[0].orders.length : 'N/A'));
  assert('(d) shortfall = requested', previewBad && previewBad[0] &&
    previewBad[0].shortfall === 100,
    'shortfall=' + (previewBad[0] ? previewBad[0].shortfall : 'N/A'));

  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_poSelector_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name +
      (results[si].detail ? ' (' + results[si].detail + ')' : ''));
  }
}

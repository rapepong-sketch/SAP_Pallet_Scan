/**
 * Dashboard.gs — Phase 6.7 — Read-only KPI aggregation engine (no UI)
 * ======================================================================
 * Aggregates today's per-Department yield/QC KPIs plus a handful of
 * system-level backlog counters, for a future google.script.run-backed
 * dashboard UI (not built in this phase — no doGet routing change here).
 *
 * READ-ONLY on OperationLog, PalletMaster, TransferLog, DeadLetter,
 * MachineMaster. Zero writes, zero SAP calls.
 *
 * Reuses (verbatim, unmodified):
 *   readOlRows_(), readPmRows_(), buildPalletOutput_() (YieldQCReport.gs)
 *   resolveWorkCenter_(), _wcCache_/_mmCache_/_mmByWC_, TZ_ (YieldQCReport.gs)
 *   getMachineMaster_() (MachineMaster.gs)
 *   OL_SHEET (OperationLog.gs), PM_SHEET (PalletGen.gs), TL_SHEET (TransferLog.gs)
 *   DL_SHEET_ / DL_HEADERS_ (Confirmation.gs)
 *   logError() / logEvent() (SapClient.gs), getSpreadsheet_() (SheetSetup.gs)
 *
 * Design note (Step 0 finding): buildPalletOutput_()'s returned per-pallet
 * object does NOT expose the raw last-op OperationLog row or its LoggedAt —
 * only the computed Good/Repair/AwaitConv/Scrap/date-from-PalletMaster
 * fields. readOlRows_() doesn't carry LoggedAt either. Rather than modify
 * either function, _readOlLastOpByPallet_() below does one small dedicated
 * read of OperationLog (LoggedAt + OperationNo + resolveWorkCenter_ call
 * only) and replicates buildPalletOutput_()'s exact last-op selection rule
 * (highest OperationNo wins; ties keep the first-seen row) so the two stay
 * in lockstep without either function needing to change.
 *
 * Design note (qcByDepartment[] cache, Phase 6.7 follow-up): the raw
 * "which OperationLog row is each pallet's last op" scan (cheap — no SAP
 * calls) is split from the "resolve that row's work center" step (the
 * expensive resolveWorkCenter_ / fetchOperationsForMO_ part). getDashboardData_()
 * uses this split to resolve work centers for only TODAY's active pallets on
 * a qcByDepartment[] cache hit (cheap), vs. every pallet ever on a cache miss
 * (expensive, cached afterward). _buildDashboardAggregates_() itself is
 * untouched either way — it always receives one already-resolved map.
 */

// ============================================================================
// Cumulative qcByDepartment[] cache — see getDashboardData_() for usage.
// Bump the _v1 suffix (not the TTL) to invalidate old cached entries after a
// schema change to the qcByDepartment[] shape.
// ============================================================================

var QC_BY_DEPT_CACHE_KEY_ = 'dashboard_qcByDept_v1';
var QC_BY_DEPT_CACHE_TTL_SEC_ = 600; // 10 min — cumulative QC stats, not real-time

// ============================================================================
// Last-op LoggedAt + work-center resolution per pallet (OperationLog)
// ============================================================================

/**
 * For every pallet in OperationLog, find the LAST operation row (same rule
 * as buildPalletOutput_: highest OperationNo wins, ties keep the first-seen
 * row) — WITHOUT resolving its work center (that's the expensive step; see
 * _resolveLastOps_ below). PL-TEST* pallets are skipped, matching readOlRows_.
 * @return {Object.<string,{opNo:string, loggedAt:*, mo:string, olIdx:Object, olRow:Array}>}
 */
function _readOlLastOpRawByPallet_() {
  var sh = getSpreadsheet_().getSheetByName(OL_SHEET);
  if (!sh || sh.getLastRow() < 2) return {};

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var lastByPallet = {};
  for (var r = 1; r < data.length; r++) {
    var pid = String(data[r][idx['PalletID']] || '').trim();
    if (!pid || /^PL-TEST/i.test(pid)) continue;

    var mo   = String(data[r][idx['ManufacturingOrder']] || '').trim();
    var opNo = _normOpNo_(data[r][idx['OperationNo']]);

    if (!lastByPallet[pid] || opNo > lastByPallet[pid].opNo) {
      lastByPallet[pid] = {
        opNo: opNo, loggedAt: data[r][idx['LoggedAt']],
        mo: mo, olIdx: idx, olRow: data[r]
      };
    }
  }

  return lastByPallet;
}

/**
 * Resolves work center (resolveWorkCenter_ — reused, not reimplemented) for
 * entries produced by _readOlLastOpRawByPallet_(). This is the expensive
 * step (live SAP fallback via fetchOperationsForMO_ on a routing-cache miss).
 * @param {Object} rawByPallet — _readOlLastOpRawByPallet_() shape
 * @param {string} [dateFilter] — 'yyyy-MM-dd'; if given, only entries whose
 *   LoggedAt falls on this date are resolved (cheap subset, for the always-
 *   live "today" section). Omit to resolve every entry (expensive — reserve
 *   for the cacheable cumulative section).
 * Caller must reset _wcCache_/_mmCache_/_mmByWC_ before calling, same as
 * buildYieldQCReport_ does.
 * @return {Object.<string,{opNo:string, loggedAt:*, machineCode:string,
 *   machineName:string, sapWC:string, wcSource:string}>}
 */
function _resolveLastOps_(rawByPallet, dateFilter) {
  var out = {};
  Object.keys(rawByPallet).forEach(function(pid) {
    var e = rawByPallet[pid];
    if (dateFilter && _fmtOlDate_(e.loggedAt) !== dateFilter) return;

    var wcInfo = resolveWorkCenter_(e.olIdx, e.olRow, e.mo, e.opNo);
    out[pid] = {
      opNo: e.opNo, loggedAt: e.loggedAt,
      machineCode: wcInfo.machineCode, machineName: wcInfo.machineName,
      sapWC: wcInfo.sapWC, wcSource: wcInfo.source
    };
  });
  return out;
}

/**
 * Full (unfiltered) last-op-per-pallet resolution — original Step 0 helper,
 * now a thin wrapper over _readOlLastOpRawByPallet_() + _resolveLastOps_().
 * Kept for callers needing the complete map in one call (all TEST_
 * fixtures pass their own hand-built map directly to _buildDashboardAggregates_
 * and don't call this).
 * @return {Object.<string,{opNo:string, loggedAt:*, machineCode:string,
 *   machineName:string, sapWC:string, wcSource:string}>}
 */
function _readOlLastOpByPallet_() {
  return _resolveLastOps_(_readOlLastOpRawByPallet_(), null);
}

/** Format a Date as 'yyyy-MM-dd' in Asia/Bangkok; '' for anything else. */
function _fmtOlDate_(d) {
  if (d instanceof Date && !isNaN(d.getTime())) {
    return Utilities.formatDate(d, TZ_, 'yyyy-MM-dd');
  }
  return '';
}

/**
 * Department for a resolved machine code. Empty/unknown machineCode (no
 * ActualMachine and no routing-derived work center matched MachineMaster)
 * lands in the visible 'ไม่ทราบแผนก' bucket rather than being dropped.
 * @param {string} machineCode
 * @return {string}
 */
function _resolveDepartment_(machineCode) {
  if (!machineCode) return 'ไม่ทราบแผนก';
  var mm = getMachineMaster_()[machineCode];
  var dept = mm && mm.department ? String(mm.department).trim() : '';
  return dept || 'ไม่ทราบแผนก';
}

// ============================================================================
// PalletMaster.UpdatedAt per pallet (for the approximate "QC completed today")
// ============================================================================

/**
 * PalletID → raw UpdatedAt value, read directly since readPmRows_() doesn't
 * carry it. PalletID is unique per row in PalletMaster, so a plain map
 * (unlike the OperationLog case) is safe with no ordering/alignment concern.
 * @return {Object.<string,*>}
 */
function _readPmUpdatedAtByPallet_() {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return {};

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var map = {};
  for (var r = 1; r < data.length; r++) {
    var pid = String(data[r][idx['PalletID']] || '').trim();
    if (!pid || /^PL-TEST/i.test(pid)) continue;
    map[pid] = idx['UpdatedAt'] !== undefined ? data[r][idx['UpdatedAt']] : '';
  }
  return map;
}

// ============================================================================
// Transfer (issue/receive) + GR movements for TODAY, grouped by StorageLocation
// ============================================================================
// Transfer side: TransferLog.Status === 'TRANSFERRED' AND UpdatedAt on dateStr
// is a SAFE combined filter — every success path (live POST, SAP-readback heal,
// retry-wrapper success) sets both Status and UpdatedAt together in the same
// write; failed/retried attempts never set Status='TRANSFERRED', so they're
// naturally excluded without any extra bookkeeping.
//
// GR side: PalletMaster has NO reliable "GR posted at this moment" field.
// ConfirmedAt is the closest proxy but is known to diverge from
// GRMaterialDocument in two paths (backfillMaterialDocument, dead-letter
// heal/replay) — grReceivedBySlocApprox is therefore approximate, same
// labeling/treatment as qcCompletedTodayApprox above, not authoritative.
// KNOWN GAP (not fixed here): a dead letter that is successfully replayed
// WITHOUT going through the heal path never writes GRMaterialDocument/
// ConfirmedAt back to PalletMaster at all, so that GR event is invisible to
// this approximate count.

/**
 * Raw TransferLog rows needed for today's issue/receive-by-StorageLocation
 * aggregation. No existing helper in the codebase filters on
 * Status==='TRANSFERRED' AND UpdatedAt (TransferReport.gs's getIssuedForDay_
 * uses a different filter — TxnType==='SPLIT_ISSUE' + CreatedAt — which mixes
 * in still-open ISSUED rows), so this is a small dedicated read, same
 * rationale as _readPmUpdatedAtByPallet_() above.
 * @return {Array<{status:string, updatedAt:*, sourceSloc:string, destSloc:string, issueQty:number}>}
 */
function _readTlRowsForSlocAgg_() {
  var sh = getSpreadsheet_().getSheetByName(TL_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var rows = [];
  for (var r = 1; r < data.length; r++) {
    rows.push({
      status:     String(data[r][idx['Status']] || '').trim(),
      updatedAt:  data[r][idx['UpdatedAt']],
      sourceSloc: String(data[r][idx['SourceSLoc']] || '').trim(),
      destSloc:   String(data[r][idx['DestSLoc']] || '').trim(),
      issueQty:   Number(data[r][idx['IssueQty']]) || 0
    });
  }
  return rows;
}

/**
 * Pure aggregator (no sheet I/O) — groups TRANSFERRED-today TransferLog rows
 * by SourceSLoc (issued) and DestSLoc (received). Testable directly with
 * synthetic rows, same pattern as _buildDashboardAggregates_.
 * @param {string} dateStr — 'yyyy-MM-dd', Asia/Bangkok
 * @param {Array} tlRows — _readTlRowsForSlocAgg_() shape
 * @return {{transferIssuedBySloc:Array, transferReceivedBySloc:Array}}
 */
function _buildTransferSlocAggregates_(dateStr, tlRows) {
  var issuedMap = {};
  var receivedMap = {};

  tlRows.forEach(function(row) {
    if (row.status !== 'TRANSFERRED') return;
    if (_fmtOlDate_(row.updatedAt) !== dateStr) return;

    if (row.sourceSloc) {
      if (!issuedMap[row.sourceSloc]) {
        issuedMap[row.sourceSloc] = { sloc: row.sourceSloc, palletCount: 0, qty: 0 };
      }
      issuedMap[row.sourceSloc].palletCount++;
      issuedMap[row.sourceSloc].qty += row.issueQty;
    }
    if (row.destSloc) {
      if (!receivedMap[row.destSloc]) {
        receivedMap[row.destSloc] = { sloc: row.destSloc, palletCount: 0, qty: 0 };
      }
      receivedMap[row.destSloc].palletCount++;
      receivedMap[row.destSloc].qty += row.issueQty;
    }
  });

  function toSortedArr(map) {
    return Object.keys(map).map(function(k) { return map[k]; }).sort(function(a, b) {
      return a.sloc < b.sloc ? -1 : (a.sloc > b.sloc ? 1 : 0);
    });
  }

  return {
    transferIssuedBySloc:   toSortedArr(issuedMap),
    transferReceivedBySloc: toSortedArr(receivedMap)
  };
}

/**
 * PalletID → {storageLocation, grMaterialDocument, confirmedAt}, read directly
 * since readPmRows_() doesn't carry StorageLocation/GRMaterialDocument/
 * ConfirmedAt. Same rationale + PL-TEST exclusion as _readPmUpdatedAtByPallet_()
 * above — callers restrict to palletIds already present in pmRows (from
 * readPmRows_()) rather than trusting this raw scan's row set independently.
 * @return {Object.<string,{storageLocation:string, grMaterialDocument:string, confirmedAt:*}>}
 */
function _readPmGrFieldsByPallet_() {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return {};

  var data = sh.getDataRange().getValues();
  var hdr  = data[0];
  var idx  = {};
  hdr.forEach(function(h, i) { idx[String(h).trim()] = i; });

  var map = {};
  for (var r = 1; r < data.length; r++) {
    var pid = String(data[r][idx['PalletID']] || '').trim();
    if (!pid || /^PL-TEST/i.test(pid)) continue;

    map[pid] = {
      storageLocation:    idx['StorageLocation']    !== undefined ? String(data[r][idx['StorageLocation']] || '').trim() : '',
      grMaterialDocument: idx['GRMaterialDocument']  !== undefined ? String(data[r][idx['GRMaterialDocument']] || '').trim() : '',
      confirmedAt:        idx['ConfirmedAt']         !== undefined ? data[r][idx['ConfirmedAt']] : ''
    };
  }
  return map;
}

/**
 * Pure aggregator (no sheet I/O) — GR'd-today pallets (GRMaterialDocument
 * non-empty AND ConfirmedAt on dateStr) grouped by StorageLocation. Empty/
 * missing StorageLocation lands in the visible 'ไม่ทราบคลัง' bucket, same
 * pattern as _resolveDepartment_'s 'ไม่ทราบแผนก' bucket — not dropped.
 * Testable directly with synthetic pmRows + grFieldsByPallet.
 * @param {string} dateStr — 'yyyy-MM-dd', Asia/Bangkok
 * @param {Array} pmRows — readPmRows_() shape (only palletId is used)
 * @param {Object} grFieldsByPallet — _readPmGrFieldsByPallet_() shape
 * @return {Array<{sloc:string, palletCount:number}>}
 */
function _buildGrSlocAggregates_(dateStr, pmRows, grFieldsByPallet) {
  var map = {};

  pmRows.forEach(function(pm) {
    var gr = grFieldsByPallet[pm.palletId];
    if (!gr || !gr.grMaterialDocument) return;
    if (_fmtOlDate_(gr.confirmedAt) !== dateStr) return;

    var sloc = gr.storageLocation || 'ไม่ทราบคลัง';
    if (!map[sloc]) map[sloc] = { sloc: sloc, palletCount: 0 };
    map[sloc].palletCount++;
  });

  return Object.keys(map).map(function(k) { return map[k]; }).sort(function(a, b) {
    return a.sloc < b.sloc ? -1 : (a.sloc > b.sloc ? 1 : 0);
  });
}

// ============================================================================
// System-level counters (no department breakdown)
// ============================================================================

/**
 * Pallets ready for QC inspection, system-wide. Mirrors getQcWorklist_()'s
 * core filter (ScanStatus === 'PD_COMPLETE') exactly, but without the
 * mandatory StorageLocation getQcWorklist_ requires — read directly instead
 * of reimplementing a diverging copy of its full row-shaping logic.
 * @return {number}
 */
function _countPendingQc_() {
  var sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return 0;

  var data = sh.getDataRange().getValues();
  var idx  = {};
  data[0].forEach(function(h, i) { idx[String(h).trim()] = i; });

  var count = 0;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['ScanStatus']] || '').trim() === 'PD_COMPLETE') count++;
  }
  return count;
}

/** TransferLog rows awaiting pickup/close (Status === 'ISSUED'). @return {number} */
function _countPendingTransfer_() {
  var sh = getSpreadsheet_().getSheetByName(TL_SHEET);
  if (!sh || sh.getLastRow() < 2) return 0;

  var data = sh.getDataRange().getValues();
  var idx  = {};
  data[0].forEach(function(h, i) { idx[String(h).trim()] = i; });

  var count = 0;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['Status']] || '').trim() === 'ISSUED') count++;
  }
  return count;
}

/**
 * Open DeadLetter entries. Exact read pattern as Runbook.gs's
 * refreshRunbookStatus() (lines 138-158): open the sheet, build an idx map
 * from the header row, count ReplayStatus === 'OPEN'.
 * @return {number}
 */
function _countDeadLetterOpen_() {
  var dlSh = getSpreadsheet_().getSheetByName('DeadLetter');
  var dlOpen = 0;
  if (dlSh && dlSh.getLastRow() >= 2) {
    var dlData = dlSh.getDataRange().getValues();
    var dlIdx = {};
    dlData[0].forEach(function(h, i) { dlIdx[String(h).trim()] = i; });
    var rsCol = dlIdx['ReplayStatus'];
    for (var d = 1; d < dlData.length; d++) {
      if (rsCol !== undefined && String(dlData[d][rsCol] || '').trim() === 'OPEN') dlOpen++;
    }
  }
  return dlOpen;
}

// ============================================================================
// Pure aggregator — no sheet I/O, testable directly with synthetic rows
// ============================================================================

/**
 * Build the departments[] / qcByDepartment[] / qcCompletedTodayApprox
 * sections from already-read rows. Kept side-effect-free (no sheet reads)
 * so tests can exercise the aggregation + Department-bucketing logic with
 * synthetic fixtures, the same way TEST_yieldQcReport_ tests
 * buildPalletOutput_() directly instead of only through the full report.
 *
 * @param {string} dateStr — 'yyyy-MM-dd', Asia/Bangkok calendar day
 * @param {Array} olRows — readOlRows_() shape
 * @param {Array} pmRows — readPmRows_() shape
 * @param {Object.<string,Object>} lastOpByPallet — _readOlLastOpByPallet_() shape
 * @param {Object.<string,*>} pmUpdatedAtByPallet — _readPmUpdatedAtByPallet_() shape
 * @return {{departments:Array, qcByDepartment:Array, qcCompletedTodayApprox:number}}
 */
function _buildDashboardAggregates_(dateStr, olRows, pmRows, lastOpByPallet, pmUpdatedAtByPallet) {
  var pmByPallet = {};
  pmRows.forEach(function(pm) { pmByPallet[pm.palletId] = pm; });

  // Per-pallet last-op yield + cumulative scrap — reused verbatim.
  var palletOutput = buildPalletOutput_(olRows, pmByPallet);

  // ── departments[] — TODAY's pallets only (last-op LoggedAt === dateStr) ──
  var departments = {};
  palletOutput.forEach(function(po) {
    var lastOp = lastOpByPallet[po.palletId];
    var loggedDateStr = lastOp ? _fmtOlDate_(lastOp.loggedAt) : '';
    if (loggedDateStr !== dateStr) return; // out of scope for this date

    var dept = lastOp ? _resolveDepartment_(lastOp.machineCode) : 'ไม่ทราบแผนก';
    if (!departments[dept]) {
      departments[dept] = { department: dept, palletCount: 0, goodQty: 0,
        repairQty: 0, defectQty: 0, awaitConvQty: 0 };
    }
    departments[dept].palletCount++;
    departments[dept].goodQty      += po.good;
    departments[dept].repairQty    += po.repair;
    departments[dept].defectQty    += po.scrap;
    departments[dept].awaitConvQty += po.awaitConv;
  });

  // ── qcByDepartment[] — CUMULATIVE across all pallets, NOT date-filtered.
  // PalletMaster has no reliable QC-recorded-at timestamp: UpdatedAt is
  // shared with unrelated writes (saveQcResult, batchOverrideConfirm,
  // _healConfirmedPallet_ all funnel through updatePalletScanFields_(),
  // which stamps UpdatedAt on EVERY field write regardless of cause — see
  // PalletSheet.gs:543-545). So QC pass/fail/pending is rolled up for every
  // pallet ever inspected, grouped by the same Department resolution used
  // above, rather than filtered to "today".
  var qcByDept = {};
  pmRows.forEach(function(pm) {
    var lastOp = lastOpByPallet[pm.palletId];
    var dept = lastOp ? _resolveDepartment_(lastOp.machineCode) : 'ไม่ทราบแผนก';
    if (!qcByDept[dept]) qcByDept[dept] = { department: dept, pass: 0, fail: 0, pending: 0 };
    if (pm.qcResult === 'PASS')      qcByDept[dept].pass++;
    else if (pm.qcResult === 'FAIL') qcByDept[dept].fail++;
    else                              qcByDept[dept].pending++;
  });

  // ── qcCompletedTodayApprox — best-effort, NOT authoritative.
  // Uses PalletMaster.UpdatedAt === dateStr for pallets that already have a
  // QC result. Can overcount (an unrelated same-day override/confirm touch
  // bumps UpdatedAt without a new QC event) or undercount (a QC event's
  // UpdatedAt gets overwritten by a later same-day unrelated write, or the
  // pallet's true QC day gets masked by a next-day unrelated touch).
  var qcCompletedTodayApprox = 0;
  pmRows.forEach(function(pm) {
    if (pm.qcResult !== 'PASS' && pm.qcResult !== 'FAIL') return;
    var ua = pmUpdatedAtByPallet[pm.palletId];
    if (_fmtOlDate_(ua) === dateStr) qcCompletedTodayApprox++;
  });

  function toSortedArr(map) {
    return Object.keys(map).map(function(k) { return map[k]; }).sort(function(a, b) {
      return a.department < b.department ? -1 : (a.department > b.department ? 1 : 0);
    });
  }

  return {
    departments: toSortedArr(departments),
    qcByDepartment: toSortedArr(qcByDept),
    qcCompletedTodayApprox: qcCompletedTodayApprox
  };
}

// ============================================================================
// Main entry point — google.script.run target (not wired into doGet here)
// ============================================================================

/**
 * Read-only dashboard snapshot for one Asia/Bangkok calendar day.
 * @param {string} [dateStr] — 'yyyy-MM-dd'; defaults to today (Asia/Bangkok)
 * @return {{date:string, departments:Array, qcByDepartment:Array,
 *   qcCompletedTodayApprox:number, pendingQcCount:number,
 *   pendingTransferCount:number, deadLetterOpenCount:number,
 *   transferIssuedBySloc:Array, transferReceivedBySloc:Array,
 *   grReceivedBySlocApprox:Array, transferGrNote:string}|
 *   {error:true, message:string}}
 */
function getDashboardData_(dateStr) {
  try {
    dateStr = String(dateStr || '').trim();
    if (!dateStr) {
      dateStr = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd');
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('Malformed dateStr (expected yyyy-MM-dd): ' + dateStr);
    }

    // Fresh work-center resolution for this call — same reset buildYieldQCReport_ does.
    _wcCache_ = {};
    _mmCache_ = null;
    _mmByWC_  = null;

    var olRows = readOlRows_();
    var pmRows = readPmRows_();
    var pmUpdatedAtByPallet = _readPmUpdatedAtByPallet_();
    var rawLastOp = _readOlLastOpRawByPallet_(); // cheap — no resolveWorkCenter_ yet

    // ---- qcByDepartment[] — cumulative, cached (see header "Design note" and
    // QC_BY_DEPT_CACHE_KEY_/QC_BY_DEPT_CACHE_TTL_SEC_ above). departments[] and
    // qcCompletedTodayApprox stay fully live per the "today" refresh-cadence
    // decision — never cached.
    var cache = CacheService.getScriptCache();
    var cachedQcByDept = cache.get(QC_BY_DEPT_CACHE_KEY_);

    var lastOpByPallet, agg, qcByDepartment;
    if (cachedQcByDept) {
      // Cache hit: resolve work centers for TODAY's active pallets only —
      // skips the resolveWorkCenter_ loop over every pallet ever logged.
      lastOpByPallet = _resolveLastOps_(rawLastOp, dateStr);
      agg = _buildDashboardAggregates_(dateStr, olRows, pmRows, lastOpByPallet, pmUpdatedAtByPallet);
      qcByDepartment = JSON.parse(cachedQcByDept);
    } else {
      // Cache miss: resolve every pallet ever logged (expensive, cumulative) —
      // departments[] comes out correct from the same fully-resolved map.
      lastOpByPallet = _resolveLastOps_(rawLastOp, null);
      agg = _buildDashboardAggregates_(dateStr, olRows, pmRows, lastOpByPallet, pmUpdatedAtByPallet);
      qcByDepartment = agg.qcByDepartment;
      // CacheService caps values at 100KB/key. qcByDepartment[] is one entry
      // per Department (small today); if the Department count ever grows
      // enough to risk that cap, this will need chunking — not built now.
      cache.put(QC_BY_DEPT_CACHE_KEY_, JSON.stringify(qcByDepartment), QC_BY_DEPT_CACHE_TTL_SEC_);
    }

    // ---- transferIssuedBySloc[] / transferReceivedBySloc[] / grReceivedBySlocApprox[] —
    // today's "รับเข้า-จ่ายออก" section. Never cached (real-time "today" data, same
    // cadence as departments[]). A failure here must not break the rest of the
    // dashboard — falls back to empty arrays + a non-fatal note, not a top-level error.
    var transferIssuedBySloc = [];
    var transferReceivedBySloc = [];
    var grReceivedBySlocApprox = [];
    var transferGrNote = '';
    try {
      var tlRows = _readTlRowsForSlocAgg_();
      var grFieldsByPallet = _readPmGrFieldsByPallet_();
      var transferAgg = _buildTransferSlocAggregates_(dateStr, tlRows);
      transferIssuedBySloc = transferAgg.transferIssuedBySloc;
      transferReceivedBySloc = transferAgg.transferReceivedBySloc;
      grReceivedBySlocApprox = _buildGrSlocAggregates_(dateStr, pmRows, grFieldsByPallet);
    } catch (eTransferGr) {
      logError('getDashboardData_', 'Dashboard', 'transfer/GR section: ' + eTransferGr.message, 'dateStr=' + dateStr);
      transferGrNote = 'ไม่สามารถโหลดข้อมูลรับเข้า/จ่ายออกได้: ' + eTransferGr.message;
    }

    return {
      date: dateStr,
      departments: agg.departments,
      qcByDepartment: qcByDepartment,
      qcCompletedTodayApprox: agg.qcCompletedTodayApprox,
      pendingQcCount: _countPendingQc_(),
      pendingTransferCount: _countPendingTransfer_(),
      deadLetterOpenCount: _countDeadLetterOpen_(),
      transferIssuedBySloc: transferIssuedBySloc,
      transferReceivedBySloc: transferReceivedBySloc,
      grReceivedBySlocApprox: grReceivedBySlocApprox,
      transferGrNote: transferGrNote
    };

  } catch (e) {
    logError('getDashboardData_', 'Dashboard', e.message, 'dateStr=' + dateStr);
    return { error: true, message: e.message };
  }
}

// ============================================================================
// TEST
// ============================================================================

/** Build a Date at the given Asia/Bangkok wall-clock time, tz-safe for tests. */
function _dashMkBkkDate_(dateStr, hhmmss) {
  return Utilities.parseDate(dateStr + ' ' + (hhmmss || '00:00:00'), TZ_, 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Self-cleaning test for getDashboardData_() and its building blocks.
 * Each sub-check RETURNS its pass boolean via assert() bookkeeping — the
 * final return value is false if ANY assertion failed or the run threw.
 * Run from Apps Script Editor → select TEST_dashboardData_ → Run.
 * @return {boolean}
 */
function TEST_dashboardData_() {
  var results = [];
  var pass    = true;

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    if (!ok) pass = false;
    Logger.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ': ' + detail : ''));
  }

  var TODAY     = Utilities.formatDate(new Date(), TZ_, 'yyyy-MM-dd');
  var YESTERDAY = Utilities.formatDate(new Date(Date.now() - 86400000), TZ_, 'yyyy-MM-dd');
  var DL_TAG_PREFIX = 'PL-TEST-DASH-DL-';

  _wcCache_ = {};
  _mmCache_ = null;
  _mmByWC_  = null;

  try {
    // ============================================================
    // (1) ACTUAL machine → correct Department, source=ACTUAL
    // ============================================================
    var resA = resolveWorkCenter_({ ActualMachine: 0 }, ['APS001'], '', '');
    assert('(1) resolveWorkCenter_ source=ACTUAL for APS001', resA.source === 'ACTUAL', 'source=' + resA.source);

    var mmMap = getMachineMaster_();
    var deptA = mmMap[resA.machineCode] ? mmMap[resA.machineCode].department : '';
    assert('(1) APS001 has a non-empty Department', !!deptA, 'dept="' + deptA + '"');

    var PID_A  = 'PL-TEST-DASH-A';
    var olA    = [{ palletId: PID_A, mo: 'MO-A', opNo: '0010', good: 8, scrap: 1, repair: 0, awaitConv: 0, pdResult: '' }];
    var pmA    = [{ palletId: PID_A, mo: 'MO-A', material: 'MAT-A', materialName: 'Mat A', unit: 'PC',
      scannedDateStr: TODAY, prodDateStr: '', qcResult: 'PASS', qcResultNote: '', qcInspector: '',
      pmGood: 8, pmScrap: 1, pmRepair: 0, pmAwaitConv: 0, qtyPerPallet: 9, hasPmMirror: true }];
    var lastOpA = {};
    lastOpA[PID_A] = { opNo: '0010', loggedAt: _dashMkBkkDate_(TODAY, '09:00:00'),
      machineCode: resA.machineCode, machineName: resA.machineName, sapWC: resA.sapWC, wcSource: resA.source };

    var aggA = _buildDashboardAggregates_(TODAY, olA, pmA, lastOpA, {});
    var deptEntryA = aggA.departments.filter(function(d) { return d.department === deptA; })[0];
    assert('(1) departments[] includes resolved Department', !!deptEntryA, 'depts=' + JSON.stringify(aggA.departments));
    if (deptEntryA) {
      assert('(1) goodQty aggregated (last op only)', deptEntryA.goodQty === 8, 'got=' + deptEntryA.goodQty);
      assert('(1) defectQty aggregated', deptEntryA.defectQty === 1, 'got=' + deptEntryA.defectQty);
    }

    // ============================================================
    // (2) PLANNED source (empty ActualMachine, valid routing WC) → correct Department
    // Same MO/opNo pair TEST_machineResolveM3 (MachineMaster.gs) uses for
    // its own PLANNED-path check — reused here rather than inventing a new
    // one, since it's already known to exercise the PLANNED branch in this
    // environment. Assertion is deliberately permissive (matches that
    // test's own style): live routing data can vary by environment, so we
    // assert "not ACTUAL" + non-empty sapWC rather than a hard PLANNED.
    // ============================================================
    var resB = resolveWorkCenter_({ ActualMachine: 0 }, [''], '1000036346', '0010');
    assert('(2) source != ACTUAL (empty ActualMachine)', resB.source !== 'ACTUAL', 'source=' + resB.source);
    Logger.log('  (2) detail: source=' + resB.source + ' machineCode=' + resB.machineCode + ' sapWC=' + resB.sapWC);

    if (resB.source === 'PLANNED' && resB.machineCode) {
      var deptB = mmMap[resB.machineCode] ? mmMap[resB.machineCode].department : '';
      var PID_B = 'PL-TEST-DASH-B';
      var olB = [{ palletId: PID_B, mo: '1000036346', opNo: '0010', good: 5, scrap: 0, repair: 0, awaitConv: 0, pdResult: '' }];
      var pmB = [{ palletId: PID_B, mo: '1000036346', material: 'MAT-B', materialName: 'Mat B', unit: 'PC',
        scannedDateStr: TODAY, prodDateStr: '', qcResult: '', qcResultNote: '', qcInspector: '',
        pmGood: 5, pmScrap: 0, pmRepair: 0, pmAwaitConv: 0, qtyPerPallet: 5, hasPmMirror: true }];
      var lastOpB = {};
      lastOpB[PID_B] = { opNo: '0010', loggedAt: _dashMkBkkDate_(TODAY, '10:00:00'),
        machineCode: resB.machineCode, machineName: resB.machineName, sapWC: resB.sapWC, wcSource: resB.source };
      var aggB = _buildDashboardAggregates_(TODAY, olB, pmB, lastOpB, {});
      var deptEntryB = aggB.departments.filter(function(d) { return d.department === deptB; })[0];
      assert('(2) PLANNED pallet lands in correct Department', !!deptEntryB, 'depts=' + JSON.stringify(aggB.departments));
    } else {
      assert('(2) PLANNED path not exercised in this environment (non-fatal, routing-dependent)', true);
    }

    // ============================================================
    // (3) No resolvable machine/WC → 'ไม่ทราบแผนก' bucket, not dropped
    // ============================================================
    var PID_C = 'PL-TEST-DASH-C';
    var olC = [{ palletId: PID_C, mo: 'MO-C', opNo: '0099', good: 3, scrap: 2, repair: 1, awaitConv: 0, pdResult: '' }];
    var pmC = [{ palletId: PID_C, mo: 'MO-C', material: 'MAT-C', materialName: 'Mat C', unit: 'PC',
      scannedDateStr: TODAY, prodDateStr: '', qcResult: '', qcResultNote: '', qcInspector: '',
      pmGood: 3, pmScrap: 2, pmRepair: 1, pmAwaitConv: 0, qtyPerPallet: 6, hasPmMirror: true }];
    var lastOpC = {};
    lastOpC[PID_C] = { opNo: '0099', loggedAt: _dashMkBkkDate_(TODAY, '11:00:00'),
      machineCode: '', machineName: '', sapWC: '', wcSource: 'RAW' };
    var aggC = _buildDashboardAggregates_(TODAY, olC, pmC, lastOpC, {});
    var deptEntryC = aggC.departments.filter(function(d) { return d.department === 'ไม่ทราบแผนก'; })[0];
    assert('(3) unresolved machine → ไม่ทราบแผนก bucket present', !!deptEntryC, 'depts=' + JSON.stringify(aggC.departments));
    if (deptEntryC) {
      assert('(3) not silently dropped from totals', deptEntryC.goodQty === 3 && deptEntryC.palletCount === 1,
        'goodQty=' + deptEntryC.goodQty + ' palletCount=' + deptEntryC.palletCount);
    }

    // ============================================================
    // (4) Scrap sums across multiple OperationLog rounds; Good = last op only
    // ============================================================
    var PID_D = 'PL-TEST-DASH-D';
    var olD = [
      { palletId: PID_D, mo: 'MO-D', opNo: '0010', good: 10, scrap: 1, repair: 0, awaitConv: 0, pdResult: '' },
      { palletId: PID_D, mo: 'MO-D', opNo: '0020', good: 9,  scrap: 2, repair: 0, awaitConv: 0, pdResult: '' },
      { palletId: PID_D, mo: 'MO-D', opNo: '0030', good: 8,  scrap: 1, repair: 0, awaitConv: 0, pdResult: '' }
    ];
    var pmD = [{ palletId: PID_D, mo: 'MO-D', material: 'MAT-D', materialName: 'Mat D', unit: 'PC',
      scannedDateStr: TODAY, prodDateStr: '', qcResult: '', qcResultNote: '', qcInspector: '',
      pmGood: 8, pmScrap: 4, pmRepair: 0, pmAwaitConv: 0, qtyPerPallet: 12, hasPmMirror: true }];
    var lastOpD = {};
    lastOpD[PID_D] = { opNo: '0030', loggedAt: _dashMkBkkDate_(TODAY, '12:00:00'),
      machineCode: '', machineName: '', sapWC: '', wcSource: 'RAW' };
    var aggD = _buildDashboardAggregates_(TODAY, olD, pmD, lastOpD, {});
    var deptEntryD = aggD.departments.filter(function(d) { return d.department === 'ไม่ทราบแผนก'; })[0];
    assert('(4) Scrap summed across all ops (1+2+1=4)', !!deptEntryD && deptEntryD.defectQty === 4,
      deptEntryD ? 'got=' + deptEntryD.defectQty : 'no entry');
    assert('(4) Good = last op only (8, not summed)', !!deptEntryD && deptEntryD.goodQty === 8,
      deptEntryD ? 'got=' + deptEntryD.goodQty : 'no entry');

    // ============================================================
    // (5) Last-op LoggedAt != dateStr → excluded from departments[],
    //     still counted in cumulative qcByDepartment[]
    // ============================================================
    var PID_E = 'PL-TEST-DASH-E';
    var olE = [{ palletId: PID_E, mo: 'MO-E', opNo: '0010', good: 5, scrap: 0, repair: 0, awaitConv: 0, pdResult: '' }];
    var pmE = [{ palletId: PID_E, mo: 'MO-E', material: 'MAT-E', materialName: 'Mat E', unit: 'PC',
      scannedDateStr: YESTERDAY, prodDateStr: '', qcResult: 'FAIL', qcResultNote: 'test', qcInspector: 'TEST',
      pmGood: 5, pmScrap: 0, pmRepair: 0, pmAwaitConv: 0, qtyPerPallet: 5, hasPmMirror: true }];
    var lastOpE = {};
    lastOpE[PID_E] = { opNo: '0010', loggedAt: _dashMkBkkDate_(YESTERDAY, '09:00:00'),
      machineCode: '', machineName: '', sapWC: '', wcSource: 'RAW' };
    var aggE = _buildDashboardAggregates_(TODAY, olE, pmE, lastOpE, {});
    var deptTotalPalletsE = aggE.departments.reduce(function(s, d) { return s + d.palletCount; }, 0);
    assert('(5) excluded from departments[] (last-op date != dateStr)', deptTotalPalletsE === 0,
      'palletCount total=' + deptTotalPalletsE);
    var qcEntryE = aggE.qcByDepartment.filter(function(d) { return d.department === 'ไม่ทราบแผนก'; })[0];
    assert('(5) included in cumulative qcByDepartment[]', !!qcEntryE && qcEntryE.fail === 1,
      qcEntryE ? 'fail=' + qcEntryE.fail : 'no entry');

    // ============================================================
    // (6) deadLetterOpenCount matches manually-seeded OPEN rows
    // Writes raw rows directly (not via captureDeadLetter_, which also
    // fires a live Lark webhook notification — undesirable side effect
    // for a test fixture).
    // ============================================================
    var before = getDashboardData_(TODAY);
    assert('(6) baseline getDashboardData_ does not error', before && before.error !== true,
      before && before.message ? before.message : '');
    var baselineOpen = (before && !before.error) ? before.deadLetterOpenCount : 0;

    var dlSh = ensureDeadLetterSheet_();
    function seedDl(palletId, replayStatus) {
      var row = DL_HEADERS_.map(function(h) {
        if (h === 'DLID')         return 'DL-' + palletId + '-' + Date.now();
        if (h === 'CapturedAt')   return new Date();
        if (h === 'Path')         return 'TEST';
        if (h === 'PalletID')     return palletId;
        if (h === 'Outcome')      return 'TEST_FIXTURE';
        if (h === 'ReplayStatus') return replayStatus;
        return '';
      });
      dlSh.appendRow(row);
    }
    seedDl(DL_TAG_PREFIX + '1', 'OPEN');
    seedDl(DL_TAG_PREFIX + '2', 'OPEN');
    seedDl(DL_TAG_PREFIX + '3', 'REPLAYED');
    SpreadsheetApp.flush();

    var after = getDashboardData_(TODAY);
    assert('(6) getDashboardData_ after seeding does not error', after && after.error !== true,
      after && after.message ? after.message : '');
    if (after && !after.error) {
      assert('(6) deadLetterOpenCount increased by exactly 2 (OPEN rows only)',
        after.deadLetterOpenCount === baselineOpen + 2,
        'before=' + baselineOpen + ' after=' + after.deadLetterOpenCount);
    }

    // ============================================================
    // (7) Malformed dateStr → graceful {error:true,...}, never throws
    // ============================================================
    var badResult = getDashboardData_('not-a-date');
    assert('(7) malformed dateStr → error:true', !!badResult && badResult.error === true, JSON.stringify(badResult));
    assert('(7) malformed dateStr → has message', !!badResult && typeof badResult.message === 'string' && badResult.message.length > 0);

    // ============================================================
    // (8) qcByDepartment[] cache: populated after first call, second call
    // returns an identical qcByDepartment[] via cache. Elapsed-time can't be
    // measured reliably here, so cache presence + value equality stand in
    // for "the second call didn't recompute".
    // ============================================================
    CacheService.getScriptCache().remove(QC_BY_DEPT_CACHE_KEY_); // clean slate
    var cacheCall1 = getDashboardData_(TODAY);
    assert('(8) first call does not error', cacheCall1 && cacheCall1.error !== true,
      cacheCall1 && cacheCall1.message ? cacheCall1.message : '');
    var cachedAfterFirst = CacheService.getScriptCache().get(QC_BY_DEPT_CACHE_KEY_);
    assert('(8) qcByDepartment[] cache populated after first call', !!cachedAfterFirst);

    var cacheCall2 = getDashboardData_(TODAY);
    assert('(8) second call does not error', cacheCall2 && cacheCall2.error !== true,
      cacheCall2 && cacheCall2.message ? cacheCall2.message : '');
    if (cacheCall1 && !cacheCall1.error && cacheCall2 && !cacheCall2.error) {
      assert('(8) qcByDepartment[] identical across both calls (served from cache)',
        JSON.stringify(cacheCall1.qcByDepartment) === JSON.stringify(cacheCall2.qcByDepartment),
        'call1=' + JSON.stringify(cacheCall1.qcByDepartment) + ' call2=' + JSON.stringify(cacheCall2.qcByDepartment));
    }

    // ============================================================
    // (9) TRANSFERRED transfer today → appears in BOTH transferIssuedBySloc
    //     (under SourceSLoc) and transferReceivedBySloc (under DestSLoc),
    //     with correct qty. Pure-function test (_buildTransferSlocAggregates_),
    //     synthetic rows only — no sheet write needed.
    // ============================================================
    var tlF = [
      { status: 'TRANSFERRED', updatedAt: _dashMkBkkDate_(TODAY, '13:00:00'),
        sourceSloc: 'PL-TEST-DASH-SLOC-X', destSloc: 'PL-TEST-DASH-SLOC-Y', issueQty: 50 }
    ];
    var aggF = _buildTransferSlocAggregates_(TODAY, tlF);
    var issuedX = aggF.transferIssuedBySloc.filter(function(x) { return x.sloc === 'PL-TEST-DASH-SLOC-X'; })[0];
    var recvY   = aggF.transferReceivedBySloc.filter(function(x) { return x.sloc === 'PL-TEST-DASH-SLOC-Y'; })[0];
    assert('(9) TRANSFERRED row appears in transferIssuedBySloc under SourceSLoc', !!issuedX && issuedX.qty === 50,
      issuedX ? 'qty=' + issuedX.qty : 'no entry');
    assert('(9) TRANSFERRED row appears in transferReceivedBySloc under DestSLoc', !!recvY && recvY.qty === 50,
      recvY ? 'qty=' + recvY.qty : 'no entry');

    // ============================================================
    // (10) Status=ISSUED (not TRANSFERRED) today, UpdatedAt bumped by a
    //      simulated failed retry → excluded from BOTH lists (proves the
    //      Status+UpdatedAt combined filter, not UpdatedAt alone).
    // ============================================================
    var tlG = [
      { status: 'ISSUED', updatedAt: _dashMkBkkDate_(TODAY, '14:00:00'),
        sourceSloc: 'PL-TEST-DASH-SLOC-Z', destSloc: 'PL-TEST-DASH-SLOC-W', issueQty: 30 }
    ];
    var aggG = _buildTransferSlocAggregates_(TODAY, tlG);
    var issuedZ = aggG.transferIssuedBySloc.filter(function(x) { return x.sloc === 'PL-TEST-DASH-SLOC-Z'; })[0];
    var recvW   = aggG.transferReceivedBySloc.filter(function(x) { return x.sloc === 'PL-TEST-DASH-SLOC-W'; })[0];
    assert('(10) Status=ISSUED excluded from transferIssuedBySloc despite today UpdatedAt', !issuedZ,
      issuedZ ? JSON.stringify(issuedZ) : 'correctly absent');
    assert('(10) Status=ISSUED excluded from transferReceivedBySloc despite today UpdatedAt', !recvW,
      recvW ? JSON.stringify(recvW) : 'correctly absent');

    // ============================================================
    // (11) GR'd pallet (GRMaterialDocument non-empty) confirmed today →
    //      appears in grReceivedBySlocApprox under its StorageLocation.
    //      Pure-function test (_buildGrSlocAggregates_), synthetic pmRows +
    //      grFieldsByPallet only — no sheet write needed.
    // ============================================================
    var PID_GR1 = 'PL-TEST-DASH-GR-1';
    var pmRowsH = [{ palletId: PID_GR1 }];
    var grFieldsH = {};
    grFieldsH[PID_GR1] = { storageLocation: 'PW30', grMaterialDocument: '5000012345', confirmedAt: _dashMkBkkDate_(TODAY, '08:00:00') };
    var aggH = _buildGrSlocAggregates_(TODAY, pmRowsH, grFieldsH);
    var slocPW30 = aggH.filter(function(x) { return x.sloc === 'PW30'; })[0];
    assert('(11) GR\'d pallet appears in grReceivedBySlocApprox under its StorageLocation',
      !!slocPW30 && slocPW30.palletCount === 1, slocPW30 ? JSON.stringify(slocPW30) : 'no entry');

    // ============================================================
    // (12) GR'd pallet with empty StorageLocation → lands in 'ไม่ทราบคลัง'
    //      bucket, not dropped.
    // ============================================================
    var PID_GR2 = 'PL-TEST-DASH-GR-2';
    var pmRowsI = [{ palletId: PID_GR2 }];
    var grFieldsI = {};
    grFieldsI[PID_GR2] = { storageLocation: '', grMaterialDocument: '5000012346', confirmedAt: _dashMkBkkDate_(TODAY, '08:30:00') };
    var aggI = _buildGrSlocAggregates_(TODAY, pmRowsI, grFieldsI);
    var slocUnknown = aggI.filter(function(x) { return x.sloc === 'ไม่ทราบคลัง'; })[0];
    assert('(12) empty StorageLocation lands in ไม่ทราบคลัง bucket, not dropped',
      !!slocUnknown && slocUnknown.palletCount === 1, slocUnknown ? JSON.stringify(slocUnknown) : 'no entry');

    // ============================================================
    // Smoke — live call against production data, structural shape only
    // ============================================================
    var live = getDashboardData_();
    assert('(smoke) live call (no args, defaults to today) does not error', live && live.error !== true,
      live && live.message ? live.message : '');
    if (live && !live.error) {
      assert('(smoke) date === today', live.date === TODAY, 'got=' + live.date);
      assert('(smoke) departments is array', Array.isArray(live.departments));
      assert('(smoke) qcByDepartment is array', Array.isArray(live.qcByDepartment));
      assert('(smoke) transferIssuedBySloc is array', Array.isArray(live.transferIssuedBySloc));
      assert('(smoke) transferReceivedBySloc is array', Array.isArray(live.transferReceivedBySloc));
      assert('(smoke) grReceivedBySlocApprox is array', Array.isArray(live.grReceivedBySlocApprox));
      assert('(smoke) JSON serializable', (function() {
        try { JSON.stringify(live); return true; } catch (e) { return false; }
      })());
    }

  } catch (e) {
    assert('test execution', false, e.message + '\n' + (e.stack || ''));
  }

  // ── Cleanup: DeadLetter test rows only (nothing else was written to any sheet) ──
  try {
    var dlSh2 = getSpreadsheet_().getSheetByName('DeadLetter');
    if (dlSh2 && dlSh2.getLastRow() >= 2) {
      var dlData = dlSh2.getDataRange().getValues();
      var pidCol = dlData[0].indexOf('PalletID');
      if (pidCol >= 0) {
        for (var dr = dlData.length - 1; dr >= 1; dr--) {
          if (String(dlData[dr][pidCol] || '').indexOf(DL_TAG_PREFIX) === 0) {
            dlSh2.deleteRow(dr + 1);
          }
        }
      }
    }
    Logger.log('Cleanup: ' + DL_TAG_PREFIX + '* rows deleted from DeadLetter');
  } catch (cleanErr) {
    Logger.log('Cleanup error (DeadLetter): ' + cleanErr.message);
  }

  Logger.log('');
  Logger.log('========================================');
  Logger.log('TEST_dashboardData_: ' + (pass ? 'ALL PASS' : 'SOME FAILED'));
  Logger.log('========================================');
  for (var si = 0; si < results.length; si++) {
    Logger.log((results[si].ok ? '  PASS' : '  FAIL') + ' — ' + results[si].name +
      (results[si].detail ? ' (' + results[si].detail + ')' : ''));
  }
  return pass;
}

/**
 * OperationLog.gs — Phase 3 scaffold
 * ====================================
 * Append-only log for intermediate operation confirmations (outside SAP by design).
 *
 * Design intent:
 *   Only the FINAL operation of each pallet is confirmed in SAP (Phase 3).
 *   All preceding operations (OP/PD/QC per routing step) are logged here and
 *   displayed on the mobile scanner UI. No SAP write occurs in logOperation().
 *
 * Idempotency key: LogID = {PalletID}-{OperationNo}-{Role}-{timestamp-ms}
 *   Timestamp-ms ensures uniqueness per entry; PalletID+OperationNo+Role
 *   allows filtering all entries for a given pallet/step/role combination.
 */

const OL_SHEET = 'OperationLog';
const OL_HEADERS = [
  'LogID', 'PalletID', 'ManufacturingOrder', 'OperationNo', 'OperationText',
  'GoodQty', 'ScrapQty', 'RepairQty', 'AwaitConvQty',
  'Operator', 'Role', 'Result', 'LoggedAt', 'Source',
  'PDResult', 'PDInspector', 'PDNote', 'PDTimestamp',
  'ActualMachine',
  // Local per-operation cumulative confirmation (LOCAL_OP_CUMULATIVE_ENABLED,
  // gated in WebApp.gs confirmScan) — additive, appended at the end. Rows
  // written before this flag existed have both columns blank; see
  // backfillOperationLogRoundColumns_() for the one-time manual backfill.
  'RoundNumber', 'IsFinalRound'
];

// ============================================================================
// Sheet bootstrap
// ============================================================================

/**
 * Create the OperationLog sheet if missing, or migrate an existing sheet by
 * appending any PD columns it doesn't have yet (idempotent — safe to call on
 * every read/write, never touches existing data rows).
 */
function ensureOperationLogSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(OL_SHEET);
  if (!sh) {
    sh = ss.insertSheet(OL_SHEET);
    sh.getRange(1, 1, 1, OL_HEADERS.length)
      .setValues([OL_HEADERS])
      .setFontWeight('bold')
      .setBackground('#0b5394')
      .setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 220);
    _forceTextColumns_(sh, OL_HEADERS);
    return sh;
  }

  const lastCol = sh.getLastColumn();
  const hdr     = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const missing = OL_HEADERS.filter(function (h) { return hdr.indexOf(h) === -1; });
  if (missing.length) {
    sh.getRange(1, lastCol + 1, 1, missing.length)
      .setValues([missing])
      .setFontWeight('bold')
      .setBackground('#0b5394')
      .setFontColor('#ffffff');
  }
  _forceTextColumns_(sh, hdr.concat(missing));
  return sh;
}

/**
 * PalletID / ManufacturingOrder / OperationNo are identifier strings that
 * happen to look like pure numbers (e.g. OperationNo "0010"). Sheets'
 * setValues()/appendRow() silently re-interprets pure-digit strings as
 * numbers on write — same as typing into a cell — which strips leading
 * zeros (e.g. "0010" → 10) and breaks every later string match against
 * these columns. Forcing Plain Text format on them prevents that coercion
 * on every future write. Safe/idempotent to call repeatedly.
 */
function _forceTextColumns_(sh, headerRow) {
  const textCols = ['PalletID', 'ManufacturingOrder', 'OperationNo', 'ActualMachine'];
  const numRows  = Math.max(sh.getMaxRows() - 1, 1);
  textCols.forEach(function (name) {
    const col = headerRow.indexOf(name);
    if (col === -1) return;
    sh.getRange(2, col + 1, numRows, 1).setNumberFormat('@');
  });
}

/**
 * Canonical form for an operation number — SAP's ManufacturingOrderOperation
 * is a zero-padded 4-digit code (e.g. "0010"). Pads any pure-digit value back
 * to 4 digits so a value that Sheets already coerced to a number (10) still
 * matches the zero-padded string ("0010") coming from SAP/the routing list.
 * @param {string|number} v
 * @return {string}
 */
function _normOpNo_(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  return /^\d+$/.test(s) ? s.padStart(4, '0') : s;
}

// ============================================================================
// Schema assertion (read-only — never mutates the sheet)
// ============================================================================

/**
 * Assert that the live OperationLog header matches OL_HEADERS exactly.
 * READ-ONLY: never writes to the sheet.
 *
 * @param {string[]} [liveHeaderOverride] — if provided, used instead of reading
 *   the sheet (for tests). Otherwise reads row 1 from the live OperationLog sheet.
 * @return {{ ok:boolean, expected:string[], actual:string[], reason:string }}
 */
function assertOperationLogSchema_(liveHeaderOverride) {
  var liveHdr;

  if (liveHeaderOverride) {
    liveHdr = liveHeaderOverride.map(function(h) { return String(h).trim(); });
  } else {
    var sh = getSpreadsheet_().getSheetByName(OL_SHEET);
    if (!sh) return { ok: true, expected: OL_HEADERS, actual: [], reason: 'NO_SHEET' };
    var lastCol = sh.getLastColumn();
    if (lastCol < 1) return { ok: true, expected: OL_HEADERS, actual: [], reason: 'NO_SHEET' };
    liveHdr = sh.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(function(h) { return String(h).trim(); });
  }

  if (liveHdr.length !== OL_HEADERS.length) {
    return {
      ok: false,
      expected: OL_HEADERS,
      actual: liveHdr,
      reason: 'LENGTH ' + liveHdr.length + '!=' + OL_HEADERS.length
    };
  }

  for (var i = 0; i < OL_HEADERS.length; i++) {
    if (liveHdr[i] !== OL_HEADERS[i]) {
      return {
        ok: false,
        expected: OL_HEADERS,
        actual: liveHdr,
        reason: 'ORDER@idx' + i + ' ' + liveHdr[i] + '!=' + OL_HEADERS[i]
      };
    }
  }

  return { ok: true, expected: OL_HEADERS, actual: liveHdr, reason: 'MATCH' };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Append one operation confirmation entry (append-only, no SAP write).
 *
 * @param {Object} entry {
 *   palletId:      string   — PalletMaster PalletID
 *   mo:            string   — ManufacturingOrder
 *   operationNo:   string   — e.g. '0050'
 *   operationText: string   — e.g. 'Assembly Final Check'
 *   goodQty:       number
 *   scrapQty:      number
 *   repairQty:     number   — Phase 3.5 4-bucket
 *   awaitConvQty:  number   — Phase 3.5 4-bucket
 *   operator:      string   — employee ID or name
 *   role:          string   — 'OP' | 'PD' | 'QC'
 *   result:        string   — 'PASS' | 'FAIL'
 *   source:        string   — 'MOBILE' | 'MANUAL' | 'SYSTEM'
 *   actualMachine: string   — MachineMaster code e.g. 'APS005' (optional)
 *   roundNumber:   number   — LOCAL_OP_CUMULATIVE_ENABLED only (1..MAX_ROUNDS_PER_OP)
 *   isFinalRound:  boolean  — LOCAL_OP_CUMULATIVE_ENABLED only
 * }
 * @return {string} LogID
 */
function logOperation(entry) {
  const now   = new Date();
  const logId = `${entry.palletId}-${entry.operationNo}-${entry.role}-${now.getTime()}`;

  const vals = {
    LogID:         logId,
    PalletID:      String(entry.palletId      || '').trim(),
    ManufacturingOrder: String(entry.mo        || '').trim(),
    OperationNo:   _normOpNo_(entry.operationNo),
    OperationText: String(entry.operationText || '').trim(),
    GoodQty:       Number(entry.goodQty)  || 0,
    ScrapQty:      Number(entry.scrapQty) || 0,
    RepairQty:     Number(entry.repairQty)    || 0,
    AwaitConvQty:  Number(entry.awaitConvQty) || 0,
    Operator:      String(entry.operator  || '').trim(),
    Role:          String(entry.role      || '').trim(),
    Result:        String(entry.result    || '').trim(),
    LoggedAt:      now,
    Source:        String(entry.source    || 'SYSTEM').trim(),
    ActualMachine: String(entry.actualMachine || '').trim(),
    PDResult:      '',
    PDInspector:   '',
    PDNote:        '',
    PDTimestamp:   '',
    RoundNumber:   entry.roundNumber   != null ? Number(entry.roundNumber) : '',
    IsFinalRound:  entry.isFinalRound  != null ? Boolean(entry.isFinalRound) : ''
  };
  const row = OL_HEADERS.map(function (h) { return vals[h] !== undefined ? vals[h] : ''; });

  if (CFG.DRY_RUN) {
    logEvent('OP_LOG', '-', 'DRY_RUN', 0,
      `would log ${logId} — role=${entry.role} result=${entry.result}`);
    return logId;
  }

  const sh = ensureOperationLogSheet_();

  // Write-time guard: verify OL_HEADERS matches the live sheet header.
  // If they differ, appendRow would put data in wrong columns (data corruption).
  var chk = assertOperationLogSchema_();
  if (!chk.ok) {
    var detail = 'OL_HEADERS=[' + OL_HEADERS.join(',') + '] sheet=[' + chk.actual.join(',') + ']';
    logEvent('OL_SCHEMA_DESYNC', OL_SHEET, 'ERROR', 0, detail);
    throw new Error('OperationLog schema desync — OL_HEADERS does not match sheet header. ' + detail);
  }

  sh.appendRow(row);
  return logId;
}

/**
 * Private — append one operation log entry from WebApp/mobile scanner.
 * Always writes to sheet regardless of CFG.DRY_RUN (local log, not a SAP call).
 * @param {Object} entry — same shape as logOperation() above
 * @return {string} LogID
 */
function logOperation_(entry) {
  return logOperation(entry);
}

/**
 * Read all operation log entries for a given PalletID.
 * @param {string} palletId
 * @return {Object[]} array of entry objects (newest first)
 */
function getOperationLogForPallet(palletId) {
  const sh = getSpreadsheet_().getSheetByName(OL_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  const data = sh.getDataRange().getValues();
  const hdr  = data[0];
  const idx  = {};
  hdr.forEach((h, i) => { idx[h] = i; });

  const results = [];
  for (let r = 1; r < data.length; r++) {
    const pid = String(data[r][idx.PalletID] || '').trim();
    if (pid !== String(palletId).trim()) continue;
    results.push({
      logId:         String(data[r][idx.LogID]          || ''),
      palletId:      pid,
      mo:            String(data[r][idx.ManufacturingOrder] || ''),
      operationNo:   _normOpNo_(data[r][idx.OperationNo]),
      operationText: String(data[r][idx.OperationText]  || ''),
      goodQty:       Number(data[r][idx.GoodQty])  || 0,
      scrapQty:      Number(data[r][idx.ScrapQty]) || 0,
      operator:      String(data[r][idx.Operator]  || ''),
      role:          String(data[r][idx.Role]       || ''),
      result:        String(data[r][idx.Result]     || ''),
      loggedAt:      data[r][idx.LoggedAt],
      source:        String(data[r][idx.Source]     || '')
    });
  }
  return results.reverse(); // newest first
}

// ============================================================================
// Local per-operation cumulative confirmation (LOCAL_OP_CUMULATIVE_ENABLED)
// — additive read helpers only. getOperationLogForPallet/getOperationLogs_
// above are untouched and keep their one-row-per-operation assumption for the
// flag-OFF path.
// ============================================================================

/**
 * All OperationLog rows for one palletId+opNo, sorted by RoundNumber
 * ascending. Rows with a blank RoundNumber (pre-flag legacy rows that were
 * never backfilled) sort first, treated as round 0.
 * @param {string} palletId
 * @param {string} opNo
 * @return {Array<{logId, roundNumber:number, isFinalRound:boolean, goodQty,
 *   scrapQty, repairQty, awaitConvQty, operator, loggedAt}>}
 */
function getOperationLogRoundsForOp_(palletId, opNo) {
  palletId = String(palletId || '').trim();
  opNo     = _normOpNo_(opNo);
  if (!palletId || !opNo) return [];

  const sh = getSpreadsheet_().getSheetByName(OL_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  const data = sh.getDataRange().getValues();
  const hdr  = data[0];
  const idx  = {};
  hdr.forEach((h, i) => { idx[h] = i; });

  const rows = [];
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idx.PalletID] || '').trim() !== palletId) continue;
    if (_normOpNo_(data[r][idx.OperationNo]) !== opNo) continue;

    const rawRound = idx.RoundNumber !== undefined ? data[r][idx.RoundNumber] : '';
    rows.push({
      logId:        String(data[r][idx.LogID] || ''),
      roundNumber:  rawRound === '' || rawRound == null ? 0 : Number(rawRound),
      isFinalRound: idx.IsFinalRound !== undefined && data[r][idx.IsFinalRound] === true,
      goodQty:      Number(data[r][idx.GoodQty])      || 0,
      scrapQty:     Number(data[r][idx.ScrapQty])     || 0,
      repairQty:    Number(data[r][idx.RepairQty])    || 0,
      awaitConvQty: Number(data[r][idx.AwaitConvQty]) || 0,
      operator:     String(data[r][idx.Operator] || ''),
      loggedAt:     data[r][idx.LoggedAt]
    });
  }

  rows.sort(function (a, b) { return a.roundNumber - b.roundNumber; });
  return rows;
}

/**
 * Cumulative qty confirmed so far for one palletId+opNo, across all rounds
 * logged (sum of all 4 buckets on every row). Never stores a running total —
 * always computed fresh from getOperationLogRoundsForOp_() to avoid a second
 * source of truth alongside the per-round raw values.
 * @param {string} palletId
 * @param {string} opNo
 * @return {{cumulativeQty:number, roundsUsed:number, hasFinalRound:boolean}}
 */
function getCumulativeQtyForOp_(palletId, opNo) {
  const rounds = getOperationLogRoundsForOp_(palletId, opNo);
  const cumulativeQty = rounds.reduce(function (sum, r) {
    return sum + r.goodQty + r.scrapQty + r.repairQty + r.awaitConvQty;
  }, 0);
  const hasFinalRound = rounds.some(function (r) { return r.isFinalRound; });
  return { cumulativeQty: cumulativeQty, roundsUsed: rounds.length, hasFinalRound: hasFinalRound };
}

/**
 * True if a row with IsFinalRound=true already exists for this palletId+opNo
 * — the LOCAL_OP_CUMULATIVE_ENABLED equivalent of isOperationLogged_()'s
 * existence check. Used by confirmScan's idempotency gate, the sequential
 * gate, and checkAllOperationsDone_/lookupPallet when the flag is on — one
 * helper, reused everywhere, so all three call sites agree on what "done"
 * means under cumulative rounds.
 * @param {string} palletId
 * @param {string} opNo
 * @return {boolean}
 */
function isOperationFinallyLogged_(palletId, opNo) {
  return getCumulativeQtyForOp_(palletId, opNo).hasFinalRound;
}

/**
 * Menu-only, manual, one-time backfill: stamps RoundNumber=1 and
 * IsFinalRound=TRUE on every existing OperationLog row that predates the
 * RoundNumber/IsFinalRound columns (blank RoundNumber cell). Safe because
 * under the pre-existing single-round exact-match system, every row WAS by
 * definition a complete, final, single-round confirmation — this just makes
 * that fact explicit so getOperationLogRoundsForOp_/getCumulativeQtyForOp_
 * treat old rows the same way as new cumulative-mode rows.
 * NOT run automatically — call from the Apps Script editor or menu only.
 * @return {{scanned:number, backfilled:number}}
 */
function backfillOperationLogRoundColumns_() {
  const sh = ensureOperationLogSheet_(); // migrates missing columns first
  if (sh.getLastRow() < 2) return { scanned: 0, backfilled: 0 };

  const data = sh.getDataRange().getValues();
  const hdr  = data[0];
  const idx  = {};
  hdr.forEach((h, i) => { idx[h] = i; });

  let scanned = 0;
  let backfilled = 0;
  for (let r = 1; r < data.length; r++) {
    scanned++;
    const rawRound = data[r][idx.RoundNumber];
    if (rawRound !== '' && rawRound != null) continue; // already has a round — skip

    const rowNum = r + 1;
    sh.getRange(rowNum, idx.RoundNumber  + 1).setValue(1);
    sh.getRange(rowNum, idx.IsFinalRound + 1).setValue(true);
    backfilled++;
    logEvent('OL_BACKFILL_ROUNDS', OL_SHEET, 'OK', 0,
      'row=' + rowNum + ' logId=' + String(data[r][idx.LogID] || ''));
  }

  logEvent('OL_BACKFILL_ROUNDS', OL_SHEET, 'DONE', 0,
    'scanned=' + scanned + ' backfilled=' + backfilled);
  return { scanned: scanned, backfilled: backfilled };
}

/** Menu-callable wrapper for backfillOperationLogRoundColumns_(). */
function runBackfillOperationLogRoundColumns() {
  const result = backfillOperationLogRoundColumns_();
  SpreadsheetApp.getUi().alert(
    '✅ Backfill RoundNumber/IsFinalRound เสร็จสิ้น\n\n' +
    'ตรวจสอบทั้งหมด: ' + result.scanned + ' แถว\n' +
    'Backfill แล้ว: ' + result.backfilled + ' แถว'
  );
}

/**
 * Per-operation log entries for a pallet, shaped for the Scanner.html/
 * Desktop.html timeline and sequential-gate checks. Under the flag-OFF
 * single-round system this is one row per OperationNo (written once by
 * confirmScan() via logOperation_(), then updated in place by updatePdResult_()
 * when PD inspects it). Under LOCAL_OP_CUMULATIVE_ENABLED an operation can
 * have up to CFG.MAX_ROUNDS_PER_OP rows (one per round) — roundNumber/
 * isFinalRound/the 4 bucket qtys are included so the client can compute
 * cumulative progress and round-aware "is this op done" checks itself
 * (Scanner.html's _findOpLog/_opRoundState, Desktop.html's equivalents)
 * without an extra round-trip. Legacy/flag-OFF rows have roundNumber=0 and
 * isFinalRound=false when blank (never backfilled) — harmless for OFF-mode
 * consumers, which only check plain row existence.
 * OFF (LOCAL_OP_CUMULATIVE_ENABLED=false): returns the original 7-field shape
 * only (operationNo, status, pdResult, opBy, pdBy, pdNote, timestamp) —
 * byte-identical to pre-feature commit 9f8732e. ON: adds roundNumber/
 * isFinalRound/the 4 bucket qtys described above.
 * @param {string} palletId
 * @return {Array<{operationNo:string, status:string, pdResult:string|null,
 *   opBy:string, pdBy:string, pdNote:string, timestamp:string,
 *   roundNumber:number=, isFinalRound:boolean=, goodQty:number=, scrapQty:number=,
 *   repairQty:number=, awaitConvQty:number=}>}
 */
function getOperationLogs_(palletId) {
  palletId = String(palletId || '').trim();
  if (!palletId) return [];

  const sh = getSpreadsheet_().getSheetByName(OL_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];

  const data = sh.getDataRange().getValues();
  const hdr  = data[0];
  const idx  = {};
  hdr.forEach((h, i) => { idx[h] = i; });

  if (idx.PalletID === undefined || idx.OperationNo === undefined) {
    logError('getOperationLogs_', 'OperationLog', 'Required column missing', 'headers=' + hdr.join(','));
    return [];
  }

  const cumulativeOn = isLocalOpCumulativeEnabled_();
  const results = [];
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idx.PalletID] || '').trim() !== palletId) continue;
    const pdResult = String(data[r][idx.PDResult] || '').trim();
    const row = {
      operationNo: _normOpNo_(data[r][idx.OperationNo]),
      status:      String(data[r][idx.Result]      || ''),
      pdResult:    pdResult || null,
      opBy:        String(data[r][idx.Operator]     || ''),
      pdBy:        String(data[r][idx.PDInspector]  || ''),
      pdNote:      String(data[r][idx.PDNote]       || ''),
      timestamp:   _fmtLogTimestamp_(data[r][idx.LoggedAt])
    };
    if (cumulativeOn) {
      const rawRound = idx.RoundNumber !== undefined ? data[r][idx.RoundNumber] : '';
      row.roundNumber  = rawRound === '' || rawRound == null ? 0 : Number(rawRound);
      row.isFinalRound = idx.IsFinalRound !== undefined && data[r][idx.IsFinalRound] === true;
      row.goodQty      = Number(data[r][idx.GoodQty])      || 0;
      row.scrapQty     = Number(data[r][idx.ScrapQty])     || 0;
      row.repairQty    = Number(data[r][idx.RepairQty])    || 0;
      row.awaitConvQty = Number(data[r][idx.AwaitConvQty]) || 0;
    }
    results.push(row);
  }
  return results;
}

/**
 * Write PD inspection result onto the OperationLog row that confirmScan()
 * already created for this pallet+operation. Rejects if OP hasn't confirmed
 * yet (no row) or PD already inspected (PDResult already set) — PD columns
 * are write-once per row, same as the OP columns.
 *
 * OFF (LOCAL_OP_CUMULATIVE_ENABLED=false): unchanged — finds the first row
 * (by sheet row order) matching palletId+operationNo. Under the single-round
 * system confirmScan's idempotency gate guarantees at most one such row, so
 * "first match" and "only match" are the same row in normal operation.
 *
 * ON: an operation can have up to CFG.MAX_ROUNDS_PER_OP rows (one per round).
 * Only the row with IsFinalRound=true is eligible for PD inspection — partial
 * rounds are skipped even if matched, since PD inspects the completed
 * operation, not an in-progress round. If no final-round row exists yet
 * (shouldn't happen — the QC/PD-unlock gate in WebApp.gs should have blocked
 * access before all rounds completed — but checked defensively anyway), this
 * returns a clear error instead of silently updating a partial-round row.
 *
 * @param {string} palletId
 * @param {string} operationNo
 * @param {string} result    'PASS' | 'FAIL'
 * @param {string} inspector
 * @param {string} note
 * @return {{ok: boolean, message: string|null}}
 */
function updatePdResult_(palletId, operationNo, result, inspector, note) {
  palletId    = String(palletId || '').trim();
  operationNo = _normOpNo_(operationNo);

  const sh = ensureOperationLogSheet_();
  if (sh.getLastRow() < 2) {
    return { ok: false, message: 'ยังไม่มีการบันทึกงานสำหรับขั้นตอนนี้' };
  }

  const data = sh.getDataRange().getValues();
  const hdr  = data[0];
  const idx  = {};
  hdr.forEach((h, i) => { idx[h] = i; });

  const cumulativeOn = isLocalOpCumulativeEnabled_();
  let targetRowNum = -1;

  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idx.PalletID] || '').trim() !== palletId) continue;
    if (_normOpNo_(data[r][idx.OperationNo]) !== operationNo)    continue;

    if (cumulativeOn) {
      const isFinalRound = idx.IsFinalRound !== undefined && data[r][idx.IsFinalRound] === true;
      if (!isFinalRound) continue; // partial round — keep scanning for the final one
    }

    targetRowNum = r + 1; // data[] includes header at index 0, so sheet row = r+1
    break;
  }

  if (targetRowNum === -1) {
    return cumulativeOn
      ? { ok: false, message: 'ยังไม่มีรอบสุดท้ายของขั้นตอนนี้ — บันทึกยังไม่ครบจำนวนต่อพาเลท' }
      : { ok: false, message: 'ยังไม่มีการบันทึกงานสำหรับขั้นตอนนี้' };
  }

  if (String(data[targetRowNum - 1][idx.PDResult] || '').trim()) {
    return { ok: false, message: 'PD ตรวจขั้นตอนนี้แล้ว' };
  }

  sh.getRange(targetRowNum, idx.PDResult    + 1).setValue(result);
  sh.getRange(targetRowNum, idx.PDInspector + 1).setValue(inspector);
  sh.getRange(targetRowNum, idx.PDNote      + 1).setValue(note);
  sh.getRange(targetRowNum, idx.PDTimestamp + 1).setValue(new Date());
  return { ok: true, message: null };
}

/** Format a Date or string as 'dd/MM/yyyy HH:mm' for JSON transfer to the UI */
function _fmtLogTimestamp_(d) {
  if (!d) return '';
  if (d instanceof Date) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
  }
  return String(d);
}

// ============================================================================
// Phase 3.5 Gate 5A — Reorder OperationLog bucket columns
// ============================================================================

/** @const {string[]} Target header order after reorder (18 cols). */
var OL_TARGET_ORDER_ = [
  'LogID', 'PalletID', 'ManufacturingOrder', 'OperationNo', 'OperationText',
  'GoodQty', 'ScrapQty', 'RepairQty', 'AwaitConvQty',
  'Operator', 'Role', 'Result', 'LoggedAt', 'Source',
  'PDResult', 'PDInspector', 'PDNote', 'PDTimestamp',
  'ActualMachine'
];

/**
 * Reorder OperationLog columns so RepairQty + AwaitConvQty sit next to ScrapQty.
 * Data-preserving: reads all rows keyed by header name, rebuilds in target order.
 * Creates a timestamped backup before any change. Spot-checks 3 rows after.
 * @return {Object} JSON-safe result
 */
function reorderOperationLogBuckets() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var sh = ss.getSheetByName(OL_SHEET);
  if (!sh) {
    return _olReorderResult_('PRECONDITION_FAILED', { detail: 'OperationLog sheet not found' });
  }

  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) {
    return _olReorderResult_('PRECONDITION_FAILED', { detail: 'Sheet is empty' });
  }

  // ---- Read current headers ----
  var oldHeaders = sh.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  if (oldHeaders.length !== OL_TARGET_ORDER_.length) {
    return _olReorderResult_('PRECONDITION_FAILED', {
      detail: 'Expected 18 headers, found ' + oldHeaders.length,
      currentHeaders: oldHeaders
    });
  }

  // Verify all target headers exist in current sheet
  for (var t = 0; t < OL_TARGET_ORDER_.length; t++) {
    if (oldHeaders.indexOf(OL_TARGET_ORDER_[t]) === -1) {
      return _olReorderResult_('PRECONDITION_FAILED', {
        detail: 'Missing header: ' + OL_TARGET_ORDER_[t],
        currentHeaders: oldHeaders
      });
    }
  }

  // Check if already in target order
  var alreadyOrdered = oldHeaders.every(function (h, i) { return h === OL_TARGET_ORDER_[i]; });
  if (alreadyOrdered) {
    return _olReorderResult_('ALREADY_ORDERED', {
      detail: 'Headers already in target order',
      finalOrder: oldHeaders
    });
  }

  // ---- STEP 2: Backup ----
  var tz = 'Asia/Bangkok';
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss');
  var backupName = 'OperationLog_bak_' + stamp;
  var backupSh = sh.copyTo(ss);
  backupSh.setName(backupName);

  // ---- Read all data ----
  var allData = sh.getDataRange().getValues();
  var oldIdx = {};
  oldHeaders.forEach(function (h, i) { oldIdx[h] = i; });

  // ---- Snapshot 3 rows for spot-check (before reorder) ----
  var spotCheckRows = [];
  var checkFields = ['LogID', 'GoodQty', 'ScrapQty', 'RepairQty', 'AwaitConvQty'];
  var sampleIndices = [];
  if (lastRow >= 2) {
    sampleIndices.push(1); // first data row
    if (lastRow >= 3) sampleIndices.push(Math.floor((lastRow - 1) / 2) + 1); // middle
    if (lastRow >= 4) sampleIndices.push(lastRow - 1); // last data row (0-based in allData)
  }
  sampleIndices.forEach(function (ri) {
    if (ri >= allData.length) return;
    var snap = {};
    checkFields.forEach(function (f) {
      snap[f] = allData[ri][oldIdx[f]];
    });
    spotCheckRows.push(snap);
  });

  // ---- STEP 3: Rebuild rows in target order ----
  var newData = [OL_TARGET_ORDER_.slice()];
  for (var r = 1; r < allData.length; r++) {
    var newRow = OL_TARGET_ORDER_.map(function (h) {
      return allData[r][oldIdx[h]];
    });
    newData.push(newRow);
  }

  // ---- Write back ----
  sh.clearContents();
  sh.getRange(1, 1, newData.length, OL_TARGET_ORDER_.length).setValues(newData);

  // Re-apply header formatting
  sh.getRange(1, 1, 1, OL_TARGET_ORDER_.length)
    .setFontWeight('bold')
    .setBackground('#0b5394')
    .setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 220);
  _forceTextColumns_(sh, OL_TARGET_ORDER_);

  // ---- STEP 4: Postcondition verify ----
  var verifiedHeaders = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  var headerOk = verifiedHeaders.length === OL_TARGET_ORDER_.length &&
    verifiedHeaders.every(function (h, i) { return h === OL_TARGET_ORDER_[i]; });

  if (!headerOk) {
    return _olReorderResult_('VERIFY_FAILED', {
      detail: 'Header mismatch after reorder',
      backupSheet: backupName,
      expected: OL_TARGET_ORDER_,
      actual: verifiedHeaders
    });
  }

  // Spot-check: re-read and compare
  var newIdx = {};
  OL_TARGET_ORDER_.forEach(function (h, i) { newIdx[h] = i; });
  var newAllData = sh.getDataRange().getValues();
  var spotCheck = [];
  var spotOk = true;

  spotCheckRows.forEach(function (snap, si) {
    var ri = sampleIndices[si];
    if (ri >= newAllData.length) { spotOk = false; return; }
    var check = { logId: snap.LogID, match: true, fields: {} };
    checkFields.forEach(function (f) {
      var oldVal = snap[f];
      var newVal = newAllData[ri][newIdx[f]];
      var match = String(oldVal) === String(newVal);
      check.fields[f] = { old: oldVal, new: newVal, match: match };
      if (!match) { check.match = false; spotOk = false; }
    });
    spotCheck.push(check);
  });

  if (!spotOk) {
    return _olReorderResult_('VERIFY_FAILED', {
      detail: 'Spot-check data mismatch — restore from backup: ' + backupName,
      backupSheet: backupName,
      spotCheck: spotCheck
    });
  }

  // ---- STEP 5: Log event ----
  var resultObj = {
    status: 'OK',
    backupSheet: backupName,
    finalOrder: OL_TARGET_ORDER_,
    spotCheck: spotCheck
  };
  logEvent('REORDER_OPLOG_BUCKETS', 'OperationLog', 'OK', 0,
    JSON.stringify({ backup: backupName, order: OL_TARGET_ORDER_.join(',') }).slice(0, 500));

  return JSON.parse(JSON.stringify(resultObj));
}

/**
 * Menu-callable wrapper for reorderOperationLogBuckets.
 */
function runReorderOperationLogBuckets() {
  var result = reorderOperationLogBuckets();
  var json = JSON.stringify(result, null, 2);
  Logger.log(json);
  var escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  var html = HtmlService.createHtmlOutput(
    '<pre style="font-size:12px;white-space:pre-wrap;max-width:100%">' + escaped + '</pre>'
  ).setWidth(800).setHeight(500).setTitle('Reorder OL Buckets');
  SpreadsheetApp.getUi().showModelessDialog(html, 'Reorder OperationLog Buckets — Gate 5A');
}

function _olReorderResult_(status, extra) {
  var result = Object.assign({ status: status }, extra || {});
  logEvent('REORDER_OPLOG_BUCKETS', 'OperationLog', status, 0,
    JSON.stringify({ status: status, detail: extra.detail || '' }).slice(0, 500));
  return JSON.parse(JSON.stringify(result));
}

// ============================================================================
// Test harness — assertOperationLogSchema_ guard
// ============================================================================

/**
 * Self-cleaning test for assertOperationLogSchema_ (read-only guard).
 * Uses liveHeaderOverride only — never mutates the live OperationLog sheet.
 * Run from Apps Script Editor → select TEST_OLSchemaGuard → Run.
 */
function TEST_OLSchemaGuard() {
  var fn = 'TEST_OLSchemaGuard';
  var t0 = Date.now();

  Logger.log('');
  Logger.log('══════════════════════════════════════════');
  Logger.log(' ' + fn);
  Logger.log('══════════════════════════════════════════');

  var pass = true;
  var results = [];

  function assert(name, cond, detail) {
    var ok = !!cond;
    results.push({ name: name, ok: ok, detail: detail || '' });
    Logger.log((ok ? '✅' : '❌') + ' ' + name + (detail ? ' — ' + detail : ''));
    if (!ok) pass = false;
  }

  // Snapshot live sheet header before any test (for read-only check at the end)
  var sh = getSpreadsheet_().getSheetByName(OL_SHEET);
  var headerBefore = null;
  if (sh && sh.getLastColumn() > 0) {
    headerBefore = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(function(h) { return String(h).trim(); });
  }

  // ---- (1) Correct header → ok:true ----
  var r1 = assertOperationLogSchema_(OL_HEADERS.slice());
  assert('(1) correct header → ok:true',
    r1.ok === true,
    'ok=' + r1.ok + ' reason=' + r1.reason);

  // ---- (2) Swapped adjacent headers → ok:false with ORDER reason ----
  var swapped = OL_HEADERS.slice();
  var swapIdx = OL_HEADERS.indexOf('ActualMachine');
  var swapIdx2 = OL_HEADERS.indexOf('PDResult');
  swapped[swapIdx]  = OL_HEADERS[swapIdx2];
  swapped[swapIdx2] = OL_HEADERS[swapIdx];

  var r2 = assertOperationLogSchema_(swapped);
  assert('(2) swapped headers → ok:false',
    r2.ok === false,
    'ok=' + r2.ok + ' reason=' + r2.reason);

  var expectIdx = Math.min(swapIdx, swapIdx2);
  assert('(2) reason names offending index',
    r2.reason.indexOf('ORDER@idx' + expectIdx) >= 0,
    'reason=' + r2.reason + ' expectedIdx=' + expectIdx);

  // ---- (3) Short header (drop last col) → ok:false with LENGTH reason ----
  var short = OL_HEADERS.slice(0, -1);
  var r3 = assertOperationLogSchema_(short);
  assert('(3) short header → ok:false',
    r3.ok === false,
    'ok=' + r3.ok + ' reason=' + r3.reason);

  assert('(3) reason contains LENGTH',
    r3.reason.indexOf('LENGTH') >= 0,
    'reason=' + r3.reason);

  assert('(3) reason shows actual!=expected length',
    r3.reason.indexOf(short.length + '!=' + OL_HEADERS.length) >= 0,
    'reason=' + r3.reason);

  // ---- (4) Read-only check: live sheet header unchanged ----
  var headerAfter = null;
  if (sh && sh.getLastColumn() > 0) {
    headerAfter = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(function(h) { return String(h).trim(); });
  }

  if (headerBefore === null && headerAfter === null) {
    assert('(4) read-only: no OL sheet before or after',
      true, 'sheet does not exist — guard never touched it');
  } else {
    assert('(4) read-only: live header unchanged',
      JSON.stringify(headerBefore) === JSON.stringify(headerAfter),
      'before=' + (headerBefore ? headerBefore.length : 'null') +
      ' after=' + (headerAfter ? headerAfter.length : 'null'));
  }

  var elapsed = Date.now() - t0;
  Logger.log('');
  Logger.log('──────────────────────────────────────────');
  Logger.log(fn + ': ' + (pass ? 'ALL PASS' : 'SOME FAILED') + ' (' + elapsed + 'ms)');
  results.forEach(function(r) {
    Logger.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name);
  });
  Logger.log('──────────────────────────────────────────');

  logEvent('TEST_OL_GUARD', 'OperationLog', pass ? 'PASS' : 'FAIL', elapsed,
    results.length + ' assertions, ' + (pass ? 'all pass' : 'some failed'));
}

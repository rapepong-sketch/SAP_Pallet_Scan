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
  'GoodQty', 'ScrapQty', 'Operator', 'Role', 'Result', 'LoggedAt', 'Source',
  // Phase 3 Step 1 Enhancement v2: PD inspection columns (written by savePdInspection())
  'PDResult', 'PDInspector', 'PDNote', 'PDTimestamp',
  // Phase 3.5 Gate 3: 4-bucket yield (RepairQty + AwaitConvQty appended after PDTimestamp)
  'RepairQty', 'AwaitConvQty'
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
  const textCols = ['PalletID', 'ManufacturingOrder', 'OperationNo'];
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
 * }
 * @return {string} LogID
 */
function logOperation(entry) {
  const now   = new Date();
  const logId = `${entry.palletId}-${entry.operationNo}-${entry.role}-${now.getTime()}`;

  const row = [
    logId,
    String(entry.palletId      || '').trim(),
    String(entry.mo            || '').trim(),
    _normOpNo_(entry.operationNo),
    String(entry.operationText || '').trim(),
    Number(entry.goodQty)  || 0,
    Number(entry.scrapQty) || 0,
    String(entry.operator  || '').trim(),
    String(entry.role      || '').trim(),
    String(entry.result    || '').trim(),
    now,
    String(entry.source    || 'SYSTEM').trim(),
    '', '', '', '',
    Number(entry.repairQty)    || 0,
    Number(entry.awaitConvQty) || 0
  ];

  if (CFG.DRY_RUN) {
    logEvent('OP_LOG', '-', 'DRY_RUN', 0,
      `would log ${logId} — role=${entry.role} result=${entry.result}`);
    return logId;
  }

  const sh = ensureOperationLogSheet_();
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

/**
 * Per-operation log entries for a pallet, shaped for the Scanner.html timeline
 * and sequential-gate checks. One row per OperationNo (written once by
 * confirmScan() via logOperation_(), then updated in place by updatePdResult_()
 * when PD inspects it) — so this returns at most one entry per operation.
 * @param {string} palletId
 * @return {Array<{operationNo:string, status:string, pdResult:string|null, opBy:string, pdBy:string, pdNote:string, timestamp:string}>}
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

  const results = [];
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idx.PalletID] || '').trim() !== palletId) continue;
    const pdResult = String(data[r][idx.PDResult] || '').trim();
    results.push({
      operationNo: _normOpNo_(data[r][idx.OperationNo]),
      status:      String(data[r][idx.Result]      || ''),
      pdResult:    pdResult || null,
      opBy:        String(data[r][idx.Operator]     || ''),
      pdBy:        String(data[r][idx.PDInspector]  || ''),
      pdNote:      String(data[r][idx.PDNote]       || ''),
      timestamp:   _fmtLogTimestamp_(data[r][idx.LoggedAt])
    });
  }
  return results;
}

/**
 * Write PD inspection result onto the OperationLog row that confirmScan()
 * already created for this pallet+operation. Rejects if OP hasn't confirmed
 * yet (no row) or PD already inspected (PDResult already set) — PD columns
 * are write-once per row, same as the OP columns.
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

  for (let r = 1; r < data.length; r++) {
    if (String(data[r][idx.PalletID] || '').trim() !== palletId) continue;
    if (_normOpNo_(data[r][idx.OperationNo]) !== operationNo)    continue;

    if (String(data[r][idx.PDResult] || '').trim()) {
      return { ok: false, message: 'PD ตรวจขั้นตอนนี้แล้ว' };
    }

    const rowNum = r + 1; // data[] includes header at index 0, so sheet row = r+1
    sh.getRange(rowNum, idx.PDResult    + 1).setValue(result);
    sh.getRange(rowNum, idx.PDInspector + 1).setValue(inspector);
    sh.getRange(rowNum, idx.PDNote      + 1).setValue(note);
    sh.getRange(rowNum, idx.PDTimestamp + 1).setValue(new Date());
    return { ok: true, message: null };
  }
  return { ok: false, message: 'ยังไม่มีการบันทึกงานสำหรับขั้นตอนนี้' };
}

/** Format a Date or string as 'dd/MM/yyyy HH:mm' for JSON transfer to the UI */
function _fmtLogTimestamp_(d) {
  if (!d) return '';
  if (d instanceof Date) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
  }
  return String(d);
}

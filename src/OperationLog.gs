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
  'GoodQty', 'ScrapQty', 'Operator', 'Role', 'Result', 'LoggedAt', 'Source'
];

// ============================================================================
// Sheet bootstrap
// ============================================================================

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
  }
  return sh;
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
    String(entry.operationNo   || '').trim(),
    String(entry.operationText || '').trim(),
    Number(entry.goodQty)  || 0,
    Number(entry.scrapQty) || 0,
    String(entry.operator  || '').trim(),
    String(entry.role      || '').trim(),
    String(entry.result    || '').trim(),
    now,
    String(entry.source    || 'SYSTEM').trim()
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
      operationNo:   String(data[r][idx.OperationNo]    || ''),
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

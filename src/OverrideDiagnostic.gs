/**
 * OverrideDiagnostic.gs — Phase 3.5 (Admin Manual Override Confirm)
 * =================================================================
 * READ-ONLY diagnostic functions. No sheet writes, no SAP POST/PATCH.
 * Every UrlFetchApp call uses muteHttpExceptions:true (via existing sapGet).
 *
 * Reuses: CFG (Config.gs), PM_HEADERS (PalletGen.gs), getSheet_ (SheetSetup.gs),
 *         sapGet/fetchOperationsForMO_ (SapClient.gs/ProductionOrders.gs).
 */

/**
 * Compare PM_HEADERS (PalletGen.gs writer constant) against
 * CFG.HEADERS.PALLET_MASTER (Config.gs single source of truth).
 * Logs both arrays, whether lengths match, and every index where they differ.
 * @return {void}
 */
function diagnoseOverrideSchema() {
  Logger.log('=== diagnoseOverrideSchema ===');
  Logger.log('PM_HEADERS (' + PM_HEADERS.length + ' cols): ' + JSON.stringify(PM_HEADERS));
  Logger.log('CFG.HEADERS.PALLET_MASTER (' + CFG.HEADERS.PALLET_MASTER.length + ' cols): ' +
    JSON.stringify(CFG.HEADERS.PALLET_MASTER));

  if (PM_HEADERS.length !== CFG.HEADERS.PALLET_MASTER.length) {
    Logger.log('LENGTH MISMATCH: PM_HEADERS=' + PM_HEADERS.length +
      ' vs CFG=' + CFG.HEADERS.PALLET_MASTER.length);
  } else {
    Logger.log('LENGTH OK: both ' + PM_HEADERS.length);
  }

  var diffs = [];
  var maxLen = Math.max(PM_HEADERS.length, CFG.HEADERS.PALLET_MASTER.length);
  for (var i = 0; i < maxLen; i++) {
    var pm = i < PM_HEADERS.length ? PM_HEADERS[i] : '(missing)';
    var cfg = i < CFG.HEADERS.PALLET_MASTER.length ? CFG.HEADERS.PALLET_MASTER[i] : '(missing)';
    if (pm !== cfg) {
      diffs.push({ index: i, PM_HEADERS: pm, CFG: cfg });
    }
  }

  if (diffs.length === 0) {
    Logger.log('HEADER SYNC OK — no differences');
  } else {
    Logger.log('HEADER DIFFS (' + diffs.length + '): ' + JSON.stringify(diffs));
  }
}

/**
 * Read PalletMaster by column name and log up to 10 rows that are override
 * candidates (ScanStatus not CONFIRMED and not QC_COMPLETE).
 * For each candidate, logs a compact object with key fields plus every column
 * whose name matches the QC/inspection regex.
 * Also logs all PalletMaster column names matching that regex.
 * @return {void}
 */
function diagnoseOverrideCandidates() {
  Logger.log('=== diagnoseOverrideCandidates ===');

  var sh = getSheet_(CFG.SHEETS.PALLET_MASTER);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) {
    Logger.log('PalletMaster has no data rows');
    return;
  }

  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();

  var colIndex = {};
  hdr.forEach(function (name, i) { colIndex[name] = i; });

  var qcRegex = /qc|inspect|decision|usage|reject|hold|pass/i;
  var qcColNames = hdr.filter(function (name) { return qcRegex.test(name); });
  Logger.log('QC-related columns in PalletMaster: ' + JSON.stringify(qcColNames));

  var scanStatusIdx = colIndex['ScanStatus'];
  if (scanStatusIdx === undefined) {
    Logger.log('ScanStatus column not found in PalletMaster');
    return;
  }

  var candidates = [];
  for (var r = 0; r < data.length; r++) {
    var status = String(data[r][scanStatusIdx] || '').trim();
    if (status !== 'CONFIRMED' && status !== 'QC_COMPLETE') {
      candidates.push(data[r]);
      if (candidates.length >= 10) break;
    }
  }

  Logger.log('Override candidates (capped at 10): ' + candidates.length);

  var keyFields = [
    'PalletID', 'ManufacturingOrder', 'FinalOperation', 'Operation',
    'ScanStatus', 'ConfirmationGroup', 'ConfirmedAt'
  ];

  candidates.forEach(function (row, i) {
    var obj = {};
    keyFields.forEach(function (f) {
      if (colIndex[f] !== undefined) {
        obj[f] = row[colIndex[f]];
      }
    });
    qcColNames.forEach(function (f) {
      obj[f] = row[colIndex[f]];
    });
    Logger.log('candidate[' + i + ']: ' + JSON.stringify(obj));
  });
}

/**
 * READ-ONLY: fetch the operations of one production order from SAP and log
 * each operation's number, confirmation/system-status fields, and whether
 * it reads as confirmed. Goal: verify whether predecessor operations must
 * be confirmed before a final-op confirmation.
 * Uses existing fetchOperationsForMO_ (muteHttpExceptions via sapGet).
 * Also does a direct SAP GET with $expand on status to surface any
 * confirmation/system-status data per operation.
 * @param {string} orderId — ManufacturingOrder number e.g. '1000036350'
 * @return {void}
 */
function diagnoseOrderOpConfirmation(orderId) {
  orderId = String(orderId || '').trim();
  Logger.log('=== diagnoseOrderOpConfirmation: ' + orderId + ' ===');
  if (!orderId) {
    Logger.log('ERROR: orderId is required');
    return;
  }

  var path = CFG.ENDPOINTS.PRODUCTION_ORDERS + "('" + orderId + "')";
  var params = {
    '$expand': 'to_ProductionOrderOperation,to_ProductionOrderStatus',
    '$select': [
      'ManufacturingOrder',
      'to_ProductionOrderOperation/ManufacturingOrderOperation',
      'to_ProductionOrderOperation/MfgOrderOperationText',
      'to_ProductionOrderOperation/WorkCenter',
      'to_ProductionOrderOperation/OpPlannedTotalQuantity',
      'to_ProductionOrderOperation/OpConfirmedYieldQuantity',
      'to_ProductionOrderOperation/OperationIsConfirmed',
      'to_ProductionOrderStatus/StatusCode',
      'to_ProductionOrderStatus/StatusShortName'
    ].join(',')
  };

  var data;
  try {
    data = sapGet(path, params, 'diagnoseOrderOpConfirmation');
  } catch (e) {
    Logger.log('SAP GET failed: ' + e.message);
    return;
  }

  var d = data.d || {};

  var statuses = (d.to_ProductionOrderStatus || {}).results || [];
  Logger.log('Order-level statuses (' + statuses.length + '): ' +
    JSON.stringify(statuses.map(function (s) {
      return { code: s.StatusCode, short: s.StatusShortName };
    })));

  var ops = (d.to_ProductionOrderOperation || {}).results || [];
  ops.sort(function (a, b) {
    return parseInt(a.ManufacturingOrderOperation, 10) -
           parseInt(b.ManufacturingOrderOperation, 10);
  });

  Logger.log('Operations (' + ops.length + '):');
  ops.forEach(function (op, i) {
    var confirmedYield = parseFloat(op.OpConfirmedYieldQuantity || '0');
    var planned = parseFloat(op.OpPlannedTotalQuantity || '0');
    var isConfirmedField = op.OperationIsConfirmed;

    var looksConfirmed = false;
    if (isConfirmedField === 'X' || isConfirmedField === true) {
      looksConfirmed = true;
    } else if (planned > 0 && confirmedYield >= planned) {
      looksConfirmed = true;
    }

    Logger.log('  op[' + i + ']: ' + JSON.stringify({
      opNo: op.ManufacturingOrderOperation,
      opText: op.MfgOrderOperationText,
      workCenter: op.WorkCenter,
      plannedQty: planned,
      confirmedYield: confirmedYield,
      isConfirmedField: isConfirmedField !== undefined ? isConfirmedField : '(not in response)',
      looksConfirmed: looksConfirmed
    }));
  });
}

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

  // Step 1: GET operations from production order service (no $select — discover real fields)
  var opsPath = CFG.ENDPOINTS.PRODUCTION_ORDERS + "('" + orderId + "')/to_ProductionOrderOperation";
  var ops = [];
  try {
    var opsData = sapGet(opsPath, {}, 'diagnoseOrderOp:ops');
    ops = ((opsData.d || {}).results) || [];
    if (ops.length > 0) {
      Logger.log('First operation raw keys: ' + JSON.stringify(Object.keys(ops[0])));
    }
  } catch (e) {
    Logger.log('Operations GET failed: ' + e.message);
  }

  var opNumbers = ops.map(function (op) {
    return op.ManufacturingOrderOperation || op.OrderOperation || '?';
  });
  Logger.log('Operations (' + ops.length + '): ' + JSON.stringify(opNumbers));

  // Step 2: GET confirmations from API_PROD_ORDER_CONFIRMATION_2_SRV / ProdnOrdConf2
  var confBase = CFG.SERVICES.PROD_ORDER_CONF + 'ProdnOrdConf2';

  // 2a: discover field names from a single row
  var sampleKeys = [];
  try {
    var sample = sapGet(confBase, { '$top': '1' }, 'diagnoseOrderOp:confSample');
    var sampleResults = ((sample.d || {}).results) || [];
    if (sampleResults.length > 0) {
      sampleKeys = Object.keys(sampleResults[0]);
      Logger.log('ProdnOrdConf2 sample keys: ' + JSON.stringify(sampleKeys));
    } else {
      Logger.log('ProdnOrdConf2 returned 0 rows on sample query');
    }
  } catch (e) {
    Logger.log('Confirmation sample GET failed: ' + e.message);
  }

  // 2b: determine the order filter field
  var orderField = 'ManufacturingOrder';
  if (sampleKeys.length > 0 && sampleKeys.indexOf('ManufacturingOrder') === -1) {
    var alt = sampleKeys.filter(function (k) { return /order/i.test(k) && !/operation/i.test(k); });
    if (alt.length > 0) orderField = alt[0];
    Logger.log('Order filter field resolved to: ' + orderField);
  }

  // 2c: fetch confirmations for this order
  var confirmedOps = {};
  try {
    var confData = sapGet(confBase,
      { '$filter': orderField + " eq '" + orderId + "'" },
      'diagnoseOrderOp:conf');
    var confs = ((confData.d || {}).results) || [];
    Logger.log('Confirmations for ' + orderId + ': ' + confs.length + ' rows');
    confs.forEach(function (c, i) {
      var opNo = c.OrderOperation || c.ManufacturingOrderOperation || '?';
      confirmedOps[opNo] = true;
      Logger.log('  conf[' + i + ']: ' + JSON.stringify({
        order: c[orderField],
        operation: opNo,
        yieldQty: c.ConfirmedYieldQuantity || c.ConfirmationYieldQuantity || '(n/a)',
        confNo: c.ConfirmationGroup || c.ConfirmationCount || '(n/a)',
        isFinal: c.IsFinalConfirmation
      }));
    });
  } catch (e) {
    Logger.log('Confirmation GET failed: ' + e.message);
  }

  // Step 3: summary
  var withConf = opNumbers.filter(function (n) { return confirmedOps[n]; });
  var withoutConf = opNumbers.filter(function (n) { return !confirmedOps[n]; });
  Logger.log('SUMMARY — confirmed: [' + withConf.join(',') + '] | unconfirmed: [' + withoutConf.join(',') + ']');
}
/**
 * Editor-runnable wrapper for diagnoseOrderOpConfirmation.
 * The Apps Script Run button cannot pass arguments, so the test order ID
 * is hardcoded here. Swap for any stuck order from diagnoseOverrideCandidates().
 */
function testDiagnoseOrderOp() {
  diagnoseOrderOpConfirmation('1000034813');
}
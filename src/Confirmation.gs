/**
 * Confirmation.gs — Phase 3 Step 2b: SAP Order Confirmation payload (DRY-RUN only)
 * ===================================================================================
 * Builds the API_PROD_ORDER_CONFIRMATION_2_SRV payload for a QC-passed pallet and
 * logs it via EventLog. Gated by SAP_WRITE_ENABLED + DRY_RUN (Flags.gs) — this step
 * NEVER calls UrlFetchApp / POSTs to SAP. Live POST arrives in Step 2c.
 *
 * Reuses:
 *  - lookupPalletById_()       (PalletSheet.gs)     — PalletMaster row by PalletID
 *  - getFinalOperationCached_() (ProductionOrders.gs) — sheet-only FinalOperation cache
 *  - sapWriteEnabled_() / isDryRun_() (Flags.gs)      — feature flag readers
 *  - logEvent()                (SapClient.gs)        — EventLog writer
 */

/**
 * Normalize an operation value to a 4-digit zero-padded string (e.g. "30" → "0030").
 * @param {string|number} v — raw operation from cache (may be numeric or string)
 * @return {string} 4-digit zero-padded operation string
 */
function padOperation_(v) {
  var op = String(v).trim().replace(/\D/g, '');
  op = ('0000' + op).slice(-4);
  if (op === '0000') {
    throw new Error('padOperation_: invalid operation value "' + v + '" resolved to 0000');
  }
  return op;
}

/**
 * Build the SAP order confirmation payload for one QC-passed pallet.
 * Pure read + transform — does not call SAP or write any sheet.
 * @param {string} palletId
 * @return {{OrderID:string, OrderOperation:string, Sequence:string,
 *   ConfirmationYieldQuantity:string, ConfirmationScrapQuantity:string,
 *   ConfirmationUnit:string, Plant:string, IsFinalConfirmation:boolean,
 *   FinalConfirmationType:string}}
 */
function buildConfirmationPayload_(palletId) {
  const pallet = lookupPalletById_(palletId);
  if (!pallet) throw new Error('PalletID not found in PalletMaster: ' + palletId);

  if (pallet.ScanStatus !== 'QC_COMPLETE') {
    throw new Error('Pallet ' + palletId + ' is not eligible to confirm — ' +
      'ScanStatus=' + pallet.ScanStatus + ' (expected QC_COMPLETE)');
  }

  const mo = pallet.ManufacturingOrder;
  if (!mo) throw new Error('ManufacturingOrder is empty for PalletID: ' + palletId);
  const orderId = String(mo).trim().padStart(12, '0');

  const finalOp = getFinalOperationCached_(mo);
  if (!finalOp) {
    throw new Error('FinalOperation not cached for ManufacturingOrder: ' + mo +
      ' — cannot confirm');
  }

  const qty = pallet.QtyPerPallet;
  if (!qty || qty <= 0) {
    throw new Error('QtyPerPallet missing or invalid for PalletID: ' + palletId);
  }

  return {
    OrderID:                   orderId,
    OrderOperation:            padOperation_(finalOp),
    Sequence:                  '0',
    ConfirmationYieldQuantity: String(qty),
    ConfirmationScrapQuantity: '0',
    ConfirmationUnit:          pallet.Unit || 'PC',
    Plant:                     CFG.PLANT,
    IsFinalConfirmation:       true,
    FinalConfirmationType:     'X'
  };
}

/**
 * DRY-RUN gate for SAP order confirmation. Builds + logs the payload but
 * NEVER posts to SAP — live POST is implemented in Step 2c.
 * Behaviour matrix (flags read from Flags.gs):
 *   SAP_WRITE_ENABLED=false               → log SKIP, return undefined
 *   SAP_WRITE_ENABLED=true, DRY_RUN=true  → build + log payload, return it
 *   SAP_WRITE_ENABLED=true, DRY_RUN=false → log BLOCKED, return undefined
 * @param {string} palletId
 * @return {Object|undefined} the confirmation payload, only when dry-run fires
 */
function dryRunConfirmation_(palletId) {
  try {
    if (!sapWriteEnabled_()) {
      logEvent('CONFIRM', 'SKIP', 'SAP_WRITE_ENABLED is off');
      return;
    }

    if (isDryRun_()) {
      const payload = buildConfirmationPayload_(palletId);
      logEvent('CONFIRM', 'DRYRUN', JSON.stringify(payload));
      return payload;
    }

    logEvent('CONFIRM', 'BLOCKED', 'Live POST not implemented until Step 2c');
    return;

  } catch (e) {
    logEvent('CONFIRM', 'ERROR', e.message);
    throw e;
  }
}

/**
 * Manual test entry point — run from the Apps Script editor.
 * Replace TEST_PALLET_ID below with a real PalletID whose ScanStatus is
 * QC_COMPLETE before running, then check the Logger output / EventLog.
 */
function testDryRunConfirmation() {
  // ⚠️ REPLACE with a real QC_COMPLETE PalletID before running
  const TEST_PALLET_ID = 'PL-1000035048-L01';

  try {
    const payload = dryRunConfirmation_(TEST_PALLET_ID);
    Logger.log(JSON.stringify(payload, null, 2));
  } catch (e) {
    Logger.log('ERROR: ' + e.message);
  }
}

/**
 * One-time checker — confirms whether PalletMaster already has the columns
 * Step 2c (live writeback) will need. Does NOT create any column; reporting
 * only. Run from the Apps Script editor and read the Logger output.
 */
function checkWritebackColumns() {
  const required = [
    'GRMaterialDocument', 'GRMaterialDocumentYear', 'ConfirmationGroup',
    'ConfirmationCount', 'ConfirmedAt', 'ConfirmedBy'
  ];

  const sh  = getSheet_(PM_SHEET);
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  required.forEach(function (col) {
    const exists = hdr.indexOf(col) !== -1;
    Logger.log((exists ? 'EXISTS  : ' : 'MISSING : ') + col);
  });
}

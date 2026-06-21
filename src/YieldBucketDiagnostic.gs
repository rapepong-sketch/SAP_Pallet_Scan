/**
 * YieldBucketDiagnostic.gs — Phase 3.5 Gate 1: READ-ONLY yield-bucket diagnostic
 * ================================================================================
 * Inspects PalletMaster, OperationLog, confirmation builder, and SAP $metadata
 * to plan the 4-bucket yield migration (GoodQty, RepairQty, DefectQty, AwaitConvQty).
 * NO writes, NO schema changes, NO confirmation logic changes.
 */

/**
 * Menu-callable wrapper: runs the diagnostic and shows the JSON report in a dialog.
 */
function runYieldBucketDiagnostic() {
  const report = diagnoseYieldBuckets();
  const json = JSON.stringify(report, null, 2);
  Logger.log(json);
  const escaped = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = HtmlService.createHtmlOutput(
    '<pre style="font-size:12px;white-space:pre-wrap;max-width:100%">' + escaped + '</pre>'
  ).setWidth(900).setHeight(600).setTitle('Yield Bucket Diagnostic');
  SpreadsheetApp.getUi().showModelessDialog(html, 'Yield Bucket Diagnostic — Gate 1');
}

/**
 * READ-ONLY diagnostic for the 4-bucket yield migration.
 * Inspects sheet headers, confirmation builder, SAP metadata, and data scope.
 * @return {Object} JSON-safe diagnostic report
 */
function diagnoseYieldBuckets() {
  const report = {
    timestamp: new Date().toISOString(),
    gate: 'Phase 3.5 Gate 1 — READ-ONLY yield-bucket diagnostic',
    sections: {}
  };

  report.sections.sheetHeaders = diagnoseSheetHeaders_();
  report.sections.confirmationPayloadSource = diagnoseConfirmationSource_();
  report.sections.sapMetadata = diagnoseSapMetadata_();
  report.sections.migrationScope = diagnoseMigrationScope_();

  const summary = JSON.stringify({
    pmHeaders: report.sections.sheetHeaders.palletMaster.headerCount,
    olHeaders: report.sections.sheetHeaders.operationLog.headerCount,
    pmRows: report.sections.migrationScope.totalRows,
    metadataStatus: report.sections.sapMetadata.httpStatus
  });
  logEvent('DIAG_YIELD_BUCKETS', 'READ', summary);

  return JSON.parse(JSON.stringify(report));
}

// ============================================================================
// Section 1: Sheet location of current qty fields
// ============================================================================

/**
 * Read live headers from PalletMaster and OperationLog and identify qty-related columns.
 * @return {Object}
 */
function diagnoseSheetHeaders_() {
  const ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  const qtyPattern = /qty|quantity|good|defect|scrap|yield|repair|await|rework|variance/i;
  const statusPattern = /status|confirm|result/i;

  function inspectSheet(sheetName) {
    const sh = ss.getSheetByName(sheetName);
    if (!sh) return { error: 'Sheet not found: ' + sheetName };
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(function (h) { return String(h).trim(); })
      .filter(function (h) { return h !== ''; });
    const qtyHeaders = headers.filter(function (h) { return qtyPattern.test(h); });
    const statusHeaders = headers.filter(function (h) { return statusPattern.test(h); });
    return {
      headerCount: headers.length,
      allHeaders: headers,
      qtyRelatedHeaders: qtyHeaders,
      statusRelatedHeaders: statusHeaders
    };
  }

  var pm = inspectSheet(CFG.SHEETS.PALLET_MASTER);
  var ol = inspectSheet(CFG.SHEETS.OPERATION_LOG);

  if (!pm.error) {
    pm.keyColumns = {
      qtyPerPallet: pm.allHeaders.indexOf('QtyPerPallet') !== -1 ? 'QtyPerPallet' : '(NOT FOUND)',
      totalQuantity: pm.allHeaders.indexOf('TotalQuantity') !== -1 ? 'TotalQuantity' : '(NOT FOUND)',
      status: pm.allHeaders.indexOf('Status') !== -1 ? 'Status' : '(NOT FOUND)',
      scanStatus: pm.allHeaders.indexOf('ScanStatus') !== -1 ? 'ScanStatus' : '(NOT FOUND)',
      qcStatus: pm.allHeaders.indexOf('QCStatus') !== -1 ? 'QCStatus' : '(NOT FOUND)',
      qcResult: pm.allHeaders.indexOf('QCResult') !== -1 ? 'QCResult' : '(NOT FOUND)',
      confirmationGroup: pm.allHeaders.indexOf('ConfirmationGroup') !== -1 ? 'ConfirmationGroup' : '(NOT FOUND)',
      confirmedAt: pm.allHeaders.indexOf('ConfirmedAt') !== -1 ? 'ConfirmedAt' : '(NOT FOUND)'
    };
    pm.yieldScrapWritebackColumns = {
      note: 'PalletMaster has NO dedicated YieldQuantity or ScrapQuantity writeback column today. ' +
            'QtyPerPallet is used as the sole yield source.'
    };
  }

  if (!ol.error) {
    ol.keyColumns = {
      goodQty: ol.allHeaders.indexOf('GoodQty') !== -1 ? 'GoodQty' : '(NOT FOUND)',
      scrapQty: ol.allHeaders.indexOf('ScrapQty') !== -1 ? 'ScrapQty' : '(NOT FOUND)',
      result: ol.allHeaders.indexOf('Result') !== -1 ? 'Result' : '(NOT FOUND)'
    };
  }

  return { palletMaster: pm, operationLog: ol };
}

// ============================================================================
// Section 2: Current confirmation payload source (static analysis)
// ============================================================================

/**
 * Report how the SAP confirmation payload is currently built.
 * This is static analysis — the function reads no live data.
 * @return {Object}
 */
function diagnoseConfirmationSource_() {
  return {
    file: 'Confirmation.gs',
    functionName: 'buildConfirmationPayload_(palletId, qtyOverride)',
    sourceSheet: 'PalletMaster (via lookupPalletById_)',
    yieldSource: {
      field: 'ConfirmationYieldQuantity',
      readFrom: 'pallet.QtyPerPallet (PalletMaster column "QtyPerPallet")',
      overrideLogic: 'qtyOverride != null ? qtyOverride : pallet.QtyPerPallet',
      relevantLines: [
        'const qty = (qtyOverride != null) ? qtyOverride : pallet.QtyPerPallet;',
        "ConfirmationYieldQuantity: String(qty),"
      ]
    },
    scrapSource: {
      field: 'ConfirmationScrapQuantity',
      readFrom: 'HARDCODED "0"',
      relevantLines: [
        "ConfirmationScrapQuantity: '0',"
      ]
    },
    postTarget: {
      entitySet: 'ProdnOrdConf2',
      serviceRoot: 'CFG.SERVICES.PROD_ORDER_CONF = /sap/opu/odata/sap/API_PROD_ORDER_CONFIRMATION_2_SRV/',
      method: 'POST (entity create, not function import)',
      functionRef: 'postConfirmation_(payload) — Confirmation.gs line 133'
    },
    operationLogUsage: 'OperationLog GoodQty/ScrapQty are NOT read by confirmation builder today. ' +
      'Yield comes exclusively from PalletMaster.QtyPerPallet.'
  };
}

// ============================================================================
// Section 3: Live SAP metadata probe (READ-ONLY GET)
// ============================================================================

/**
 * GET $metadata of API_PROD_ORDER_CONFIRMATION_2_SRV and extract quantity-related fields.
 * @return {Object}
 */
function diagnoseSapMetadata_() {
  var result = {
    service: CFG.SERVICES.PROD_ORDER_CONF,
    httpStatus: null,
    entityTypes: [],
    quantityFields: [],
    reworkVarianceCheck: null,
    entitySetInfo: null,
    error: null
  };

  try {
    var creds = getSapCredentials_();
    var url = buildSapUrl_(CFG.SERVICES.PROD_ORDER_CONF + '$metadata', {});
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass)
      },
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true
    });

    result.httpStatus = resp.getResponseCode();
    if (result.httpStatus < 200 || result.httpStatus >= 300) {
      result.error = 'Non-2xx response: ' + resp.getContentText().slice(0, 300);
      return result;
    }

    var xml = resp.getContentText();

    var entityTypeNames = [];
    var etMatches = xml.match(/<EntityType\s+[^>]*Name="([^"]+)"/gi) || [];
    etMatches.forEach(function (tag) {
      var m = tag.match(/Name="([^"]+)"/);
      if (m) entityTypeNames.push(m[1]);
    });
    result.entityTypes = entityTypeNames;

    var fieldPattern = /yield|scrap|rework|variance|quantity/i;
    var propBlocks = xml.match(/<Property\s[^>]+\/>/gi) || [];
    var unclosed = xml.match(/<Property\s[^\/]*>[^<]*<\/Property>/gi) || [];
    propBlocks = propBlocks.concat(unclosed);

    var seenFields = {};
    propBlocks.forEach(function (tag) {
      var nameMatch = tag.match(/Name="([^"]+)"/);
      var typeMatch = tag.match(/Type="([^"]+)"/);
      if (!nameMatch) return;
      var name = nameMatch[1];
      if (!fieldPattern.test(name)) return;
      var key = name + '|' + (typeMatch ? typeMatch[1] : '?');
      if (seenFields[key]) return;
      seenFields[key] = true;
      result.quantityFields.push({
        name: name,
        edmType: typeMatch ? typeMatch[1] : 'unknown'
      });
    });

    var reworkPattern = /rework/i;
    var variancePattern = /variance.*quantity|quantity.*variance/i;
    var reworkFields = result.quantityFields.filter(function (f) { return reworkPattern.test(f.name); });
    var varianceFields = result.quantityFields.filter(function (f) { return variancePattern.test(f.name); });
    result.reworkVarianceCheck = {
      hasReworkField: reworkFields.length > 0,
      reworkFieldNames: reworkFields.map(function (f) { return f.name; }),
      hasVarianceQuantityField: varianceFields.length > 0,
      varianceFieldNames: varianceFields.map(function (f) { return f.name; }),
      note: 'These fields are reported for awareness only — no action taken in Gate 1.'
    };

    var entitySets = [];
    var esMatches = xml.match(/<EntitySet\s[^>]+>/gi) || [];
    esMatches.forEach(function (tag) {
      var nm = tag.match(/Name="([^"]+)"/);
      var et = tag.match(/EntityType="([^"]+)"/);
      if (nm) {
        entitySets.push({
          name: nm[1],
          entityType: et ? et[1] : 'unknown'
        });
      }
    });

    var funcImports = [];
    var fiMatches = xml.match(/<FunctionImport\s[^>]+>/gi) || [];
    fiMatches.forEach(function (tag) {
      var nm = tag.match(/Name="([^"]+)"/);
      if (nm) funcImports.push(nm[1]);
    });

    result.entitySetInfo = {
      entitySets: entitySets,
      functionImports: funcImports,
      codebaseUsesEntitySet: 'ProdnOrdConf2',
      codebaseMethod: 'POST to entity set (not function import)'
    };

  } catch (e) {
    result.error = e.message;
  }

  return result;
}

// ============================================================================
// Section 4: Migration scope
// ============================================================================

/**
 * Count PalletMaster rows and check whether QtyPerPallet == GoodQty + DefectQty
 * for existing data. Since PalletMaster has no DefectQty column today,
 * also checks OperationLog for any scrap data.
 * @return {Object}
 */
function diagnoseMigrationScope_() {
  var ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  var result = {
    totalRows: 0,
    qtyPopulatedRows: 0,
    defectColumnExists: false,
    goodDefectSumCheck: null,
    operationLogScrapSummary: null,
    sampleMismatches: []
  };

  var pmSh = ss.getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!pmSh || pmSh.getLastRow() < 2) {
    result.error = 'PalletMaster sheet not found or empty';
    return result;
  }

  var pmData = pmSh.getDataRange().getValues();
  var pmHdr = pmData[0];
  var pmIdx = {};
  pmHdr.forEach(function (h, i) { pmIdx[String(h).trim()] = i; });

  result.totalRows = pmData.length - 1;

  var qtyCol = pmIdx['QtyPerPallet'];
  var palletIdCol = pmIdx['PalletID'];

  if (qtyCol === undefined) {
    result.error = 'QtyPerPallet column not found in PalletMaster';
    return result;
  }

  var qtyPopulated = 0;
  for (var r = 1; r < pmData.length; r++) {
    var v = pmData[r][qtyCol];
    if (v !== '' && v !== null && v !== undefined && v !== 0) qtyPopulated++;
  }
  result.qtyPopulatedRows = qtyPopulated;

  var defectCandidates = ['DefectQty', 'Defect', 'DefectQuantity', 'ScrapQty', 'Scrap'];
  var foundDefectCol = null;
  for (var d = 0; d < defectCandidates.length; d++) {
    if (pmIdx[defectCandidates[d]] !== undefined) {
      foundDefectCol = defectCandidates[d];
      break;
    }
  }

  result.defectColumnExists = foundDefectCol !== null;
  result.defectColumnName = foundDefectCol || '(none in PalletMaster)';

  if (foundDefectCol) {
    var defCol = pmIdx[foundDefectCol];
    var defPopulated = 0;
    var mismatches = [];
    for (var r2 = 1; r2 < pmData.length; r2++) {
      var defVal = Number(pmData[r2][defCol]) || 0;
      if (defVal !== 0) defPopulated++;
      var qtyVal = Number(pmData[r2][qtyCol]) || 0;
      if (defVal !== 0 || qtyVal !== 0) {
        if (qtyVal !== qtyVal + defVal && mismatches.length < 5) {
          mismatches.push({
            palletId: String(pmData[r2][palletIdCol]),
            qtyPerPallet: qtyVal,
            defectQty: defVal,
            sum: qtyVal + defVal
          });
        }
      }
    }
    result.defectPopulatedRows = defPopulated;
    result.sampleMismatches = mismatches;
    result.goodDefectSumCheck = {
      note: 'Checked QtyPerPallet vs (QtyPerPallet + ' + foundDefectCol + ')',
      mismatchCount: mismatches.length,
      rule: 'QtyPerPallet is good-only today (no defect column to sum against)'
    };
  } else {
    result.goodDefectSumCheck = {
      note: 'PalletMaster has no defect/scrap column — QtyPerPallet is the only qty field. ' +
            'Sum validation not applicable until new columns are added.',
      rule: 'N/A — defect column does not exist yet'
    };
  }

  var olSh = ss.getSheetByName(CFG.SHEETS.OPERATION_LOG);
  if (olSh && olSh.getLastRow() >= 2) {
    var olData = olSh.getDataRange().getValues();
    var olHdr = olData[0];
    var olIdx = {};
    olHdr.forEach(function (h, i) { olIdx[String(h).trim()] = i; });

    var goodCol = olIdx['GoodQty'];
    var scrapCol = olIdx['ScrapQty'];
    var olTotalRows = olData.length - 1;
    var olGoodPopulated = 0;
    var olScrapPopulated = 0;
    var olScrapNonZero = 0;

    if (goodCol !== undefined && scrapCol !== undefined) {
      for (var r3 = 1; r3 < olData.length; r3++) {
        var g = olData[r3][goodCol];
        var s = olData[r3][scrapCol];
        if (g !== '' && g !== null && g !== undefined) olGoodPopulated++;
        if (s !== '' && s !== null && s !== undefined) olScrapPopulated++;
        if (Number(s) > 0) olScrapNonZero++;
      }
    }

    result.operationLogScrapSummary = {
      totalRows: olTotalRows,
      goodQtyPopulated: olGoodPopulated,
      scrapQtyPopulated: olScrapPopulated,
      scrapQtyNonZero: olScrapNonZero,
      note: 'OperationLog tracks per-operation good/scrap but is NOT used by the confirmation builder today.'
    };
  } else {
    result.operationLogScrapSummary = { note: 'OperationLog sheet not found or empty' };
  }

  return result;
}

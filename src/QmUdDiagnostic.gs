/**
 * QmUdDiagnostic.gs — Phase 4.5C: READ-ONLY diagnostic for QM Usage Decision
 * =============================================================================
 * All functions are GET-only probes. No SAP writes. No schema changes.
 * Run from Apps Script editor → select function → Run.
 */

// ============================================================================
// A1. $metadata probe — API_INSPECTIONLOT_SRV
// ============================================================================

function DIAG_inspectionLotMetadata() {
  var creds = getSapCredentials_();
  var url = CFG.SAP_BASE_URL + CFG.SERVICES.INSPECTION_LOT + '$metadata';
  console.log('FETCH_URL: ' + url);
  logEvent('DIAG_metadata', url, 'START', 0, 'Phase 4.5C diagnostic');

  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'Accept': 'application/xml'
    },
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();
  logEvent('DIAG_metadata', url, code, 0, 'length=' + body.length);

  if (code !== 200) {
    console.log('HTTP ' + code + ': ' + body.slice(0, 500));
    return;
  }

  // EntitySets
  var esets = body.match(/EntitySet Name="[^"]+"/g) || [];
  console.log('=== EntitySets (' + esets.length + ') ===');
  esets.forEach(function(e) { console.log('  ' + e); });

  // EntityTypes
  var etypes = body.match(/EntityType Name="[^"]+"/g) || [];
  console.log('=== EntityTypes (' + etypes.length + ') ===');
  etypes.forEach(function(e) { console.log('  ' + e); });

  // A_InspLotUsageDecision entity block
  var udBlock = body.match(
    /EntityType Name="A_InspLotUsageDecisionType"[\s\S]*?<\/EntityType>/
  );
  if (udBlock) {
    console.log('=== A_InspLotUsageDecisionType FOUND ===');
    var udProps = udBlock[0].match(/Property Name="[^"]+"/g) || [];
    console.log('Properties (' + udProps.length + '):');
    udProps.forEach(function(p) { console.log('  ' + p); });
    var udKeys = udBlock[0].match(/<Key>[\s\S]*?<\/Key>/);
    if (udKeys) console.log('Key block: ' + udKeys[0].replace(/\s+/g, ' '));
    // Check sap:creatable
    var creatableMatch = udBlock[0].match(/sap:creatable="([^"]+)"/);
    console.log('sap:creatable = ' + (creatableMatch ? creatableMatch[1] : 'NOT FOUND in entity'));
  } else {
    console.log('⚠️ A_InspLotUsageDecisionType NOT FOUND in metadata');
  }

  // Check sap:creatable on EntitySet level
  var udEsetMatch = body.match(/EntitySet Name="A_InspLotUsageDecision"[^>]*/);
  if (udEsetMatch) {
    console.log('EntitySet tag: ' + udEsetMatch[0]);
    var esCreatable = udEsetMatch[0].match(/sap:creatable="([^"]+)"/);
    console.log('EntitySet sap:creatable = ' + (esCreatable ? esCreatable[1] : 'NOT FOUND on EntitySet'));
  }

  // A_InspectionLot entity block
  var lotBlock = body.match(
    /EntityType Name="A_InspectionLotType"[\s\S]*?<\/EntityType>/
  );
  if (lotBlock) {
    console.log('=== A_InspectionLotType FOUND ===');
    var lotProps = lotBlock[0].match(/Property Name="[^"]+"/g) || [];
    console.log('Properties (' + lotProps.length + '):');
    lotProps.forEach(function(p) { console.log('  ' + p); });
    var lotKeys = lotBlock[0].match(/<Key>[\s\S]*?<\/Key>/);
    if (lotKeys) console.log('Key block: ' + lotKeys[0].replace(/\s+/g, ' '));
  }

  // InspectionLotWithStatus
  var statusBlock = body.match(
    /EntityType Name="InspectionLotWithStatusType"[\s\S]*?<\/EntityType>/
  );
  if (statusBlock) {
    console.log('=== InspectionLotWithStatusType FOUND ===');
    var statusProps = statusBlock[0].match(/Property Name="[^"]+"/g) || [];
    statusProps.forEach(function(p) { console.log('  ' + p); });
  } else {
    console.log('InspectionLotWithStatusType not found');
  }

  // Navigation properties
  var navs = body.match(/NavigationProperty Name="[^"]+"/g) || [];
  console.log('=== NavigationProperties (' + navs.length + ') ===');
  navs.forEach(function(n) { console.log('  ' + n); });

  // Dump full metadata for offline analysis
  console.log('=== FULL METADATA (first 15000 chars) ===');
  console.log(body.slice(0, 15000));
  if (body.length > 15000) {
    console.log('=== METADATA continued (15000-30000) ===');
    console.log(body.slice(15000, 30000));
  }

  return code;
}

// ============================================================================
// A2. Probe inspection lots for specific MOs
// ============================================================================

function DIAG_inspectionLotsForMOs() {
  var testMOs = _getQcCompleteMOs_(3);
  if (!testMOs.length) {
    console.log('⚠️ No QC_COMPLETE pallets found in PalletMaster — using hardcoded MO');
    testMOs = ['1000036346'];
  }
  console.log('Testing MOs: ' + JSON.stringify(testMOs));

  testMOs.forEach(function(mo) {
    var path = CFG.SERVICES.INSPECTION_LOT + 'A_InspectionLot';
    var params = {
      '$format': 'json',
      '$filter': "ManufacturingOrder eq '" + mo + "'",
      '$expand': 'to_InspectionLotWithStatus'
    };
    var url = buildSapUrl_(path, params);
    console.log('FETCH_URL: ' + url);
    logEvent('DIAG_lots', path, 'START', 0, 'MO=' + mo);

    var resp = sapRequest_('get', path, params, null, null, 'DIAG_lots');
    var code = resp.getResponseCode();
    var data = JSON.parse(resp.getContentText() || '{}');
    var results = (data.d && data.d.results) || [];

    console.log('=== MO ' + mo + ' → HTTP ' + code + ', lots found: ' + results.length + ' ===');

    if (results.length === 0) {
      console.log('  ⚠️ NO INSPECTION LOTS FOUND for MO ' + mo);
    }

    results.forEach(function(lot) {
      console.log('  InspectionLot:        ' + lot.InspectionLot);
      console.log('  InspectionLotOrigin:  ' + lot.InspectionLotOrigin + ' (03=in-process, 04=GR, 89=auto)');
      console.log('  InspectionLotType:    ' + (lot.InspectionLotType || '(empty)'));
      console.log('  Material:             ' + lot.Material);
      console.log('  Batch:                ' + (lot.Batch || '(empty)'));
      console.log('  Plant:                ' + lot.Plant);
      console.log('  InspLotQuantity:      ' + (lot.InspectionLotQuantity || lot.InspLotQuantity || '(?)'));
      console.log('  InspLotActualQuantity:' + (lot.InspLotActualQuantity || '(?)'));

      var status = lot.to_InspectionLotWithStatus;
      if (status && status.results && status.results.length) {
        status.results.forEach(function(s) {
          console.log('  Status: ' + JSON.stringify(s));
        });
      } else if (status && !status.results) {
        console.log('  Status (single): ' + JSON.stringify(status));
      } else {
        console.log('  Status: (no expand data)');
      }
      console.log('  --- full lot JSON ---');
      console.log('  ' + JSON.stringify(lot).slice(0, 2000));
      console.log('  ---');
    });
  });
}

// ============================================================================
// A4. Probe existing Usage Decisions
// ============================================================================

function DIAG_usageDecisions() {
  var testMOs = _getQcCompleteMOs_(2);
  if (!testMOs.length) testMOs = ['1000036346'];

  testMOs.forEach(function(mo) {
    // First get the lot number
    var lotPath = CFG.SERVICES.INSPECTION_LOT + 'A_InspectionLot';
    var lotParams = {
      '$format': 'json',
      '$filter': "ManufacturingOrder eq '" + mo + "'",
      '$select': 'InspectionLot,ManufacturingOrder'
    };
    var url = buildSapUrl_(lotPath, lotParams);
    console.log('FETCH_URL: ' + url);

    var lotResp = sapRequest_('get', lotPath, lotParams, null, null, 'DIAG_ud_lot');
    var lotData = JSON.parse(lotResp.getContentText() || '{}');
    var lots = (lotData.d && lotData.d.results) || [];

    if (!lots.length) {
      console.log('MO ' + mo + ': no lots → skip UD probe');
      return;
    }

    lots.forEach(function(lot) {
      var lotNum = lot.InspectionLot;
      var udPath = CFG.SERVICES.INSPECTION_LOT + "A_InspLotUsageDecision('" + lotNum + "')";
      var udParams = { '$format': 'json' };
      var udUrl = buildSapUrl_(udPath, udParams);
      console.log('FETCH_URL: ' + udUrl);
      logEvent('DIAG_ud', udPath, 'START', 0, 'lot=' + lotNum);

      try {
        var udResp = sapRequest_('get', udPath, udParams, null, null, 'DIAG_ud');
        var udCode = udResp.getResponseCode();
        var udBody = udResp.getContentText();
        console.log('=== UD for lot ' + lotNum + ' → HTTP ' + udCode + ' ===');
        console.log(udBody.slice(0, 3000));
      } catch (e) {
        console.log('=== UD for lot ' + lotNum + ' → ERROR: ' + e.message + ' ===');
      }
    });
  });
}

// ============================================================================
// A2b. Alternative filter: try Material+Batch+Plant if MO filter fails
// ============================================================================

function DIAG_inspectionLotsByMaterialBatch() {
  var samples = _getQcCompleteSamples_(2);
  if (!samples.length) {
    console.log('No QC_COMPLETE samples found');
    return;
  }

  samples.forEach(function(s) {
    var filter = "Material eq '" + s.material + "' and Batch eq '" + s.batch +
                 "' and Plant eq '" + s.plant + "'";
    var path = CFG.SERVICES.INSPECTION_LOT + 'A_InspectionLot';
    var params = { '$format': 'json', '$filter': filter };
    var url = buildSapUrl_(path, params);
    console.log('FETCH_URL: ' + url);

    try {
      var resp = sapRequest_('get', path, params, null, null, 'DIAG_lotByMatBatch');
      var code = resp.getResponseCode();
      var data = JSON.parse(resp.getContentText() || '{}');
      var results = (data.d && data.d.results) || [];
      console.log('=== Material=' + s.material + ' Batch=' + s.batch +
                   ' Plant=' + s.plant + ' → HTTP ' + code + ', lots=' + results.length + ' ===');
      results.forEach(function(lot) {
        console.log('  lot=' + lot.InspectionLot + ' origin=' + lot.InspectionLotOrigin +
                     ' MO=' + lot.ManufacturingOrder);
      });
    } catch (e) {
      console.log('ERROR: ' + e.message);
    }
  });
}

// ============================================================================
// B6. Check PalletMaster.InspectionLot column emptiness
// ============================================================================

function DIAG_palletMasterInspLotEmpty() {
  var sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!sh || sh.getLastRow() < 2) {
    console.log('PalletMaster empty');
    return;
  }
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var col = -1;
  for (var i = 0; i < hdr.length; i++) {
    if (String(hdr[i]).trim() === 'InspectionLot') { col = i; break; }
  }
  if (col === -1) {
    console.log('⚠️ InspectionLot column NOT FOUND in PalletMaster header');
    return;
  }
  console.log('InspectionLot column index (0-based): ' + col + ' (header row col ' + (col + 1) + ')');

  var nonEmpty = 0;
  var total = data.length - 1;
  for (var r = 1; r < data.length; r++) {
    var v = String(data[r][col] || '').trim();
    if (v) {
      nonEmpty++;
      if (nonEmpty <= 5) console.log('  Row ' + (r + 1) + ': ' + v);
    }
  }
  console.log('Total data rows: ' + total + ', InspectionLot non-empty: ' + nonEmpty);
  if (nonEmpty === 0) console.log('✅ CONFIRMED: InspectionLot column is empty across all rows');
}

// ============================================================================
// B7. InspectionLots sheet header + row count
// ============================================================================

function DIAG_inspectionLotsSheet() {
  var sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.INSPECTION_LOTS);
  if (!sh) {
    console.log('⚠️ InspectionLots sheet not found');
    return;
  }
  var lastRow = sh.getLastRow();
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  console.log('InspectionLots header: ' + JSON.stringify(hdr));
  console.log('Last row: ' + lastRow + ' → data rows: ' + (lastRow - 1));
  if (lastRow <= 1) console.log('✅ CONFIRMED: InspectionLots sheet has 0 data rows');
}

// ============================================================================
// B9. Feature-flag inventory
// ============================================================================

function DIAG_featureFlagInventory() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var keys = Object.keys(props).sort();
  console.log('=== Script Properties (' + keys.length + ') ===');
  keys.forEach(function(k) {
    // Mask credentials
    if (/PASS|SECRET|TOKEN/i.test(k)) {
      console.log('  ' + k + ' = ****');
    } else {
      console.log('  ' + k + ' = ' + props[k]);
    }
  });
  console.log('FEATURE_QM_UD exists: ' + (props.hasOwnProperty('FEATURE_QM_UD') ? 'YES → ' + props['FEATURE_QM_UD'] : 'NO'));
  console.log('FEATURE_TRANSFER311 exists: ' + (props.hasOwnProperty('FEATURE_TRANSFER311') ? 'YES → ' + props['FEATURE_TRANSFER311'] : 'NO'));
}

// ============================================================================
// Helpers — read PalletMaster for QC_COMPLETE samples
// ============================================================================

function _getQcCompleteMOs_(limit) {
  var sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var idx = {};
  hdr.forEach(function(h, i) { idx[h] = i; });
  var moCol = idx['ManufacturingOrder'];
  var ssCol = idx['ScanStatus'];
  if (moCol === undefined || ssCol === undefined) return [];

  var mos = [];
  var seen = {};
  for (var r = 1; r < data.length; r++) {
    var ss = String(data[r][ssCol] || '').trim();
    if (ss !== 'QC_COMPLETE') continue;
    var mo = String(data[r][moCol] || '').trim();
    if (!mo || seen[mo]) continue;
    if (/^PL-TEST/i.test(String(data[r][idx['PalletID']] || '').trim())) continue;
    seen[mo] = true;
    mos.push(mo);
    if (mos.length >= limit) break;
  }
  return mos;
}

function _getQcCompleteSamples_(limit) {
  var sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PALLET_MASTER);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getDataRange().getValues();
  var hdr = data[0];
  var idx = {};
  hdr.forEach(function(h, i) { idx[h] = i; });

  var samples = [];
  var seen = {};
  for (var r = 1; r < data.length; r++) {
    var ss = String(data[r][idx['ScanStatus']] || '').trim();
    if (ss !== 'QC_COMPLETE') continue;
    var mo = String(data[r][idx['ManufacturingOrder']] || '').trim();
    if (!mo || seen[mo]) continue;
    if (/^PL-TEST/i.test(String(data[r][idx['PalletID']] || '').trim())) continue;
    seen[mo] = true;
    samples.push({
      mo: mo,
      material: String(data[r][idx['Material']] || '').trim(),
      batch: String(data[r][idx['Batch']] || '').trim(),
      plant: String(data[r][idx['Plant']] || '').trim()
    });
    if (samples.length >= limit) break;
  }
  return samples;
}

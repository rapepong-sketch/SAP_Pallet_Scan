/**
 * StockCount.gs — Phase 4 Step 5: Stock Count session + SAP reconcile
 * ====================================================================
 * Operator scans pallets in a warehouse area; system compares counted qty
 * vs SAP unrestricted stock per Material+Batch+SLoc. READ for count,
 * GET-only for SAP reconcile — no POST/PATCH to SAP.
 *
 * Reuses: CFG (Config.gs), getSpreadsheet_ (SheetSetup.gs),
 *         logEvent/logError (SapClient.gs), sapGet (SapClient.gs),
 *         PM_SHEET (PalletGen.gs), tlHeaderIdx_ (TransferLog.gs)
 */

var SC_SHEET = 'StockCount';
var SC_HEADERS = [
  'SessionID', 'ScannedAt', 'ScannedBy', 'PalletID', 'Material', 'Batch',
  'SLoc', 'QtyPerPallet', 'Unit', 'QRPayload', 'Note'
];

var SCR_SHEET = 'StockCountReconcile';
var SCR_HEADERS = [
  'SessionID', 'ReconciledAt', 'SLoc', 'Material', 'Batch', 'Unit',
  'CountedQty', 'SAPQty', 'Variance', 'Status', 'SAPError'
];

var MATERIAL_STOCK_SRV_SC_ = '/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/';

// ============================================================================
// Sheet bootstrap
// ============================================================================

function ensureStockCountSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(SC_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(SC_SHEET);
  sh.getRange(1, 1, 1, SC_HEADERS.length).setValues([SC_HEADERS]);
  sh.getRange(1, 1, 1, SC_HEADERS.length)
    .setFontWeight('bold').setBackground('#d9e2f3');
  sh.setFrozenRows(1);
  logEvent('ENSURE_SHEET', SC_SHEET, 'CREATED', 0, SC_HEADERS.length + ' cols');
  return sh;
}

function ensureReconcileSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(SCR_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(SCR_SHEET);
  sh.getRange(1, 1, 1, SCR_HEADERS.length).setValues([SCR_HEADERS]);
  sh.getRange(1, 1, 1, SCR_HEADERS.length)
    .setFontWeight('bold').setBackground('#d9e2f3');
  sh.setFrozenRows(1);
  logEvent('ENSURE_SHEET', SCR_SHEET, 'CREATED', 0, SCR_HEADERS.length + ' cols');
  return sh;
}

// ============================================================================
// Helper — today's session ID for a given SLoc
// ============================================================================

function todaySessionId_(sloc) {
  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyyMMdd');
  return 'COUNT-' + dateStr + '-' + sloc;
}

// ============================================================================
// startCountSession
// ============================================================================

function startCountSession(sloc) {
  sloc = String(sloc || '').trim();
  if (!sloc) throw new Error('SLoc is required');

  var sessionId = todaySessionId_(sloc);
  var sh = ensureStockCountSheet_();

  if (sh.getLastRow() >= 2) {
    var data = sh.getDataRange().getValues();
    var idx = {};
    data[0].forEach(function (h, i) { idx[h] = i; });
    var sidCol = idx['SessionID'];
    if (sidCol !== undefined) {
      for (var r = data.length - 1; r >= 1; r--) {
        if (String(data[r][sidCol] || '').trim() === sessionId) {
          sh.deleteRow(r + 1);
        }
      }
    }
  }

  logEvent('STOCK_COUNT', 'SESSION_START', sessionId, 0, 'sloc=' + sloc);
  return sessionId;
}

// ============================================================================
// recordCountScan — called from scanner UI
// ============================================================================

function recordCountScan(palletId, sloc, scannedBy) {
  try {
    palletId  = String(palletId || '').trim();
    sloc      = String(sloc || '').trim();
    scannedBy = String(scannedBy || '').trim();

    if (!palletId) return { error: 'PalletID ว่าง' };
    if (!sloc)     return { error: 'SLoc ว่าง' };

    var pallet = lookupPalletById_(palletId);
    if (!pallet) return { error: 'ไม่พบพาเลท: ' + palletId };

    var sessionId = todaySessionId_(sloc);
    var sh = ensureStockCountSheet_();
    var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var idx = {};
    hdr.forEach(function (h, i) { idx[h] = i; });

    var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");

    var rowObj = {
      SessionID:    sessionId,
      ScannedAt:    now,
      ScannedBy:    scannedBy,
      PalletID:     palletId,
      Material:     pallet.Material,
      Batch:        pallet.Batch,
      SLoc:         sloc,
      QtyPerPallet: pallet.QtyPerPallet,
      Unit:         pallet.Unit,
      QRPayload:    pallet.QRPayload || '',
      Note:         ''
    };

    var isRescan = false;
    if (sh.getLastRow() >= 2) {
      var data = sh.getDataRange().getValues();
      var sidCol = idx['SessionID'];
      var pidCol = idx['PalletID'];
      if (sidCol !== undefined && pidCol !== undefined) {
        for (var r = 1; r < data.length; r++) {
          if (String(data[r][sidCol] || '').trim() === sessionId &&
              String(data[r][pidCol] || '').trim() === palletId) {
            var sheetRow = hdr.map(function (h) {
              return rowObj[h] !== undefined ? rowObj[h] : '';
            });
            sh.getRange(r + 1, 1, 1, sheetRow.length).setValues([sheetRow]);
            isRescan = true;
            break;
          }
        }
      }
    }

    if (!isRescan) {
      var newRow = hdr.map(function (h) {
        return rowObj[h] !== undefined ? rowObj[h] : '';
      });
      sh.getRange(sh.getLastRow() + 1, 1, 1, newRow.length).setValues([newRow]);
    }

    logEvent('STOCK_COUNT', 'SCAN', sessionId + '|' + palletId, 0,
      isRescan ? 'RESCAN' : 'NEW');

    return JSON.parse(JSON.stringify({
      success:  true,
      rescan:   isRescan,
      sessionId: sessionId,
      palletId: palletId,
      material: pallet.Material,
      batch:    pallet.Batch,
      qty:      pallet.QtyPerPallet,
      unit:     pallet.Unit,
      sloc:     sloc
    }));

  } catch (e) {
    logError('recordCountScan', SC_SHEET, e.message, palletId);
    return { error: 'เกิดข้อผิดพลาด: ' + e.message };
  }
}

// ============================================================================
// getCountSessionSummary
// ============================================================================

function getCountSessionSummary(sloc) {
  sloc = String(sloc || '').trim();
  var sessionId = todaySessionId_(sloc);
  var sh = getSpreadsheet_().getSheetByName(SC_SHEET);

  var lines = [];
  if (!sh || sh.getLastRow() < 2) {
    return JSON.parse(JSON.stringify({
      sessionId: sessionId, sloc: sloc,
      scannedAt: new Date().toISOString(), lines: lines
    }));
  }

  var data = sh.getDataRange().getValues();
  var idx = {};
  data[0].forEach(function (h, i) { idx[h] = i; });

  var groups = {};
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['SessionID']] || '').trim() !== sessionId) continue;

    var mat   = String(data[r][idx['Material']] || '').trim();
    var batch = String(data[r][idx['Batch']] || '').trim();
    var unit  = String(data[r][idx['Unit']] || '').trim();
    var qty   = Number(data[r][idx['QtyPerPallet']]) || 0;
    var pid   = String(data[r][idx['PalletID']] || '').trim();
    var key   = mat + '|' + batch;

    if (!groups[key]) {
      groups[key] = { material: mat, batch: batch, unit: unit, countedQty: 0, palletIds: [] };
    }
    groups[key].countedQty += qty;
    if (groups[key].palletIds.indexOf(pid) === -1) groups[key].palletIds.push(pid);
  }

  Object.keys(groups).sort().forEach(function (k) {
    var g = groups[k];
    lines.push({
      material:    g.material,
      batch:       g.batch,
      unit:        g.unit,
      countedQty:  g.countedQty,
      palletCount: g.palletIds.length
    });
  });

  return JSON.parse(JSON.stringify({
    sessionId: sessionId, sloc: sloc,
    scannedAt: new Date().toISOString(), lines: lines
  }));
}

// ============================================================================
// reconcileCountWithSAP
// ============================================================================

function reconcileCountWithSAP(sloc) {
  try {
    sloc = String(sloc || '').trim();
    if (!sloc) throw new Error('SLoc is required');

    var summary = getCountSessionSummary(sloc);
    if (!summary.lines.length) {
      return JSON.parse(JSON.stringify({
        sessionId: summary.sessionId, sloc: sloc,
        lines: [], error: 'ไม่มีข้อมูลนับ — สแกนก่อน'
      }));
    }

    // Re-aggregate count summary to Material+SLoc grain (sum across batches)
    var countByMat = {};
    summary.lines.forEach(function (line) {
      var mat = line.material;
      if (!countByMat[mat]) {
        countByMat[mat] = { countedQty: 0, unit: line.unit };
      }
      countByMat[mat].countedQty += line.countedQty;
    });

    // Fetch SAP stock per Material+SLoc via A_MatlStkInAcctMod
    var sapStockMap = {};
    var sapErrors   = {};
    Object.keys(countByMat).forEach(function (mat) {
      try {
        var path = MATERIAL_STOCK_SRV_SC_ + 'A_MatlStkInAcctMod';
        var data = sapGet(path, {
          '$filter': "Material eq '" + mat + "' and Plant eq '" + CFG.PLANT + "'",
          '$top': '200'
        }, 'STOCK_COUNT.reconcile');

        var rows = (data.d && data.d.results) || [];

        var slocRows = rows.filter(function (row) {
          return String(row.StorageLocation || '').trim() === sloc;
        });

        // Log stock-type breakdown for diagnostics
        var byType = {};
        var totalAllTypes = 0;
        slocRows.forEach(function (row) {
          var stkType = String(row.InventoryStockType || '').trim();
          var qty = parseFloat(row.MatlWrhsStkQtyInMatlBaseUnit) || 0;
          if (!byType[stkType]) byType[stkType] = 0;
          byType[stkType] += qty;
          totalAllTypes += qty;
        });

        // Sum unrestricted stock only (InventoryStockType '01')
        var unrestrictedQty = byType['01'] || 0;
        sapStockMap[mat] = unrestrictedQty;

        var typeBreakdown = Object.keys(byType).map(function (t) {
          return t + '=' + byType[t];
        }).join(', ');

        logEvent('RECONCILE_SAP', 'STOCK_FETCHED', mat + '/' + sloc, 0,
          'unrestricted=' + unrestrictedQty + ' allTypes=' + totalAllTypes +
          ' breakdown=[' + typeBreakdown + '] slocRows=' + slocRows.length +
          ' totalRows=' + rows.length);

      } catch (e) {
        sapErrors[mat] = e.message;
        logEvent('RECONCILE_SAP', 'SAP_ERROR', mat + '/' + sloc, 0, e.message);
      }
    });

    // Build variance lines — one row per Material (batch-agnostic)
    var resultLines = Object.keys(countByMat).sort().map(function (mat) {
      var counted = countByMat[mat];
      var sapErr  = sapErrors[mat] || null;
      var sapQty  = sapStockMap.hasOwnProperty(mat) ? sapStockMap[mat] : null;

      if (sapErr) sapQty = null;

      var variance = sapQty !== null ? counted.countedQty - sapQty : null;
      var status;
      if (sapQty === null)     status = 'SAP_ERROR';
      else if (variance === 0) status = 'OK';
      else if (variance > 0)   status = 'SURPLUS';
      else                     status = 'DEFICIT';

      logEvent('RECONCILE_SAP', status, mat + '/' + sloc, 0,
        'counted=' + counted.countedQty + ' sap=' + sapQty + ' var=' + variance);

      return {
        material:   mat,
        batch:      'ALL',
        unit:       counted.unit,
        countedQty: counted.countedQty,
        sapQty:     sapQty,
        variance:   variance,
        status:     status,
        sapError:   sapErr || ''
      };
    });

    // Write to StockCountReconcile sheet (overwrite each run)
    writeReconcileSheet_(summary.sessionId, sloc, resultLines);

    logEvent('STOCK_COUNT', 'RECONCILE',
      summary.sessionId + ' lines=' + resultLines.length, 0,
      'grain=Material+SLoc');

    return JSON.parse(JSON.stringify({
      sessionId: summary.sessionId, sloc: sloc, lines: resultLines
    }));

  } catch (e) {
    logError('reconcileCountWithSAP', SCR_SHEET, e.message, sloc);
    return { error: 'เกิดข้อผิดพลาด: ' + e.message };
  }
}

// ============================================================================
// Write reconcile results to sheet
// ============================================================================

function writeReconcileSheet_(sessionId, sloc, lines) {
  var sh = ensureReconcileSheet_();
  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', "yyyy-MM-dd'T'HH:mm:ss");

  // Clear existing rows for this session
  if (sh.getLastRow() >= 2) {
    var existing = sh.getDataRange().getValues();
    var sidCol = existing[0].indexOf('SessionID');
    if (sidCol >= 0) {
      for (var r = existing.length - 1; r >= 1; r--) {
        if (String(existing[r][sidCol] || '').trim() === sessionId) {
          sh.deleteRow(r + 1);
        }
      }
    }
  }

  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var hdrIdx = {};
  hdr.forEach(function (h, i) { hdrIdx[h] = i; });

  var statusCol = hdrIdx['Status'];
  var startRow  = sh.getLastRow() + 1;

  var sheetRows = lines.map(function (line) {
    var rowObj = {
      SessionID:    sessionId,
      ReconciledAt: now,
      SLoc:         sloc,
      Material:     line.material,
      Batch:        line.batch,
      Unit:         line.unit,
      CountedQty:   line.countedQty,
      SAPQty:       line.sapQty !== null ? line.sapQty : '',
      Variance:     line.variance !== null ? line.variance : '',
      Status:       line.status,
      SAPError:     line.sapError || ''
    };
    return hdr.map(function (h) { return rowObj[h] !== undefined ? rowObj[h] : ''; });
  });

  if (sheetRows.length > 0) {
    sh.getRange(startRow, 1, sheetRows.length, hdr.length).setValues(sheetRows);

    // Color the Status column
    if (statusCol !== undefined) {
      for (var i = 0; i < lines.length; i++) {
        var cell = sh.getRange(startRow + i, statusCol + 1);
        cell.setFontWeight('bold');
        var st = lines[i].status;
        if (st === 'OK')        cell.setBackground('#d4edda').setFontColor('#155724');
        else if (st === 'SURPLUS')  cell.setBackground('#fff3cd').setFontColor('#856404');
        else if (st === 'DEFICIT')  cell.setBackground('#f8d7da').setFontColor('#721c24');
        else if (st === 'SAP_ERROR') cell.setBackground('#e2e3e5').setFontColor('#383d41');
      }
    }

    sh.autoResizeColumns(1, hdr.length);
  }
}

// ============================================================================
// Test wrapper
// ============================================================================

function TEST_stockCountFlow() {
  Logger.log('=== Stock Count Flow Test — START ===');

  var sloc = 'PW30';
  var sessionId = startCountSession(sloc);
  Logger.log('SessionID: ' + sessionId);

  // Pick first 3 pallets at PW30 from PalletMaster
  var ss = getSpreadsheet_();
  var pmSh = ss.getSheetByName(PM_SHEET);
  if (!pmSh || pmSh.getLastRow() < 2) {
    Logger.log('PalletMaster empty — cannot test');
    return;
  }

  var pmData = pmSh.getDataRange().getValues();
  var pmIdx = {};
  pmData[0].forEach(function (h, i) { pmIdx[h] = i; });

  var pidCol  = pmIdx['PalletID'];
  var slocCol = pmIdx['StorageLocation'];
  if (pidCol === undefined || slocCol === undefined) {
    Logger.log('PalletMaster missing PalletID or StorageLocation column');
    return;
  }

  var testPallets = [];
  for (var r = 1; r < pmData.length && testPallets.length < 3; r++) {
    var rSloc = String(pmData[r][slocCol] || '').trim();
    var rPid  = String(pmData[r][pidCol] || '').trim();
    if (rSloc === sloc && rPid) testPallets.push(rPid);
  }

  Logger.log('Test pallets: ' + JSON.stringify(testPallets));

  try {
    // Scan each pallet
    testPallets.forEach(function (pid) {
      var result = recordCountScan(pid, sloc, 'TEST');
      Logger.log('Scan ' + pid + ': ' + JSON.stringify(result));
    });

    // Re-scan first pallet (idempotency test)
    if (testPallets.length > 0) {
      var rescan = recordCountScan(testPallets[0], sloc, 'TEST');
      Logger.log('Re-scan ' + testPallets[0] + ': rescan=' + rescan.rescan);
    }

    // Summary
    var summary = getCountSessionSummary(sloc);
    Logger.log('Summary: ' + JSON.stringify(summary, null, 2));

    Logger.log('Reconcile skipped in unit test — run manually from scanner UI');

  } finally {
    // Cleanup — delete all StockCount rows for this session
    var scSh = ss.getSheetByName(SC_SHEET);
    if (scSh && scSh.getLastRow() >= 2) {
      var scData = scSh.getDataRange().getValues();
      var scIdx = {};
      scData[0].forEach(function (h, i) { scIdx[h] = i; });
      var sidCol = scIdx['SessionID'];
      if (sidCol !== undefined) {
        var deleted = 0;
        for (var d = scData.length - 1; d >= 1; d--) {
          if (String(scData[d][sidCol] || '').trim() === sessionId) {
            scSh.deleteRow(d + 1);
            deleted++;
          }
        }
        Logger.log('Cleanup: deleted ' + deleted + ' StockCount rows');
      }
    }
  }

  Logger.log('=== Stock Count Flow Test — COMPLETE ===');
}

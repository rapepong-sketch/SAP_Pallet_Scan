/**
 * PrintEngine.gs — Phase 2.5
 * ===========================
 * FIFO pallet allocation + progressive printing (ทยอยพิมพ์ across sessions).
 *
 * PalletID format: PL-{ManufacturingOrder}-L{seq} (e.g. PL-1000035048-L01)
 *   seq = 2-digit padded, continues from max existing seq for that MO (idempotent)
 *
 * Allocation logic:
 *   remainingQty = TotalQuantity − sum(QtyPerPallet of existing PM rows for that MO)
 *   → enables re-running for the same MO without over-allocating
 */

const PQ_SHEET = 'PrintQueue';
const PQ_HEADERS = [
  'QueueID', 'Material', 'RequestedQty', 'AllocatedQty', 'Status',
  'RequestedBy', 'RequestedAt', 'ProcessedAt', 'Detail'
];

// ============================================================================
// Sheet helpers
// ============================================================================

function ensurePrintQueueSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(PQ_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PQ_SHEET);
    sh.getRange(1, 1, 1, PQ_HEADERS.length)
      .setValues([PQ_HEADERS])
      .setFontWeight('bold')
      .setBackground('#6a0dad')
      .setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ============================================================================
// Data loaders
// ============================================================================

/**
 * Load released production orders sorted FIFO (startDate ASC, then MO ASC).
 */
function getReleasedPoData_() {
  const sh = getSpreadsheet_().getSheetByName(CFG.SHEETS.PRODUCTION_ORDERS);
  if (!sh || sh.getLastRow() < 2) return [];

  const data = sh.getDataRange().getValues();
  const hdr = data[0];
  const idx = {};
  hdr.forEach((h, i) => { idx[h] = i; });

  const orders = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const isRel = row[idx.IsReleased];
    if (!isRel && isRel !== 'TRUE' && isRel !== true) continue;
    orders.push({
      ManufacturingOrder:      String(row[idx.ManufacturingOrder] || '').trim(),
      Material:                String(row[idx.Material] || '').trim(),
      TotalQuantity:           Number(row[idx.TotalQuantity]) || 0,
      ProductionUnit:          String(row[idx.ProductionUnit] || '').trim(),
      Batch:                   String(row[idx.Batch] || '').trim(),
      WorkCenters:             String(row[idx.WorkCenters] || '').trim(),
      Plant:                   String(row[idx.Plant] || '').trim(),
      StorageLocation:         String(row[idx.StorageLocation] || '').trim(),
      MfgOrderPlannedStartDate: row[idx.MfgOrderPlannedStartDate] || null
    });
  }

  orders.sort((a, b) => {
    const da = a.MfgOrderPlannedStartDate ? new Date(a.MfgOrderPlannedStartDate).getTime() : 0;
    const db = b.MfgOrderPlannedStartDate ? new Date(b.MfgOrderPlannedStartDate).getTime() : 0;
    if (da !== db) return da - db;
    return a.ManufacturingOrder < b.ManufacturingOrder ? -1 : 1;
  });
  return orders;
}

/**
 * Build existing PalletMaster summary per MO.
 * @return {Object} { [mo]: { sumQty: number, maxSeq: number } }
 *   sumQty  = sum of QtyPerPallet already created (for remainingQty calc)
 *   maxSeq  = highest L-seq in new-format PalletIDs (for next-seq calc)
 */
function getExistingPmSummary_() {
  const sh = getSpreadsheet_().getSheetByName(PM_SHEET);
  if (!sh || sh.getLastRow() < 2) return {};

  const data = sh.getDataRange().getValues();
  const hdr = data[0];
  const idx = {};
  hdr.forEach((h, i) => { idx[h] = i; });

  const result = {};
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const mo  = String(row[idx.ManufacturingOrder] || '').trim();
    const qty = Number(row[idx.QtyPerPallet]) || 0;
    const pid = String(row[idx.PalletID] || '').trim();
    if (!mo) continue;
    if (!result[mo]) result[mo] = { sumQty: 0, maxSeq: 0 };
    result[mo].sumQty += qty;
    // Parse seq from new-format IDs: PL-{mo}-L{nn}
    const m = pid.match(/PL-[^-]+-L(\d+)$/);
    if (m) {
      const seq = parseInt(m[1], 10);
      if (seq > result[mo].maxSeq) result[mo].maxSeq = seq;
    }
  }
  return result;
}

// ============================================================================
// Core allocation
// ============================================================================

/**
 * FIFO pallet allocator — idempotent across sessions (progressive printing).
 *
 * @param {Array} requests — [{material: 'MATCODE', qty: 2000}, ...]
 * @return {Array} [{material, palletIds[], totalSheets, shortfall, error?}]
 *
 * Test trace (single MO, TotalQty=10000, MOQ=500):
 *   request 800 qty → L01(500) + L02(300)
 *   request 2000  → L01..L04 (4 × 500)
 *   then request 800 → L05(500) + L06(300)
 */
function allocatePallets(requests) {
  const t0 = Date.now();
  const materialMap = getMaterialMap();         // from MaterialMaster.gs
  const poList      = getReleasedPoData_();
  const pmSummary   = getExistingPmSummary_();  // mutable within this run

  const pqSheet = ensurePrintQueueSheet_();
  const now     = new Date();
  const queueId = 'PQ-' + now.getTime();

  const allNewPmRows = [];
  const results      = [];

  requests.forEach((req, i) => {
    const mat          = String(req.material || '').trim();
    const requestedQty = Number(req.qty) || 0;
    const queueRowId   = `${queueId}-${i + 1}`;

    // Validate material
    const mmData = materialMap[mat];
    if (!mmData || !(mmData.moq > 0)) {
      const errDetail = 'ไม่มี MOQ ใน MaterialMaster หรือ MOQ = 0';
      if (!CFG.DRY_RUN) {
        pqSheet.appendRow([queueRowId, mat, requestedQty, 0, 'ERROR',
          Session.getActiveUser().getEmail(), now, now, errDetail]);
      }
      logEvent('PRINT_ENGINE', '-', 'ERROR', 0, `${mat}: ${errDetail}`);
      results.push({ material: mat, palletIds: [], totalSheets: 0, shortfall: requestedQty, error: 'NO_MOQ' });
      return;
    }

    const moq = mmData.moq;

    // Filter + sort candidates (FIFO already sorted by getReleasedPoData_)
    const candidates = poList.filter(po => po.Material === mat);

    const palletIds  = [];
    let allocatedQty = 0;
    let remaining    = requestedQty;
    const details    = [];

    candidates.forEach(po => {
      if (remaining <= 0) return;
      const moKey      = po.ManufacturingOrder;
      const pmInfo     = pmSummary[moKey] || { sumQty: 0, maxSeq: 0 };
      const moRemaining = po.TotalQuantity - pmInfo.sumQty;
      if (moRemaining <= 0) return;

      const toAllocate = Math.min(remaining, moRemaining);
      let nextSeq      = pmInfo.maxSeq + 1;
      let qty          = toAllocate;

      while (qty > 0) {
        const palletQty  = Math.min(qty, moq);
        const seq        = nextSeq++;
        const seqStr     = seq < 10 ? '0' + seq : String(seq);
        const palletId   = `PL-${moKey}-L${seqStr}`;
        const qrPayload  = `PALLET|${palletId}|${moKey}|${po.Material}|${po.Batch || ''}|${palletQty}`;
        const totalPallets = Math.ceil(po.TotalQuantity / moq);
        const firstWc    = String(po.WorkCenters || '').split(/[;,]/)[0].trim();

        allNewPmRows.push([
          palletId,
          moKey,
          po.Material,
          mmData.name || '',
          po.Batch || '',
          palletQty,
          mmData.unit || po.ProductionUnit,
          seq,           // PalletSeq
          totalPallets,  // TotalPallets (theoretical for this MO)
          firstWc,
          po.Plant,
          po.StorageLocation,
          po.MfgOrderPlannedStartDate || '',
          'CREATED',
          qrPayload,
          now,
          '', '', ''     // PrintedAt, ScannedAt, QCResult
        ]);

        palletIds.push(palletId);
        qty          -= palletQty;
        allocatedQty += palletQty;

        // Update pmSummary in-memory for idempotency within this run
        if (!pmSummary[moKey]) pmSummary[moKey] = { sumQty: 0, maxSeq: 0 };
        pmSummary[moKey].sumQty += palletQty;
        pmSummary[moKey].maxSeq  = nextSeq - 1;
      }

      remaining -= toAllocate;
      details.push(`MO ${moKey}: ${toAllocate} → ${palletIds.length} pallets`);
    });

    const shortfall = Math.max(0, remaining);
    const detail    = details.join('; ') + (shortfall > 0 ? ` | SHORTFALL: ${shortfall}` : '');
    const status    = shortfall > 0 ? (allocatedQty > 0 ? 'PARTIAL' : 'ERROR') : 'OK';

    if (!CFG.DRY_RUN) {
      pqSheet.appendRow([queueRowId, mat, requestedQty, allocatedQty, status,
        Session.getActiveUser().getEmail(), now, now, detail.slice(0, 500)]);
    }
    results.push({ material: mat, palletIds, totalSheets: palletIds.length, shortfall });
  });

  // Batch-write new PalletMaster rows
  if (allNewPmRows.length > 0) {
    if (CFG.DRY_RUN) {
      logEvent('PRINT_ENGINE', '-', 'DRY_RUN', Date.now() - t0,
        `would create ${allNewPmRows.length} pallets: ` + allNewPmRows.slice(0, 3).map(r => r[0]).join(','));
    } else {
      const pmSheet = ensurePalletMasterSheet_();
      pmSheet.getRange(pmSheet.getLastRow() + 1, 1, allNewPmRows.length, PM_HEADERS.length)
             .setValues(allNewPmRows);
      logEvent('PRINT_ENGINE', '-', 'OK', Date.now() - t0,
        `created ${allNewPmRows.length} pallets across ${requests.length} requests`);
    }
  } else {
    logEvent('PRINT_ENGINE', '-', CFG.DRY_RUN ? 'DRY_RUN' : 'NO_PALLETS', Date.now() - t0,
      'requests=' + requests.length + ' — no new pallets created');
  }

  return results;
}

// ============================================================================
// Print request dialog (menu entry)
// ============================================================================

/**
 * Open multi-material print request dialog.
 * Dialog submits → allocatePallets() → opens pallet sheet HTML.
 */
function printRequestDialog() {
  const html = buildPrintRequestDialogHtml_();
  const out  = HtmlService.createHtmlOutput(html).setWidth(720).setHeight(480);
  SpreadsheetApp.getUi().showModalDialog(out, '🖨️ สั่งพิมพ์ใบติดตามพาเลท');
}

/** Called from dialog JS via google.script.run */
function getMaterialListForDialog() {
  const map = getMaterialMap();
  return Object.keys(map)
    .map(code => ({ code, name: map[code].name, moq: map[code].moq, unit: map[code].unit }))
    .sort((a, b) => a.code < b.code ? -1 : 1);
}

/**
 * Called from dialog JS via google.script.run.
 * Allocates pallets then opens the print sheet dialog.
 * @return {{opened:boolean, totalPallets:number, message?:string}}
 */
function submitPrintRequest(requests) {
  const results    = allocatePallets(requests);
  const allPalletIds = [];
  results.forEach(r => { if (r.palletIds) allPalletIds.push(...r.palletIds); });

  if (!allPalletIds.length) {
    return {
      opened: false,
      totalPallets: 0,
      message: 'ไม่มีพาเลทใหม่ — ตรวจ MaterialMaster MOQ และ ProductionOrders'
    };
  }

  const html = buildPalletSheetsHtml(allPalletIds, false); // from PalletSheet.gs
  const out  = HtmlService.createHtmlOutput(html).setWidth(1100).setHeight(840);
  SpreadsheetApp.getUi().showModalDialog(out, `พิมพ์ใบติดตามพาเลท (${allPalletIds.length} ใบ)`);
  return { opened: true, totalPallets: allPalletIds.length, results };
}

// ============================================================================
// Dialog HTML builder
// ============================================================================

function buildPrintRequestDialogHtml_() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body{font-family:'Sarabun',Arial,sans-serif;font-size:14px;padding:10px;margin:0}
  h2{font-size:16px;margin:0 0 10px}
  table{width:100%;border-collapse:collapse}
  th{background:#1a4e8a;color:#fff;padding:6px 8px;text-align:left;font-size:13px}
  td{padding:4px 2px}
  input[type=text],input[type=number]{width:100%;padding:5px;box-sizing:border-box;border:1px solid #ccc;border-radius:3px;font-size:13px}
  .btn{padding:6px 14px;margin:3px 2px;cursor:pointer;border:none;border-radius:3px;font-size:13px}
  .btn-add{background:#27ae60;color:#fff}
  .btn-submit{background:#1a4e8a;color:#fff;font-size:14px;padding:8px 20px}
  .btn-remove{background:#e74c3c;color:#fff;padding:3px 8px;font-size:12px}
  #status{margin-top:8px;padding:7px 10px;border-radius:4px;display:none}
  .ok{background:#d4edda;color:#155724}.err{background:#f8d7da;color:#721c24}
  .warn{background:#fff3cd;color:#856404}
</style>
</head>
<body>
<h2>🖨️ สั่งพิมพ์ใบติดตามพาเลท</h2>
<datalist id="mat-list"></datalist>
<table id="req-table">
  <thead><tr>
    <th>Material Code</th>
    <th style="width:120px">จำนวนที่ต้องการ</th>
    <th style="width:36px"></th>
  </tr></thead>
  <tbody id="req-body"></tbody>
</table>
<div style="margin-top:8px">
  <button class="btn btn-add" onclick="addRow()">+ เพิ่ม Material</button>
  <button class="btn btn-submit" id="btn-submit" onclick="submitRequest()">🖨️ สั่งพิมพ์</button>
</div>
<div id="status"></div>
<script>
  function addRow(mat,qty){
    var tr=document.createElement('tr');
    tr.innerHTML='<td><input type="text" list="mat-list" class="mi" placeholder="รหัสวัสดุ" value="'+(mat||'')+'"></td>'+
      '<td><input type="number" class="qi" min="1" placeholder="จำนวน" value="'+(qty||'')+'"></td>'+
      '<td><button class="btn btn-remove" onclick="rm(this)">✕</button></td>';
    document.getElementById('req-body').appendChild(tr);
  }
  function rm(b){var p=b.parentNode.parentNode,t=p.parentNode;if(t.children.length>1)t.removeChild(p);}
  function submitRequest(){
    var reqs=[],rows=document.querySelectorAll('#req-body tr');
    rows.forEach(function(r){
      var m=r.querySelector('.mi').value.trim(),q=parseInt(r.querySelector('.qi').value,10);
      if(m&&q>0)reqs.push({material:m,qty:q});
    });
    if(!reqs.length){showStatus('กรุณากรอกข้อมูลอย่างน้อย 1 รายการ','err');return;}
    showStatus('⏳ กำลังจัดสรรพาเลท กรุณารอ...','');
    document.getElementById('btn-submit').disabled=true;
    google.script.run
      .withSuccessHandler(function(r){
        document.getElementById('btn-submit').disabled=false;
        if(r.opened){showStatus('✅ เปิดหน้าพิมพ์แล้ว — '+r.totalPallets+' ใบ','ok');}
        else{showStatus('⚠️ '+(r.message||'ไม่มีพาเลทใหม่'),'warn');}
      })
      .withFailureHandler(function(e){
        document.getElementById('btn-submit').disabled=false;
        showStatus('❌ Error: '+e.message,'err');
      })
      .submitPrintRequest(reqs);
  }
  function showStatus(msg,cls){
    var el=document.getElementById('status');
    el.textContent=msg;el.className=cls;el.style.display='block';
  }
  // Load material datalist
  google.script.run.withSuccessHandler(function(mats){
    var dl=document.getElementById('mat-list');
    mats.forEach(function(m){
      var o=document.createElement('option');
      o.value=m.code;
      o.label=m.code+(m.name?' — '+m.name:'')+' (MOQ:'+m.moq+' '+m.unit+')';
      dl.appendChild(o);
    });
  }).getMaterialListForDialog();
  // Start with one empty row
  addRow();
</script>
</body>
</html>`;
}

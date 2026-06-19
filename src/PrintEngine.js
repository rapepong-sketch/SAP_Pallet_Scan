/**
 * PrintEngine.gs — Phase 2.5
 * ===========================
 * FIFO pallet allocation + progressive printing (ทยอยพิมพ์ across sessions).
 *
 * PalletID format: PL-{ManufacturingOrder}-L{seq} (e.g. PL-1000035048-L01)
 *   seq = 2-digit padded, extends to 3+ digits above 99 (idempotent across sessions)
 *
 * Allocation logic:
 *   remainingQty = TotalQuantity − sum(QtyPerPallet of existing PM rows for that MO)
 *   → enables re-running for the same MO without over-allocating
 *
 * Input: requests = [{material, requestedQty}, ...]
 *   requestedQty drives FIFO split across open MOs; pallets fill full MOQ buckets,
 *   last pallet in each MO gets the remainder.
 */

const PQ_SHEET = 'PrintQueue';
const PQ_HEADERS = [
  'QueueID', 'RequestedAt', 'RequestedBy', 'Material', 'RequestedQty',
  'AllocatedQty', 'Shortfall', 'PalletCount', 'Status', 'PalletIDs'
];
const PQ_STATUS_COL = 9; // 1-based index of Status column in PQ_HEADERS

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
    var wcRaw = row[idx.WorkCenters];
    orders.push({
      ManufacturingOrder:       String(row[idx.ManufacturingOrder] || '').trim(),
      Material:                 String(row[idx.Material] || '').trim(),
      TotalQuantity:            Number(row[idx.TotalQuantity]) || 0,
      ProductionUnit:           String(row[idx.ProductionUnit] || '').trim(),
      Batch:                    String(row[idx.Batch] || '').trim(),
      WorkCenters:              dateToWorkCenter_(wcRaw),
      Plant:                    String(row[idx.Plant] || '').trim(),
      StorageLocation:          String(row[idx.StorageLocation] || '').trim(),
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
 * @param {Array} requests — [{material, requestedQty}, ...]
 *   Accepts legacy {qty} field for backward compatibility.
 * @return {Array} [{material, palletIds[], totalSheets, shortfall, pqRowNum, error?}]
 *
 * Dry-run trace (MOQ=2560, MO-A remaining=5120, MO-B remaining=99000, request=10000):
 *   MO-A: allocate min(10000,5120)=5120 → L01(2560)+L02(2560) — exhausted
 *   MO-B: remaining=4880 → L01(2560)+L02(2320) — last pallet = 4880−2560=2320
 *   Total: 4 pallets, shortfall=0
 */
function allocatePallets(requests) {
  ensurePalletMasterColumns_();
  const t0 = Date.now();
  const materialMap = getMaterialMap();
  const poList      = getReleasedPoData_();
  const pmSummary   = getExistingPmSummary_();

  const pqSheet = ensurePrintQueueSheet_();
  const now     = new Date();
  const email   = getActiveUserSafe_();
  const tsStr   = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMddHHmmss');

  const allNewPmRows = [];
  const results      = [];

  requests.forEach((req) => {
    const mat          = String(req.material || '').trim();
    const requestedQty = Number(req.requestedQty !== undefined ? req.requestedQty : req.qty) || 0;
    const queueRowId   = tsStr + '-' + mat;

    // Validate material
    const mmData = materialMap[mat];
    if (!mmData || !(mmData.moq > 0)) {
      const errDetail = 'ไม่มี MOQ ใน MaterialMaster หรือ MOQ = 0';
      let pqRowNum = -1;
      if (!CFG.DRY_RUN) {
        pqSheet.appendRow([queueRowId, now, email, mat, requestedQty,
          0, requestedQty, 0, 'ERROR', errDetail]);
        pqRowNum = pqSheet.getLastRow();
      }
      logEvent('PRINT_ENGINE', mat, 'ERROR', 0, errDetail);
      results.push({ material: mat, palletIds: [], totalSheets: 0,
        shortfall: requestedQty, pqRowNum, error: 'NO_MOQ' });
      return;
    }

    if (requestedQty <= 0) {
      results.push({ material: mat, palletIds: [], totalSheets: 0,
        shortfall: 0, pqRowNum: -1, error: 'ZERO_QTY' });
      return;
    }

    const moq        = mmData.moq;
    const candidates = poList.filter(po => po.Material === mat);

    const palletIds  = [];
    let allocatedQty = 0;
    let remaining    = requestedQty;

    // Write QUEUED row first; capture row number for update after allocation
    let pqRowNum = -1;
    if (!CFG.DRY_RUN) {
      pqSheet.appendRow([queueRowId, now, email, mat, requestedQty,
        0, 0, 0, 'QUEUED', '']);
      pqRowNum = pqSheet.getLastRow();
    }

    candidates.forEach(po => {
      if (remaining <= 0) return;
      const moKey       = po.ManufacturingOrder;
      const pmInfo      = pmSummary[moKey] || { sumQty: 0, maxSeq: 0 };
      const moRemaining = po.TotalQuantity - pmInfo.sumQty;
      if (moRemaining <= 0) return;

      const toAllocate  = Math.min(remaining, moRemaining);
      let nextSeq       = pmInfo.maxSeq + 1;
      let qty           = toAllocate;

      while (qty > 0) {
        const palletQty    = Math.min(qty, moq);
        const seq          = nextSeq++;
        const seqStr       = seq < 10 ? '0' + seq : String(seq);
        const palletId     = 'PL-' + moKey + '-L' + seqStr;
        const qrPayload    = 'PALLET|' + palletId + '|' + moKey + '|' +
                             po.Material + '|' + (po.Batch || '') + '|' + palletQty;
        const totalPallets = Math.ceil(po.TotalQuantity / moq);
        const firstWc      = String(po.WorkCenters || '').split(/[;,]/)[0].trim();

        allNewPmRows.push(buildPalletRow_({
          PalletID:           palletId,
          ManufacturingOrder: moKey,
          Material:           po.Material,
          MaterialName:       mmData.name || '',
          Batch:              po.Batch || '',
          QtyPerPallet:       palletQty,
          Unit:               mmData.unit || po.ProductionUnit,
          PalletSeq:          seq,
          TotalPallets:       totalPallets,
          WorkCenter:         firstWc,
          ProductionDate:     po.MfgOrderPlannedStartDate || '',
          QRPayload:          qrPayload,
          ScanStatus:         'CREATED',
          TotalQuantity:      Number(po.TotalQuantity) || 0,
          Plant:              po.Plant || '',
          StorageLocation:    po.StorageLocation || '',
          Status:             'CREATED',
          CreatedAt:          now
        }));

        palletIds.push(palletId);
        qty          -= palletQty;
        allocatedQty += palletQty;

        if (!pmSummary[moKey]) pmSummary[moKey] = { sumQty: 0, maxSeq: 0 };
        pmSummary[moKey].sumQty += palletQty;
        pmSummary[moKey].maxSeq  = nextSeq - 1;
      }

      remaining -= toAllocate;
    });

    const shortfall    = Math.max(0, remaining);
    const status       = shortfall > 0 ? (allocatedQty > 0 ? 'PARTIAL' : 'ERROR') : 'ALLOCATED';
    const palletIdsStr = palletIds.length <= 30
      ? palletIds.join(',')
      : palletIds.slice(0, 30).join(',') + '... (+' + (palletIds.length - 30) + ')';

    if (shortfall > 0) {
      logEvent('PRINT_ENGINE', mat, 'SHORTFALL', Date.now() - t0,
        'ขาด ' + shortfall + ' PCS — ไม่มี MO เพียงพอ');
    }

    if (!CFG.DRY_RUN && pqRowNum > 0) {
      pqSheet.getRange(pqRowNum, 1, 1, PQ_HEADERS.length).setValues([[
        queueRowId, now, email, mat, requestedQty,
        allocatedQty, shortfall, palletIds.length, status, palletIdsStr
      ]]);
    }

    results.push({ material: mat, palletIds, totalSheets: palletIds.length,
      shortfall, pqRowNum });
  });

  // Batch-write new PalletMaster rows
  if (allNewPmRows.length > 0) {
    if (CFG.DRY_RUN) {
      logEvent('PRINT_ENGINE', '-', 'DRY_RUN', Date.now() - t0,
        'would create ' + allNewPmRows.length + ' pallets: ' +
        allNewPmRows.slice(0, 3).map(r => r[0]).join(','));
    } else {
      const pmSheet = ensurePalletMasterSheet_();
      pmSheet.getRange(pmSheet.getLastRow() + 1, 1, allNewPmRows.length, PM_HEADERS.length)
             .setValues(allNewPmRows);
      logEvent('PRINT_ENGINE', '-', 'OK', Date.now() - t0,
        'created ' + allNewPmRows.length + ' pallets across ' + requests.length + ' requests');
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
  const out  = HtmlService.createHtmlOutput(html).setWidth(860).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(out, '🖨️ สั่งพิมพ์ใบติดตามพาเลท');
}

/** Called from dialog JS via google.script.run */
function getMaterialListForDialog() {
  const map = getMaterialMap();
  return Object.keys(map)
    .map(code => ({
      code,
      name:            map[code].name,
      moq:             map[code].moq,
      unit:            map[code].unit,
      storageLocation: map[code].storageLocation,
      productGroup:    map[code].productGroup
    }))
    .sort((a, b) => a.code < b.code ? -1 : 1);
}

/**
 * Called from dialog JS via google.script.run.
 * Allocates pallets, opens the print sheet dialog, then marks PrintQueue as PRINTED.
 * @return {{opened:boolean, totalPallets:number, message?:string}}
 */
function submitPrintRequest(requests) {
  const results      = allocatePallets(requests);
  const allPalletIds = [];
  results.forEach(r => { if (r.palletIds) allPalletIds.push(...r.palletIds); });

  if (!allPalletIds.length) {
    return {
      opened: false,
      totalPallets: 0,
      message: 'ไม่มีพาเลทใหม่ — ตรวจ MaterialMaster MOQ และ ProductionOrders'
    };
  }

  const html = buildPalletSheetsHtml(allPalletIds, false);
  const out  = HtmlService.createHtmlOutput(html).setWidth(1100).setHeight(840);
  SpreadsheetApp.getUi().showModalDialog(out, 'พิมพ์ใบติดตามพาเลท (' + allPalletIds.length + ' ใบ)');

  if (!CFG.DRY_RUN) {
    const pqSheet = ensurePrintQueueSheet_();
    results.forEach(r => {
      if (r.pqRowNum > 0) {
        pqSheet.getRange(r.pqRowNum, PQ_STATUS_COL).setValue('PRINTED');
      }
    });
  }

  return { opened: true, totalPallets: allPalletIds.length, results };
}

// ============================================================================
// Dialog HTML builder
// ============================================================================

function buildPrintRequestDialogHtml_() {
  return '<!DOCTYPE html>\n' +
'<html>\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<style>\n' +
'body{font-family:\'Sarabun\',Arial,sans-serif;font-size:14px;padding:10px;margin:0}\n' +
'h2{font-size:16px;margin:0 0 10px}\n' +
'table{width:100%;border-collapse:collapse}\n' +
'th{background:#1a4e8a;color:#fff;padding:6px 8px;text-align:left;font-size:13px}\n' +
'td{padding:4px 2px;vertical-align:top}\n' +
'input[type=text],input[type=number]{width:100%;padding:5px;box-sizing:border-box;border:1px solid #ccc;border-radius:3px;font-size:13px}\n' +
'.btn{padding:6px 14px;margin:3px 2px;cursor:pointer;border:none;border-radius:3px;font-size:13px}\n' +
'.btn-add{background:#27ae60;color:#fff}\n' +
'.btn-submit{background:#1a4e8a;color:#fff;font-size:14px;padding:8px 20px}\n' +
'.btn-remove{background:#e74c3c;color:#fff;padding:3px 8px;font-size:12px}\n' +
'#status{margin-top:8px;padding:7px 10px;border-radius:4px;display:none}\n' +
'.ok{background:#d4edda;color:#155724}.err{background:#f8d7da;color:#721c24}\n' +
'.warn{background:#fff3cd;color:#856404}\n' +
'.mat-err{font-size:11px;margin-top:2px;min-height:15px}\n' +
'.preview-text{font-size:11px;color:#333;display:block;margin-top:2px}\n' +
'.warn-text{font-size:11px;color:#856404;display:none;margin-top:2px}\n' +
'.col-mat{min-width:170px}.col-qty{width:130px}.col-preview{min-width:230px}.col-del{width:38px}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<h2>🖨️ สั่งพิมพ์ใบติดตามพาเลท</h2>\n' +
'<datalist id="mat-list"></datalist>\n' +
'<table id="req-table">\n' +
'  <thead><tr>\n' +
'    <th class="col-mat">Material Code</th>\n' +
'    <th class="col-qty">Requested Qty (PCS)</th>\n' +
'    <th class="col-preview">Preview</th>\n' +
'    <th class="col-del"></th>\n' +
'  </tr></thead>\n' +
'  <tbody id="req-body"></tbody>\n' +
'</table>\n' +
'<div style="margin-top:8px">\n' +
'  <button class="btn btn-add" onclick="addRow()">+ เพิ่ม Material</button>\n' +
'  <button class="btn btn-submit" id="btn-submit" onclick="submitRequest()">🖨️ สั่งพิมพ์</button>\n' +
'</div>\n' +
'<div id="status"></div>\n' +
'<script>\n' +
'var moqCache={};\n' +
'\n' +
'function addRow(mat,qty){\n' +
'  var tr=document.createElement("tr");\n' +
'  tr.innerHTML=\n' +
'    "<td class=\'col-mat\'>"+\n' +
'      "<input type=\'text\' list=\'mat-list\' class=\'mi\' placeholder=\'รหัสวัสดุ\' value=\'"+(mat||"")+"\'>" +\n' +
'      "<div class=\'mat-err\'></div>"+\n' +
'    "</td>"+\n' +
'    "<td class=\'col-qty\'>"+\n' +
'      "<input type=\'number\' class=\'qi\' min=\'1\' placeholder=\'จำนวน PCS\' value=\'"+(qty||"")+"\'>" +\n' +
'    "</td>"+\n' +
'    "<td class=\'col-preview\'>"+\n' +
'      "<span class=\'preview-text\'></span>"+\n' +
'      "<span class=\'warn-text\'></span>"+\n' +
'    "</td>"+\n' +
'    "<td class=\'col-del\'><button class=\'btn btn-remove\' onclick=\'rm(this)\'>✕</button></td>";\n' +
'  var mi=tr.querySelector(".mi");\n' +
'  var qi=tr.querySelector(".qi");\n' +
'  mi.addEventListener("blur",function(){onMaterialBlur(tr);});\n' +
'  qi.addEventListener("input",function(){updatePreview(tr);});\n' +
'  document.getElementById("req-body").appendChild(tr);\n' +
'  if(mat){setTimeout(function(){onMaterialBlur(tr);},50);}\n' +
'}\n' +
'\n' +
'function rm(b){\n' +
'  var p=b.parentNode.parentNode,t=p.parentNode;\n' +
'  if(t.children.length>1)t.removeChild(p);\n' +
'}\n' +
'\n' +
'function onMaterialBlur(tr){\n' +
'  var mat=tr.querySelector(".mi").value.trim();\n' +
'  var errEl=tr.querySelector(".mat-err");\n' +
'  tr.dataset.valid="false";\n' +
'  if(!mat){errEl.textContent="";return;}\n' +
'  if(moqCache.hasOwnProperty(mat)){validateAndPreview(tr,moqCache[mat]);return;}\n' +
'  errEl.textContent="⏳ กำลังตรวจสอบ...";\n' +
'  errEl.style.color="#555";\n' +
'  google.script.run\n' +
'    .withSuccessHandler(function(info){moqCache[mat]=info;validateAndPreview(tr,info);})\n' +
'    .withFailureHandler(function(e){errEl.textContent="❌ "+e.message;errEl.style.color="red";})\n' +
'    .getMoqForMaterial(mat);\n' +
'}\n' +
'\n' +
'function validateAndPreview(tr,info){\n' +
'  var errEl=tr.querySelector(".mat-err");\n' +
'  if(!info){\n' +
'    errEl.textContent="⛔ ไม่พบใน MaterialMaster หรือ Status ไม่ใช่ CONFIRMED";\n' +
'    errEl.style.color="red";\n' +
'    tr.dataset.valid="false";\n' +
'    tr.querySelector(".preview-text").textContent="";\n' +
'    return;\n' +
'  }\n' +
'  errEl.textContent="✅ "+(info.name||"")+" MOQ="+info.moq+" "+(info.unit||"");\n' +
'  errEl.style.color="green";\n' +
'  tr.dataset.valid="true";\n' +
'  tr.dataset.moq=String(info.moq);\n' +
'  tr.dataset.remaining=String(info.remainingQty!==undefined?info.remainingQty:999999999);\n' +
'  updatePreview(tr);\n' +
'}\n' +
'\n' +
'function updatePreview(tr){\n' +
'  var qty=parseInt(tr.querySelector(".qi").value,10)||0;\n' +
'  var prevEl=tr.querySelector(".preview-text");\n' +
'  var warnEl=tr.querySelector(".warn-text");\n' +
'  var moq=parseInt(tr.dataset.moq||"0",10);\n' +
'  var remaining=parseInt(tr.dataset.remaining||"0",10);\n' +
'  if(!moq||qty<=0){prevEl.textContent="";warnEl.style.display="none";return;}\n' +
'  var pallets=Math.ceil(qty/moq);\n' +
'  var lastQty=qty-moq*(pallets-1);\n' +
'  if(qty<moq){\n' +
'    prevEl.textContent="1 ใบ = "+qty+" PCS (น้อยกว่า MOQ)";\n' +
'  } else if(pallets===1){\n' +
'    prevEl.textContent="1 ใบ = "+qty+" PCS";\n' +
'  } else {\n' +
'    prevEl.textContent="จะพิมพ์ "+pallets+" ใบ: ใบ 1–"+(pallets-1)+" = "+moq+" PCS, ใบสุดท้าย = "+lastQty+" PCS";\n' +
'  }\n' +
'  if(qty>remaining){\n' +
'    warnEl.textContent="⚠️ ต้องการ "+qty+" PCS แต่ MO เปิดมีเหลือ "+remaining+" PCS";\n' +
'    warnEl.style.display="block";\n' +
'  } else {\n' +
'    warnEl.style.display="none";\n' +
'  }\n' +
'}\n' +
'\n' +
'function submitRequest(){\n' +
'  var reqs=[],rows=document.querySelectorAll("#req-body tr"),hasErr=false;\n' +
'  rows.forEach(function(tr){\n' +
'    var mat=tr.querySelector(".mi").value.trim();\n' +
'    var qty=parseInt(tr.querySelector(".qi").value,10)||0;\n' +
'    if(!mat&&!qty)return;\n' +
'    if(!mat||tr.dataset.valid!=="true"){\n' +
'      var e=tr.querySelector(".mat-err");\n' +
'      if(!e.textContent||e.style.color!=="red"){\n' +
'        e.textContent="⛔ กรุณาออกจากช่อง Material เพื่อตรวจสอบก่อน";\n' +
'        e.style.color="red";\n' +
'      }\n' +
'      hasErr=true;return;\n' +
'    }\n' +
'    if(qty<=0){showStatus("กรุณากรอกจำนวน PCS > 0","err");hasErr=true;return;}\n' +
'    reqs.push({material:mat,requestedQty:qty});\n' +
'  });\n' +
'  if(hasErr)return;\n' +
'  if(!reqs.length){showStatus("กรุณากรอกข้อมูลอย่างน้อย 1 รายการ","err");return;}\n' +
'  showStatus("⏳ กำลังจัดสรรพาเลท กรุณารอ...","");\n' +
'  document.getElementById("btn-submit").disabled=true;\n' +
'  google.script.run\n' +
'    .withSuccessHandler(function(r){\n' +
'      document.getElementById("btn-submit").disabled=false;\n' +
'      if(r.opened){showStatus("✅ เปิดหน้าพิมพ์แล้ว — "+r.totalPallets+" ใบ","ok");}\n' +
'      else{showStatus("⚠️ "+(r.message||"ไม่มีพาเลทใหม่"),"warn");}\n' +
'    })\n' +
'    .withFailureHandler(function(e){\n' +
'      document.getElementById("btn-submit").disabled=false;\n' +
'      showStatus("❌ Error: "+e.message,"err");\n' +
'    })\n' +
'    .submitPrintRequest(reqs);\n' +
'}\n' +
'\n' +
'function showStatus(msg,cls){\n' +
'  var el=document.getElementById("status");\n' +
'  el.textContent=msg;el.className=cls;el.style.display="block";\n' +
'}\n' +
'\n' +
'google.script.run.withSuccessHandler(function(mats){\n' +
'  var dl=document.getElementById("mat-list");\n' +
'  mats.forEach(function(m){\n' +
'    var o=document.createElement("option");\n' +
'    o.value=m.code;\n' +
'    o.label=m.code+(m.name?" — "+m.name:"")+" (MOQ:"+m.moq+" "+m.unit+")";\n' +
'    dl.appendChild(o);\n' +
'  });\n' +
'}).getMaterialListForDialog();\n' +
'\n' +
'addRow();\n' +
'</script>\n' +
'</body>\n' +
'</html>';
}

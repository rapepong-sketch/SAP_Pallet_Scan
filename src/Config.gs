/**
 * Config.gs — Central constants for SAP Pallet Tracking System
 * ============================================================
 * Phase 1 — Foundation
 *
 * กฎเหล็ก:
 *  - ห้ามมี credential ใด ๆ ในไฟล์นี้ (หรือไฟล์ไหนก็ตาม)
 *  - SAP_USER / SAP_PASS / SAP_CLIENT อ่านจาก PropertiesService.getScriptProperties() เท่านั้น
 *  - DRY_RUN = true → ทุก operation log อย่างเดียว ไม่เขียน SAP และไม่เขียนข้อมูลลง sheet
 */

const CFG = {

  // ---- Build version (bump on meaningful server changes that require redeploy) ----
  WEBAPP_BUILD: 'p5s1-2d',

  // ---- Safety gate -------------------------------------------------------
  DRY_RUN: false, // ✅ PDFG filter verified — writing to sheet

  // ---- SAP tenant --------------------------------------------------------
  SAP_BASE_URL: 'https://my417293-api.s4hana.cloud.sap',
  PLANT: '1100',
  DEST_SLOCS: ['PW40'],

  // ---- Factory identity --------------------------------------------------
  FACTORY_NAME: 'PJ Chonburi',

  // ---- Google Sheet ------------------------------------------------------
  SHEET_ID: '1NZmKOuYAmpu1csjd83kNgZXSjCz5lVk7odIyDxJoKRk',
  QR_API:   'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=',

  // ---- Pull behaviour ----------------------------------------------------
  PULL_DAYS_BACK: 180,  // ดึง 180 วันย้อนหลัง = ครอบ 2026 ทั้งปี (export จริงมี 2026-01 ถึง 2026-11)
  PAGE_SIZE: 500,       // OData $top ต่อ page — 500×4 pages = 2000 records ครอบ 1732 orders
  // Order types for Pallet Tracking
  // PDFG = Finished Goods — StorageLoc WF01
  // PDSM = Semi-finished (Part) — StorageLoc PW40/PW20/PW30 etc. — หลัก pallet label
  ORDER_TYPES: ['PDFG', 'PDSM'],
  MAX_RETRIES: 3,       // retry ต่อ 1 SAP call
  RETRY_BASE_MS: 1000,  // backoff: 1s, 2s, 4s

  // ---- SAP OData services (OData V2) --------------------------------------
  // service root ใช้สำหรับ fetch CSRF token / endpoint ใช้ยิงจริง
  SERVICES: {
    PRODUCTION_ORDERS: '/sap/opu/odata/sap/API_PRODUCTION_ORDER_2_SRV/',
    PROD_ORDER_CONF:   '/sap/opu/odata/sap/API_PROD_ORDER_CONFIRMATION_2_SRV/', // Phase 3
    MATERIAL_DOCUMENT: '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/',         // Phase 3
    INSPECTION_LOT:    '/sap/opu/odata/sap/API_INSPECTIONLOT_SRV/',             // Phase 4
    BATCH:             '/sap/opu/odata/sap/API_BATCH_SRV/',                     // Phase 2
    WORK_CENTERS:      '/sap/opu/odata/sap/API_WORK_CENTERS/'                   // Phase 2
  },

  ENDPOINTS: {
    PRODUCTION_ORDERS: '/sap/opu/odata/sap/API_PRODUCTION_ORDER_2_SRV/A_ProductionOrder_2'
  },

  // ---- Phase 3: Feature flags (stored in Script Properties, managed via Flags.gs + menu)
  // Readers: sapWriteEnabled_() / isDryRun_()  — ใช้ภายในโค้ด
  // Setters: flagEnable/Disable/DryRunOn/Off    — ผูกกับ menu ⚙️ Pallet SAP Toggle
  FLAG_KEYS: {
    SAP_WRITE: 'SAP_WRITE_ENABLED', // 'false'(default) | 'true'
    DRY_RUN:   'DRY_RUN'            // 'true'(default)  | 'false'
  },

  // ---- Phase 3: Web app --------------------------------------------------
  WEB_APP_TITLE: 'ใบติดตามพาเลท - PJ Chonburi',

  /**
   * Admin email allowlist — add emails here to grant access to admin pages
   * (?app=print, ?app=confirm). Case-insensitive match.
   * Set ADMIN_LOCK_ENABLED = false for temporary open access (all users = admin).
   */
  ADMIN_EMAILS: ['pc@pjwood.org'],
  ADMIN_LOCK_ENABLED: true,

  // ---- Sheet names ---------------------------------------------------------
  SHEETS: {
    CONFIG:            'Config',
    PRODUCTION_ORDERS: 'ProductionOrders',
    PALLET_MASTER:     'PalletMaster',
    MOQ_CONFIG:        'MOQ_Config',          // deprecated — kept for migration
    MATERIAL_MASTER:   'MaterialMaster',       // Phase 2.5
    PRINT_QUEUE:       'PrintQueue',           // Phase 2.5
    OPERATION_LOG:     'OperationLog',         // Phase 2.5 scaffold
    INSPECTION_LOTS:   'InspectionLots',
    EVENT_LOG:         'EventLog',
    ERROR_LOG:         'ErrorLog'
  },

  // ---- Sheet headers (single source of truth — SheetSetup + writers ใช้ชุดเดียวกัน)
  HEADERS: {
    CONFIG: ['Key', 'Value', 'Description'],

    PRODUCTION_ORDERS: [
      'ManufacturingOrder',         // A: key (idempotency) — real field name
      'Material',
      'ManufacturingOrderType',     // replaces MaterialName (not in entity)
      'TotalQuantity',
      'ProductionUnit',
      'MfgOrderPlannedStartDate',
      'Plant',
      'StorageLocation',
      'MfgOrderConfirmedYieldQty',
      'Batch',                      // จาก to_ProductionOrderItem
      'WorkCenters',                // unique list จาก to_ProductionOrderOperation
      'Operations',                 // "0010:WC|text; 0020:WC|text"
      'StatusCodes',                // จาก to_ProductionOrderStatus
      'IsReleased',                 // direct boolean flag from header
      'LastSyncAt',
      'OperationsJSON',             // Phase 2.5: JSON array for routing table (lazy-fetch cache)
      'FinalOperation'              // Phase 3: cached last routing op number — getFinalOperationForMo_()
    ],

    PALLET_MASTER: [
      // Single source of truth — PM_HEADERS in PalletGen.gs mirrors this 41-col layout
      'PalletID', 'ManufacturingOrder', 'Material', 'MaterialName', 'Batch',
      'QtyPerPallet', 'Unit', 'PalletSeq', 'TotalPallets',
      'WorkCenter', 'ProductionDate', 'TotalQuantity', 'Plant', 'StorageLocation',
      'QRPayload', 'Status', 'CreatedAt', 'PrintedAt',
      'ScannedAt', 'ScannedBy', 'ScanStatus',
      'GRMaterialDocument', 'GRMaterialDocumentYear',
      'ConfirmationGroup', 'ConfirmationCount', 'ConfirmedAt', 'ConfirmedBy',
      'QCStatus', 'QCResult', 'InspectionLot',
      'LabelPrintedAt', 'UpdatedAt', 'QCResultNote',
      'OverrideBy', 'OverrideReason', 'OverrideAt',
      'GoodQty', 'RepairQty', 'DefectQty', 'AwaitConvQty',
      'QCInspector'
    ],

    MOQ_CONFIG: [
      'Material', 'MaterialName', 'MaterialType', // SEMI / FG — deprecated
      'MOQ_Per_Pallet', 'Unit', 'MaxPalletQty', 'Remark'
    ],

    MATERIAL_MASTER: [
      'Material', 'MaterialName', 'OrderType', 'ProductGroup', 'MOQ_Per_Pallet',
      'Unit', 'MaxPalletQty', 'Status', 'Remark', 'StorageLocation'
    ],

    PRINT_QUEUE: [
      'QueueID', 'Material', 'RequestedQty', 'AllocatedQty', 'Status',
      'RequestedBy', 'RequestedAt', 'ProcessedAt', 'Detail'
    ],

    OPERATION_LOG: [
      'LogID', 'PalletID', 'ManufacturingOrder', 'OperationNo', 'OperationText',
      'GoodQty', 'ScrapQty', 'RepairQty', 'AwaitConvQty',
      'Operator', 'Role', 'Result', 'LoggedAt', 'Source',
      'PDResult', 'PDInspector', 'PDNote', 'PDTimestamp'
    ],

    INSPECTION_LOTS: [
      'InspectionLot',              // key
      'Material', 'Batch', 'Plant', 'InspectionLotOrigin',
      'InspLotQuantity', 'Unit', 'ProductionOrder',
      'UD_Code', 'UD_Status', 'LastSyncAt'
    ],

    EVENT_LOG: ['Timestamp', 'Function', 'Endpoint', 'Status', 'ResponseTimeMs', 'Note'],

    ERROR_LOG: ['Timestamp', 'Function', 'Endpoint', 'ErrorMessage', 'PayloadSnippet']
  }
};

/**
 * อ่าน SAP credentials จาก Script Properties เท่านั้น
 * ต้องตั้งค่า: SAP_USER, SAP_PASS, SAP_CLIENT (=100)
 */
function getSapCredentials_() {
  const p = PropertiesService.getScriptProperties();
  const user = p.getProperty('SAP_USER');
  const pass = p.getProperty('SAP_PASS');
  if (!user || !pass) {
    throw new Error(
      'Missing SAP_USER / SAP_PASS — ตั้งค่าใน Project Settings → Script Properties ก่อนรัน');
  }
  return {
    user: user,
    pass: pass,
    client: p.getProperty('SAP_CLIENT') || '' // S/4HANA Cloud มักไม่บังคับ แต่รองรับไว้
  };
}

/** Returns active user email, or 'unknown' if the scope is unavailable. */
function getActiveUserSafe_() {
  try {
    var email = Session.getActiveUser().getEmail();
    return email || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

function setRunbookExecUrl(url) {
  PropertiesService.getScriptProperties().setProperty('WEBAPP_EXEC_URL', String(url || '').trim());
  logEvent('RUNBOOK', 'SET_EXEC_URL', url);
}

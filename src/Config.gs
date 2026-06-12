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

  // ---- Safety gate -------------------------------------------------------
  DRY_RUN: true, // เปลี่ยนเป็น false เมื่อผ่าน Test Gate ข้อ 3 แล้วเท่านั้น

  // ---- SAP tenant --------------------------------------------------------
  SAP_BASE_URL: 'https://my417293-api.s4hana.cloud.sap',
  PLANT: '1100',

  // ---- Google Sheet ------------------------------------------------------
  SHEET_ID: '1NZmKOuYAmpu1csjd83kNgZXSjCz5lVk7odIyDxJoKRk',

  // ---- Pull behaviour ----------------------------------------------------
  PULL_DAYS_BACK: 30,   // ดึง PO ที่ PlannedStartDate ย้อนหลังกี่วัน (0 = ไม่ filter วันที่)
  PAGE_SIZE: 200,       // OData $top ต่อ page (pagination ผ่าน __next)
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

  // ---- Sheet names ---------------------------------------------------------
  SHEETS: {
    CONFIG:            'Config',
    PRODUCTION_ORDERS: 'ProductionOrders',
    PALLET_MASTER:     'PalletMaster',
    MOQ_CONFIG:        'MOQ_Config',
    INSPECTION_LOTS:   'InspectionLots',
    EVENT_LOG:         'EventLog',
    ERROR_LOG:         'ErrorLog'
  },

  // ---- Sheet headers (single source of truth — SheetSetup + writers ใช้ชุดเดียวกัน)
  HEADERS: {
    CONFIG: ['Key', 'Value', 'Description'],

    PRODUCTION_ORDERS: [
      'ProductionOrder',            // A: key (idempotency)
      'Material',
      'MaterialName',
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
      'IsReleased',
      'LastSyncAt'
    ],

    PALLET_MASTER: [
      'PalletID',                   // {PO}-P{seq} — key (idempotency, QR payload)
      'ProductionOrder', 'Material', 'MaterialName', 'Batch',
      'QtyPerPallet', 'Unit', 'PalletSeq', 'TotalPallets',
      'WorkCenter', 'ProductionDate', 'QRPayload',
      'LabelPrintedAt', 'ScanStatus', 'ScannedAt', 'ScannedBy',
      'GRMaterialDocument', 'QCStatus', 'InspectionLot', 'UpdatedAt'
    ],

    MOQ_CONFIG: [
      'Material', 'MaterialName', 'MaterialType', // SEMI / FG
      'MOQ_Per_Pallet', 'Unit', 'MaxPalletQty', 'Remark'
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

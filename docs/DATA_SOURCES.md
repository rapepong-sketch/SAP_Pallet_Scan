# DATA_SOURCES — SAP S/4HANA Cloud API Mapping

> ตรวจสอบ API version จริงใน SAP API Business Hub (api.sap.com) ก่อนใช้ — endpoint อาจต่างตาม release

## 1. Production Order (อ่าน)
- API: `API_PRODUCTION_ORDER_2_SRV` (OData V2) หรือ `ProductionOrder` (V4)
- Entity: `A_ProductionOrder_2`, `A_ProductionOrderComponent_2`, `A_ProductionOrderOperation_2`
- Fields หลัก: ManufacturingOrder, Material, TotalQuantity, ProductionPlant, MfgOrderPlannedStartDate, OrderIsReleased
- Filter ตัวอย่าง: `$filter=ProductionPlant eq '1000' and OrderIsReleased eq true`
- Comm Arrangement: SAP_COM_0104

## 2. BOM (อ่าน)
- API: `API_BILL_OF_MATERIAL_SRV;v=2`
- Entity: `MaterialBOM`, `MaterialBOMItem`
- หมายเหตุ: Production Order Component (ข้อ 1) มักพอใช้แทน BOM master ได้ — ใช้ component ของ order จริงดีกว่า
- Comm Arrangement: SAP_COM_0318

## 3. Routing / Operations (อ่าน)
- ใช้ `A_ProductionOrderOperation_2` จาก Production Order API (operation จริงของ order)
- Fields: ManufacturingOrderOperation, WorkCenter, OperationText, OpPlannedTotalQuantity

## 4. Material Master (อ่าน)
- API: `API_PRODUCT_SRV`
- Entity: `A_Product`, `A_ProductDescription`, `A_ProductPlant`
- ใช้ดึง: ชื่อสินค้า, Base UoM, (MOQ ถ้าเก็บใน custom field)
- Comm Arrangement: SAP_COM_0102

## 5. Batch (อ่าน)
- API: `API_BATCH_SRV`
- Entity: `Batch`
- Fields: Material, Batch, BatchBySupplier, ShelfLifeExpirationDate

## 6. Inspection Lot — QM (อ่าน + เขียน)
- API: `API_INSPECTIONLOT_SRV`
- Entity: `A_InspectionLot`, `A_InspLotUsageDecision`
- อ่าน: lot ที่ผูกกับ production order (`InspLotOrigin eq '03'`)
- เขียน: POST Usage Decision (Accept/Reject)
- Comm Arrangement: SAP_COM_0110

## 7. Production Order Confirmation (เขียน)
- API: `API_PROD_ORDER_CONFIRMATION_2_SRV`
- Entity: `ProdnOrdConf2`
- POST: confirm yield quantity ต่อ operation — ใช้ตอน scan ส่งผลผลิต
- Comm Arrangement: SAP_COM_0106

## 8. Goods Movement (เขียน — ถ้าต้อง GR แยก)
- API: `API_MATERIAL_DOCUMENT_SRV`
- Entity: `A_MaterialDocumentHeader` + `A_MaterialDocumentItem`
- Movement Type 101 (GR for order)
- Comm Arrangement: SAP_COM_0109

## Google Sheets Structure (Middleware)
| Sheet | หน้าที่ |
|---|---|
| Config | MOQ mapping, plant, flags |
| ProductionOrders | order ที่ดึงมา |
| Pallets | pallet records + status |
| ScanLog | ทุกการ scan (timestamp, operator, pallet) |
| QcResults | ผล QC ต่อ pallet |
| WritebackQueue | รายการรอ post เข้า SAP |
| ApiLog | log ทุก API call |

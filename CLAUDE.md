# SAP Pallet Tracking System — CLAUDE.md

## Project
- GAS project in src/ — deploy via `clasp push`
- SAP tenant: https://my417293-api.s4hana.cloud.sap | Plant: 1100
- Google Sheet ID: 1NZmKOuYAmpu1csjd83kNgZXSjCz5lVk7odIyDxJoKRk
- Script ID: 1XWzndOUMBb5UvpAD-6OYLXdPdSzWyi5AqWPF8FjLExfnhJ3g3TCZsS7Y

## Coding Rules (never violate)
- DRY_RUN gate on every write operation — never hardcode DRY_RUN = false
- Never hardcode credentials — use PropertiesService.getScriptProperties() only
- Idempotency key for every insert = PalletID (PalletGen) or ManufacturingOrder (PO sync)
- Log every operation to EventLog sheet via logEvent(type, status, detail)
- Every .gs file must have a JSDoc header with phase number and purpose
- QR API = api.qrserver.com — Google Charts (chart.googleapis.com) is shut down, never use it

## Phase Status
- Phase 1 COMPLETE: Config.gs, SheetSetup.gs, SapClient.gs, ProductionOrders.gs
- Phase 2 COMPLETE: MOQConfigSetup.gs, PalletGen.gs, LabelPrint.gs
- Phase 3 PENDING: Mobile scanner Web App (doGet), Goods Receipt POST to SAP
- Phase 4 PENDING: QC Inspection UI, Inspection Lot PATCH to SAP QM
- Phase 5 PENDING: SAP writeback (Order Confirmation, Stock)

## Key Field Mapping
- Production Order key field = ManufacturingOrder (NOT ProductionOrder)
- QR Payload format = PALLET|{PalletID}|{ManufacturingOrder}|{Material}|{Batch}|{Qty}
- PalletID format = {ManufacturingOrder}-P001, P002, ...
- Status lifecycle = CREATED → PRINTED → SCANNED → QC_PASS / QC_HOLD / QC_REJECT

## SAP OData Services
- Production Orders: API_PRODUCTION_ORDER_2_SRV / A_ProductionOrder_2
- Goods Movement: API_MATERIAL_DOCUMENT_SRV (Phase 3) — needs SAP_COM_0109
- Order Confirmation: API_PROD_ORDER_CONFIRMATION_2_SRV (Phase 3) — needs SAP_COM_0104
- Inspection Lot: API_INSPECTIONLOT_SRV (Phase 4) — needs SAP_COM_0190

## Deploy Command
clasp push   # always run from project root after any code change

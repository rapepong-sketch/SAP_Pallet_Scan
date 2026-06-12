# SAP_Pallet_Tracker — Project Instructions for Claude Code

## Project Overview
ระบบใบติดตามพาเลท (Pallet Tracking System) ดึงข้อมูลจาก SAP S/4HANA Cloud 100%
- พิมพ์ใบติดตามพาเลท แยกตาม MOQ ต่อ Material
- Scan QR ผ่านมือถือเพื่อ confirm การส่งผลผลิต (Production) และบันทึกผล QC
- Writeback สถานะกลับเข้า SAP (Goods Movement / Inspection Lot Usage Decision)
- Platform: Google Apps Script (GAS) + Google Sheets เป็น middleware/UI
- Pattern เดียวกับโปรเจค SAP_Sales_Order_Hub: phased architecture, dry-run default, safety gates, idempotent

## Tech Stack & Constraints
- Google Apps Script (V8 runtime) — ห้ามใช้ arrow function ใน IIFE (GAS quirk)
- HTML Service สำหรับ Mobile Web App — ใช้ `<?!= ?>` สำหรับ unescaped template output
- clasp CLI สำหรับ local development
- SAP OData V2/V4 APIs ผ่าน UrlFetchApp + Basic Auth (Communication User)
- ทุก write operation ต้องมี DRY_RUN flag (default = true)
- ทุก batch call ต้อง idempotent — เช็ค duplicate ก่อนสร้างเสมอ
- Logging ทุก API call ลง Log sheet พร้อม timestamp + payload + response

## Architecture (Phased)
- Phase 1: Config + SAP connection test (read-only)
- Phase 2: ดึง Production Order + BOM + Routing ลง Sheets
- Phase 3: MOQ split logic + สร้าง Pallet records + พิมพ์ Label (PDF + QR)
- Phase 4: Mobile Web App — scan confirm production
- Phase 5: QC Module — checklist + result recording
- Phase 6: SAP Writeback (Goods Receipt + Usage Decision) — gated, dry-run first
- Phase 7: Dashboard + Lark notifications

## File Structure
```
sap_pallet_tracker/
├── CLAUDE.md                  # this file
├── docs/
│   ├── CONFIG_CHECKLIST.md    # ข้อมูลที่ต้องเตรียมก่อนเริ่ม
│   ├── DATA_SOURCES.md        # SAP API mapping
│   └── ARCHITECTURE.md        # design doc (สร้างใน Phase 1)
├── src/
│   ├── 00_Config.js           # CONFIG object, sheet names, flags
│   ├── 01_SapClient.js        # OData client (auth, GET/POST/PATCH, retry)
│   ├── 02_ProductionOrder.js  # ดึง Production Order
│   ├── 03_BomRouting.js       # ดึง BOM + Routing
│   ├── 04_PalletEngine.js     # MOQ split, pallet ID generation
│   ├── 05_LabelPrint.js       # PDF label + QR code
│   ├── 06_MobileApp.js        # doGet router + scan endpoints
│   ├── 07_QcModule.js         # QC checklist + result
│   ├── 08_Writeback.js        # SAP writeback (gated)
│   ├── 09_Dashboard.js        # summary + charts
│   ├── 10_LarkNotify.js       # Lark webhook
│   ├── 99_Utils.js            # logging, retry, idempotency helpers
│   └── html/
│       ├── scan.html          # mobile scan page
│       └── qc.html            # QC checklist page
└── appsscript.json
```

## Coding Rules
1. ทุกไฟล์ JS ใช้ JSDoc ครบทุก function
2. CONFIG อยู่ที่เดียว (00_Config.js) — ไม่ hardcode URL/credential ในไฟล์อื่น
3. Credentials เก็บใน Script Properties เท่านั้น (SAP_BASE_URL, SAP_USER, SAP_PASS, LARK_WEBHOOK)
4. Pallet ID format: `{OrderNo}-{Seq3digit}` เช่น `1000123-001`
5. ทุก writeback function ต้องผ่าน safety gate: `if (CONFIG.DRY_RUN) { log only }`
6. Status flow ของ pallet: `CREATED → PRINTED → PRODUCED → QC_PASS / QC_HOLD / QC_REJECT → POSTED_TO_SAP`
7. ห้าม transition ข้าม status — validate ทุกครั้ง

## Before Writing Code
อ่าน docs/CONFIG_CHECKLIST.md และยืนยันว่าข้อมูล config ครบก่อน
ถ้าข้อมูลไม่ครบ ให้ถาม user ก่อนเริ่ม Phase นั้น ๆ

## Verification Pattern
ทุก Phase: เขียนโค้ด → user ทดสอบ → ส่ง log/screenshot → ยืนยัน → ค่อยไป Phase ถัดไป

# Phase 2 — Pallet Generation + Label Printing

## ไฟล์ใหม่
| File | หน้าที่ |
|---|---|
| `MOQConfigSetup.gs` | สร้าง/seed ชีต `MOQ_Config` + helper `getMoqMap()` |
| `PalletGen.gs` | split TotalQuantity ตาม MOQ → `PalletMaster` (idempotent ด้วย PalletID) |
| `LabelPrint.gs` | HTML label A5 (2/A4) + QR + popup print dialog |

## เพิ่มใน Config.gs
```javascript
// QR API — Google Charts (chart.googleapis.com) ถูกปิดแล้ว ห้ามใช้
CFG.QR_API = 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=';
// fallback: 'https://quickchart.io/qr?size=150&text='
```

## เพิ่มในเมนู onOpen (SheetSetup.gs)
```javascript
.addSeparator()
.addItem('⚙️ Setup MOQ Config', 'setupMoqConfig')
.addItem('📦 Generate Pallets (ALL)', 'generatePallets')
.addItem('📦 Generate Pallets (1 Order)', 'generatePalletsForOrder')
.addItem('🖨️ Print Pallet Labels', 'printLabelsDialog')
```

## ลำดับการใช้งาน
1. `setupMoqConfig()` → ใส่ค่า MOQ จริงในชีต `MOQ_Config` (seed เป็นตัวอย่างเท่านั้น)
2. ตั้ง `CFG.DRY_RUN = true` → รัน `generatePallets()` → ดู EventLog summary
3. พอใจแล้ว → `DRY_RUN = false` → รันจริง → ได้ rows ใน `PalletMaster`
4. `printLabelsDialog()` → ใส่ MO หรือ PalletID → popup → Print / Save PDF

## Design notes
- **Idempotent**: PalletID เป็น key — รันซ้ำกี่ครั้งก็ไม่สร้างซ้ำ; ถ้า TotalQuantity เปลี่ยนหลัง gen แล้ว จะเพิ่มเฉพาะ pallet seq ใหม่ (ใบเดิมไม่ถูกแก้ — ถ้าต้อง regen ให้ลบ rows ของ MO นั้นเอง)
- **เศษ pallet สุดท้าย**: ใบสุดท้าย = total − (moq × (n−1)) เช่น 950/200 → P001–P004=200, P005=150
- **Status lifecycle**: `CREATED → PRINTED → SCANNED → QC_PASS/HOLD/REJECT` (Phase 3/4 จะ update ผ่าน scan + QC)
- **QR payload**: `PALLET|{PalletID}|{MO}|{Material}|{Batch}|{Qty}` — Phase 3 mobile scanner จะ parse ด้วย `split('|')`
- **MaxPalletQty**: ยังไม่ enforce ใน Phase 2 (สำรองไว้สำหรับ validation ตอน scan ว่า GR qty ≤ max)
- Materials ที่ไม่มีใน MOQ_Config จะถูก skip และรายงานใน summary — เติม config แล้วรันใหม่ได้เลย

## Phase 3 preview (Mobile Scan)
- `doGet(e)` Web App → mobile UI + html5-qrcode
- Scan → parse payload → POST goods movement ผ่าน `API_MATERIAL_DOCUMENT_SRV` (GM code 02, movement 101) หรือ confirmation ผ่าน `API_PROD_ORDER_CONFIRMATION_2_SRV`
- ต้องมี Communication Arrangement `SAP_COM_0109` (Material Documents) / `SAP_COM_0104` (Confirmations)

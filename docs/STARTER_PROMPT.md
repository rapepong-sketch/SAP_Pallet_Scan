# STARTER_PROMPT — copy ไปวางใน Claude Code เพื่อเริ่มโปรเจค

```
อ่าน CLAUDE.md, docs/CONFIG_CHECKLIST.md และ docs/DATA_SOURCES.md ในโปรเจคนี้ก่อน

เราจะสร้างระบบ Pallet Tracking ที่ integrate กับ SAP S/4HANA Cloud
ตาม phased architecture ที่กำหนดใน CLAUDE.md

เริ่มจาก Phase 1:
1. ตรวจสอบว่าข้อมูลใน CONFIG_CHECKLIST ส่วน A (SAP Connection) ครบหรือยัง
   ถ้าไม่ครบ ให้ list คำถามที่ต้องการคำตอบจากผม
2. สร้าง src/00_Config.js — CONFIG object, sheet names, DRY_RUN flag,
   Script Properties keys
3. สร้าง src/01_SapClient.js — OData client พร้อม:
   - Basic Auth จาก Script Properties
   - GET พร้อม $filter/$select/$top
   - retry with exponential backoff (3 ครั้ง)
   - log ทุก call ลง ApiLog sheet
4. สร้าง function testConnection() ที่ดึง Production Order 5 รายการ
   มาแสดงเพื่อทดสอบ

ข้อกำหนด:
- GAS V8, ไม่ใช้ arrow function ใน IIFE
- JSDoc ทุก function
- ยังไม่ต้องเขียน Phase อื่น — รอผมทดสอบ Phase 1 และส่ง log ให้ก่อน
```

## คำสั่ง clasp ที่ใช้
```bash
npm install -g @google/clasp
clasp login
clasp create --title "SAP_Pallet_Tracker" --type sheets
clasp push          # push code ขึ้น GAS
clasp open          # เปิด editor
```

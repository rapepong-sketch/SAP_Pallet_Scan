# PJ Chonburi Pallet System — Ops Runbook

## เปิดวันผลิตจริง (Pre-shift checklist)

1. `git pull && clasp pull` — ยืนยัน HEAD ล่าสุด
2. เปิด Sheet → เมนู 🏭 → ⚙ ตั้งค่า → **📊 System Status** (เช็ก SAP ✅ + flags ถูกต้อง)
3. ถ้าแก้โค้ด (.gs หรือ .html): `clasp push` → **Manage Deployments → Edit → New Version** → ยืนยัน `/exec` URL ใหม่
4. Flip flags ถ้าต้องการ LIVE:
   - FEATURE_TRANSFER311 → LIVE (เมนู Transfer → เปิดใช้งานจริง)
   - SAP_WRITE_ENABLED → true + DRY_RUN → false (เมนู ⚙️ Pallet SAP Toggle)
5. ให้ operator สแกนเครื่อง `M:APSxxx` ครั้งแรกของกะ (sticky badge จะติดตลอดกะ)

## ปิดกะ / สิ้นสุดวัน

1. เมนู ▶ งานประจำ → **📊 รายงาน Yield/QC** (ตรวจเลข)
2. Lark ห้อง QC รับรายงาน 18:00 อัตโนมัติ (ถ้า REPORT_LARK_QC=LIVE)
3. Reset flags → DRY_RUN ถ้าต้องการ:
   - เมนู ⚙️ Pallet SAP Toggle → ↩️ รีเซ็ตเป็น default ปลอดภัย

## Troubleshoot: "สแกนแล้วไม่บันทึก / ไม่ส่ง SAP"

- เช็ก: แก้ .gs แต่ลืม REDEPLOY? → Manage Deployments → Edit → New version
- เช็ก: DRY_RUN=true / SAP_WRITE_ENABLED=false? → System Status dialog
- เช็ก: Network tab (F12) ดู response body `[Ljava.lang.Object` → google.script.run serialization error (ฟังก์ชัน return ต้อง JSON-safe)

## Troubleshoot: "Lark ไม่ส่ง"

- REPORT_LARK_QC=LIVE? + LARK_WEBHOOK_URL_QC set? → System Status
- Webhook หมดอายุ? → สร้าง custom bot ใหม่ใน Lark → อัป ScriptProperties

## Troubleshoot: "เครื่องจักร badge ไม่ขึ้น"

- สแกน QR ที่ขึ้นต้น `M:APSxxx` → badge สีเขียว
- ถ้า badge แดง "ไม่พบเครื่อง" → เช็ก MachineMaster: Active=TRUE + MachineCode ตรงกัน
- Badge sticky ตลอดกะ — ไม่ต้องสแกนซ้ำทุกพาเลท

## Feature flag states (reference)

| Flag | OFF / false | DRY_RUN / true | LIVE |
|------|-------------|----------------|------|
| DRY_RUN | — | 🧪 build+log เท่านั้น (default) | ⚠️ POST จริง |
| SAP_WRITE_ENABLED | 🔴 ปิด SAP (default) | — | 🟢 เปิดเขียน SAP |
| FEATURE_TRANSFER311 | ไม่โอนย้าย | 🧪 log payload เท่านั้น (default) | 🟢 POST 311 จริง |
| FEATURE_QM_UD | 🔴 record-only (parked) | — | POST UD จริง |
| REPORT_LARK_QC | ไม่ส่ง | 🧪 log payload (default) | 🟢 ส่งห้อง QC |

## การเพิ่มเครื่องใน MachineMaster

1. เปิด Sheet → แท็บ MachineMaster → เพิ่มแถว (MachineCode unique, Active=TRUE)
2. เมนู ▶ งานประจำ → 🏷️ พิมพ์ QR เครื่องจักร → เลือก dept หรือ ALL → พิมพ์ A4
3. ติด sticker หน้าเครื่อง

## Phase status

| Phase | Status | Description |
|-------|--------|-------------|
| 1 — Config + SAP | ✅ COMPLETE | Config, SheetSetup, SapClient, ProductionOrders |
| 2 — Pallet Gen | ✅ COMPLETE | MOQ, PalletGen, LabelPrint, PrintEngine |
| 2.5 — Material + Print | ✅ COMPLETE | MaterialMaster, PrintEngine FIFO, PalletSheet A4 |
| 3 — Scanner + Confirm | ✅ COMPLETE | Mobile scanner, OperationLog, SAP confirmation |
| 3.5 — Transfer + Override | ✅ COMPLETE | Transfer 311, Admin override, FIFO pick |
| 4 — QC Inspection | 🟡 PARTIAL | QC UI live; SAP QM UD parked (no lots) |
| 4.5 — Yield/QC Report | ✅ COMPLETE | Snapshot, Lark push, tripwires, machine localize |
| M1–M3 — Machine Capture | ✅ COMPLETE | MachineMaster, ActualMachine, scanner M: badge |
| 5 — SAP Writeback | 🔜 PENDING | Stock posting, full confirmation flow |

## Deployment reminder

```
clasp push                          # push code to Apps Script (HEAD only)
clasp deploy -i <deployment-id>     # REDEPLOY to update web app version
```

**`clasp push` alone does NOT update the web app.** The web app runs the pinned
deployment version. Always REDEPLOY (new version) after changing any `.gs` or
`.html` file that the web app serves.

# Handoff — Phase 4.5C: QM Usage Decision Writeback

> เอกสารส่งต่อสำหรับ session ถัดไป
> ภาษาไทย (สนทนา) + English สำหรับ SAP/Claude Code terms

---

## สถานะปัจจุบัน (ปิดแล้วใน session นี้)

### Phase 4.5 Operator/QC split — ปิดครบทุก gate (1→3d), 5/5 tests pass

- **scan mode** = operator ลงยอด 4 ช่อง, SEQUENTIAL LOCK kept
- **qc mode** (ใหม่, mode ที่ 3 ใน `switchMode`) =
  - PD สุ่มราย op (optional, record-only)
  - QC final (gate `checkAllOperationsDone_`)
- inline PD/QC **ถอดออกจาก scan mode** แล้ว
- **QCInspector column** (PalletMaster col 41/AO) เพิ่มแล้ว, `saveQcResult` เขียนแล้ว
  - `TEST_qcInspectorWrite_` ยืนยัน `'TESTQC_INSPECTOR'` persisted
- **UX**: loading state + inline red validation ทุกปุ่มบันทึก

### Item B QR parser — ปิดแล้ว

- `parseQrPayload` รับ Format B (`P:|Q:|L:`) แล้ว
- count mode delegate มาใช้ `parseQrPayload`, `T:` guard คงไว้
- scan+qc mode รับ Format B เป็น bonus

---

## ที่เก็บข้อมูล QC/PD ตอนนี้ (record-only, local)

| ข้อมูล | ที่เก็บ | columns |
|--------|---------|---------|
| PD ราย op | **OperationLog** | PDResult / PDInspector / PDNote / PDTimestamp |
| QC ทั้งพาเลท | **PalletMaster** | QCStatus=`INSPECTED` / QCResult=`PASS`\|`FAIL` / QCResultNote / QCInspector / ScanStatus=`QC_COMPLETE` |

**InspectionLots sheet** มีอยู่แล้วแต่ยังว่าง (รอ Phase 4.5C):

columns: `InspectionLot` / `Material` / `Batch` / `Plant` / `InspectionLotObjectType` /
`InspLotQuantity` / `Unit` / `ProductionOrder` / `UD_Code` / `UD_Status` / `LastSyncAt`

---

## งานถัดไป — Phase 4.5C: QM Usage Decision writeback

**เป้าหมาย**: เขียน QC PASS/FAIL กลับ SAP QM เป็น Usage Decision (UD)

### Comm Arrangement

- **SAP_COM_0319** (Quality Inspection) — confirmed on tenant `my417293`

### เริ่มด้วย READ-ONLY diagnostic gate (อย่าข้าม)

1. **Probe `API_INSPECTIONLOT_SRV`** ของจริงบน tenant `my417293`:
   - entitySet, key fields
   - fields สำหรับ Usage Decision (UD code `A`=accept / `R`=reject)
   - inspection lot จาก production order
2. **หา mapping: pallet → InspectionLot**
   - PalletMaster มี InspectionLot column (col 30) แต่ "ว่างทุก row" (per Gate 1 diagnostic)
   - ต้องหาว่า inspection lot ของ production order ดึงจาก SAP ยังไง แล้ว populate InspectionLots sheet
3. **ยืนยัน UD code values จริง** (`A`/`R` หรือ tenant-specific) ก่อน build payload

### จากนั้น: implementation gates (discipline เดิม)

```
DRY_RUN payload builder → TEST_ → LIVE
```

### Idempotency

- UD เขียนครั้งเดียวต่อ lot
- guard ถ้า `UD_Status` set แล้ว

---

## บทเรียนสำคัญ (ย้ำ)

- **DEPLOYMENT**: `clasp push` อัปแค่ HEAD; web app `/exec` รัน deployment snapshot —
  แก้ HTML *หรือ* server `.gs` ที่ web app เรียก **ต้อง REDEPLOY New Version**
- **Leading zeros = STRING** (Batch, FinalOperation, op numbers, InspectionLot น่าจะด้วย)
- **Column by NAME** via header map เท่านั้น — ห้าม hardcode column index
- `google.script.run` return → `JSON.parse(JSON.stringify())`
- **Schema change**: backup-first + idempotency + postcondition (เหมือน Gate 3a)
- **TEST_ prefix**, self-clean, fake `PL-TEST-*` (ถูก filter จาก production lists)
- Credentials ใน `PropertiesService` เท่านั้น; `logEvent` ทุก operation
- **FETCH_URL log ก่อน `UrlFetchApp` ทุกครั้ง** (เลิกเดา entity/path)

---

## SESSION WORKFLOW

### เปิด session

```bash
git pull && clasp pull && git log --oneline -5 && git status
```

### ปิด session

- Reset flags → `DRY_RUN`
- Redeploy เมื่อแก้ web app code

---

## FIRST TASK แชทใหม่

> เริ่ม Phase 4.5C ด้วย **READ-ONLY diagnostic** ของ `API_INSPECTIONLOT_SRV`:
>
> 1. Probe entitySet / key / UD fields บน tenant จริง
> 2. Mapping pallet → InspectionLot
> 3. ก่อนออกแบบ payload

# Yield + QC Reporting — READ-ONLY Schema Diagnostic

> Generated: 2026-06-22
> Source: `src/` after `clasp pull` — code-only, no live sheet reads (no SAP, no redeploy)

---

## A. OperationLog (per-operation source of truth)

### A1. Full header row (18 columns)

Source of truth: `OL_HEADERS` in `OperationLog.gs:17-22`, mirrored in
`CFG.HEADERS.OPERATION_LOG` (`Config.gs:142-147`).

| 0-based index | Column name     |
|:---:|:---|
| 0  | LogID |
| 1  | PalletID |
| 2  | ManufacturingOrder |
| 3  | OperationNo |
| 4  | OperationText |
| 5  | GoodQty |
| 6  | ScrapQty |
| 7  | RepairQty |
| 8  | AwaitConvQty |
| 9  | Operator |
| 10 | Role |
| 11 | Result |
| 12 | LoggedAt |
| 13 | Source |
| 14 | PDResult |
| 15 | PDInspector |
| 16 | PDNote |
| 17 | PDTimestamp |

### A2. Yield bucket columns

| Bucket | Header text | 0-based index | Written by |
|:---|:---|:---:|:---|
| Good | `GoodQty` | **5** | `logOperation` (OperationLog.gs:129) |
| Scrap | `ScrapQty` | **6** | `logOperation` (OperationLog.gs:130) |
| Repair | `RepairQty` | **7** | `logOperation` (OperationLog.gs:131) |
| AwaitConv | `AwaitConvQty` | **8** | `logOperation` (OperationLog.gs:132) |

All four are written via `Number(entry.xxxQty) || 0` — always **number**, never
string. Zero-default means blank rows will have `0`, not empty string.

**Note**: OperationLog uses `ScrapQty` (index 6) while PalletMaster uses
`DefectQty` (index 38). The column **names differ** between the two sheets.
Any join/rollup code must map `ScrapQty` ↔ `DefectQty`.

### A3. Keys, dimensions, and time columns

| Purpose | Column name | Index | Notes |
|:---|:---|:---:|:---|
| Pallet key (join) | `PalletID` | 1 | `String`, forced Plain Text format |
| MO key | `ManufacturingOrder` | 2 | `String`, forced Plain Text |
| Operation number | `OperationNo` | 3 | `String`, zero-padded 4 digits via `_normOpNo_` |
| Operation text | `OperationText` | 4 | Free text from SAP routing |
| Operator name | `Operator` | 9 | Free text (employee name) |
| Role | `Role` | 10 | `'OP'` / `'PD'` / `'QC'` |
| Result | `Result` | 11 | `'PASS'` / `'FAIL'` |
| Timestamp | `LoggedAt` | 12 | `new Date()` — **JS Date object** |
| Source | `Source` | 13 | `'MOBILE'` / `'MANUAL'` / `'SYSTEM'` |

**WorkCenter is NOT stored in OperationLog.** It exists only on PalletMaster
(per pallet, index 9) and in the routing data returned by
`getOperationsForOrder(mo)` → `{opNo, opText, workCenter, isFinal}`.
To group by work center per operation, a 3-way join is needed:
`OperationLog.OperationNo` + `OperationLog.ManufacturingOrder` →
`getOperationsForOrder(mo)` → `workCenter` per `opNo`.

**Material is NOT directly stored in OperationLog.** It must be resolved via
`PalletID` → `PalletMaster.Material` or via `ManufacturingOrder` →
`ProductionOrders.Material`.

### A4. PD sampling fields

| Field | Index | Written by |
|:---|:---:|:---|
| `PDResult` | 14 | `updatePdResult_` (OperationLog.gs:279) |
| `PDInspector` | 15 | `updatePdResult_` (OperationLog.gs:280) |
| `PDNote` | 16 | `updatePdResult_` (OperationLog.gs:281) |
| `PDTimestamp` | 17 | `updatePdResult_` (OperationLog.gs:282) — `new Date()` |

PD fields are empty on initial write (`logOperation` sets them to `''`) and
filled in-place by `updatePdResult_` only when a PD inspector inspects that
operation. PD is optional random sampling — most rows will have empty PD fields.

### A5. Value-format probe (from code analysis)

| Column | Written as | Expected `typeof` | Blank value |
|:---|:---|:---|:---|
| GoodQty | `Number(entry.goodQty) \|\| 0` | `number` | `0` (never blank) |
| ScrapQty | `Number(entry.scrapQty) \|\| 0` | `number` | `0` (never blank) |
| RepairQty | `Number(entry.repairQty) \|\| 0` | `number` | `0` (never blank) |
| AwaitConvQty | `Number(entry.awaitConvQty) \|\| 0` | `number` | `0` (never blank) |
| LoggedAt | `new Date()` | `object` (Date) | Never blank |
| PDTimestamp | `new Date()` or `''` | `object` (Date) or `string` | `''` when no PD |
| Operator | `String(…).trim()` | `string` | `''` if unset |

**Serialization risk**: `LoggedAt` and `PDTimestamp` are Date objects. When
returned via `google.script.run` → `JSON.parse(JSON.stringify(…))`, they
serialize to ISO strings. When read via `getValues()`, they come back as JS
Date objects. Any report code reading from sheet must handle Date objects for
time-series grouping.

### A6. Row count (code-level)

Row count cannot be determined from code alone — it depends on how many
operations have been confirmed in production. Based on the codebase:
- Every `confirmScan()` call creates one OperationLog row (WebApp.gs:290-303)
- Each pallet has N operations (varies by MO routing, typically 3-10)
- With ~14 pallets in PalletMaster and ~5 ops each → estimate ~70 rows

Bucket population: every row has all 4 buckets populated (default `0`) because
`logOperation` writes `Number(…) || 0` for all four. No row should have blank
buckets.

---

## B. PalletMaster (per-pallet mirror + QC)

### B1. Full header row (41 columns)

Source of truth: `PM_HEADERS` in `PalletGen.gs:21-63`, identical to
`CFG.HEADERS.PALLET_MASTER` (`Config.gs:111-125`).

| Index | Column name | Index | Column name |
|:---:|:---|:---:|:---|
| 0  | PalletID | 21 | GRMaterialDocument |
| 1  | ManufacturingOrder | 22 | GRMaterialDocumentYear |
| 2  | Material | 23 | ConfirmationGroup |
| 3  | MaterialName | 24 | ConfirmationCount |
| 4  | Batch | 25 | ConfirmedAt |
| 5  | QtyPerPallet | 26 | ConfirmedBy |
| 6  | Unit | 27 | QCStatus |
| 7  | PalletSeq | 28 | QCResult |
| 8  | TotalPallets | 29 | InspectionLot |
| 9  | WorkCenter | 30 | LabelPrintedAt |
| 10 | ProductionDate | 31 | UpdatedAt |
| 11 | TotalQuantity | 32 | QCResultNote |
| 12 | Plant | 33 | OverrideBy |
| 13 | StorageLocation | 34 | OverrideReason |
| 14 | QRPayload | 35 | OverrideAt |
| 15 | Status | 36 | GoodQty |
| 16 | CreatedAt | 37 | RepairQty |
| 17 | PrintedAt | 38 | DefectQty |
| 18 | ScannedAt | 39 | AwaitConvQty |
| 19 | ScannedBy | 40 | QCInspector |
| 20 | ScanStatus | | |

### B2. Mirrored bucket columns

| Bucket | Column name | Index | Written by |
|:---|:---|:---:|:---|
| Good | `GoodQty` | **36** | `confirmScan` → `updatePalletScanFields_` (WebApp.gs:310-313) |
| Repair | `RepairQty` | **37** | same |
| Defect | `DefectQty` | **38** | same — maps to OperationLog's `ScrapQty` |
| AwaitConv | `AwaitConvQty` | **39** | same |

These are written **only when `isFinalOp` is true** (WebApp.gs:309: `if (isFinalOp)`).
So only rows where the final routing operation has been scanned will have
non-empty bucket values. Earlier-stage pallets will have blank/0 in these
columns.

**Name mismatch confirmed**: PalletMaster uses `DefectQty` (index 38) while
OperationLog uses `ScrapQty` (index 6). Same semantic meaning, different names.

### B3. QC fields

| Field | Index | Values | Written by |
|:---|:---:|:---|:---|
| `QCStatus` | 27 | `''` → `'INSPECTED'` | `saveQcResult` (WebApp.gs:489) |
| `QCResult` | 28 | `'PASS'` / `'FAIL'` | `saveQcResult` (WebApp.gs:489) |
| `QCResultNote` | 32 | Free text (required on FAIL) | `saveQcResult` (WebApp.gs:489) |
| `QCInspector` | 40 | Inspector name | `saveQcResult` (WebApp.gs:489) |
| `ScanStatus` | 20 | Lifecycle: `''` → `SCANNED` → `PD_COMPLETE` → `QC_COMPLETE` → `CONFIRMED` | Various |

Value tallies cannot be determined from code alone (need live sheet data). Based
on codebase analysis:
- `QCStatus='INSPECTED'` + `QCResult='PASS'` + `ScanStatus='QC_COMPLETE'` are
  set together by `saveQcResult` (WebApp.gs:489-494)
- Pallets that haven't been QC'd will have blank QCStatus/QCResult
- `ScanStatus` progression: blank → `SCANNED` (first op confirm) → `PD_COMPLETE`
  (all ops done) → `QC_COMPLETE` (QC done) → `CONFIRMED` (SAP confirmation)

### B4. Key dimension columns

| Purpose | Column | Index | Notes |
|:---|:---|:---:|:---|
| Pallet key | `PalletID` | 0 | Join key to OperationLog |
| MO | `ManufacturingOrder` | 1 | |
| Material | `Material` | 2 | Direct — no join needed |
| Material name | `MaterialName` | 3 | |
| Batch | `Batch` | 4 | |
| Work center | `WorkCenter` | 9 | Per-pallet, from PO routing |
| Production date | `ProductionDate` | 10 | Date value from PO sync |
| Created date | `CreatedAt` | 16 | Pallet creation timestamp |
| Scanned date | `ScannedAt` | 18 | First scan timestamp |
| Confirmed date | `ConfirmedAt` | 25 | SAP confirmation timestamp |
| Updated date | `UpdatedAt` | 31 | Last field update timestamp |

### B5. Row count and sample structure

Row count depends on live data. Based on the handoff doc, ~14 production
pallets exist (excluding PL-TEST-* test pallets which are filtered in
production queries).

De-identified sample structure (columns relevant to reporting):

```
PalletID             | MO           | Material  | WorkCenter | ScanStatus   | QCStatus  | QCResult | GoodQty | DefectQty
PL-{MO}-L01         | 10000xxxxx   | 1234xxxx  | WC-xxx     | QC_COMPLETE  | INSPECTED | PASS     | 450     | 0
PL-{MO}-L02         | 10000xxxxx   | 1234xxxx  | WC-xxx     | SCANNED      |           |          |         |
```

---

## C. Join + Reporting Feasibility

### C1. Join grain

**Primary join key: `PalletID`** across OperationLog ↔ PalletMaster.

- OperationLog has `PalletID` (index 1) and `ManufacturingOrder` (index 2)
- PalletMaster has `PalletID` (index 0) and `ManufacturingOrder` (index 1)
- Both are String type, forced Plain Text format
- `PalletID` is the most specific — a given PalletID maps to exactly one MO,
  material, batch, and work center

**Secondary join**: OperationLog.OperationNo + OperationLog.ManufacturingOrder →
`getOperationsForOrder(mo)` routing data → `workCenter` per operation.

### C2. Supported groupings

| Grouping | Directly available? | Source |
|:---|:---:|:---|
| By Material | **Yes** | PalletMaster.Material (join via PalletID) |
| By ManufacturingOrder | **Yes** | Both sheets have it directly |
| By Work Center (per pallet) | **Yes** | PalletMaster.WorkCenter (index 9) |
| By Work Center (per operation) | **Indirect** | Requires routing lookup: MO+OpNo → `getOperationsForOrder` |
| By Operator | **Yes** | OperationLog.Operator (index 9) |
| By Date | **Yes** | OperationLog.LoggedAt (index 12) or PalletMaster.ProductionDate/ScannedAt |
| By Batch | **Yes** | PalletMaster.Batch (index 4, join via PalletID) |
| By Plant | **Yes** | PalletMaster.Plant (index 12) — single-plant system (1100) |
| By StorageLocation | **Yes** | PalletMaster.StorageLocation (index 13) |
| By PD Inspector | **Yes** | OperationLog.PDInspector (index 15) |
| By QC Inspector | **Yes** | PalletMaster.QCInspector (index 40) |

**Gaps**:
- Work center per operation is NOT stored in OperationLog — requires a routing
  lookup via `getOperationsForOrder(mo)`. This works but is an extra step per MO.
  For a report, caching the routing per MO once is efficient enough.
- Material is not in OperationLog — requires PalletMaster join. The MO field in
  OperationLog could also be joined to ProductionOrders for material, but
  PalletMaster is simpler.

### C3. Existing yield/QC report functions

**Confirmed: NO existing yield/QC reporting function exists.** Grep results:
- `YieldQCReport` / `YieldReport` / `QCReport` / `reportYield` / `reportQC` → **0 matches**
- The only report is `TransferReport.gs` (daily transfer/receive summary)

**Attachment points for a new YieldQCReport**:

1. **New file**: `YieldQCReport.gs` — following the `TransferReport.gs` pattern:
   - Constant: `var YQR_SHEET = 'YieldQCReport';`
   - `buildYieldQCReport_(dateStr)` → read OperationLog + PalletMaster, compute metrics
   - `writeYieldQCReportToSheet_(report)` → clear+overwrite snapshot sheet
   - `buildYieldQCReportText_(report)` → plain-text summary for dialog
   - Menu handlers: `yieldQcReportTodayDialog()` / `yieldQcReportDateDialog()`

2. **Sheet header**: add `'YIELD_QC_REPORT'` to `CFG.SHEETS` and `CFG.HEADERS`
   (Config.gs), and `setupSheets()` will auto-create it.

3. **Menu wiring** (SheetSetup.gs `onOpen`): add under `▶ งานประจำ` submenu,
   after the existing report items (lines 24-25):
   ```
   .addItem('📊 รายงาน Yield/QC วันนี้',     'yieldQcReportTodayDialog')
   .addItem('📅 รายงาน Yield/QC ตามวันที่',   'yieldQcReportDateDialog')
   ```

4. **Lark integration**: follow the `sendTodayReportLarkDialog` pattern in
   `LarkNotify.gs` to optionally push the report text to Lark webhook.

---

## GATE SUMMARY

| Metric | Required fields | Present? | Notes |
|:---|:---|:---:|:---|
| **Yield%** = Good / (Good+Repair+Defect+AwaitConv) | OperationLog: GoodQty, ScrapQty, RepairQty, AwaitConvQty | **Y** | All 4 buckets at indices 5-8; default 0, number type |
| **Scrap%** share | OperationLog.ScrapQty / sum | **Y** | Note: called `ScrapQty` in OL, `DefectQty` in PM |
| **Repair%** share | OperationLog.RepairQty / sum | **Y** | |
| **AwaitConv%** share | OperationLog.AwaitConvQty / sum | **Y** | |
| **QC pass rate** | PalletMaster: QCResult (`PASS`/`FAIL`), ScanStatus (`QC_COMPLETE`) | **Y** | Per-pallet, not per-operation |
| **PD sampling coverage** | OperationLog: PDResult (non-empty = inspected) / total ops | **Y** | Most rows will have empty PDResult (PD is optional) |
| **Time-series by date** | OperationLog.LoggedAt (Date object) | **Y** | Serialization: handle `instanceof Date` |
| **Group-by work center** | PalletMaster.WorkCenter (per pallet); routing lookup (per op) | **Y** (indirect) | Not in OperationLog directly — join required |
| **Group-by operator** | OperationLog.Operator | **Y** | Direct |
| **Group-by material** | PalletMaster.Material (join via PalletID) | **Y** (join) | Not in OperationLog directly |

### Field gaps

| Gap | Impact | Resolution |
|:---|:---|:---|
| `ScrapQty` (OL) vs `DefectQty` (PM) naming mismatch | Confusion risk in report code | Map explicitly; document in report constants |
| WorkCenter absent from OperationLog | Per-op WC grouping needs routing lookup | Cache `getOperationsForOrder(mo)` per MO; add opNo→WC map |
| Material absent from OperationLog | Grouping by material needs join | Join OperationLog → PalletMaster via PalletID |
| Small N (~14 pallets, ~70 op rows) | Percentages volatile; report still useful | Build to scale — same code works at 1000+ pallets |

### Verdict

**All metrics are feasible with existing schema.** No schema change needed.
The report can be built as a pure read-only aggregation over OperationLog +
PalletMaster, following the TransferReport.gs pattern. The only complexity is
the WorkCenter-per-operation join via routing lookup, which is a cached
in-memory operation and scales fine.

**Recommended next step**: write `YieldQCReport.gs` with a diagnostic/preview
gate (sheet snapshot only, no Lark push) to validate the aggregation logic
against live data before adding menu items.

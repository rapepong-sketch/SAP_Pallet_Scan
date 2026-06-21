# Phase 4.5 Gate 1 — Operator / QC Split Diagnostic

> **Read-only audit** — no code changes.
> Generated: 2026-06-21

---

## 1. ROUTING: doGet handler → HTML → server-fn table

The web app is served by `doGet()` in `src/WebApp.gs:28-84`.
Routing is keyed on the `?app=` query parameter (line 29).

| `?app=` value | HTML file | Auth gate | Server functions called via `google.script.run` |
|---|---|---|---|
| `scan` (default) | `Scanner.html` | **None** (open to all) | `getSapStatus` (line 714), `lookupPallet` (lines 806, 817), `confirmScan` (line 1130), `savePdInspection` (line 1255), `saveQcResult` (line 1357), `getTransferSlipInfo` (line 1537), `confirmTransfer311` (line 1625), `startCountSession` (line 1771), `recordCountScan` (line 1844), `getCountSessionSummary` (line 1876), `reconcileCountWithSAP` (line 1903) |
| `print` | `AdminPrint.html` | `isAdminUser_()` (line 69) | `getActiveUserEmail` (line 161), `getSapStatus` (line 170), `getCascadeData` (line 194), `previewPalletAllocation` (line 411), `commitPalletAllocation` (line 555), `buildPalletSheetsHtml` (line 626) |
| `confirm` | `AdminConfirm.html` | `isAdminUser_()` (line 69) | `getActiveUserEmail` (line 320), `getSapStatus` (line 331), `listConfirmablePallets` (line 371), `batchConfirmPallets` (line 556), `listOverrideCandidates` (line 669), `batchOverrideConfirm` (line 1018) |
| `slip` | `AdminSlip.html` | `isAdminUser_()` (line 43) | `getActiveUserEmail` (line 334), `slipBuildReceiveHtml` (line 178), `slipGetStorageLocations` (line 195), `slipGetMaterialsForSloc` (line 223), `slipPlanPick` (line 284), `slipCommitPick` (line 320) |
| _(anything else)_ | — | — | Returns 404 HTML (line 65) |

**Key finding:** All operator production entry AND QC inspection happen on the **same** `Scanner.html` page served at `?app=scan`. There is no separate QC route or QC HTML file today.

---

## 2. SEQUENTIAL OPERATION LOCK

### Server-side gate (primary enforcement)

**Location:** `src/WebApp.gs:confirmScan()`, lines 269-287.

**Guard condition (exact code):**

```javascript
// === Sequential gate — operation N can't start until N-1 has OP confirm ===
if (opNo) {
  const operations = getOperationsForOrder(pallet.ManufacturingOrder);
  const opIndex     = operations.findIndex(function (o) { return o.opNo === opNo; });
  if (opIndex > 0) {
    const logs = getOperationLogs_(palletId);
    for (let i = 0; i < opIndex; i++) {
      const prevLog = logs.find(function (l) { return l.operationNo === operations[i].opNo; });
      if (!prevLog) {
        return {
          success: false, sapSent: false,
          message: '⚠️ ต้องบันทึกขั้นตอน ' + operations[i].opNo + ' — ' +
                   (operations[i].opText || operations[i].workCenter) + ' ก่อน',
          logId: null
        };
      }
    }
  }
}
```

**Logic:** For operation at index `opIndex`, **every** operation at indices `0` through `opIndex-1` must have a matching row in OperationLog (matched by `operationNo`). PD result is **not** checked — only OP confirmation existence.

### Data inputs

1. **`getOperationsForOrder(mo)`** — `src/WebApp.gs:518-547`. Returns sorted routing operations from ProductionOrders sheet (OperationsJSON column, parsed Operations string fallback) or live SAP routing fetch (`fetchOperationsForMO_` with 30 min CacheService TTL). Sorted ascending by opNo.
2. **`getOperationLogs_(palletId)`** — `src/OperationLog.gs:210-242`. Reads OperationLog sheet, returns one entry per operation (with pdResult if PD inspected).

### Client-side mirror (UI enforcement)

**Location:** `src/Scanner.html`, `renderTimeline()` lines 902-955 and `populateOpsDropdown()` lines 1017-1054.

The client-side timeline walks operations in order: the first operation with no matching log becomes `nextOperationNo`; all subsequent operations show a lock icon and are `disabled` in the dropdown. Only the `nextOperationNo` option is selectable and auto-selected.

### Call sites (full blast radius)

| Call site | File | Lines | Purpose |
|---|---|---|---|
| `confirmScan()` sequential gate | `WebApp.gs` | 269-287 | Server-side enforcement |
| `renderTimeline()` | `Scanner.html` | 902-955 | UI visual lock (client) |
| `populateOpsDropdown()` | `Scanner.html` | 1017-1054 | Dropdown disable (client) |
| `updateFormVisibility()` | `Scanner.html` | 963-968 | Hides form when all ops done |

---

## 3. QC PASS/FAIL WRITE PATH

### 3a. `saveQcResult()` — whole-pallet QC inspection

**Location:** `src/WebApp.gs:465-505`

- **Target sheet:** PalletMaster (via `updatePalletScanFields_`)
- **Columns written:**
  - `QCStatus` → `'INSPECTED'`
  - `QCResult` → `'PASS'` or `'FAIL'`
  - `QCResultNote` → free-text note (mandatory when FAIL)
  - `ScanStatus` → `'QC_COMPLETE'`
- **Allowed values:** `result` must be `'PASS'` or `'FAIL'` (line 474)
- **Idempotency:** Rejects if `pallet.QCStatus === 'INSPECTED'` (line 481)
- **Gate:** `checkAllOperationsDone_(palletId)` must return true (line 485) — every routing operation must have an OP confirm in OperationLog

### 3b. `savePdInspection()` — per-operation PD sampling

**Location:** `src/WebApp.gs:393-431`

- **Target sheet:** OperationLog (via `updatePdResult_`)
- **Columns written on OperationLog row:** `PDResult`, `PDInspector`, `PDNote`, `PDTimestamp`
  - `src/OperationLog.gs:updatePdResult_()`, lines 256-286
- **Allowed values:** `result` must be `'PASS'` or `'FAIL'` (line 404)
- **Gate:** OP must have already confirmed this operation (an OperationLog row must exist). PD result is write-once.
- **Effect on status:** If `checkAllOperationsDone_()` is true after PD save, PalletMaster.ScanStatus → `'PD_COMPLETE'` (lines 419-421). PD is **optional** and does not block QC.

### 3c. OP/PD/QC dual-inspection flow

**Order of operations per pallet:**

1. **OP confirms each operation sequentially** via `confirmScan()` — writes to OperationLog, records 4-bucket quantities. Each confirmation appends one row.
2. **PD samples (optional)** via `savePdInspection()` — immediately after each OP confirm (inline on same screen, same session). Updates the same OperationLog row with PD columns. Can be skipped via `skipPdInspection()` (Scanner.html:1294).
3. **Once all operations are OP-confirmed** → `ScanStatus` moves to `'PD_COMPLETE'` → QC section becomes visible.
4. **QC inspects entire pallet once** via `saveQcResult()` — writes to PalletMaster. This is a whole-pallet inspection, not per-operation.

**Key:** PD is per-operation random sampling. QC is whole-pallet, gated on all-ops-done. Both are recorded on the **same** Scanner.html page.

---

## 4. FOUR-BUCKET CAPTURE

### 4a. Reading bucket values (UI → server)

**UI inputs** in `Scanner.html`:
- `f-good` (line 419), `f-repair` (line 424), `f-awaitconv` (line 429), `f-defect` (line 433)
- `recalcYield()` (lines 1059-1091) validates `sum === QtyPerPallet` on every input change

**Sent to server** in `submitConfirm()` (Scanner.html:1093-1142) as:
```
{ qtyGood, qtyScrap (=defect), qtyRepair, qtyAwaitConv }
```

### 4b. Server-side validation

**Location:** `src/WebApp.gs:confirmScan()`, lines 236-250.

- Non-negative integer check (line 236): `v < 0 || !Number.isInteger(v)`
- **Strict-equality validation** (line 242):
  ```javascript
  const bucketSum = qtyGood + qtyRepair + qtyScrap + qtyAwaitConv;
  if (bucketSum !== pallet.QtyPerPallet) { /* reject */ }
  ```

### 4c. Writing to OperationLog

**Location:** `src/WebApp.gs:confirmScan()`, lines 290-303 → `logOperation_()` → `src/OperationLog.gs:logOperation()`, lines 119-154.

OperationLog columns written: `GoodQty`, `ScrapQty`, `RepairQty`, `AwaitConvQty` (per OL_HEADERS, OperationLog.gs:17-22).

### 4d. Mirroring to PalletMaster at final operation

**Location:** `src/WebApp.gs:confirmScan()`, lines 306-316.

```javascript
const isFinalOp = _isFinalOperation_(pallet.ManufacturingOrder, opNo);
if (isFinalOp) {
  updatePalletScanFields_(palletId, {
    GoodQty:      qtyGood,
    RepairQty:    qtyRepair,
    DefectQty:    qtyScrap,
    AwaitConvQty: qtyAwaitConv
  });
}
```

PalletMaster columns: `GoodQty` (index 36), `RepairQty` (index 37), `DefectQty` (index 38), `AwaitConvQty` (index 39) — per `PM_HEADERS` in `src/PalletGen.gs:20-60`.

### 4e. Downstream consumption

`src/Confirmation.gs:buildConfirmationPayload_()` (lines 55-134) reads the 4 buckets from PalletMaster and computes:
- `yield = GoodQty + RepairQty + AwaitConvQty`
- `scrap = DefectQty`

---

## 5. INSPECTION LOT

### Header presence

`InspectionLot` is defined in `CFG.HEADERS.PALLET_MASTER` at `src/Config.gs:120` and in `PM_HEADERS` at `src/PalletGen.gs:50` as **1-based column index 30** (0-based index 29).

### How the header map resolves it

`lookupPalletById_()` in `src/PalletSheet.gs:435-485` does **not** read `InspectionLot` — it is absent from the returned object. The column exists on the sheet but is not surfaced to the scanner UI or confirmation pipeline.

### Population status

`InspectionLot` is **written as empty string** on pallet creation (`PalletGen.gs`, line 50 shows it in header position 29, `buildPalletRow_` maps by name — no key set = `''`).

The column is **read** by `TransferSlip.gs` (lines 88, 389) for slip rendering but is expected to be empty for most rows. No function currently writes to `InspectionLot` on PalletMaster — Phase 4 (SAP QM integration via `API_INSPECTIONLOT_SRV`) has not been implemented.

**Conclusion:** The column header exists at index 30 (1-based). Existing rows are **empty** (unpopulated). Phase 4 would populate this.

---

## 6. FLAGS & GATING

### Feature flags (apply to all pages)

| Flag key | Property name | Reader function | File:lines | Default |
|---|---|---|---|---|
| `SAP_WRITE` | `SAP_WRITE_ENABLED` | `sapWriteEnabled_()` | `Flags.gs:20-23` | `false` (safe) |
| `DRY_RUN` | `DRY_RUN` | `isDryRun_()` | `Flags.gs:29-33` | `true` (safe) |

Both are stored in `PropertiesService.getScriptProperties()` and toggled via the spreadsheet menu (Flags.gs setters, lines 40-113).

### SAP badge on Scanner.html

`getSapStatus()` (`WebApp.gs:143-148`) returns both flags to the UI. `loadSapStatus()` (Scanner.html:694-715) renders the badge.

### Admin gate (confirm/print/slip pages)

`isAdminUser_()` (`WebApp.gs:102-114`):
- If `CFG.ADMIN_LOCK_ENABLED === false` → **open mode** (everyone is admin)
- Otherwise checks `Session.getActiveUser().getEmail()` against `CFG.ADMIN_EMAILS` (case-insensitive)
- `CFG.ADMIN_LOCK_ENABLED` = `true` (Config.gs:71)
- `CFG.ADMIN_EMAILS` = `['pc@pjwood.org']` (Config.gs:70)

### Scanner page (no auth)

The `?app=scan` page has **no auth gate** (WebApp.gs:32-38). Any user with the URL can access all operator AND QC functions.

### DRY_RUN gate in data flow

- `confirmScan()` → checks `sapWriteEnabled_()` at line 342 (WebApp.gs) — controls SAP POST, local log always writes
- `logOperation()` → checks `CFG.DRY_RUN` at line 145 (OperationLog.gs) — note: this is the code-level DRY_RUN constant (Config.gs:15, currently `false`), NOT the Script Properties flag
- `saveQcResult()` → no SAP call today (Phase 4 pending) — always writes locally
- Confirmation pipeline → `postConfirmation_()` checks both flags (Confirmation.gs:191-199)

---

## 7. COUPLING POINTS: Where Operator and QC Are Intertwined

### 7a. Single HTML page

**`Scanner.html`** serves both operator production entry and QC inspection. There is no separate QC page or route. The QC section (lines 496-523) is shown/hidden by `updateQcVisibility()` (line 975-979) based on server-computed flags.

### 7b. Shared state variables

In Scanner.html's `<script>` block (lines 635-648), these state variables are shared:
- `currentPallet` — used by both OP confirm and QC
- `currentOperations` / `currentOperationLogs` — drive both the OP timeline and the QC gate
- `currentAllOpsConfirmed` — computed by `lookupPallet()`, gates QC visibility
- `currentQcDone` — from `lookupPallet()`, hides QC section after inspection

### 7c. Server functions shared between OP and QC flows

| Function | Used by OP flow | Used by QC flow | File:lines |
|---|---|---|---|
| `lookupPallet()` | Yes (initial scan) | Yes (re-fetch after QC) | `WebApp.gs:163-203` |
| `checkAllOperationsDone_()` | Yes (after confirmScan) | Yes (saveQcResult gate) | `WebApp.gs:442-453` |
| `lookupPalletById_()` | Yes | Yes | `PalletSheet.gs:435-485` |
| `updatePalletScanFields_()` | Yes (ScanStatus) | Yes (QCStatus, QCResult) | `PalletSheet.gs:495-525` |
| `getOperationsForOrder()` | Yes | Indirectly (via checkAllOperationsDone_) | `WebApp.gs:518-547` |
| `getOperationLogs_()` | Yes | Indirectly (via checkAllOperationsDone_) | `OperationLog.gs:210-242` |

### 7d. UI flow coupling

The flow in `Scanner.html` is a single linear pipeline:
1. Scan QR → `lookupPallet()` → show pallet card + operation timeline
2. Select operation → fill buckets → `confirmScan()` → show PD section
3. PD inspect or skip → repeat from step 2 until all ops done
4. All ops done → `updateQcVisibility()` shows QC section on **same page**
5. QC PASS/FAIL → `saveQcResult()` → `refreshPallet()` → status banner

The **operator name** field (`f-operator`, line 386) is pre-filled into the QC inspector field (Scanner.html:1308: `document.getElementById('qc-inspector').value = document.getElementById('f-operator').value || ''`).

### 7e. Seams to cut for the split

1. **Route split:** Add `?app=qc` route in `doGet()` serving a new `QcScanner.html`. The existing `?app=scan` becomes operator-only.

2. **HTML separation:** Extract `qc-section` (lines 496-523), `submitQcResult()` (lines 1336-1363), `onQcResult()` (lines 1365-1380), `setQcResult()` (lines 1325-1334), `showQcSectionIfNeeded()` (lines 1304-1323), and `updateQcVisibility()` (lines 975-979) into the new QC page.

3. **Server function split:** `saveQcResult()` (WebApp.gs:465-505) can be called from the QC page with no changes. The QC page needs its own `lookupPallet()` call to verify `allOpsConfirmed` before showing the QC form.

4. **Remove QC from operator page:** In `Scanner.html`, remove/hide `qc-section`, `updateQcVisibility()`, and the QC-related JS. The operator page's `onConfirmResult()` (line 1192) currently shows `'พร้อมให้ QC ตรวจ'` — this message stays but the QC form is no longer inline.

5. **State decoupling:** The QC page only needs `currentPallet`, `currentAllOpsConfirmed`, and `currentQcDone` from `lookupPallet()`. It does NOT need `currentOperations`, `currentOperationLogs`, or `currentConfirmedOp` (those are operator concerns).

6. **PD remains with operator:** `savePdInspection()` and the inline PD section stay on the operator page — PD is production-line sampling done immediately after each OP confirm.

7. **Shared utilities stay shared:** `lookupPalletById_()`, `updatePalletScanFields_()`, `checkAllOperationsDone_()` remain in their current files. Both pages call them via `google.script.run`.

8. **Auth consideration:** Today `?app=scan` has no auth gate. If QC inspectors should be restricted, the new `?app=qc` route could add a role-based gate (e.g., QC_EMAILS allowlist) or remain open like the operator page.

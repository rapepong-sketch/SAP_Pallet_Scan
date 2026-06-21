# Phase 4.5 Gate 2 Design — Operator / QC Split

> Status: **LOCKED** (Gate 1 diagnostic + Gate 1.5 probe complete, business confirmed)
> Author: Claude + PJ  |  Date: 2026-06-21

---

## 1. Final Model

### 1a. Operator page (`?app=scan` — Scanner.html)

4-bucket production entry ONLY.

- Scan QR -> select operation -> enter 4 buckets (Good / Repair / Defect /
  AwaitConv) -> submit -> done.
- **SEQUENTIAL LOCK KEPT** — operators submit in routing order. The server gate
  (`WebApp.gs:269-287`) and the client-side lock logic are NOT removed.
- `confirmScan()` makes **no SAP call** (confirmed Gate 1.5 — the function
  writes to OperationLog + PalletMaster sheets only; SAP confirmation is a
  separate pipeline via `Confirmation.gs`).
- **NO PD section** on this page.
- **NO QC section** on this page.

### 1b. Inspection page (`?app=qc` — NEW `QcScanner.html`)

Used by supervisor / QC inspector.

#### PD (Process Discipline) — per-operation random sampling

- NOT locked to routing order — inspector may pick any operation.
- May be skipped entirely (record-only, does not gate anything).
- PASS / FAIL per operation via existing `savePdInspection()`.
  - Writes to OperationLog columns: `PDResult`, `PDInspector`, `PDNote`,
    `PDTimestamp`.
- Only operations already logged by the operator (i.e. rows exist in
  OperationLog) are inspectable — the UI queries OperationLog to build the
  op list.

#### QC (Quality Control) — whole-pallet final inspection

- Gate: `checkAllOperationsDone_()` (called inside `saveQcResult()`,
  unchanged) — all routing operations must have OperationLog rows.
- QC may proceed **WITHOUT** any PD having been done — PD is independent.
- PASS / FAIL + mandatory note on FAIL via existing `saveQcResult()`.
- Writes to PalletMaster: `QCStatus`, `QCResult`, `QCResultNote`,
  `ScanStatus` (set to `QC_COMPLETE`).

#### Inspector name

- Entered manually for **both** PD and QC.
- NO auto-fill from operator name — the inspector is a different person.

### 1c. Auth

Both pages are open (no authentication gate) — matches current `?app=scan`
behavior. Auth is out of scope for this phase.

### 1d. SAP

Neither page posts to SAP. QM Usage Decision writeback is deferred to
Phase 4.5C.

---

## 2. What Is NOT Changing (scope-creep guard)

| Item | Status | Detail |
|------|--------|--------|
| Sequential lock | **KEPT as-is** | Server gate `WebApp.gs:269-287` + client lock. The earlier handoff note to "unlock sequential for operator" is **SUPERSEDED** — do not touch it. |
| Confirmation pipeline | **Untouched** | `Confirmation.gs`, Admin override path (`confirmPalletOverride`), SAP confirmation flow — no changes. |
| Missed/skipped ops | **Existing path** | Handled by Admin override (`confirmPalletOverride`) at final-op SAP confirm — no new logic needed. |
| Schema migration | **None** | QC + PD columns already exist in PalletMaster (`PM_HEADERS` cols 27-28, 32) and OperationLog. |
| Server functions | **UNCHANGED** | `savePdInspection()`, `saveQcResult()`, `lookupPalletById_`, `updatePalletScanFields_`, `checkAllOperationsDone_` — no modifications. Only the **client call sites** move from Scanner.html to QcScanner.html. |

---

## 3. Seam Cuts (ref Gate 1 section 7e)

### Seam 1 — Route: add `?app=qc` to `doGet`

- In `WebApp.gs` (~lines 28-84), add a new branch:
  `?app=qc` -> serve `QcScanner.html`.
- `?app=scan` stays operator-only (Scanner.html, unchanged).

### Seam 2 — New `QcScanner.html`

New HTML file served by `doGet` for `?app=qc`.

**Flow:**

1. Scan QR / manual entry -> call `lookupPallet()` -> display pallet info.
2. **PD panel:** show operation timeline (ops from OperationLog for this
   pallet). Per-op PASS/FAIL buttons -> call `savePdInspection()` with
   manual inspector name.
3. **QC panel:** appears after pallet lookup. Whole-pallet PASS/FAIL +
   mandatory note on FAIL -> call `saveQcResult()` with manual inspector
   name. Gate message shown if `checkAllOperationsDone_` returns false.

### Seam 3 — Strip PD + QC from Scanner.html

Remove from Scanner.html:

- **HTML:** PD section, QC section (all DOM elements).
- **JS functions to remove:**
  - `savePdInspection` caller (the client-side wrapper)
  - `skipPdInspection`
  - `submitQcResult`
  - `onQcResult`
  - `setQcResult`
  - `showQcSectionIfNeeded`
  - `updateQcVisibility` (both occurrences)
- **Operator final message** changes to:
  `"บันทึกครบแล้ว — รอหัวหน้างาน/QC ตรวจ"`
  (All ops recorded — waiting for supervisor/QC inspection)

---

## 4. Open Item — QCInspector Column

> Resolve before coding Seam 3. Do not code yet.

**Question:** Does `saveQcResult()` currently persist the QC inspector name
to a PalletMaster column?

**Finding: NO.** The inspector name is **not written to PalletMaster**.

Evidence:

- `saveQcResult()` (`WebApp.gs:465-505`) receives `params.inspector` but the
  `updatePalletScanFields_()` call (lines 489-494) only writes four fields:
  `QCStatus`, `QCResult`, `QCResultNote`, `ScanStatus`.
- The inspector value is logged to EventLog via `logEvent('QC_RESULT', ...)`
  as part of the JSON detail string (line 496-497) — but **not** to any
  PalletMaster column.
- `PM_HEADERS` (`PalletGen.gs:20-61`) has 40 columns (indices 0-39). There
  is no `QCInspector` column. The QC-related columns are:
  - `QCStatus` (col 27)
  - `QCResult` (col 28)
  - `QCResultNote` (col 32)
- `PDInspector` is stored per-operation in OperationLog (via
  `savePdInspection`), but there is no equivalent PalletMaster column for
  the QC inspector.

**Action for Gate 3a:** Add `QCInspector` to `PM_HEADERS` (col 40) and add
a write in `saveQcResult()` → `updatePalletScanFields_()` call. This
replaces the operator auto-fill that is being removed with the split.

---

## 5. Gate 3 Commit Plan

One commit each, no batching.

### 5a — Gate 3a: `?app=qc` route + `QcScanner.html`

- Add `?app=qc` branch in `doGet()` (`WebApp.gs`).
- Create `QcScanner.html` with PD + QC panels.
- Add `QCInspector` column to `PM_HEADERS` + write in `saveQcResult()`.

### 5b — Gate 3b: Strip PD + QC from `Scanner.html`

- Remove PD section, QC section, and all related JS from `Scanner.html`.
- Update operator completion message.

### Deployment note

Each commit touches `?app=` routing code (server `doGet` in `.gs` + HTML).
Server-side `.gs` code is **frozen in the deployment snapshot** — changes
only take effect after a **New Version** deploy (lesson from Gate 1.5
session-id investigation). Both Gate 3a and 3b **require redeploy** after
`clasp push`.

---

## 6. Out of Scope

- **4.5C:** QM Usage Decision writeback to SAP (`API_INSPECTIONLOT_SRV`).
- **Item B:** QR parser bug (separate fix track).
- **QC_EMAILS:** Auth / email-gated access for QC page.

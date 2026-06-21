# Phase 4.5 Design — Operator / QC Split

> Status: **LOCKED** — Gate 2.6 amendment: third mode in Scanner.html
> (supersedes Gate 2 route/file approach)
> Author: Claude + PJ  |  Date: 2026-06-21  |  Amended: 2026-06-21

---

## 1. Final Model — Three Modes in Scanner.html

Scanner.html already has a `switchMode()` toggle between `scan` and `count`
modes. The `count` mode is the proven template: separate mode button,
separate scan input, separate state, separate lookup. The QC split follows
the same pattern — a third mode `qc` added to `switchMode()`.

**No new route. No new HTML file. No `?app=qc`. No `QcScanner.html`.**

### 1a. `scan` mode — Operator production entry

4-bucket production entry ONLY.

- Scan QR → select operation → enter 4 buckets (Good / Repair / Defect /
  AwaitConv) → submit → done.
- **SEQUENTIAL LOCK KEPT** — operators submit in routing order. The server gate
  (`WebApp.gs:269-287`) and the client-side lock logic are NOT removed.
- `confirmScan()` makes **no SAP call** (confirmed Gate 1.5 — the function
  writes to OperationLog + PalletMaster sheets only; SAP confirmation is a
  separate pipeline via `Confirmation.gs`).
- After Gate 3c: **NO PD section**, **NO QC section** in this mode.
- Operator final message (after 3c):
  `"บันทึกครบแล้ว — รอหัวหน้างาน/QC ตรวจ"`

### 1b. `count` mode — Reconciliation (existing, unchanged)

No changes. Included here for completeness of the three-mode map.

### 1c. `qc` mode — Inspection (NEW)

Used by supervisor / QC inspector. Activated via a new mode button in the
Scanner.html tab bar, handled by `switchMode('qc')`.

**Own scan input:** `#qc-qr-input` — separate from `#qr-input` (scan mode)
and any count-mode input. This avoids triggering `onScanSuccess` and the
scan-mode pipeline.

**Own state vars:** do NOT reuse `currentPallet`, `currentPalletId`, or any
scan-mode state. The qc mode maintains its own pallet reference
(e.g. `qcPallet`, `qcPalletId`) to prevent cross-mode contamination.

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
  `ScanStatus` (set to `QC_COMPLETE`), **`QCInspector`** (NEW — see §4).

#### Inspector name

- Entered manually for **both** PD and QC.
- NO auto-fill from operator name — the inspector is a different person.

#### Record-only scope

- Store PASS/FAIL + inspector + timestamp. No report generation, no
  additional logic beyond the existing `savePdInspection` / `saveQcResult`
  server functions.

### 1d. Auth

All modes are open (no authentication gate) — matches current `?app=scan`
behavior. Auth is out of scope for this phase.

### 1e. SAP

No mode posts to SAP. QM Usage Decision writeback is deferred to Phase 4.5C.

---

## 2. What Is NOT Changing (scope-creep guard)

| Item | Status | Detail |
|------|--------|--------|
| Sequential lock | **KEPT as-is** | Server gate `WebApp.gs:269-287` + client lock. The earlier handoff note to "unlock sequential for operator" is **SUPERSEDED** — do not touch it. |
| Confirmation pipeline | **Untouched** | `Confirmation.gs`, Admin override path (`confirmPalletOverride`), SAP confirmation flow — no changes. |
| Missed/skipped ops | **Existing path** | Handled by Admin override (`confirmPalletOverride`) at final-op SAP confirm — no new logic needed. |
| Schema migration | **QCInspector only** | QC + PD columns already exist in PalletMaster (`PM_HEADERS` cols 27-28, 32) and OperationLog. Only new column is `QCInspector` (see §4). |
| Server functions | **UNCHANGED** | `savePdInspection()`, `saveQcResult()`, `lookupPalletById_`, `updatePalletScanFields_`, `checkAllOperationsDone_` — no modifications except `saveQcResult` gains the `QCInspector` write (see §4). |
| doGet / routing | **UNCHANGED** | No `?app=qc` route. No new HTML file. `doGet` is not touched. |

---

## 3. Guards from Gate 2.5 Probe

The Gate 2.5 tab-structure probe identified these blast-radius risks when
adding a third mode. Each must be addressed:

| Guard | Risk | Mitigation |
|-------|------|------------|
| `onScanSuccess` | Scan-mode callback fires on QR scan — would route qc scan into operator pipeline | **Separate input `#qc-qr-input`** — qc mode has its own scan handler, `onScanSuccess` is never triggered |
| `resetScanner` | Clears all state — would wipe qc-mode pallet mid-inspection | qc mode uses own state vars; `resetScanner` only clears scan-mode state |
| `maybeAutoReset` | Timer-based auto-reset could clear qc state | Must NOT auto-reset across qc mode — guard with mode check |
| `updateQcVisibility` | Shows inline `#qc-section` when final op done in scan mode | After Gate 3c removal: function removed. During Gate 3b (additive): must not show inline `#qc-section` when in qc mode |

---

## 4. QCInspector Column

**Finding (from Gate 2 §4): NO** — `saveQcResult()` does not persist the QC
inspector name to PalletMaster. The inspector is only in EventLog JSON.

**Resolution:**

- `QCInspector`: NEW PalletMaster column, appended at the end.
- Implementation: read the **real header count** from the sheet at runtime
  (do not hardcode the column index). This is future-safe if columns are
  added between now and deploy.
- `saveQcResult()` gains a write of `QCInspector` via
  `updatePalletScanFields_()`.
- Schema migration (Gate 3a) writes the header and backfills existing rows
  with `''`.

---

## 5. Gate 3 Commit Plan

One commit each, no batching. **Supersedes the Gate 2 route/file plan.**

### 5a — Gate 3a: Schema — append QCInspector column

- Append `QCInspector` header to PalletMaster (after last existing column).
- **Backup-first:** snapshot existing headers before mutation.
- **Idempotency guard:** skip if `QCInspector` header already exists.
- **Postcondition:** verify header count = expected after write.
- **Migrate existing rows:** fill new column with `''` for all existing rows.
- **No redeploy** — schema-only, no server `.gs` or HTML changes.

### 5b — Gate 3b: Additive — add `qc` mode to Scanner.html

- Add `qc` mode button to tab bar.
- Add `switchMode('qc')` branch.
- Add qc-mode sections: `#qc-qr-input`, PD panel, QC panel (markup moved
  from inline scan-mode position into qc-mode container).
- Add separate qc state vars (`qcPallet`, `qcPalletId`, etc.).
- Add `QCInspector` write in `saveQcResult()` →
  `updatePalletScanFields_()`.
- Add manual inspector name input for both PD and QC.
- **EXISTING inline PD/QC in scan mode REMAINS for now** — no removal in
  this commit. Both paths work in parallel during transition.
- **Touches `?app=` / server `.gs` → REDEPLOY New Version** after
  `clasp push`.

### 5c — Gate 3c: Subtractive — remove inline PD/QC from scan mode

- Remove PD section, QC section from scan mode (all DOM elements).
- **JS functions to remove:**
  - `savePdInspection` caller (the client-side wrapper in scan context)
  - `skipPdInspection`
  - `submitQcResult`
  - `onQcResult`
  - `setQcResult`
  - `showQcSectionIfNeeded`
  - `updateQcVisibility` (both occurrences)
- **Guard:** `updateQcVisibility` — must not show inline `#qc-section` once
  qc mode exists. After this commit the function is removed entirely.
- **Guard:** `maybeAutoReset` — must not auto-reset across qc mode.
- Operator completion message → `"บันทึกครบแล้ว — รอหัวหน้างาน/QC ตรวจ"`
- **Touches `?app=` / server `.gs` → REDEPLOY New Version** after
  `clasp push`.

### 5d — Gate 3d: TEST_ functions

- `Phase45Tests.gs` — test helpers for the new qc mode flow.
- **No redeploy** — test-only, no server `.gs` or HTML changes.

### Deployment note

Gate 3b and 3c touch `?app=` routing code (server `.gs` + HTML).
Server-side `.gs` code is **frozen in the deployment snapshot** — changes
only take effect after a **New Version** deploy (lesson from Gate 1.5
session-id investigation). Gates 3a and 3d do not require redeploy.

---

## 6. Out of Scope

- **4.5C:** QM Usage Decision writeback to SAP (`API_INSPECTIONLOT_SRV`).
- **Item B:** QR parser bug (separate fix track).
- **QC_EMAILS:** Auth / email-gated access for QC mode.

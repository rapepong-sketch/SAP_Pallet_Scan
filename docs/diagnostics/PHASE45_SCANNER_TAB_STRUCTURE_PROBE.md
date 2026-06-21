# Phase 4.5 Gate 2.5 — Scanner.html Tab/Mode Structure Probe

> **Purpose:** Read-only diagnostic mapping Scanner.html's tab/mode architecture
> before adding the "ตรวจงาน/QC" dedicated tab.
> **File:** `src/Scanner.html` (1960 lines total)

---

## 1. TAB INVENTORY

The page has exactly **2 modes** (not traditional tabs — a binary toggle):

| # | Mode key | Button / Label | DOM container(s) shown | JS activation |
|---|----------|---------------|----------------------|---------------|
| 1 | `scan` | `#mode-btn-scan` — "📷 สแกนยืนยัน" | `#scan-section`, then dynamically: `#pallet-section`, `#timeline-section`, `#form-section`, `#pd-section`, `#result-section`, `#qc-section`, `#transfer-section`, `#transfer-result-section`, `#transfer-rescan-section`, `#next-scan-section` | `switchMode('scan')` (line 291) |
| 2 | `count` | `#mode-btn-count` — "📋 นับสต๊อก" | `#count-setup-section`, `#count-scan-section`, `#count-result-section` | `switchMode('count')` (line 291) |

**Transfer (311)** is NOT a separate tab — it's a sub-flow within `scan` mode triggered by a T:-prefix QR code (lines 739–745). It reuses the same scan input and `onScanSuccess` dispatcher.

---

## 2. TAB SWITCH MECHANISM

### Core function: `switchMode(mode)` — lines 1696–1728

```javascript
function switchMode(mode) {
  currentMode = mode;
  document.getElementById('mode-btn-scan').className  = 'mode-btn' + (mode === 'scan'  ? ' active' : '');
  document.getElementById('mode-btn-count').className = 'mode-btn' + (mode === 'count' ? ' active' : '');

  if (mode === 'scan') {
    hide('count-setup-section');
    hide('count-scan-section');
    hide('count-result-section');
    show('scan-section');
  } else {
    resetScanner();
    hide('scan-section');
    hide('pallet-section'); hide('timeline-section'); hide('form-section');
    hide('pd-section'); hide('result-section'); hide('qc-section');
    hide('next-scan-section'); hide('transfer-section');
    hide('transfer-result-section'); hide('transfer-rescan-section');

    if (countSessionId) {
      show('count-scan-section');
    } else {
      populateCountSlocs();
      show('count-setup-section');
    }
    hide('count-result-section');
  }
}
```

### Mechanism details:
- **CSS class toggle on buttons:** `.mode-btn.active` gets `background:#1a4e8a; color:#fff` (line 229–232)
- **Section visibility:** `show(id)` / `hide(id)` toggle `.hidden` class (`display:none !important`, line 274)
- **Active mode tracked in:** `var currentMode = 'scan';` (line 1677)
- **No data attributes** — pure string comparison on mode key
- **Toggle bar DOM:** `div.mode-toggle#mode-toggle` with two `button.mode-btn` children (lines 289–292)

---

## 3. SECTION-TO-TAB MAP

### 4-bucket production entry (confirmScan flow)
- **DOM container:** `#form-section` (lines 381–449)
- **Fields:** `#f-good`, `#f-repair`, `#f-defect`, `#f-awaitconv`
- **Submit button:** `#btn-confirm` → `submitConfirm()` (line 448)
- **Tab:** **scan** mode only
- **Visibility controller:** `updateFormVisibility(nextOpNo)` (lines 963–968)
- **Position:** Inline within the scan flow, shown after `#timeline-section`, before `#pd-section`

### PD section (savePdInspection / skipPdInspection)
- **DOM container:** `#pd-section` (lines 452–485)
- **Submit:** `submitPdResult()` → calls `google.script.run.savePdInspection(...)` (lines 1234–1262)
- **Skip:** `skipPdInspection()` (lines 1294–1299) — hides PD section, checks QC gate
- **Tab:** **scan** mode only
- **Position:** Inline, shown AFTER a successful `confirmScan` response (within `onConfirmResult`, line 1181). It is a sequential step in the same flow, NOT a separate block the user navigates to independently.

### QC section (submitQcResult / setQcResult / showQcSectionIfNeeded / updateQcVisibility)
- **DOM container:** `#qc-section` (lines 496–523)
- **Submit:** `submitQcResult()` → calls `google.script.run.saveQcResult(...)` (lines 1336–1363)
- **Gate:** `updateQcVisibility()` (lines 975–979) — shows only when `currentAllOpsConfirmed && !currentQcDone`
- **Tab:** **scan** mode only
- **Position:** Inline after all ops are confirmed. Appears at the bottom of the scan flow page. **It is NOT in a separate tab today** — it shows below the pallet card + timeline when the pallet status permits.

### Summary:
All three (OP form, PD, QC) are **inline sequential blocks within the `scan` mode**, not separate navigable tabs. They show/hide based on workflow state, not user tab selection.

---

## 4. SHARED STATE ACROSS TABS

### Global state vars (lines 635–648):
```
currentPallet, currentOperations, currentOperationLogs,
currentConfirmedOp, currentPdResult, currentQcResult,
currentAllOpsConfirmed, currentQcDone,
pendingOpNo, pendingOpLabel,
html5QrCode, autoResetTimer, autoResetArmed
```

### Count-mode state vars (lines 1677–1681):
```
currentMode, countSessionId, countSloc, countScanTotal,
countQrListenerAttached, countRpcTimer
```

### Shared vs scoped:
| Variable | Scope |
|----------|-------|
| `currentMode` | Global — determines which sections are visible |
| `currentPallet`, `currentOperations`, `currentOperationLogs`, `currentConfirmedOp`, `currentPdResult`, `currentQcResult`, `currentAllOpsConfirmed`, `currentQcDone` | **scan mode only** — `switchMode('count')` calls `resetScanner()` which nulls all of these (lines 1430–1438) |
| `countSessionId`, `countSloc`, `countScanTotal` | **count mode only** — switching to scan doesn't reset these (count session survives mode switches) |
| `html5QrCode` | **Shared** — both modes use the same Html5Qrcode instance for `scanFile()` |
| `autoResetTimer` | scan mode only — `resetScanner()` cancels it |

### Tab-switch behavior:
- **scan → count:** Calls `resetScanner()` first → clears all pallet state, resets form fields. The scanned pallet is **NOT preserved**.
- **count → scan:** Does NOT reset count session. Shows `#scan-section` fresh.

---

## 5. SCAN INPUT REUSE

### Separate inputs per mode — NO shared scan box:

| Mode | Camera input | Manual input | Handler |
|------|-------------|-------------|---------|
| scan | `#qr-input-file` (line 302) + `#btn-scan` (line 307) | `#manual-id` + "ค้นหา" button → `lookupManual()` (line 347) | File change → `onScanSuccess(decoded)` → routes to `doLookup()` or `doTransferLookup()` |
| count | `#count-qr-input` (line 583) + inline camera button (line 592) | `#count-manual-id` + "นับ" button → `countManualLookup()` (line 601) | File change → `onCountScan(decoded)` → `doCountScan()` |

### Trigger paths:
- **scan mode:** `qr-input-file` change (line 656) → `html5QrCode.scanFile()` → `onScanSuccess()` → `parseQrPayload()` → `doLookup(palletId)` → `google.script.run.lookupPallet()`
- **count mode:** `count-qr-input` change (line 1778) → `html5QrCode.scanFile()` → `onCountScan()` → `doCountScan(palletId)` → `google.script.run.recordCountScan()`

Both QR listeners are registered independently. The `html5QrCode` instance is shared but stateless (just decodes files).

---

## 6. ADD-A-TAB BLAST RADIUS

To add a third mode (e.g. `'qc'` — dedicated QC tab), the following changes are needed:

### Must add:
1. **Button in `.mode-toggle`** (line 289–292): A third `<button class="mode-btn" id="mode-btn-qc" onclick="switchMode('qc')">🔍 ตรวจงาน/QC</button>`
2. **DOM container(s):** New `<div class="section hidden" id="qc-tab-section">...</div>` for the QC-tab-specific content (scan input + QC form). Distinct from existing `#qc-section` which is the inline QC block.
3. **`switchMode()` expansion** (line 1696): Add an `else if (mode === 'qc')` branch that:
   - Hides all scan-mode sections
   - Hides all count-mode sections
   - Shows QC-tab sections
4. **Mode button CSS update:** The `switchMode()` function must also toggle `.active` on the third button (currently only toggles two: lines 1698–1699)
5. **QR listener for QC tab:** Either reuse `#qr-input-file` (shared with scan mode) or add a dedicated `<input type="file">` for the QC tab
6. **`currentMode` expansion:** The var is currently `'scan' | 'count'` — add `'qc'` as a valid value

### Guards needed on existing functions:
| Function | Why |
|----------|-----|
| `onScanSuccess()` (line 735) | If scan input is shared, must route differently when `currentMode === 'qc'` |
| `resetScanner()` (line 1415) | Currently resets all scan-mode state. QC tab may have its own state that needs separate reset |
| `maybeAutoReset()` (line 1403) | Checks `form-section`, `pd-section`, `qc-section` visibility. A new QC-tab section shouldn't trigger auto-reset in scan mode |
| `updateQcVisibility()` (line 975) | Currently shows/hides `#qc-section` (the inline block). Must NOT show it if user is on the dedicated QC tab — or rename the inline section |

### Naming collision risk:
- The existing `#qc-section` (inline QC block, lines 496–523) will conflict conceptually with a new QC tab. Recommend renaming the inline block to `#qc-inline-section` or similar before adding the tab.

### No changes needed:
- `html5QrCode` instance — stateless, can be shared
- Count mode state — fully isolated
- `loadSapStatus()` — mode-agnostic
- `parseQrPayload()` / `parseTransferQr()` — pure functions

---

## Summary

Scanner.html uses a **2-mode binary toggle** (scan / count), not a traditional multi-tab system. All production workflow sections (OP confirm, PD inspection, QC inspection) are **inline sequential blocks within scan mode** that show/hide based on pallet state. Adding a third mode requires expanding `switchMode()`, adding a third toggle button, creating new section containers, and guarding the inline `#qc-section` visibility logic to avoid conflicts with the new dedicated QC tab.

# Machine Capture — Gate M1: Read-Only Diagnostic

Generated: 2026-06-23
Status: DIAGNOSTIC ONLY — no code modified outside `MachineMaster.gs` (new reader helper)

---

## D1. OperationLog Header Dump

Current `OL_HEADERS` (OperationLog.gs:17–22) — 18 columns:

| Index | Column Name    |
|-------|----------------|
| 0     | LogID          |
| 1     | PalletID       |
| 2     | ManufacturingOrder |
| 3     | OperationNo    |
| 4     | OperationText  |
| 5     | GoodQty        |
| 6     | ScrapQty       |
| 7     | RepairQty      |
| 8     | AwaitConvQty   |
| 9     | Operator       |
| 10    | Role           |
| 11    | Result         |
| 12    | LoggedAt       |
| 13    | Source         |
| 14    | PDResult       |
| 15    | PDInspector    |
| 16    | PDNote         |
| 17    | PDTimestamp     |

**CONFIRMED: No `ActualMachine` column exists.**

M2 insertion point: after `Source` (index 13), before PD columns. This groups
the machine capture with the OP confirmation data block (indices 0–13), keeping
the PD inspection block (14–17) at the end.

New OL_HEADERS would be 19 columns:
```
..., 'Source', 'ActualMachine', 'PDResult', 'PDInspector', 'PDNote', 'PDTimestamp'
```

The migration must use the same pattern as `ensureOperationLogSheet_()` (line 33):
append missing columns and run `_forceTextColumns_` to prevent numeric coercion.

---

## D2. Scan-mode Save Path

### Server function

**`confirmScan(params)`** — `WebApp.gs:214`

Signature:
```javascript
function confirmScan(params) {
  // params: { palletId, opNo, opText, isFinal, qtyGood, qtyScrap,
  //           qtyRepair, qtyAwaitConv, operator, role }
```

### Write to OperationLog

The actual OperationLog write occurs at **WebApp.gs:290–303**:

```javascript
const logId = logOperation_({
  palletId:      palletId,
  mo:            pallet.ManufacturingOrder,
  operationNo:   opNo,
  operationText: opText,
  goodQty:       qtyGood,
  scrapQty:      qtyScrap,
  repairQty:     qtyRepair,
  awaitConvQty:  qtyAwaitConv,
  operator:      operator,
  role:          role,
  result:        'PASS',
  source:        'MOBILE'
});
```

### M2 hook line

In M2, `ActualMachine` would be:

1. Parsed from params: `const actualMachine = String(params.actualMachine || '').trim();` (after line 226)
2. Passed to the entry object: add `actualMachine: actualMachine` to the object at line 290–303
3. Written in `logOperation()` (OperationLog.gs:123): add `ActualMachine: String(entry.actualMachine || '').trim()` to the `vals` object

The client sends it via `google.script.run.confirmScan({ ..., actualMachine: currentMachine })`.

---

## D3. parseQrPayload Dispatch

### Location

`Scanner.html:789–809` (client-side function)

### Current prefixes accepted

| Priority | Prefix/Pattern | Handler | Description |
|----------|---------------|---------|-------------|
| 1 (pre-dispatch) | `T:` | `onScanSuccess()` line 768–775 | Transfer 311 QR — handled BEFORE parseQrPayload is called |
| 2 | `PALLET\|` | `parseQrPayload()` line 792–795 | Format A: `PALLET\|{PalletID}\|{MO}\|{Material}\|{Batch}\|{Qty}` |
| 3 | `P:` | `parseQrPayload()` line 797–804 | Format B: `P:{Material}\|Q:{Qty}\|L:{PalletID}\|Loc:{SLoc}\|` (slip QR) |
| 4 | bare | `parseQrPayload()` line 806–807 | Bare PalletID: `PL-\d+-L\d+` or `\d+-P\d{3}` |

### Current dispatch structure in `onScanSuccess()` (line 764–784)

```javascript
function onScanSuccess(decoded) {
  decoded = (decoded || '').trim();

  // ── T: prefix → Transfer 311 ──
  if (decoded.indexOf('T:') === 0) { ... doTransferLookup(); return; }

  // ── Everything else → parseQrPayload ──
  var palletId = parseQrPayload(decoded);
  if (!palletId) { showMsg('error', ...); return; }
  doLookup(palletId);
}
```

### M2 insertion point for `M:<MachineCode>`

Add an `M:` branch in `onScanSuccess()` AFTER the `T:` check and BEFORE `parseQrPayload`:

```javascript
// ── M: prefix → Machine scan (set sticky machine, don't navigate) ──
if (decoded.indexOf('M:') === 0) {
  var machineCode = decoded.substring(2).trim();
  setCurrentMachine(machineCode);  // updates sticky state + UI badge
  return;                          // don't proceed to pallet lookup
}
```

This preserves the existing dispatch: `T:` → `M:` → `PALLET|` / `P:` / bare.

---

## D4. Scanner.html Scan-mode Session State

### State variables (Scanner.html:667–676)

```javascript
var currentPallet        = null;    // pallet object from lookupPallet result
var currentOperations    = [];      // routing ops: {opNo, opText, workCenter, isFinal}
var currentOperationLogs = [];      // OL rows: {operationNo, status, pdResult, ...}
var currentAllOpsConfirmed = false; // server flag — every routing op has OP confirm
var pendingOpNo          = '';      // set before RPC, read in onConfirmResult
var html5QrCode          = null;    // Html5Qrcode instance (reused)
var autoResetTimer       = null;    // setTimeout id for auto-return-to-scan
var _savingConfirm       = false;   // RPC semaphore
var _savingPd            = {};      // per-op PD save semaphore
var _savingQc            = false;   // QC save semaphore
```

### Reset behavior

`resetScanner()` (line 1234–1273) clears ALL of the above. This means
every pallet scan starts fresh — no state persists across pallets.

### Sticky "current machine" design for M2

A new global var would be added at line 667–676:

```javascript
var currentMachine = null;   // sticky: set by M: scan, persists across pallet scans
```

Key properties:
- **NOT cleared by `resetScanner()`** — persists across pallet scans within the same shift
- Set when operator scans an `M:<MachineCode>` QR, validated via `lookupMachine_()` server call
- Displayed as a persistent badge in the `app-header` div (line 294–296), next to the SAP badge
- A "เปลี่ยนเครื่อง" button on the badge allows the operator to clear/rescan
- Auto-populated into `confirmScan()` params at line 1149 (`.confirmScan({ ..., actualMachine: currentMachine })`)
- Survives mode switches (scan/count/qc) since it's a top-level var

---

## D5. Report Resolver Path

### Current state

`resolveWorkCenter_()` in `YieldQCReport.gs:32–47`:

```javascript
function resolveWorkCenter_(olIdx, olRow, mo, opNo) {
  if (olIdx['ActualMachine'] !== undefined) {          // ← checks for column
    var actual = String(olRow[olIdx['ActualMachine']] || '').trim();
    if (actual) return actual;                         // ← would return raw code
  }
  // fallback: planned WC from routing cache
  if (!_wcCache_[mo]) { ... }
  return _wcCache_[mo][opNo] || '';
}
```

**Current behavior:** Since OperationLog has NO `ActualMachine` column,
`olIdx['ActualMachine']` is always `undefined`. The function always falls
through to the planned-WC fallback from SAP routing.

### M3 change (one-line enrichment)

Once M2 populates `ActualMachine` with APS codes, M3 changes line 34–35 to:

```javascript
if (actual) {
  var mach = lookupMachine_(actual);
  return mach ? mach.name + ' (' + mach.sapWorkCenter + ')' : actual;
}
```

This maps e.g. `APS001` → `เครื่องตัด Auto Press 1 (PRESS01)` in the Yield/QC
report's By Work Center section. The planned-WC fallback remains unchanged for
pallets without a machine scan.

---

## D6. WorkCenter ↔ MachineMaster Cross-Check

### Methodology

A diagnostic function `diagMachineWcCrossCheck_()` is provided in
`MachineMaster.gs`. It:

1. Reads all distinct `workCenter` values from `ProductionOrders.OperationsJSON`
   (the routing cache for produced MOs)
2. Reads all `SAPWorkCenter` values from the MachineMaster sheet
3. Reports match rate: how many routing WCs have at least one MachineMaster
   row with a matching `SAPWorkCenter`

### How to run

From Apps Script Editor: select `diagMachineWcCrossCheck_` → Run → check Logs.

### Interpretation

- **Matched WCs**: Planned-WC fallback can show a Thai machine name too
  (when no ActualMachine is set, `resolveWorkCenter_` returns the planned WC;
  M3 could optionally map these via MachineMaster as well)
- **Unmatched WCs**: These WCs appear in routing but have no MachineMaster
  entry — they'll display the raw SAP WC code. This is expected for
  non-machine work centers (e.g. manual assembly stations)
- **Match rate** informs whether the MachineMaster import is complete enough
  to cover the factory's machine fleet

---

## Summary — M2 Implementation Points

| # | Location | What M2 adds |
|---|----------|-------------|
| 1 | `OperationLog.gs:17` | `'ActualMachine'` to `OL_HEADERS` (index 14, before PD block) |
| 2 | `OperationLog.gs:123` | `ActualMachine` to `vals` in `logOperation()` |
| 3 | `WebApp.gs:226` | Parse `params.actualMachine` |
| 4 | `WebApp.gs:290` | Pass `actualMachine` to `logOperation_()` entry |
| 5 | `Scanner.html:667` | `var currentMachine = null;` (sticky state) |
| 6 | `Scanner.html:768` | `M:` prefix branch in `onScanSuccess()` |
| 7 | `Scanner.html:294` | Machine badge in app-header |
| 8 | `Scanner.html:1149` | `actualMachine: currentMachine` in confirmScan params |

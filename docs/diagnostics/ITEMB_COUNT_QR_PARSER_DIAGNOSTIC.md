# Item B Gate 1 — Count-Mode QR Parser Bug Diagnostic

**Date:** 2026-06-22  
**Status:** READ-ONLY diagnostic — no code changes  
**Bug:** Count mode rejects QR payloads of the form `P:STT1001-...|Q:10|L:PL-...` with "QR ไม่ถูกต้อง"

---

## 1. COUNT-MODE PARSE PATH

### End-to-end flow

1. **Camera input:** `#count-qr-input` change event fires (`Scanner.html:1628-1638`).  
   `html5QrCode.scanFile()` resolves with the decoded string, which is passed to `onCountScan(decoded)`.

2. **`onCountScan(decoded)`** (`Scanner.html:1647-1670`):  
   This function contains its **own inline parser** — it does NOT call `parseQrPayload()`. The logic is:

   ```js
   // Step 1: Reject transfer QR (line 1651)
   if (decoded.indexOf('T:') === 0) → reject "ใบเบิก ไม่ใช่ใบพาเลท"

   // Step 2: Parse PALLET| format (line 1657-1663)
   if (decoded.indexOf('PALLET|') === 0) → split('|'), extract parts[1] → doCountScan(palletId)

   // Step 3: Bare PalletID regex (line 1665)
   if (/^PL-\d+-L\d+$/.test(decoded) || /^\d+-P\d{3}$/.test(decoded)) → doCountScan(decoded)

   // Step 4: REJECT everything else (line 1669)
   addCountToast('err', 'QR ไม่ถูกต้อง: ' + decoded.substring(0, 40));
   ```

3. **`doCountScan(palletId)`** (`Scanner.html:1672-1695`):  
   Calls `google.script.run.recordCountScan(palletId, countSloc, '')` — passes the already-extracted PalletID string.

4. **`recordCountScan(palletId, sloc, scannedBy)`** (`StockCount.gs:100-180`):  
   Server-side. Receives a plain PalletID string, looks it up via `lookupPalletById_(palletId)` (`PalletSheet.gs:435`). No QR parsing here — it expects a clean PalletID.

### Formats `onCountScan` currently ACCEPTS

| Format | Example | Accepted? |
|--------|---------|-----------|
| `PALLET\|{PalletID}\|...` | `PALLET\|PL-1000035048-L01\|1000035048\|STT1001\|\|100` | YES |
| Bare PalletID (Phase 2.5) | `PL-1000035048-L01` | YES |
| Bare PalletID (Phase 2) | `1000035048-P001` | YES |
| `P:{Material}\|Q:{Qty}\|L:{LotNo}\|Loc:{SLoc}\|` | `P:STT1001-1100\|Q:10\|L:PL-1000035048-L01\|Loc:PW30\|` | **NO — rejected** |
| `T:{TxnID}\|P:...\|Q:...\|L:...\|Loc:...\|` | `T:TXN-20260620-001\|P:STT1001\|Q:10\|L:PL-...\|Loc:PW30\|` | NO (intentionally — transfer QR) |

### Exact rejection point

`Scanner.html:1669`:
```js
addCountToast('err', 'QR ไม่ถูกต้อง: ' + decoded.substring(0, 40));
```
The `P:` prefix doesn't match `T:` (step 1), doesn't match `PALLET|` (step 2), and doesn't match the bare PalletID regexes (step 3), so it falls through to the catch-all rejection.

---

## 2. ALL QR FORMATS PRODUCED BY THE SYSTEM

### Format A: PALLET label QR (pallet tracking sheet)

- **Structure:** `PALLET|{PalletID}|{ManufacturingOrder}|{Material}|{Batch}|{Qty}`
- **Delimiter:** pipe `|`
- **PalletID position:** field index 1 (second segment after `PALLET`)
- **Builder functions:**
  - `buildQrPayload_()` — `PalletGen.gs:224-226`
  - Inline construction — `PrintEngine.gs:211-212`
  - Inline construction — `PrintAllocation.gs:430-431`
  - Inline repair — `PalletGen.gs:189`, `PalletGen.gs:447`
- **Example:** `PALLET|PL-1000035048-L01|1000035048|STT1001-1100||100`

### Format B: Transfer slip QR (no TxnID — stock label)

- **Structure:** `P:{Material}|Q:{Qty}|L:{LotNo}|Loc:{StorageLocation}|`
- **Delimiter:** pipe `|` with key-value prefix tags
- **PalletID position:** embedded in `L:` field as `LotNo` (which equals `Batch || PalletID` per `TransferSlip.gs:94`)
- **Builder function:** `slipQrPayload_()` — `TransferSlip.gs:146-151`
- **Also:** `remainSlipQrPayload_()` — `TransferSlip.gs:176-181` (same format, different qty)
- **Example:** `P:STT1001-1100|Q:100|L:PL-1000035048-L01|Loc:PW30|`

### Format C: Transfer issue slip QR (with TxnID)

- **Structure:** `T:{TxnID}|P:{Material}|Q:{IssueQty}|L:{LotNo}|Loc:{SourceSLoc}|`
- **Delimiter:** pipe `|` with key-value prefix tags; starts with `T:`
- **PalletID position:** embedded in `L:` field as `LotNo` (same derivation)
- **Builder function:** `issueSlipQrPayload_()` — `TransferSlip.gs:160-165`
- **Example:** `T:TXN-20260620-001|P:STT1001-1100|Q:50|L:PL-1000035048-L01|Loc:PW30|`

### LotNo derivation (how PalletID ends up in `L:`)

`TransferSlip.gs:94` and `TransferSlip.gs:395`:
```js
LotNo: batch ? batch : pid
```
When `Batch` is empty (common case), `LotNo` = `PalletID`. When `Batch` is populated, `LotNo` = `Batch` (and the PalletID is NOT in the QR at all in Format B).

---

## 3. SCAN-MODE PARSER

### `parseQrPayload(text)` — `Scanner.html:789-799`

```js
function parseQrPayload(text) {
  text = (text || '').trim();
  // Primary format: PALLET|{PalletID}|{MO}|{Material}|{Batch}|{Qty}
  if (text.indexOf('PALLET|') === 0) {
    var parts = text.split('|');
    if (parts.length >= 2 && parts[1]) return parts[1].trim();
  }
  // Fallback: bare PalletID formats
  if (/^PL-\d+-L\d+$/.test(text) || /^\d+-P\d{3}$/.test(text)) return text;
  return null;
}
```

**What it handles:**
- `PALLET|...` → extracts `parts[1]` (PalletID) — YES
- Bare `PL-{digits}-L{digits}` — YES
- Bare `{digits}-P{nnn}` — YES
- `P:{Material}|Q:...|L:...|Loc:...` — **NO, returns `null`**

**`parseQrPayload` does NOT handle Format B.** It has the exact same limitation as count mode's inline parser.

### `parseTransferQr(text)` — `Scanner.html:1316-1328`

```js
function parseTransferQr(text) {
  var result = {};
  var segments = text.split('|');
  segments.forEach(function (seg) {
    seg = seg.trim();
    if (seg.indexOf('T:') === 0)   result.txnId    = seg.substring(2).trim();
    if (seg.indexOf('P:') === 0)   result.material = seg.substring(2).trim();
    if (seg.indexOf('Q:') === 0)   result.qty      = seg.substring(2).trim();
    if (seg.indexOf('L:') === 0)   result.lotNo    = seg.substring(2).trim();
    if (seg.indexOf('Loc:') === 0) result.srcSloc  = seg.substring(4).trim();
  });
  return result;
}
```

This parser **can** extract `L:` → `lotNo` from both Format B and Format C. However, it is **only called for `T:`-prefixed payloads** (`Scanner.html:768-769`):
```js
if (decoded.indexOf('T:') === 0) {
  var transferFields = parseTransferQr(decoded);
```

So Format B (no `T:` prefix, starts with `P:`) is **never routed to `parseTransferQr`** in scan mode either.

### Scan-mode behavior for Format B

In `onScanSuccess()` (`Scanner.html:764-783`):
1. `decoded.indexOf('T:') === 0` → false (starts with `P:`)
2. `parseQrPayload(decoded)` → returns `null` (no `PALLET|` prefix, no bare PalletID match)
3. Shows error: `"QR code ไม่ถูกต้อง — ต้องขึ้นต้นด้วย PALLET|... หรือ T:..."` (`Scanner.html:779`)

**Conclusion: Scan mode ALSO cannot handle Format B (`P:...|Q:...|L:...`).** The asymmetry is not between scan vs count mode — NEITHER mode handles Format B. The difference is only in the error message text.

---

## 4. ROOT CAUSE

**Count mode rejects `P:...|Q:...|L:...` because its `onCountScan()` inline parser (`Scanner.html:1647-1670`) only recognizes three patterns:**

1. `T:` prefix → rejected as transfer slip (intentional)
2. `PALLET|` prefix → extracts PalletID from field 1
3. Bare PalletID regex (`/^PL-\d+-L\d+$/` or `/^\d+-P\d{3}$/`)

**Format B (`P:{Material}|Q:{Qty}|L:{LotNo}|Loc:{SLoc}|`)** doesn't match any of these three patterns, so it falls to the catch-all rejection at line 1669.

The deeper issue: **the system generates a QR format (Format B, from `slipQrPayload_` and `remainSlipQrPayload_`) that NO mode of the scanner can parse.** Both scan mode and count mode lack a handler for it.

The `parseTransferQr()` function (`Scanner.html:1316-1328`) is technically capable of extracting `L:` (which contains the PalletID when Batch is empty), but it is only invoked for Format C (`T:`-prefixed) payloads, and even then, scan mode uses it to look up a transfer transaction (via `doTransferLookup(transferFields.txnId)`) — not to extract a PalletID.

### Edge case: when `Batch` IS populated

When a pallet has a Batch value, `LotNo = Batch` (not PalletID). In this case, extracting the `L:` field would yield a Batch string, not a PalletID. Any fix that extracts PalletID from `L:` must account for this — it works only when `LotNo` happens to be a PalletID-formatted string.

---

## 5. FIX OPTIONS

### Option A: Reuse `parseQrPayload()` in count mode

**Status: NOT sufficient on its own.** `parseQrPayload()` (`Scanner.html:789-799`) does not handle Format B either. Both scan-mode and count-mode share the same gap.

To use this approach, `parseQrPayload()` itself must first be extended to handle Format B. Then count mode's `onCountScan()` could delegate to it instead of using inline parsing.

**Steps:**
1. Extend `parseQrPayload()` to detect `P:...|` prefix, split segments, extract `L:` field, validate it looks like a PalletID.
2. Replace the inline parser in `onCountScan()` with a call to `parseQrPayload()`.
3. Scan mode's `onScanSuccess()` already calls `parseQrPayload()` — so it would automatically gain Format B support.

**Pros:** Single source of truth for PalletID extraction across all modes. Fixes both scan and count mode.  
**Cons:** Slightly more code in `parseQrPayload()`. Must handle the Batch-as-LotNo edge case.

### Option B: Extend count mode's inline parser only

Add a Format B handler in `onCountScan()` between the `PALLET|` check and the bare-PalletID regex:

```js
// After PALLET| check, before bare PalletID regex:
if (decoded.indexOf('P:') === 0) {
  var segments = decoded.split('|');
  for (var i = 0; i < segments.length; i++) {
    if (segments[i].indexOf('L:') === 0) {
      var lotNo = segments[i].substring(2).trim();
      if (/^PL-\d+-L\d+$/.test(lotNo) || /^\d+-P\d{3}$/.test(lotNo)) {
        doCountScan(lotNo);
        return;
      }
    }
  }
}
```

**Pros:** Minimal change, doesn't touch scan mode.  
**Cons:** Duplicates parsing logic. Scan mode still can't handle Format B. Two parsers to maintain.

### Recommendation: Option A

Option A is safer and more maintainable. The `parseQrPayload()` function is already the intended single parser for PalletID extraction. Extending it once fixes BOTH scan and count modes. The key addition is:

```
if text starts with 'P:' → split by '|' → find segment starting with 'L:' →
extract substring after 'L:' → validate it matches a known PalletID pattern → return it
```

The Batch-as-LotNo edge case is handled naturally by the PalletID regex validation: if `L:` contains a Batch string (e.g., `BATCH001`), it won't match `/^PL-\d+-L\d+$/` or `/^\d+-P\d{3}$/`, so `parseQrPayload` returns `null` and the caller shows an appropriate error.

### Existing helpers

- **`parseTransferQr(text)`** (`Scanner.html:1316-1328`): Already extracts all `P:`, `Q:`, `L:`, `Loc:`, `T:` segments. Could be reused inside `parseQrPayload()` for the Format B case.
- **No shared server-side QR parser exists.** `recordCountScan()` and `lookupPallet()` both expect a clean PalletID — all parsing happens client-side in Scanner.html.

---

## 6. BLAST RADIUS

### What calls count mode's inline parser?

Only `onCountScan()` (`Scanner.html:1647`) which is called from:
- `initCountQrScanner()` camera handler (`Scanner.html:1631`)

`countManualLookup()` (`Scanner.html:1641-1645`) bypasses `onCountScan()` entirely — it passes the raw text input directly to `doCountScan()`, which passes it to `recordCountScan()` on the server. Manual entry is unaffected by parser changes.

### What calls `parseQrPayload()`?

1. `onScanSuccess()` — scan mode camera/decode handler (`Scanner.html:777`)
2. QC mode's `initQcmQrScanner()` camera handler (`Scanner.html:1826`)

### Regression risk for Option A (reuse `parseQrPayload` in count mode)

**Format compatibility matrix — does `parseQrPayload` currently accept it?**

| Input | Current `parseQrPayload` | Current `onCountScan` | After fix |
|-------|--------------------------|----------------------|-----------|
| `PALLET\|PID\|...` | YES → PalletID | YES → PalletID | YES |
| Bare `PL-\d+-L\d+` | YES | YES | YES |
| Bare `\d+-P\d{3}` | YES | YES | YES |
| `P:...\|Q:...\|L:PID\|...` | NO (returns null) | NO (rejected) | YES → PalletID |
| `T:...\|P:...\|L:...\|...` | NO (returns null) | NO (rejected as transfer) | Depends on impl |
| Arbitrary text | NO (returns null) | NO (rejected) | NO |

**Count mode accepts nothing today that `parseQrPayload` does NOT.** Both accept the same three formats. No regression risk from switching count mode to use `parseQrPayload()`.

**Transfer QR (`T:` prefix):** Count mode currently rejects `T:` before reaching the parser (line 1651). This rejection should remain as a separate check before calling `parseQrPayload()`, since transfer QRs should not be counted as pallets. The `T:` guard is semantic, not a parsing concern.

### QC mode impact

QC mode (`initQcmQrScanner`, `Scanner.html:1826`) already calls `parseQrPayload()`. If `parseQrPayload` is extended to handle Format B, QC mode automatically gains the ability to scan transfer slip QR codes and extract the pallet — a desirable side effect since QC inspectors may encounter these labels in the field.

---

## Summary

| # | Finding |
|---|---------|
| Root cause | `onCountScan()` has its own inline parser that only handles `PALLET\|` and bare PalletID formats. Format B (`P:...\|Q:...\|L:...\|Loc:...\|`) falls to catch-all rejection. |
| Scope | **System-wide gap** — neither scan mode nor QC mode can handle Format B either. `parseQrPayload()` has the same limitation. |
| Fix | Extend `parseQrPayload()` to extract PalletID from `L:` field in Format B, then replace count mode's inline parser with a call to it. |
| Blast radius | Minimal — count mode accepts no unique formats that would be lost. QC mode and scan mode gain Format B support as a bonus. |
| Edge case | When `Batch` is populated, `L:` contains Batch (not PalletID). The PalletID regex validation in `parseQrPayload` naturally filters this out. |

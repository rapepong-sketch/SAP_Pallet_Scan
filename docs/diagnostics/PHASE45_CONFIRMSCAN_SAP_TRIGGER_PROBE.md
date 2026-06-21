# Phase 4.5 Gate 1.5 — confirmScan SAP Trigger Blast-Radius Probe

**Date:** 2026-06-21
**Scope:** Read-only trace of `confirmScan()` (WebApp.gs) through SAP gate;
cross-reference with `Confirmation.gs` admin-confirm path.

---

## 1. Does confirmScan() call SAP after the sapWriteEnabled_() gate?

**No. Zero SAP calls exist anywhere in confirmScan().**

After the `sapWriteEnabled_()` check at line 342, confirmScan() returns
immediately in **both branches** — neither calls any SAP helper:

```js
// WebApp.gs:342-358 — SAP gate
if (!sapWriteEnabled_()) {
  return {
    success: true,
    sapSent: false,                          // ← literal false
    allOperationsDone: allOperationsDone,
    message: '...(SAP OFF — โหมดทดสอบ)',
    logId:   logId
  };
}

return {
  success: true,
  sapSent: false,                            // ← also literal false
  allOperationsDone: allOperationsDone,
  message: '...SAP confirmation จะเปิดใช้ใน Step 2',   // "will be enabled in Step 2"
  logId:   logId
};
```

A `grep` for `UrlFetchApp`, `postConfirmation_`, `buildConfirmationPayload_`,
`dryRunConfirmation_`, and `getCsrfSession_` across `WebApp.gs` returns **zero
matches**. The function's JSDoc (line 207) itself says `SAP gate (Step 1 = stub)`.

confirmScan() writes to:
1. **OperationLog** sheet (append row via `logOperation_()`)
2. **PalletMaster** sheet (update scan fields via `updatePalletScanFields_()`)
3. **EventLog** sheet (via `logEvent()`)

That is all. No HTTP call to SAP exists in any code path of this function.

---

## 2. Per-operation vs. final-operation SAP confirmation?

**confirmScan() makes no SAP confirmation at all** — neither per-operation nor
final-operation. The `_isFinalOperation_()` helper (line 374) is called, but
only to:
- Mirror 4-bucket quantities to PalletMaster columns when it's the final op
  (lines 309-316)
- Append `final=true` to the log message (line 337)
- Compute `allOperationsDone` for the response (line 326)

The message on line 356 explicitly says: `SAP confirmation จะเปิดใช้ใน Step 2`
("SAP confirmation will be enabled in Step 2").

---

## 3. Cross-check: Confirmation.gs vs. confirmScan()

### Confirmation.gs path (Admin Confirm)

| Function | Role |
|---|---|
| `buildConfirmationPayload_(palletId)` | Builds OData payload for `API_PROD_ORDER_CONFIRMATION_2_SRV / ProdnOrdConf2` |
| `postConfirmation_(payload)` | POSTs to SAP (flag-gated: sapWriteEnabled_ + isDryRun_) |
| `readMaterialDocument_(group, count, session)` | GETs MaterialDocument after successful POST |
| `confirmPallet(palletId)` | Orchestrator: build + POST + readback + writeback |
| `batchConfirmPallets(palletIds[])` | Loops `confirmPallet()` for admin batch confirm (cap 15) |
| `confirmPalletOverride(palletId, reason, qty)` | Admin override — same SAP call, bypasses QC_COMPLETE guard |

### Key characteristics of the Confirmation.gs path

- **OData service:** `API_PROD_ORDER_CONFIRMATION_2_SRV`
- **EntitySet:** `ProdnOrdConf2`
- **Operation scope:** Always the **FinalOperation only** (from
  `getFinalOperationCached_(mo)`), with `IsFinalConfirmation: true`,
  `FinalConfirmationType: 'X'` — this is the full yield/GR confirmation,
  not a per-routing-step confirmation.
- **Eligibility gate:** `ScanStatus === 'QC_COMPLETE'` (line 59 of
  `buildConfirmationPayload_`)
- **Idempotency:** Skips if `ScanStatus === 'CONFIRMED'` or
  `ConfirmationGroup` already filled

### Relationship: mutually exclusive by design

| Aspect | confirmScan() (WebApp.gs) | Confirmation.gs |
|---|---|---|
| Caller | Operator mobile scan | Admin UI (batch/override) |
| Writes to SAP | **Never** | Yes (flag-gated) |
| Writes to sheet | OperationLog + PalletMaster scan fields | PalletMaster confirmation fields |
| ScanStatus output | SCANNED / PD_COMPLETE | CONFIRMED |
| When it runs | Per routing operation, during production | After QC_COMPLETE, admin-triggered |

They are **sequential, not redundant**: confirmScan() logs each operation to
the sheet; once all operations are done and QC passes, the pallet reaches
`QC_COMPLETE`; then — and only then — the admin triggers `confirmPallet()` /
`batchConfirmPallets()` which POSTs the final-operation confirmation to SAP.

There is no code path where both attempt the same SAP POST.

---

## 4. Current flag state analysis

### With SAP_WRITE_ENABLED=true, DRY_RUN=true (current state)

**confirmScan() makes zero SAP calls.** The `sapWriteEnabled_()` gate at line
342 returns `true`, but the code falls through to the second return block
(line 352) which still returns `sapSent: false`. The gate exists purely as a
stub — there is no SAP call to enable or disable. The function always returns
`sapSent: false` regardless of flag state.

For the admin path: `postConfirmation_()` checks `isDryRun_()` at line 196 and
returns `{ dryRun: true, payload: payload }` without calling `UrlFetchApp`.

### Would DRY_RUN=false cause out-of-order SAP operation confirmations?

**No.**

1. **confirmScan() still won't POST to SAP** — the function has no SAP call
   code at all; `sapSent: false` is hardcoded in both return paths. Changing
   DRY_RUN does not create a SAP call where none exists.

2. **confirmScan() enforces sequential operation order** — the sequential gate
   at lines 269-287 rejects operation N if operation N-1 hasn't been logged:
   ```js
   // WebApp.gs:269-287 — Sequential gate
   if (opNo) {
     const operations = getOperationsForOrder(pallet.ManufacturingOrder);
     const opIndex = operations.findIndex(function (o) { return o.opNo === opNo; });
     if (opIndex > 0) {
       const logs = getOperationLogs_(palletId);
       for (let i = 0; i < opIndex; i++) {
         const prevLog = logs.find(function (l) {
           return l.operationNo === operations[i].opNo;
         });
         if (!prevLog) {
           return { success: false, ... };  // blocks out-of-order
         }
       }
     }
   }
   ```

3. **The Confirmation.gs path only confirms the FinalOperation** — it does not
   confirm individual routing steps. It always sends `OrderOperation:
   padOperation_(finalOp)` with `IsFinalConfirmation: true`. So even when
   DRY_RUN=false, the SAP POST is a single final-operation confirmation, not
   per-routing-step. Out-of-order individual operation confirmations are
   structurally impossible because individual operations are never sent to SAP.

**Verdict: No — out-of-order SAP operation confirmations cannot occur.**

---

## Summary

| Question | Answer |
|---|---|
| Does confirmScan() POST to SAP? | **No** — zero SAP calls in any code path |
| What does it write? | OperationLog row + PalletMaster scan fields (sheet only) |
| Who POSTs to SAP? | `Confirmation.gs` admin path only (`confirmPallet` / `batchConfirmPallets` / `confirmPalletOverride`) |
| Same SAP call? | N/A — confirmScan has none; Confirmation.gs uses `ProdnOrdConf2` (final op only) |
| Redundant? | No — sequential by design (scan first, admin confirm later) |
| Current flags: any SAP call? | No — confirmScan never calls SAP; admin path dry-runs |
| DRY_RUN=false risk? | No out-of-order risk — operations are sheet-only; SAP gets final-op only |

# Phase 3 — Mobile Scanner + Production Confirmation

## Step 1 COMPLETE (local only, no SAP)

### Features
- Mobile web app at /exec URL
- Photo-based QR scanning (GAS iframe blocks live camera)
- Operation timeline with sequential enforcement
- OP confirmation per operation
- PD random sampling inspection (optional, doesn't block flow)
- QC inspection after all operations complete
- Idempotency: 3-layer duplicate prevention
- Feature flags: SAP_WRITE_ENABLED + DRY_RUN via Sheet menu
- FinalOperation cache: ProductionOrders.FinalOperation column, populated by
  getFinalOperationForMo_() — lets Step 2 read the last routing op number
  straight from the sheet instead of re-deriving it from SAP on every scan

### Files created/modified in Step 1
- src/Flags.gs — feature flag management + Sheet menu
- src/WebApp.gs — doGet(), lookupPallet, confirmScan, saveQcResult, savePdInspection
- src/Scanner.html — mobile UI with photo scan, timeline, PD/QC forms
- src/SheetSetup.gs — onOpen menu updated
- src/Config.gs — flag keys, web app config, FinalOperation header
- src/OperationLog.gs — logOperation_, getOperationLogs_
- src/PalletSheet.gs — scan field updates
- src/ProductionOrders.gs — getFinalOperationCached_/cacheFinalOperation_/getFinalOperationForMo_

### Pallet Status Flow
CREATED → SCANNED → PD_COMPLETE (optional) → QC_COMPLETE → CONFIRMED (Step 2)

### Known gap (flagged for follow-up)
If PD fails an operation there's no recovery path — isOperationLogged_()
blocks re-confirming the same opNo forever, so a PD FAIL permanently stalls
that pallet. Needs a decision on how rework should be re-logged before this
goes to real production use.

### Step 2 TODO: SAP Confirmation + Auto-GR
- POST to API_PROD_ORDER_CONFIRMATION_2_SRV via SAP_COM_0522
- CSRF token handling (2-step: Fetch + POST with cookie replay)
- Use getFinalOperationForMo_() to know which operation closes the order
- Auto-GR/Backflush (single atomic transaction)
- DRY_RUN testing before live POST
- Read back MaterialDocument from response

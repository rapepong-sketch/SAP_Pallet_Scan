# Confirm Drift — Read-Only Diagnostic

Generated: 2026-06-23
Status: DIAGNOSTIC ONLY — no writes, no SAP POST

---

## A1. PalletMaster Profile

Run `diagConfirmDrift_()` from Apps Script Editor to get live counts.

### Confirmation-related columns (by NAME from PM_HEADERS in PalletGen.gs)

| Column | Idx | Purpose |
|--------|-----|---------|
| ScanStatus | 20 | Lifecycle state: CREATED→PRINTED→SCANNED→PD_COMPLETE→QC_COMPLETE→CONFIRMED |
| GRMaterialDocument | 21 | SAP Material Document number from GR (Goods Receipt) |
| GRMaterialDocumentYear | 22 | Fiscal year of the Material Document |
| ConfirmationGroup | 23 | SAP Confirmation Group ID from ProdnOrdConf2 POST response |
| ConfirmationCount | 24 | SAP Confirmation Count within the group |
| ConfirmedAt | 25 | Timestamp of confirmation |
| ConfirmedBy | 26 | User email who confirmed |
| OverrideBy | 33 | Admin email if override-confirmed |
| OverrideReason | 34 | Override justification text |
| OverrideAt | 35 | Override timestamp |

### Confirmation flow (Confirmation.gs)

1. `buildConfirmationPayload_(palletId)` — builds ProdnOrdConf2 payload (yield/scrap from 4-bucket or legacy)
2. `postConfirmation_(payload)` — POST to `API_PROD_ORDER_CONFIRMATION_2_SRV/ProdnOrdConf2` → returns ConfirmationGroup + Count
3. `readMaterialDocument_(group, count, session)` — GET nav property `to_ProdnOrdConfMatlDocItm` → returns MaterialDocument + Year (up to 3 retries with 2s sleep)
4. `confirmPallet(palletId)` orchestrator — writes ConfirmationGroup, Count, GRMaterialDocument, Year, ConfirmedAt, ConfirmedBy, ScanStatus='CONFIRMED' to PalletMaster

## A2. SAP Document Number Field

**Column name: `GRMaterialDocument`** (PalletGen.gs PM_HEADERS index 21)

Populated by `readMaterialDocument_()` after the confirmation POST succeeds. The readback uses the ConfirmationGroup navigation property, NOT a direct MaterialDocument query. This means:

- **GRMaterialDocument populated** → we have a direct handle to verify in SAP
- **GRMaterialDocument empty + ConfirmationGroup populated** → SAP confirmation succeeded but readback failed (async GR posting). Can be recovered via `backfillMaterialDocument()`.
- **Both empty** → confirmation never reached SAP (DRY_RUN or SAP_WRITE disabled)

## B3. SAP Verification Strategy (GRMaterialDocument present)

```
GET {SAP_BASE_URL}/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader
  ?$filter=MaterialDocument eq '{doc}' and MaterialDocumentYear eq '{year}'
  &$select=MaterialDocument,MaterialDocumentYear,PostingDate,DocumentDate,
           ReferenceDocument,MovementType
  &$format=json
```

Expected: HTTP 200 with `d.results[0]` containing the GR document. MovementType should be `101` (GR for production order).

## B4. Reverse Lookup Strategy (no GRMaterialDocument)

```
GET {SAP_BASE_URL}/sap/opu/odata/sap/API_PROD_ORDER_CONFIRMATION_2_SRV/ProdnOrdConf2
  ?$filter=OrderID eq '{padded12MO}'
  &$select=ConfirmationGroup,ConfirmationCount,OrderID,OrderOperation,
           ConfirmationYieldQuantity,ConfirmationScrapQuantity
  &$format=json
```

This returns ALL confirmations for an MO. Match against ConfirmationGroup stored in PalletMaster.

## B5. API_MATERIAL_DOCUMENT_SRV Filterable Fields

Key filterable fields from the OData $metadata:
- `MaterialDocument` (key)
- `MaterialDocumentYear` (key)
- `PostingDate`
- `DocumentDate`
- `ReferenceDocument`
- `MaterialDocumentHeaderText`

ManufacturingOrder is NOT a direct filter on A_MaterialDocumentHeader — it's on
the line item entity A_MaterialDocumentItem via navigation property. Direct MO→GR
lookup requires: `A_MaterialDocumentItem?$filter=ManufacturingOrder eq '{MO}' and
GoodsMovementType eq '101'`.

## C6. Gap Analysis

### Join strategies

| Strategy | Key | Reliability | Coverage |
|----------|-----|-------------|----------|
| Direct | GRMaterialDocument + Year | ✅ Exact match | Only rows where readback succeeded |
| Via ConfirmationGroup | Group + Count → readback → MatDoc | ✅ Can recover | Rows where POST succeeded but readback didn't |
| MO reverse | ManufacturingOrder → ProdnOrdConf2 | ⚠️ Ambiguous (multiple pallets per MO) | All CONFIRMED rows |
| MO→GR items | MO → A_MaterialDocumentItem(GoodsMovementType='101') | ⚠️ Multiple docs | Broad but noisy |

### Expected patterns

- All CONFIRMED pallets should have ConfirmationGroup (POST succeeded)
- Some may lack GRMaterialDocument (readback retry exhausted before async GR posted)
- Pre-M2-deploy pallets should have the same structure (M2 only added ActualMachine, didn't change confirmation flow)
- DRY_RUN pallets would show ScanStatus≠CONFIRMED (never reached confirmPallet)

### Recommended drift detection approach

1. **Primary**: for each CONFIRMED pallet with GRMaterialDocument → GET A_MaterialDocumentHeader → verify exists + matches MO
2. **Recovery**: for CONFIRMED with empty GRMaterialDocument but ConfirmationGroup → run backfillMaterialDocument_() → then verify
3. **Anomaly**: CONFIRMED with neither → flag as unverifiable (should not happen if code flow is correct)

---

## Runtime Data (fill in after running `diagConfirmDrift_()`)

```
Total PM rows:         ___
CONFIRMED rows:        ___
  with GRMaterialDoc:  ___
  with ConfirmGroup:   ___
  with neither:        ___

Sample CONFIRMED rows:
  PL-xxx: MO=xxx GRDoc=xxx ConfGrp=xxx
  PL-xxx: MO=xxx GRDoc=    ConfGrp=xxx  (readback failed)
  PL-xxx: MO=xxx GRDoc=    ConfGrp=     (???)

SAP verification:
  B3 direct:  ___
  B4 reverse: ___
```

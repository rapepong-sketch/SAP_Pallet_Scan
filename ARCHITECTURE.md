## Scan-to-Transfer (FEATURE_SCAN_TRANSFER=LIVE)
Go-live: 2026-06-29. First-live doc 4900216622 (PL-1000036050-L01, STB1006-A0503S3XRX,
batch 0000094629, 2560 PC, PW30→PW40). Reversed to 4900216623/2026. Net-zero confirmed.

Flow: Operator scans PL- QR in tab "สแกนโอนย้าย" → scanTransferLookup (CONFIRMED
guard + SAP stock pre-check) → review panel (pre-fill from PalletMaster) → dest
interlock (CFG.DEST_SLOCS whitelist: PW40, PW44) → scanTransferConfirm (creates
SCAN_ISSUE TransferLog row, double-tap guard, delegates to confirmTransfer311 →
postTransfer311WithRetry_ hardened path). One-shot disarm after success.

Key files: ScanTransfer.gs, ScanTransferTest.gs (8/8 PASS), Scanner.html (xfer tab,
onScanSuccess untouched). Flag: FEATURE_SCAN_TRANSFER (OFF→DRY_RUN→LIVE).
Commits: c985cf1 → 67f1921 → 7235a37 → 25cb1ac + Config PW44.

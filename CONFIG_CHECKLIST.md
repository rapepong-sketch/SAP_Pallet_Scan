# CONFIG_CHECKLIST — ข้อมูลที่ต้องเตรียมก่อนเริ่มโปรเจค

> เติมข้อมูลให้ครบทุกข้อก่อนเริ่ม Phase 1 — ข้อที่ติ๊ก ❓ คือยังไม่มีคำตอบ

## A. SAP Connection (Phase 1)
- [ ] SAP S/4HANA Cloud Base URL: `https://myXXXXXX.s4hana.ondemand.com`
- [ ] Communication User + Password (เก็บใน Script Properties)
- [ ] Communication Arrangements ที่ activate แล้ว:
  - [ ] SAP_COM_0104 — Production Order Integration (อ่าน Production Order)
  - [ ] SAP_COM_0105 / 0106 — Production Order Confirmation (writeback confirm)
  - [ ] SAP_COM_0102 — Master Data (Product, Batch)
  - [ ] SAP_COM_0318 — BOM Integration
  - [ ] SAP_COM_0110 — Inspection Lot / QM (อ่าน + Usage Decision)
  - [ ] SAP_COM_0109 — Material Documents (Goods Movement)
- [ ] Plant code(s) ที่ใช้: ________
- [ ] Test order number สำหรับทดสอบ: ________

## B. Business Rules (Phase 3 — MOQ / Pallet)
- [ ] MOQ ต่อ pallet เก็บที่ไหน?
  - ( ) Material Master field (ระบุ field: ________)
  - ( ) Config sheet ใน Google Sheets (Material → MOQ mapping)
- [ ] เศษที่เหลือจาก MOQ (partial pallet) ทำอย่างไร? (พิมพ์ label แยก / รวมใบสุดท้าย)
- [ ] Pallet ID format ต้องการแบบไหน? (default: OrderNo-001)
- [ ] หน่วยนับ (UoM) ที่ใช้: PC / KG / อื่น ๆ

## C. Label Design (Phase 3)
- [ ] ขนาดกระดาษ label: A4 / A5 / sticker ขนาด ________
- [ ] ข้อมูลบน label (ติ๊กที่ต้องการ):
  - [ ] Production Order No.
  - [ ] Material Code + Description
  - [ ] Batch No.
  - [ ] Quantity / pallet
  - [ ] QR Code (encode อะไร: Pallet ID / JSON?)
  - [ ] Work Center / Line
  - [ ] วันที่ผลิต / Expiry
  - [ ] Logo บริษัท
- [ ] เครื่องพิมพ์: laser ธรรมดา / label printer (รุ่น: ________)

## D. Mobile Scan (Phase 4)
- [ ] ผู้ใช้งานเข้าผ่าน: Google account บริษัท / anonymous link?
- [ ] Scan แล้วทำอะไร: confirm ผลผลิตทั้ง pallet / ระบุ qty บางส่วนได้?
- [ ] ต้องบันทึก operator name / shift หรือไม่?
- [ ] กล้องมือถือ scan QR ผ่าน browser (html5-qrcode library) — OK?

## E. QC Module (Phase 5)
- [ ] QC checklist มีกี่ข้อ? รายการ: ________
- [ ] ผลตรวจ: Pass / Hold / Reject — มี status อื่นไหม?
- [ ] ต้องแนบรูปได้หรือไม่?
- [ ] QC sampling: ตรวจทุก pallet / สุ่มตาม AQL?
- [ ] Usage Decision ใน SAP ใช้ code อะไร (A = Accept, R = Reject)?

## F. SAP Writeback (Phase 6)
- [ ] Confirm production ใช้ API ไหน:
  - ( ) Production Order Confirmation (CO11N equivalent)
  - ( ) Goods Receipt via Material Document (MIGO 101)
- [ ] QC result เขียนกลับเป็น Usage Decision หรือแค่ remark?
- [ ] ใครมีสิทธิ์กด "Post to SAP"? (role gate)

## G. Notification & Dashboard (Phase 7)
- [ ] Lark webhook URL (เก็บใน Script Properties)
- [ ] Alert เมื่อไหร่: QC Reject / Hold / pallet ค้างเกิน X ชม.?
- [ ] Dashboard ต้องการ metric อะไร: pallets/day, QC pass rate, WIP?

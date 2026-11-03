# งานค้าง (เก็บไว้ทำทีหลัง)

บันทึกเมื่อ 30 ต.ค. 2026 จากการไล่ประวัติแชท ยังไม่ได้ทำทั้งหมด จะเลือกทำบางส่วน
รายละเอียดระบบอยู่ใน `MUSIC_RESILIENCE.md`

## ผมรับปากไว้แล้ว

1. **restart node อัตโนมัติแบบจำกัดครั้ง**: restart เฉพาะตอนพังจริง (ไม่ตอบ 2-3 รอบติด) ไม่เกิน 1 ครั้งต่อ 6 ชม. ต่อ node
   เกินนั้นแค่แจ้งเตือน ห้าม restart node ทั้งกลุ่มพร้อมกัน (เดิมคุยไว้ตอนเรื่อง node สาธารณะ)
2. **อัปเดต `MUSIC_RESILIENCE.md`**: หน้า `/nodes` ในเว็บ status, endpoint `10.0.0.1:30065/status` ของ sidecar,
   soak ที่กู้ตัวเอง, การย้าย node เมื่อเพลงเริ่มเล่นไม่ขึ้นซ้ำ, การแยก branch (`main` = status และอื่นๆ, `feat/music-resilience` = เพลง)

## เสนอไว้ รอตัดสินใจ

3. ทดสอบ Cloudflare WARP เป็น IP ขาออกของ node สาธารณะ
4. เพิ่ม `.claude/` ใน `.gitignore` และเอา `musicV1/bot/players_music.json`, `musicV1/bot/tsconfig.tsbuildinfo` ออกจาก git
5. รายงานประจำวันให้ส่งตรง 19:00 (ตอนนี้ช้าได้ถึง 5 นาที เพราะส่งในรอบเช็คถัดไป)
6. ย้ายระบบเช็คของเพลงทั้งหมดไปไว้ใน status หลัก (ตอนนี้ status ทำแค่ขึ้น/ล่ม, ประวัติ, แจ้งเตือนภาพรวม)

## รอผู้ใช้ทำหรือตัดสินใจ

7. bot Discord ตัวใหม่สำหรับ soak แล้วใส่ token ที่ `PROBE_TOKEN`
   (ตอนนี้ `YM_SoakClient` หยุดไว้ เพราะใช้ token เดียวกับบอท dev แล้วน่าจะทำให้ `playerStateChange timed out`)
8. สมัคร Hurricane Electric Tunnelbroker ถ้าจะลอง IPv6 rotation
9. merge `feat/music-resilience` เข้า `main`
10. ลำดับแหล่งเพลงในช่องค้นหา (ตอนนี้ SoundCloud ก่อน YouTube Music ขึ้นเฉพาะตอน SoundCloud ไม่เจอ)
11. เปิด syncthing โฟลเดอร์ "Yumi Project" กลับ หรือใช้ git อย่างเดียว (ตอนนี้ pause ฝั่ง VPS)

# Yumi

รวมโปรเจคทั้งหมดของ Yumi ไว้ใน monorepo เดียว: บอท Discord, backend, เว็บไซต์, ระบบเพลง, status และ audio node

- เว็บไซต์: [yumistack.net](https://yumistack.net/)
- Discord: [discord.gg/brxPZB3Jzy](https://discord.gg/brxPZB3Jzy)
- งานที่กำลังทำ: [GitHub Projects](https://github.com/users/Campus2454/projects/4)

👋 ยินดีต้อนรับ! Welcome!

## บอท Yumi

บอท Discord ที่พัฒนาโดยคนไทย 🇹🇭

หากพบข้อผิดพลาดหรือจุดบกพร่อง แจ้งให้ทีมทราบได้ทาง [Discord](https://discord.gg/brxPZB3Jzy) หรือช่องทางอื่น

## โครงสร้างโปรเจค

| โฟลเดอร์ | หน้าที่ | เทคโนโลยี |
| --- | --- | --- |
| `bot/` | บอท Discord หลัก | discord.js, TypeScript |
| `backend/` | API ฝั่ง server ของเว็บไซต์ | NestJS, TypeScript |
| `frontend/` | เว็บไซต์ yumistack.net (`website-next`) และ `/api/status` | Next.js, Tailwind |
| `status/` | หน้า status, เก็บประวัติ downtime, แจ้งเตือน Discord และอีเมล | Express, PostgreSQL |
| `musicV1/` | ระบบเพลงของบอท (bot, api, sidecar, sujv2) | TypeScript, Kazagumo |
| `music-web/` | เว็บ player เพลง (`webplayer`) | Next.js |
| `lavalink/` | Lavalink audio server (docker compose, application.yml, plugins) | Lavalink |
| `nodelink/` | NodeLink audio node (docker compose, patch) | NodeLink |
| `global/` | โค้ด, type และ function ที่ใช้ร่วมกันระหว่างโปรเจค | TypeScript |
| `assets-web/` | ไฟล์ asset ของเว็บ | - |

ไฟล์ระดับ root
- `ecosystem.config.cjs` ไฟล์ตั้งค่า pm2 สำหรับรันบริการบนเครื่อง
- `RegisterCommand.js` ลงทะเบียน slash command ของบอท (`yarn register`)
- `yumiOffline.js` บอทสถานะ offline (`yarn sleep`)
- `yumi_db.sql` โครงสร้างและข้อมูลฐานข้อมูลเริ่มต้น
- `CLAUDE.md` กฎสำหรับการพัฒนาในโปรเจคนี้

## การพัฒนา

### เวอร์ชันก่อน push

ก่อน `git push` ทุกครั้ง ให้เพิ่ม `version` ใน `package.json` ของทุกโปรเจคย่อยที่มีการเปลี่ยนแปลง รูปแบบ `MAJOR.MINOR.PATCH` (เลขแต่ละส่วนไม่มีขีดจำกัด เช่น `1.234.5678`)

- PATCH: แก้บั๊ก, ปรับเล็กน้อย, refactor
- MINOR: ฟีเจอร์ใหม่หรือพฤติกรรมที่เห็นได้ชัด
- MAJOR: เปลี่ยนแปลงที่ไม่เข้ากับเวอร์ชันเดิม (เมื่อเจ้าของโปรเจคขอเท่านั้น)

`bot`, `backend` และ `frontend` รายงาน `version` ให้ `status` การเปลี่ยน version จะถูกตรวจจับเป็นการอัปเดต จึงต้องอัปเดตให้ถูกต้องและ deploy พร้อมโค้ด

### เริ่มต้นใช้งาน

ติดตั้ง dependency ในแต่ละโปรเจคที่ต้องการ (ใช้ Yarn ตาม `packageManager` ของแต่ละโปรเจค)

```bash
cd <โฟลเดอร์โปรเจค>
yarn install
```

สร้างไฟล์ `.env` ในโปรเจคที่ต้องการ ห้าม commit ค่าจริงลง git (`.gitignore` ตั้งไว้แล้ว) โปรเจคย่อยแต่ละตัวจะระบุตัวแปรที่ต้องใช้ไว้ในโค้ดหรือ README ของตัวเอง

### รันบริการ

- บอท: ดูคำสั่งใน `bot/package.json` แล้วรันด้วย `yarn`
- backend: `yarn start` (ใน `backend/`)
- เว็บไซต์: `yarn dev` (ใน `frontend/`) และ `yarn build` ก่อน deploy
- status: `yarn auto:dev` (โหมดพัฒนา) หรือ `yarn auto:start` (production)
- ระบบเพลง: ดู `musicV1/README.md` และ `musicV1/MUSIC_RESILIENCE.md`

### Deploy

- ส่วนใหญ่ deploy ผ่าน Coolify และ Docker (มี `Dockerfile.production` และ `docker-compose.yaml` ในแต่ละโปรเจค)
- Coolify deploy อัตโนมัติเมื่อมีการ push (ตั้งค่าไว้ใน Coolify)
- บริการบางตัวรันบนเครื่องด้วย pm2 ตาม `ecosystem.config.cjs`

## ทีม Yumi

1) **Campus2454 (แคมปัส)**
   - เจ้าของโปรเจค
   - นักพัฒนาบอท (ทำทั้งหมด 100%)
   - นักพัฒนาเว็บไซต์ (Frontend ประมาณ 80%, Backend ทำทั้งหมด 100%)
2) **kxnomtom (คุณน๋ม - ขนมต้ม - บีม)**
   - ทีมช่วยเหลือเรื่องต่างๆ
   - นักพัฒนาเว็บไซต์ (Frontend ประมาณ 20%)
3) **alpha._.ice (อัลฟา)**
   - ทีมช่วยเหลือเรื่องต่างๆ
   - แอดมินและดูแลความปลอดภัยของเซิร์ฟเวอร์ Discord

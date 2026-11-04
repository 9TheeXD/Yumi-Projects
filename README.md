# **Yumi Projects**

👋 ยินดีต้อนรับ! Welcome!

โปรเจคบอท Discord ที่พัฒนาโดยคนไทย

###### หากพบข้อผิดพลาดหรือจุดบกพร่อง แจ้งให้ทีมทราบได้ทาง [Discord](https://discord.gg/brxPZB3Jzy) หรือช่องทางอื่นๆ

## Links

- เว็บไซต์: [yumistack.net](https://yumistack.net/)
- Discord: [discord.gg/brxPZB3Jzy](https://discord.gg/brxPZB3Jzy)
- งานที่กำลังทำ: [GitHub Projects](https://github.com/users/Campus2454/projects/4)
- [โครงสร้างโปรเจค ↘](https://github.com/Campus2454/Yumi-Projects/edit/main/README.md#project-structure)
- [สมาชิกทีม Yumi ↘](https://github.com/Campus2454/Yumi-Projects/edit/main/README.md#team-yumi)

## Project Structure

| โฟลเดอร์ | หน้าที่ | เทคโนโลยี |
| --- | --- | --- |
| `bot/` | บอท Discord หลัก | discord.js, TypeScript |
| `backend/` | API ฝั่ง server ของเว็บไซต์ | NestJS, TypeScript |
| `frontend/` | เว็บไซต์ [yumistack.net](https://yumistack.net/) | Next.js |
| `status/` | หน้า status, เก็บประวัติ downtime, แจ้งเตือน Discord และอีเมล | Express, PostgreSQL |
| `musicV1/` | บอท Discord สำหรับเล่นเพลง | TypeScript, Kazagumo |
| `music-web/` | เว็บไซต์ player ควบคุมบอทเพลง | Next.js |
| `lavalink/` | Lavalink audio server | Lavalink |
| `nodelink/` | NodeLink audio node | NodeLink |
| `global/` | โค้ด, type และ function ที่ใช้ร่วมกันระหว่างโปรเจค | TypeScript |
| `assets-web/` | ไฟล์ asset ของเว็บ | - |
| `RegisterCommand.js` | ลงทะเบียน slash command ของบอท (`yarn register`) | JavaScript |

## Team Yumi

1) **Campus2454 (แคมปัส - ธีร์)**
   - เจ้าของโปรเจค
   - นักพัฒนาบอท (ทำทั้งหมด 100%)
   - นักพัฒนาเว็บไซต์ (Frontend ประมาณ 80%, Backend ทำทั้งหมด 100%)
2) **kxnomtom (คุณน๋ม - ขนมต้ม - บีม)**
   - ทีมช่วยเหลือเรื่องต่างๆ
   - นักพัฒนาเว็บไซต์ (Frontend ประมาณ 20%)
3) **alpha._.ice (อัลฟา)**
   - ทีมช่วยเหลือเรื่องต่างๆ
   - แอดมินและดูแลความปลอดภัยของเซิร์ฟเวอร์ Discord

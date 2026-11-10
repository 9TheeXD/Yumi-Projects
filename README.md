# **Yumi Projects**

👋 ยินดีต้อนรับ! Welcome!

โปรเจคบอท Discord ที่พัฒนาโดยคนไทย

###### หากพบข้อผิดพลาดหรือจุดบกพร่อง แจ้งให้ทีมทราบได้ทาง [Discord](https://discord.gg/brxPZB3Jzy) หรือช่องทางอื่นๆ

## Links

- เว็บไซต์: [yumistack.net](https://yumistack.net/)
- Discord: [discord.gg/brxPZB3Jzy](https://discord.gg/brxPZB3Jzy)
- งานที่กำลังทำ: [GitHub Projects](https://github.com/users/9TheeXD/projects/4)
- [โครงสร้างโปรเจค ↘](https://github.com/9TheeXD/Yumi-Projects/tree/main#project-structure)
- [สมาชิกทีม Yumi ↘](https://github.com/9TheeXD/Yumi-Projects/tree/main#team-yumi)

## Project Structure

| โฟลเดอร์ | หน้าที่ | เทคโนโลยี |
| --- | --- | --- |
| `bot/` | บอท Discord หลัก | discord.js, TypeScript |
| `backend/` | API ฝั่ง server ของเว็บไซต์ | NestJS, TypeScript |
| `frontend/` | เว็บไซต์ [yumistack.net](https://yumistack.net/) | Next.js |
| `status/` | เว็บไซต์ [status.yumistack.net](https://status.yumistack.net/), เก็บประวัติ downtime, แจ้งเตือน Discord และอีเมล | Express, PostgreSQL |
| `music-web/` | เว็บไซต์ [music.yumistack.net](https://music.yumistack.net/), ควบคุม Player บอทเพลง | Next.js |
| `musicV1/` | บอท Discord สำหรับเล่นเพลง | TypeScript, Kazagumo |
| `lavalink/` | Lavalink audio server | Lavalink |
| `nodelink/` | NodeLink audio node | NodeLink |
| `global/` | โค้ด, type และ function ที่ใช้ร่วมกันระหว่างโปรเจค | TypeScript |
| `assets-web/` | ไฟล์ asset ของเว็บ | - |
| `RegisterCommand.js` | ลงทะเบียน slash command ของบอท (`yarn register`) | JavaScript |

## Team Yumi

1) **[9TheeXD](https://github.com/9TheeXD) (แคมปัส - ธีร์)**
   - เจ้าของโปรเจค
   - พัฒนาบอทหลัก `(ทำทั้งหมด)`
   - พัฒนาเว็บไซต์ `(~80%)`
   - พัฒนาบอทเพลง `(~80%)`
2) **[cnkkt](https://github.com/cnkkt) (คุณน๋ม - ขนมต้ม - บีม)**
   - ทีมช่วยเหลือเรื่องต่างๆ
   - พัฒนาเว็บไซต์ `(~20%)`
3) **alpha._.ice (อัลฟา)**
   - ทีมช่วยเหลือเรื่องต่างๆ
   - แอดมินและดูแลความปลอดภัยของเซิร์ฟเวอร์ Discord
4) **[Claude Code](https://github.com/Claude)**
   - เป็นที่ปรึกษาด้านการ Coding
   - พัฒนาระบบ Status `(ทำทั้งหมด)`
   - ปรับปรุงและดัดแปลง lavalink/nodelink `(ทำทั้งหมด)`

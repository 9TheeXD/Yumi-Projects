# ระบบเพลงทนบล็อก YouTube

สรุปสถานะ ณ 29 ต.ค. 2026 (แทน `handoff-music-bot.md` เดิม ซึ่งลบไปแล้ว)
โค้ดอยู่ที่ branch `music-resilience` ของ repo `musicV1` (ยังไม่ได้ merge เข้า `master`)

## 1. ภาพรวม

```
คำสั่งผู้ใช้ (/play, !play, autocomplete, เว็บ, restore)
  -> musicSearch()  bot/src/music/resolver.ts
       1. ลิงก์: โหลดลิงก์ตรง (autocomplete ก็โหลดลิงก์ ไม่ค้นเป็นข้อความ)
          ลิงก์ YouTube โหลดไม่ได้ -> ค้น ytsearch:<videoId> แล้วเลือกผลที่ id ตรงกัน
          YouTube ใช้ไม่ได้ทั้งหมด -> เอาชื่อเพลงจาก oEmbed ไปค้นแหล่งอื่น
       2. DB cache (SQLite) -> จำกัดอัตราค้นต่อผู้ใช้
       3. ไล่แหล่งตาม MUSIC_SOURCE_ORDER (ค่าเริ่มต้น soundcloud -> audiomack -> youtube_music -> youtube)
          ข้ามแหล่งที่ปิด / node ไม่มี (/v4/info) / negative cache / circuit breaker เปิด
  -> เล่นบน node ที่ nodeResolver เลือก (NODELINK01 ก่อน แล้ว LAVALINK01)
       แทร็กที่ node encode มาแล้วเล่นเลย (trackResolver) ไม่ให้ Kazagumo ค้นซ้ำจากชื่อ
  -> node ตาย: ย้าย player ไป node อื่นทันทีตอน socket close (ไม่ใช้ moveOnDisconnect ของ Shoukaku ที่พัง)
  -> เล่นไม่ได้ (playerException): ลบ cache เพลงนั้น ค้นเพลงเดียวกันจากแหล่งอื่น 1 ครั้ง
  -> restart บอท: คืน player จาก track ที่บันทึกไว้ทั้งก้อน (encoded) ได้เพลงเดิมเป๊ะ

sidecar/sidecar.mjs (pm2: YM_Sidecar) ทุก 5 นาที
  เช็ค node + แหล่ง (NodeLink เช็คถึงระดับ stream) + ผลเล่นจริงจาก soak-client + RAM ของ container
  สถานะเปลี่ยน -> Discord webhook
  YouTube พังทุก node 2 รอบติด -> ปิด YouTube ใน bot/music-sources.json ให้บอทเอง หายแล้วเปิดคืน
  วันละครั้ง: เช็คเวอร์ชันใหม่ NodeLink / Lavalink (release + dev) / youtube-source / yt-cipher

sidecar/soak-client.mjs (pm2: YM_SoakClient)
  ใช้บอท dev เล่นเพลงในชุดทดสอบวนตลอดที่ห้อง test2 ของ "It's a test server!!"
  สลับ node ทุกเพลง เช็คทุก 30 วิว่าเพลงเดินจริง ผลลง soak-client.log และ soak-status.json
```

## 2. อะไรรันอยู่ที่ไหน

| ส่วน | ที่อยู่ | หมายเหตุ |
|---|---|---|
| NodeLink v3.9.0 ×2 + yt-cipher | `/home/yumi/nodelink` (docker compose) | `127.0.0.1:3000`, `:3002` tier หลัก build จาก git ref ที่ pin ไว้ |
| Lavalink dev (`6740a40`) ×2 + youtube-source `2be8e54` + yt-cipher | `/home/yumi/lavalink` (docker compose) | `127.0.0.1:2333`, `:2334` tier สำรอง image pin ด้วย digest |
| บอท `YM_V1`, `YMm_V1` | pm2, `bot/build` | ต้อง build ใหม่ทุกครั้งที่แก้โค้ด (`node ../node_modules/typescript/bin/tsc -b` ใน `bot/`) |
| บอท dev `YMTest_V1` | pm2, nodemon + tsx | reload เองเมื่อแก้ไฟล์ใน `bot/src` (ทำให้เพลงที่เปิดอยู่สะดุด) |
| `YM_Sidecar`, `YM_SoakClient` | pm2, `sidecar/` | |

docker ต้องใช้ `sudo` (user `ubuntu` ไม่อยู่ในกลุ่ม docker) sidecar ใช้ `SIDECAR_DOCKER = sudo -n docker`
ไฟล์ `.env` ของ node ทั้งสอง stack ไม่ขึ้น git มีรหัสผ่าน node และ refresh token ของ burner

## 3. env สำคัญ (`musicV1/.env`)

```env
NODELINK01_HOST = 127.0.0.1:3000      # บอททุกตัวใช้ node บนเครื่องนี้ (ค่า serenetia เดิมเก็บเป็นคอมเมนต์ไว้)
LAVALINK01_HOST = 127.0.0.1:2333
MUSIC_NODE_PRIORITY = NODELINK01,NODELINK02|LAVALINK01,LAVALINK02
MUSIC_SOURCE_ORDER = soundcloud,audiomack,youtube_music,youtube   # ไม่ใส่ = ค่านี้
MUSIC_AUTOCOMPLETE_ORDER = soundcloud,youtube_music
SIDECAR_WEBHOOK_URL = https://discord.com/api/webhooks/...
SIDECAR_CONTAINERS = yumi_nodelink,yumi_lavalink,yumi_nodelink_cipher,yumi_lavalink_cipher
PIN_LAVALINK / PIN_LAVALINK_DEV / PIN_NODELINK / PIN_YT_PLUGIN   # เวอร์ชันที่ใช้อยู่ ให้ sidecar เทียบกับของใหม่
# SIDECAR_VOICE_GUILD / SIDECAR_VOICE_CHANNEL   ปิดไว้ (ใช้บอท dev ตัวเดียวกับคน เลยไปรบกวนเพลงคนฟัง)
```

ตัวแปร resolver อื่นๆ (breaker, rate limit, negative cache) ดูค่าเริ่มต้นใน `bot/src/music/config.ts`
ปิดแหล่งทันทีโดยไม่ต้อง redeploy: เขียน `bot/music-sources.json` เช่น `{ "disabled": ["youtube"] }` บอทอ่านใหม่ทุก 10 วินาที

## 4. งานที่ต้องทำเป็นครั้งคราว

**มี 4 node: NODELINK01, NODELINK02, LAVALINK01, LAVALINK02** (container: `yumi_nodelink`, `yumi_nodelink2`, `yumi_lavalink`, `yumi_lavalink2` ตั้งใน `<NAME>_CONTAINER`) แต่ละตัวควรใช้ burner คนละบัญชี
- `NODELINK02` อยู่ใน compose เดียวกับ `NODELINK01` (`/home/yumi/nodelink`, port 3002) ใช้ yt-cipher ร่วมกัน token อยู่ใน `YT_REFRESH_TOKENS_2`
- `LAVALINK02` อยู่ใน compose เดียวกับ `LAVALINK01` (`/home/yumi/lavalink`, port 2334) token อยู่ใน `YT_REFRESH_TOKEN_2`
- บอทกระจายโหลด (`MUSIC_NODE_PRIORITY = NODELINK01,NODELINK02|LAVALINK01,LAVALINK02`): ใน tier เดียวกันเลือก node ที่มี player น้อยสุด
  ข้าม node ที่ sidecar บอกว่า YouTube พัง ถ้ายังมี node อื่นที่ใช้ได้ tier ถัดไปใช้เมื่อทั้ง tier ล่ม
- เพิ่ม node: เพิ่ม service ใน compose แล้วเพิ่มชื่อใน `MUSIC_NODES` + ตัวแปร `<NAME>_HOST/_PASS/_STACK/_SERVICE/_TOKEN_VAR`
  แล้ว restart บอท / sidecar / soak-client (ดูรูปแบบใน `bot/src/music/nodes.ts`)

**การแจ้งเตือน** (ห้อง status, ส่งโดย Yumi Music)
- ส่งเมื่อสถานะเปลี่ยน: node ล่ม/กลับมา, แหล่งเพลงบน node ใช้ไม่ได้/กลับมา, YouTube ขอ login, ปิด/เปิด YouTube ทั้งบอท, RAM เกิน 85%, มีเวอร์ชันใหม่
- เตือน (เหลือง/แดง) จะแท็ก role `SIDECAR_MENTION_ROLE`
- **รายงานประจำวัน** 19:00 เวลาไทย (`SIDECAR_REPORT_TIME`): การ์ดต่อ node มีสถานะ, uptime, downtime ล่าสุด, % ใช้งานได้ 24 ชม., ping, player,
  CPU, RAM, YouTube/SoundCloud, บัญชี burner, เวอร์ชัน (แท็ก role ถ้ามี node ล่ม) สั่งส่งเองได้ด้วย `node sidecar/sidecar.mjs report`
- error ร้ายแรงใน log ของ node (NodeLink worker crash, Lavalink OutOfMemory ฯลฯ) แจ้งทุกรอบที่เจอ
- ปัญหาที่ยังไม่หาย (node ล่ม, YouTube บน node ใช้ไม่ได้) ส่งซ้ำทุก `SIDECAR_REMIND_HOURS` (3 ชม.) พร้อมปุ่ม login จนกว่าจะแก้

**บัญชี burner โดนบล็อก หรือ token หมดอายุ** (ไม่ต้องเข้าเซิร์ฟเวอร์)
1. สมัครบัญชี Google ใหม่ด้วยตัวเอง (ห้ามใช้บัญชีหลัก) แล้ว login ค้างไว้ในเบราว์เซอร์
2. ในห้อง status กดปุ่ม **🔑 สร้างรหัส login ใหม่ให้ <NODE>** ที่อยู่ในการ์ดแจ้งเตือน
   หรือสั่ง `node sidecar/sidecar.mjs panel` ให้ส่งการ์ดสถานะที่มีปุ่มครบทุก node (บอท Yumi Music เป็นคนส่ง)
   (ปุ่มใช้ได้เฉพาะคนที่มีสิทธิ์ Manage Server หรืออยู่ใน `MUSIC_ADMIN_IDS`)
3. บอทตอบเป็นข้อความที่เห็นคนเดียว มีรหัสกับปุ่มเปิดหน้า Google ใส่รหัสแล้วกดอนุญาต
4. บอทบันทึก token ลง `.env` ของ stack ให้เอง
   - Lavalink: ใช้ token ใหม่ทันที ไม่ต้อง restart
   - NodeLink: รีสตาร์ทเฉพาะ container นั้น (player ย้ายไป node อื่นเอง)
   เสร็จแล้วบอทเช็ค YouTube ให้แล้วแจ้งผล
ทำเองแบบเดิมก็ได้: แก้ token ใน `.env` ของ stack แล้ว `sudo docker compose up -d <service>`
(โค้ด: `bot/src/music/login.ts`, `bot/src/commands/nodeLogin.ts`, Google client เดียวกับ NodeLink/youtube-source)

**ห้าม restart node ทุกตัวในกลุ่มเดียวกันพร้อมกัน** (เช่น NODELINK01 กับ NODELINK02) restart ทีละตัว แล้วรอให้ healthy ก่อน
เพลงจะได้ย้ายไป node ชนิดเดียวกัน ถ้าทั้งกลุ่มหายพร้อมกัน เพลงต้องย้ายข้ามไป Lavalink (บอทแปลงเพลงให้ แต่ช้ากว่าและอาจได้คลิปคนละตัว)

**อัปเดตเวอร์ชันแบบมี rollback**
```
node sidecar/sidecar.mjs update ../lavalink LAVALINK_TAG <tag หรือ dev@sha256:...> LAVALINK01
node sidecar/sidecar.mjs update ../nodelink NODELINK_REF <commit> NODELINK01
```
แก้ `.env` ของ stack -> `compose up -d --build` -> รอ health check (node ขึ้น + แหล่งที่ไม่ใช่ YouTube ใช้ได้)
ไม่ผ่านก็คืน `.env` เดิมแล้ว up ใหม่ ทดสอบแล้วทั้งกรณีดึง image ไม่ได้และกรณี health check ไม่ผ่าน
ข้อความแจ้งเตือนซ่อนค่าของ key ที่เป็นรหัส (PASS/TOKEN/SECRET/KEY/AUTH)
NodeLink: ห้ามอัปเวอร์ชันแล้วใช้เลย หลายเวอร์ชันมี memory leak ดู RAM ใน `sidecar-history.jsonl` 24 ชม.

**เครื่องมือทดสอบ** (ใช้ token บอท dev อย่าใช้ใน guild ที่คนกำลังฟังบอท dev อยู่)
- `node sidecar/voiceprobe.mjs <guild> <voiceChannel> 12 < sidecar/probe-queries.txt` เล่นจริงทีละเพลงทุก node
- `node sidecar/failover-test.mjs <guild> <voiceChannel> yumi_nodelink` ปิด node ระหว่างเล่น ดูว่าย้ายแล้วเล่นต่อไหม
- `node sidecar/sidecar.mjs check` / `releases` / `test-notify` (ส่งตัวอย่างแจ้งเตือนทุกแบบไป webhook)
- `/v4/trackstream?encodedTrack=...` ของ NodeLink บอก url, protocol, format และ `newTrack` ถ้า fallback ไปแหล่งอื่น ใช้ดีบัคได้

## 5. ผลทดสอบบน VPS และปัญหาที่แก้แล้ว

เครื่อง: OVH VPS `148.113.174.253`, Ubuntu kernel 6.14, Docker 29, Coolify รันอยู่แต่ไม่ได้ใช้กับ node เพลง

- IP ของ VPS (IPv4 และ IPv6) โดน YouTube ตอบ `Sign in to confirm you’re not a bot` กับเพลงส่วนใหญ่ถ้าไม่มี OAuth
  หลัง login burner ทั้ง 2 node เล่น YouTube ได้ 7/7 เพลงทดสอบ
- **Lavalink ไม่มีเสียง position ค้าง 0 ไม่มี error**: JDA-NAS ส่ง UDP ไม่ออกบนเครื่องนี้ แก้ด้วย `bufferDurationMs: 0`
- **Lavalink โหลดลิงก์ YouTube ตรงไม่ได้** (client ที่ใช้โหลดข้อมูลวิดีโอไม่ใช้ OAuth): resolver ค้นด้วย video id แทน
- **SoundCloud บน Lavalink พัง** (`Did not detect any supported formats`, SoundCloud ส่งแค่ AAC-HLS): ปิดใน Lavalink, NodeLink เล่นได้
- **`moveOnDisconnect` ของ Shoukaku ไม่ย้าย player** (`Player.move()` เรียก `destroyPlayer` กับ node ที่ตายก่อน): ย้ายเองตอน `close`
  ทดสอบทั้ง 2 ทาง ย้ายใน 0.5 วินาที เล่นต่อจากตำแหน่งเดิม encoded track ใช้ข้าม node ได้ (เหมือนกันทุก byte)
- **Kazagumo ค้นเพลงซ้ำจาก "ศิลปิน - ชื่อ"** ทุกครั้งที่ sourceName ไม่อยู่ในรายการของมัน (เช่น `ytmusic` ของ NodeLink) ทำให้เพลงเปลี่ยนเป็นคลิปอื่นได้: ใช้ `trackResolver`
- **restore หลัง restart ได้เพลงคนละเวอร์ชัน** (เดิมค้นใหม่จาก URL): บันทึก encoded track แทน
- **รูปการ์ดเพลงโหลดไม่ขึ้น**: เดิมสร้างรูปและอัปโหลดใหม่ทุกครั้งที่อัปเดต แถมหลาย event แก้ข้อความพร้อมกัน
  ตอนนี้สร้างรูปครั้งเดียวต่อเพลง (ไม่มี progress ในรูป) อัปโหลดเฉพาะตอนเปลี่ยนเพลง และแก้ข้อความทีละครั้งต่อ guild progress bar อยู่ใน components เสมอ
- **NodeLink worker crash จาก SoundCloud ที่เข้ารหัส** (`Unsupported protocol: cbc-encrypted-hls`): เพลงค่ายใหญ่บน SoundCloud บางเพลง
  มีแต่ stream แบบเข้ารหัส NodeLink เลือกมันเป็นตัวสุดท้าย แล้วโยน error ที่ไม่มีใครจับ ทำให้ worker ล่มและทุก player บน worker นั้นหลุด
  แก้ด้วย patch ใน `/home/yumi/nodelink/patches/apply.mjs` (build เป็น `yumi/nodelink:v3.9.0-patched` ผ่าน `Dockerfile.patch`)
  ตอนนี้เพลงแบบนี้แค่ error `No valid transcoding found` แล้วบอทหาเพลงจากแหล่งอื่นแทน
  อัปเวอร์ชัน NodeLink: build base ใหม่จาก git ref แล้ว `docker compose build nodelink` ถ้า patch ใช้ไม่ได้แล้ว build จะล้ม (ตั้งใจให้รู้ตัว)
- youtube-source branch `feat/sabr-support` (02f536d) แย่กว่า 2be8e54 บนเครื่องนี้
- NodeLink `GET /v4/youtube/config?validate=true` ค้างหรือตอบ `isValid:false` ทั้งที่ token ใช้ได้ ไม่ใช้
- Lavalink: โฟลเดอร์ `plugins/` ต้องเป็นของ uid 322 (`sudo chown -R 322 plugins`)

### แหล่งเพลงใน NodeLink (ทดสอบค้น + stream จริง)
- **Audiomack**: เพลงเต็ม mp3 ไม่ต้องมีบัญชี เพลงฝรั่ง/K-pop เจอดี คำค้นไทยผสมอังกฤษมักไม่เจอ (ใช้อยู่)
- Deezer / Spotify / Apple Music / Tidal: ได้แค่ข้อมูลเพลง ตอนเล่น mirror ไป YouTube
- JioSaavn / Gaana: เพลงเต็มแต่ผลค้นไทยไม่ตรง / Qobuz / Mixcloud / Bandcamp: ค้นเพลงไทยไม่เจอ

## 6. ยังไม่ได้ทำ (ไว้ทำทีหลัง)

**รอผล**
- ทดสอบรันค้าง 24 ชม. (เริ่ม 29 ต.ค. 2026 ~16:30 UTC): ดู `sidecar/soak-client.log` (FAIL/STALL) และ RAM ใน `sidecar/sidecar-history.jsonl`

**ต้องตัดสินใจ**
- ช่องค้นหา (autocomplete) ตอนนี้ขึ้น SoundCloud เป็นหลัก YouTube Music ขึ้นเฉพาะตอน SoundCloud ไม่เจอ
  จะให้ผสมผลหลายแหล่ง หรือให้ YouTube มาก่อน แลกกับการยิง YouTube บ่อยขึ้น (ปรับ `MUSIC_AUTOCOMPLETE_ORDER` / `MUSIC_SOURCE_ORDER` หรือแก้ `autocomplete()` ให้รวมผล)
- burner สำหรับ NODELINK02 / LAVALINK02: ยังไม่มี (ตอนนี้ YouTube บน 2 ตัวนี้ใช้ไม่ได้ บอทเลยไม่ส่งงาน YouTube ไปที่นั่น)
  กดปุ่ม login ในห้อง status ทีละ node ด้วยบัญชีใหม่คนละบัญชี
- ยังไม่รู้ว่า token ของ NODELINK01 กับ LAVALINK01 มาจากบัญชีเดียวกันไหม ถ้าใช่ ควร login ใหม่ให้ตัวใดตัวหนึ่งด้วยบัญชีอื่น
- merge branch `music-resilience` เข้า `master` และ push (ยังไม่มี remote ใน `musicV1` มี git ครอบที่ `/home/yumi`)

**ข้อจำกัดที่รู้อยู่**
- IPv6 rotation ทำไม่ได้: OVH VPS นี้ได้ IPv6 แค่ `/128` (ลองเพิ่ม IP อื่นใน /64 แล้วออกเน็ตไม่ได้)
- ไม่มี residential proxy ถ้า IP โดนหนักจนลำพัง OAuth ไม่พอ ต้องใช้ proxy (`YT_PROXIES` ของ NodeLink) หรือ node ที่เน็ตบ้าน
- ทุก node ออก IP เดียวกัน หลาย node ช่วยเรื่องบัญชีโดนแบน แต่ถ้า IP โดนบล็อก ทุก node โดนพร้อมกัน
- Lavalink เช็ค YouTube ได้แค่ระดับค้นหา (ค้นได้แม้ไม่มี token) ผลเล่นจริงมาจาก soak-client ซึ่งวนครบ 4 node ราว 15 นาที
- RAM ตอนนี้: NodeLink ~250 MB/ตัว, Lavalink ~300 MB/ตัว, yt-cipher ~120 MB/ตัว (รวมราว 1.3 GB)
- การเช็คเล่นจริงผ่านห้องเสียงของ sidecar ปิดไว้ เพราะใช้บอท dev ตัวเดียวกับคน ทางแก้: สร้างบอทแยกสำหรับทดสอบแล้วใส่ `PROBE_TOKEN`
  ตอนนี้ใช้ผลจาก soak-client แทน (สลับ node ทุกเพลง)
- Lavalink ใช้ image `dev` (ไม่ใช่ release) เพราะ koe/libdave ใหม่กว่า กลับไป 4.2.2 ได้ถ้า `bufferDurationMs: 0` ยังอยู่ (ทดสอบแล้วว่าเล่นได้)
- SoundCloud ของ Lavalink ใช้ไม่ได้จนกว่า lavaplayer จะรองรับ AAC-HLS
- Shoukaku `moveOnDisconnect` ยังเปิดอยู่แต่ไม่มีผล ถ้าอัป Shoukaku ที่แก้ `Player.move()` แล้ว ตัวย้ายเองใน `kazagumoManager.ts` ยังใช้ได้ ไม่ชนกัน
- การเช็คอัตโนมัติทุก 20 นาทีของ Claude อยู่ได้แค่ตอน session เปิดอยู่ และหมดอายุใน 7 วัน
- ห้ามเขียนสคริปต์สร้างบัญชี Google อัตโนมัติ หรือเลี่ยง captcha/2FA ผู้ใช้ login burner เองเท่านั้น ห้ามใช้บัญชีหลัก

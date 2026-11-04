import chalk from "chalk";
import { ContainerBuilder } from "discord.js";
import { Client, TextDisplayBuilder } from "discord.js";
import fs from "fs";
import { Kazagumo, KazagumoTrack } from "kazagumo";
import path from "path";
import { setTimeout as wait } from 'timers/promises';
import { sendPStatus } from "./messages.js";
import { MessageFlags } from "discord.js";
import { createCanvas, loadImage, registerFont } from "canvas";

// The server has no Thai font, so Thai titles rendered as boxes. Bundle Noto Sans Thai (OFL) and
// list it after Sans: Pango takes Latin from Sans and falls back to it for Thai glyphs.
const FONT_DIR = path.join(process.cwd(), "src/utils/fonts");
try {
  registerFont(path.join(FONT_DIR, "NotoSansThai-Regular.ttf"), { family: "Noto Sans Thai" });
  registerFont(path.join(FONT_DIR, "NotoSansThai-Bold.ttf"), { family: "Noto Sans Thai", weight: "bold" });
} catch (e) {
  console.error("[MusicCard] Thai font not loaded:", (e as Error).message);
}
import { isDev, isM } from "./env.js";
import { Player, Track } from "shoukaku";
import { User } from "discord.js";
import { musicSearch, portTrack } from "../music/resolver.js";
import { NOTICE, notify } from "./friendly.js";

const SAVE_FILE = path.join(process.cwd(), `players_${isDev ? 'dev' : isM ? 'music' : 'main'}.json`);

// Saved players that could not be restored yet (voice join failed after a restart). They stay in the
// save file until a retry works or gives up, so another restart in between does not lose them.
type SavedPlayer = { guildId: string; voiceId: string; textId: string; [k: string]: any };
const pendingRestore = new Map<string, SavedPlayer>();

export function savePlayers(kazagumo: Kazagumo) {
  const data: unknown[] = [...pendingRestore.values()].filter(d => !kazagumo.players.has(d.guildId));

  for (const player of kazagumo.players.values()) {
    if (!player.voiceId) continue;
    data.push({
      guildId: player.guildId,
      voiceId: player.voiceId,
      textId: player.textId,
      messageId: player.messageId,
      volume: player.volume,
      position: player.position,
      paused: player.paused,
      // A song that failed for good stays the current one in the file: a restart plays it again.
      current: (player.queue.current ?? player.failedTrack)?.uri ?? null,
      queue: player.queue.map(t => t.uri),
      // Exact tracks (encoded + info). Restoring from these needs no search, so a restart cannot
      // swap the song for another version. Encoded tracks play on both NodeLink and Lavalink.
      currentRaw: (player.queue.current ?? player.failedTrack) ? rawTrack((player.queue.current ?? player.failedTrack)!) : null,
      queueRaw: player.queue.map(rawTrack),
      loop: player.loop,
      247: player[247] || false
    });
  }

  fs.writeFileSync(SAVE_FILE, JSON.stringify(data, null, 2));
}

function rawTrack(t: KazagumoTrack) {
  return (t.getRaw() as { _raw?: unknown })._raw ?? null;
}

// Saved raw track first, URL search only for old save files.
async function restoreTrack(kazagumo: Kazagumo, raw: unknown, uri: string | null | undefined, nodeName: string) {
  const node = kazagumo.shoukaku.nodes.get(nodeName);
  if (raw && typeof raw === 'object' && 'encoded' in raw && node) {
    // The player may land on another node than the one that encoded the track.
    const t = await portTrack(kazagumo, raw as Track, node);
    if (t) return new KazagumoTrack(t, undefined);
  }
  if (!uri) return null;
  const res = await musicSearch(kazagumo, uri, { nodeName });
  return res.tracks[0] ?? null;
}

function loadPlayers() {
  if (!fs.existsSync(SAVE_FILE)) return [];
  return JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
}

export async function restorePlayers(client: Client, kazagumo: Kazagumo) {
  const head = chalk.bold('[RePlayer]');
  console.log(head, `Trying to restore players...`);
  const saved: SavedPlayer[] = loadPlayers();
  for (const data of saved) await restoreOne(client, kazagumo, data, 0);
  console.log(head, `Restore players complete`);
}

const RESTORE_RETRY_MS = [30_000, 2 * 60_000, 5 * 60_000];

async function restoreOne(client: Client, kazagumo: Kazagumo, data: SavedPlayer, attempt: number) {
  const head = chalk.bold('[RePlayer]');
  // Saved while out of any voice channel: nothing to rejoin.
  if (!data.voiceId) { console.warn(head, `Skip ${data.guildId}: no voice channel saved`); pendingRestore.delete(data.guildId); return; }
  {
    try {
      const player = await kazagumo.createPlayer({
        guildId: data.guildId,
        voiceId: data.voiceId,
        textId: data.textId
      });
      player.restoring = true;

      const guild = client.guilds.cache.get(data.guildId);
      const channel = await guild?.channels.fetch(data.textId);
      const oldM = channel?.isSendable() && await channel.messages.fetch(data.messageId) || undefined;
      const m = { components: [
          (new ContainerBuilder()
            .addTextDisplayComponents(t=>t.setContent('trying to restore this player...'))
            .setAccentColor(0x00ff00)
          ),
      ]};
      try{
        if(oldM && oldM.editable){
          const newM = await oldM.edit(m);

          player.messageId = newM.id;
          // console.log([player.messageId, newM.id, data.messageId]);
          await wait(500);
        }else if(channel?.isSendable()){
          // console.log(m);
          const newM = await channel.send({ ...m, flags: [ MessageFlags.IsComponentsV2 ] });

          player.messageId = newM.id;
          // console.log(newM);
          await wait(500);
        };
      }catch{(e: any)=>console.error(head, `Error to send new message:`, e)};

      player.setVolume(data.volume ?? 100);

      // ใส่เพลงที่กำลังเล่นก่อน
      const nodeName = player.shoukaku.node.name;
      const current = data.current || data.currentRaw ? await restoreTrack(kazagumo, data.currentRaw, data.current, nodeName) : null;
      if (current) player.queue.add(current);

      // แล้วค่อยใส่ queue
      const urls: (string | null)[] = data.queue || [];
      for (let i = 0; i < Math.max(urls.length, data.queueRaw?.length ?? 0); i++) {
        const t = await restoreTrack(kazagumo, data.queueRaw?.[i], urls[i], nodeName);
        if (t) player.queue.add(t);
      }

      if (player.queue.size || player.queue.current) {
        await player.play();
      }

      // Nothing restored (track gone): seek() would throw and abort the rest of this player's restore.
      if (data.position && player.queue.current) player.seek(data.position);
      if (data.paused) player.pause(true);
      player.loop = data.loop;
      player[247] = data[247];

      await sendPStatus(client, kazagumo, player, { from: 'playerRestore' });
      savePlayers(kazagumo);
      console.log(head, `Restore player for ${chalk.yellowBright(player.guildId)}`);

      pendingRestore.delete(data.guildId);
    } catch (e) {
      console.error("Restore player error:", e);
      if (!kazagumo.players.has(data.guildId)) {
        const delay = RESTORE_RETRY_MS[attempt];
        if (delay === undefined) {
          pendingRestore.delete(data.guildId);
          void notify(client, data.guildId, data.textId, 'restore', NOTICE.restoreFailed());
        } else {
          pendingRestore.set(data.guildId, data);
          console.warn(head, `Retrying restore of ${data.guildId} in ${delay / 1000}s`);
          setTimeout(() => { void restoreOne(client, kazagumo, data, attempt + 1); }, delay);
        }
        savePlayers(kazagumo);
      }
    } finally {
      const p = kazagumo.players.get(data.guildId);
      if (p) p.restoring = false;
    }
  }
}

const IDLE_LEAVE_MS = 5 * 60_000;
const FAILED_LEAVE_MS = 60 * 60_000;

export function autoDisconnect(client: Client, kazagumo: Kazagumo) {
  const head = chalk.bold('[AutoDC]');
  setInterval(() => {
    const now = Date.now();

    for (const player of kazagumo.players.values()) {
      if (player[247] || player.recovering || player.restoring) continue;
      if (player.queue.current || player.queue.size) { player.idleSince = undefined; continue; }
      player.idleSince ??= now;
      // A song that failed for good waits for the Resume button longer than an empty player does.
      if (now - player.idleSince < (player.failedTrack ? FAILED_LEAVE_MS : IDLE_LEAVE_MS)) continue;
      console.log(head, `Leave idle player ${player.guildId}`);
      void notify(client, player.guildId, player.textId, 'idle', NOTICE.idleLeft());
      player.destroy().catch(() => {});
    }
  }, 1*60_000);
}

function drawCover(ctx:any,img:any,w:number,h:number){
  const scale = Math.max(w/img.width,h/img.height)
  const x = (w-img.width*scale)/2
  const y = (h-img.height*scale)/2
  ctx.drawImage(img,x,y,img.width*scale,img.height*scale)
}

// Wraps text into at most maxLines lines (last one ends with "…" when cut) and returns the y
// of the next line. Breaks between words, or inside a word when it has no spaces (Thai, long titles).
function drawWrapText(ctx:any,text:string,x:number,y:number,maxWidth:number,lineHeight:number,maxLines = Infinity){
  const fits = (t:string) => ctx.measureText(t).width <= maxWidth
  const lines:string[] = []
  let line = ""
  for(const word of text.split(/(\s+)/)){
    if(fits(line + word)){ line += word; continue }
    if(line.trim()){ lines.push(line.trim()); line = "" }
    // Word wider than the box: split by characters.
    for(const ch of word.trimStart()){
      if(!fits(line + ch)){ lines.push(line); line = "" }
      line += ch
    }
  }
  if(line.trim()) lines.push(line.trim())
  const shown = lines.slice(0, maxLines)
  if(lines.length > shown.length){
    let last = shown[shown.length - 1]
    while(last && !fits(last + "…")) last = last.slice(0, -1)
    shown[shown.length - 1] = last.trimEnd() + "…"
  }
  for(const l of shown){ ctx.fillText(l,x,y); y += lineHeight }
  return y
}

const emojiCache = new Map<string, any>()

async function getEmoji(url:string){
  if(!emojiCache.has(url)){
    emojiCache.set(url, await loadImage(url))
  }
  return emojiCache.get(url)
}

export async function drawStatus(
  ctx:any,
  data:{
    position:string
    duration:string
    volume:number
    loop:string
    loopText:string
    nextSong?:string
  },
  x:number,
  y:number,
  maxWidth:number
){

  const loopIcons: Record<string,string> = {
    none: "https://cdn.discordapp.com/emojis/1399323885710872746.png",
    queue: "https://cdn.discordapp.com/emojis/1399323901619601498.png",
    track: "https://cdn.discordapp.com/emojis/1399323918061535384.png"
  }

  const parts = [
    {
      icon:"https://cdn.discordapp.com/emojis/1398230368921976922.png",
      text:`${data.position}/${data.duration}`
    },
    {
      icon:"https://cdn.discordapp.com/emojis/1399327081355284480.png",
      text:`${data.volume}%`
    },
    {
      icon:loopIcons[data.loop] || loopIcons.none,
      text:data.loopText
    }
  ]

  if(data.nextSong){
    parts.push({
      icon:"https://cdn.discordapp.com/emojis/1399323787203448894.png",
      text:data.nextSong
    })
  }

  let cx = x
  let cy = y

  for(const part of parts){

    const icon = await getEmoji(part.icon)

    const textWidth = ctx.measureText(part.text).width
    const blockWidth = 20 + 6 + textWidth + 20

    if(cx + blockWidth > x + maxWidth){
      cx = x
      cy += 24
    }

    ctx.drawImage(icon,cx,cy-16,18,18)
    cx += 24

    ctx.fillText(part.text,cx,cy)
    cx += textWidth + 20
  }
}

// Static per track: no progress, position, volume or loop here. Those change every few seconds
// and live in the message components instead.
export async function createMusicCard(data:{
  track:any
  duration:string
}){

  const canvas = createCanvas(800,250)
  const ctx = canvas.getContext("2d")

  // Some artwork comes in formats node-canvas cannot read ("Unsupported image type", e.g. AVIF):
  // fall back to the default cover instead of failing the whole card.
  const img = await loadImage(data.track?.thumbnail || "./src/utils/default.png")
    .catch(() => loadImage("./src/utils/default.png"))

  // background cover + blur
  ;(ctx as any).filter = "blur(30px)"
  drawCover(ctx,img,800,250)
  ;(ctx as any).filter = "none"

  // gradient
  const gradient = ctx.createLinearGradient(0,0,800,0)
  gradient.addColorStop(0,"rgba(0,0,0,0.85)")
  gradient.addColorStop(1,"rgba(0,0,0,0.3)")
  ctx.fillStyle = gradient
  ctx.fillRect(0,0,800,250)

  // thumbnail
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(20,20,210,210,20)
  ctx.clip()
  ctx.drawImage(img,20,20,210,210)
  ctx.restore()

  // title
  ctx.fillStyle = "#fff"
  ctx.font = "bold 28px Sans, Noto Sans Thai"
  let y = drawWrapText(ctx,data.track?.title || "unknown",250,55,520,32,2)

  // author
  ctx.fillStyle = "#ccc"
  ctx.font = "20px Sans, Noto Sans Thai"
  y = drawWrapText(ctx,data.track?.author || "unknown",250,y + 2,520,24,1)

  // duration, then requester, below whatever height the title and author took
  ctx.fillStyle = "#ddd"
  ctx.font = "18px Sans, Noto Sans Thai"
  ctx.fillText(data.duration, 250, y + 8)

  ctx.fillStyle = "#fff"
  ctx.font = "18px Sans, Noto Sans Thai"
  drawWrapText(ctx,`Requested by: ${(data.track?.requester as User)?.globalName || (data.track?.requester as User)?.username || "unknown"}`,250,y + 38,520,22,1)

  return canvas.toBuffer("image/png")
}

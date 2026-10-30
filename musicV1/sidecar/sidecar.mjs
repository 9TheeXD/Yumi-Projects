#!/usr/bin/env node
// Music node sidecar. Zero dependencies, Node >= 22.
//
//   node sidecar.mjs watch                         health loop (every SIDECAR_INTERVAL_MS, default 5 min)
//   node sidecar.mjs check                         one health round, prints JSON, exit 1 if any node is down
//   node sidecar.mjs token nodelink <refreshToken> [visitorData]
//   node sidecar.mjs token lavalink <refreshToken|-> [poToken visitorData]
//   node sidecar.mjs releases                      compare pinned versions with upstream, notify
//   node sidecar.mjs update <stackDir> <ENV_VAR> <newValue> [nodeName]
//                                                  edit stack .env, recreate, health check, roll back on failure
//
// Reads ../.env (same file as the bot) plus process env. Docs: ../MUSIC_RESILIENCE.md
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.resolve(here, '../.env'));

const env = (k, d) => process.env[k]?.trim() || d;
const INTERVAL = Number(env('SIDECAR_INTERVAL_MS', 300_000));
const WEBHOOK = env('SIDECAR_WEBHOOK_URL');
const STATE_FILE = path.resolve(here, env('SIDECAR_STATE_FILE', 'sidecar-state.json'));
// Same file the bot reads (bot/src/music/config.ts). The sidecar only adds/removes "youtube" in `disabled`.
const OVERRIDE_FILE = path.resolve(here, env('SIDECAR_CONFIG_FILE') || env('MUSIC_CONFIG_FILE', '../bot/music-sources.json'));
// Fail this many rounds in a row on every node before YouTube is switched off for the bot.
const YT_OFF_AFTER = Number(env('SIDECAR_YT_OFF_AFTER', 2));

// Test probes. Keep them few: every probe is a real request to the source.
// The YouTube probe is a label music video on purpose: from a flagged IP, non-music videos still
// play while most music asks "Sign in to confirm you're not a bot".
const PROBES = [
  // Search by id: Lavalink cannot load a video URL with OAuth (see loadYoutubeById in the bot resolver).
  { source: 'youtube', id: env('SIDECAR_YT_PROBE', 'ytsearch:ff7ao5s0heQ') },
  { source: 'soundcloud', id: env('SIDECAR_SC_PROBE', 'scsearch:lofi chill beat'), manager: 'soundcloud' },
  // Plain HTTP file: every node has it, so the update health check has a non-YouTube source on Lavalink too.
  { source: 'http', id: env('SIDECAR_HTTP_PROBE', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'), manager: 'http' },
  // Catalog sources (metadata only, audio comes from YouTube): search check only, no stream check,
  // so they add no YouTube traffic. A node without the source manager (no key yet) reports "off".
  { source: 'spotify', id: env('SIDECAR_SP_PROBE', 'spsearch:Bodyslam ความเชื่อ'), manager: 'spotify', catalog: true },
  { source: 'applemusic', id: env('SIDECAR_AM_PROBE', 'amsearch:Bodyslam ความเชื่อ'), manager: 'applemusic', catalog: true },
  { source: 'deezer', id: env('SIDECAR_DZ_PROBE', 'dzsearch:Bodyslam ความเชื่อ'), manager: 'deezer', catalog: true },
];
// Real playback results written by soak-client.mjs (alternates nodes track by track).
// Fresher than SOAK_MAX_AGE_MS they win over load-level checks.
const SOAK_FILE = path.resolve(here, env('SIDECAR_SOAK_FILE', 'soak-status.json'));
// Long enough for the soak to cycle through every node; a missing fresh result must not flip a
// node back to the (weaker) load-level verdict and send a false "works again".
const SOAK_MAX_AGE_MS = Number(env('SIDECAR_SOAK_MAX_AGE_MS', 6 * 3600_000));
// Optional real playback through Discord voice (sidecar/voiceprobe.mjs) every N rounds.
// It is the only real playback check for Lavalink, which has no stream endpoint.
const VOICE_GUILD = env('SIDECAR_VOICE_GUILD');
const VOICE_CHANNEL = env('SIDECAR_VOICE_CHANNEL');
const VOICE_EVERY = Number(env('SIDECAR_VOICE_EVERY', 6));
// Sidecar runs as a normal user; set SIDECAR_DOCKER="sudo -n docker" if it is not in the docker group.
const DOCKER = env('SIDECAR_DOCKER', 'docker').split(' ');
// Container memory watch (leaks). Comma list of container names, empty = off.
const CONTAINERS = env('SIDECAR_CONTAINERS', '').split(',').map(s => s.trim()).filter(Boolean);
const MEM_ALERT_PCT = Number(env('SIDECAR_MEM_ALERT_PCT', 85));
// One JSON line per round, for soak tests (RAM over 24h, flapping sources). Rotated at 5 MB.
const HISTORY_FILE = path.resolve(here, env('SIDECAR_HISTORY_FILE', 'sidecar-history.jsonl'));

// SIDECAR_NODELINK_HOST etc. win over the bot's NODELINK_HOST, so the sidecar can watch other nodes than prod uses.
const nodeEnv = k => env(`SIDECAR_${k}`) || env(k);
// Same registry as the bot (bot/src/music/nodes.ts): MUSIC_NODES = NODELINK,NODELINK2,LAVALINK,...
const NODES = env('MUSIC_NODES', 'NODELINK,LAVALINK').split(',').map(s => s.trim()).filter(Boolean).map(name => ({
  name,
  kind: env(`${name}_KIND`) || (name.includes('NODELINK') ? 'nodelink' : 'lavalink'),
  host: nodeEnv(`${name}_HOST`),
  pass: nodeEnv(`${name}_PASS`),
  secure: nodeEnv(`${name}_SECURE`) === 'true',
  stack: env(`${name}_STACK`),
  service: env(`${name}_SERVICE`),
})).filter(n => n.host);
// Alerts go through the music bot (YMm_V1) when set, so they can carry buttons ("ytlogin:<NODE>" is handled
// by bot/src/commands/nodeLogin.ts). Plain webhooks cannot have interactive buttons.
const ALERT_CHANNEL = env('SIDECAR_CHANNEL_ID');
// Default: the music bot (YMm_V1, BOT_TOKEN_M). SIDECAR_BOT_TOKEN_VAR names another variable in .env.
// Role pinged on warn/error alerts (not on ok/info), e.g. the dev team.
const MENTION_ROLE = env('SIDECAR_MENTION_ROLE');
// While a problem stays (node down, YouTube broken on a node), repeat the alert this often.
const REMIND_MS = Number(env('SIDECAR_REMIND_HOURS', 3)) * 3600_000;
const ALERT_BOT_TOKEN = env('SIDECAR_BOT_TOKEN') || env(env('SIDECAR_BOT_TOKEN_VAR', 'BOT_TOKEN_M'));

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const base = n => `${n.secure ? 'https' : 'http'}://${n.host}`;

async function call(n, method, p, body) {
  const r = await fetch(base(n) + p, {
    method,
    headers: { Authorization: n.pass ?? '', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, ok: r.ok, json, text };
}

// NodeLink only: ask for the stream URL. Search and even track loads succeed from a blocked IP,
// the stream is what fails. `newTrack` means NodeLink fell back to another source.
async function streamCheck(n, encoded) {
  const r = await call(n, 'GET', `/v4/trackstream?encodedTrack=${encodeURIComponent(encoded)}`);
  if (r.status === 404) return null; // endpoint disabled
  if (!r.ok) return { ok: false, error: r.json?.message || `trackstream ${r.status}` };
  if (r.json?.newTrack) return { ok: false, error: `fallback to ${r.json.newTrack.info?.sourceName || 'other source'}` };
  return { ok: !!r.json?.url, error: r.json?.url ? undefined : 'no stream url', format: r.json?.format };
}

async function probeNode(n) {
  const out = { name: n.name, kind: n.kind, up: false, version: null, sources: {}, error: null };
  try {
    const t0 = Date.now();
    const v = await call(n, 'GET', '/version');
    out.pingMs = Date.now() - t0;
    if (!v.ok) throw new Error(`/version ${v.status}`);
    out.version = v.text.trim();
    out.up = true;
  } catch (e) {
    out.error = e.message;
    return out;
  }
  let managers = null;
  try { managers = (await call(n, 'GET', '/v4/info')).json?.sourceManagers ?? null; } catch {}
  for (const p of PROBES) {
    // Not on this node: catalog sources wait for a key, so show them as "off"; other sources are simply not shipped.
    if (p.manager && managers && !managers.includes(p.manager)) {
      if (p.catalog) out.sources[p.source] = { ok: false, off: true, error: 'not enabled on this node' };
      continue;
    }
    try {
      const r = await call(n, 'GET', `/v4/loadtracks?identifier=${encodeURIComponent(p.id)}`);
      const t = r.json?.loadType;
      const data = t === 'track' ? r.json.data : t === 'search' ? r.json.data[0] : t === 'playlist' ? r.json.data.tracks?.[0] : null;
      if (!data) {
        out.sources[p.source] = { ok: false, error: r.json?.data?.message || r.json?.exception?.message || `${r.status} ${t ?? ''}`.trim() };
        continue;
      }
      out.sources[p.source] = { ok: true, level: 'load' };
      if (n.kind === 'nodelink' && !p.catalog) {
        const s = await streamCheck(n, data.encoded);
        if (s) out.sources[p.source] = { ...s, level: 'stream' };
      }
    } catch (e) {
      out.sources[p.source] = { ok: false, error: e.message };
    }
  }
  return out;
}

// Plays the YouTube probe on every node through Discord voice. Returns { NODE: {ok, error} }.
function voiceCheck() {
  const nodes = NODES.map(n => ({ name: n.name, url: n.host, auth: n.pass, secure: n.secure }));
  try {
    const outText = execFileSync(process.execPath, [path.join(here, 'voiceprobe.mjs'), VOICE_GUILD, VOICE_CHANNEL, '12', PROBES[0].id], {
      env: { ...process.env, PROBE_NODES: JSON.stringify(nodes), PROBE_JSON: '1' },
      timeout: 180_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const json = outText.trim().split('\n').pop();
    return Object.fromEntries(JSON.parse(json).map(r => [r.node, { ok: r.ok, error: r.ok ? undefined : `${r.stage}: ${r.msg}`, level: 'voice' }]));
  } catch (e) {
    console.error('[sidecar] voice probe failed:', e.message);
    return {};
  }
}

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// --- notifications (Discord Components V2 through the webhook) -------------

const LEVELS = {
  ok: { emoji: '🟢', color: 0x57f287 },
  warn: { emoji: '🟡', color: 0xfee75c },
  error: { emoji: '🔴', color: 0xed4245 },
  info: { emoji: '🔵', color: 0x5865f2 },
};
const SOURCE_TH = { youtube: 'YouTube', soundcloud: 'SoundCloud', http: 'ไฟล์เสียงทั่วไป (http)', spotify: 'Spotify', applemusic: 'Apple Music', deezer: 'Deezer' };
const sourceTh = s => SOURCE_TH[s] || s;

// Raw node errors -> one Thai sentence. The raw text still goes in a small line for debugging.
function explain(err = '') {
  const e = String(err);
  if (/sign in|login|not a bot/i.test(e)) return 'YouTube ขอให้ login (บัญชี burner หมดอายุ หรือ IP โดนสงสัยว่าเป็นบอท)';
  if (/fallback to/i.test(e)) return `YouTube เล่นไม่ได้ NodeLink เลยไปเล่นจาก ${e.replace(/.*fallback to /i, '')} แทน`;
  if (/ECONNREFUSED|ECONNRESET|socket hang up|closed before/i.test(e)) return 'เชื่อมต่อ node ไม่ได้ (container ไม่ได้รันหรือกำลังรีสตาร์ท)';
  if (/\b(401|403)\b/.test(e)) return 'รหัสผ่านของ node ไม่ตรง';
  if (/timeout|aborted/i.test(e)) return 'node ไม่ตอบภายในเวลาที่กำหนด';
  if (/stalled|stuck|no progress/i.test(e)) return 'เพลงค้าง ตำแหน่งเพลงไม่เดิน';
  if (/preview/i.test(e)) return 'ได้แค่คลิปตัวอย่าง 30 วินาที';
  if (/not found|manifest unknown|failed to resolve reference/i.test(e)) return 'ดึง image ไม่ได้ (ไม่มีเวอร์ชันนี้)';
  if (/not healthy/i.test(e)) return 'หลังอัปเดต node ไม่ผ่านการตรวจ (ไม่ขึ้น หรือเล่นแหล่งทดสอบไม่ได้)';
  return '';
}

function since(first) {
  if (!first) return '';
  const h = Math.floor((Date.now() - first) / 3600_000);
  const m = Math.floor((Date.now() - first) / 60_000) % 60;
  return `-# เป็นแบบนี้มาแล้ว ${h ? `${h} ชม. ` : ''}${m} นาที`;
}

function rawLine(err) {
  if (!err) return '';
  const t = String(err).replace(/\s+/g, ' ').replace(/`/g, "'").slice(0, 300);
  return `-# รายละเอียด: \`${t}\``;
}

const time = () => new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'medium' });

/**
 * @param {'ok'|'warn'|'error'|'info'} level
 * @param {string} title  one line, Thai
 * @param {string[]} lines  body lines (markdown), empty ones are dropped
 */
const loginButton = name => ({ type: 2, style: 1, custom_id: `ytlogin:${name}`, label: `สร้างรหัส login ใหม่ให้ ${name}`, emoji: { name: '🔑' } });

/**
 * @param {'ok'|'warn'|'error'|'info'} level
 * @param {string} title  one line, Thai
 * @param {string[]} lines  body lines (markdown), empty ones are dropped
 * @param {{ loginNodes?: string[] }} [opts]  adds a login button per node (needs SIDECAR_CHANNEL_ID)
 */
async function notify(level, title, lines = [], opts = {}) {
  const L = LEVELS[level] || LEVELS.info;
  const body = lines.filter(Boolean).join('\n');
  console.log(`[sidecar] ${L.emoji} ${title}${body ? ' | ' + body.replace(/\n/g, ' | ') : ''}`);
  const buttons = (opts.loginNodes || []).map(loginButton);
  const ping = !!MENTION_ROLE && (level === 'warn' || level === 'error');
  const allowed_mentions = ping ? { parse: [], roles: [MENTION_ROLE] } : { parse: [] };
  const components = [{
    type: 17, // container
    accent_color: L.color,
    components: [
      ...(ping ? [{ type: 10, content: `<@&${MENTION_ROLE}>` }] : []),
      { type: 10, content: `### ${L.emoji} ${title}` },
      ...(body ? [{ type: 10, content: body.slice(0, 3500) }] : []),
      ...(buttons.length && ALERT_CHANNEL ? [{ type: 1, components: buttons.slice(0, 5) }] : []),
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: `-# ระบบเฝ้าดูเพลง • ${time()}` },
    ],
  }];
  await postComponents(components, allowed_mentions);
}

// Posts a Components V2 message: through the music bot (buttons work) or, failing that, the webhook.
async function postComponents(components, allowed_mentions = { parse: [] }) {
  if (ALERT_CHANNEL && ALERT_BOT_TOKEN) {
    try {
      const r = await fetch(`https://discord.com/api/v10/channels/${ALERT_CHANNEL}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bot ${ALERT_BOT_TOKEN}` },
        body: JSON.stringify({ flags: 1 << 15, components, allowed_mentions }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) return;
      console.error('[sidecar] bot post failed, using webhook:', r.status, (await r.text()).slice(0, 300));
    } catch (e) {
      console.error('[sidecar] bot post failed, using webhook:', e.message);
    }
  }
  if (!WEBHOOK) return;
  try {
    const url = WEBHOOK + (WEBHOOK.includes('?') ? '&' : '?') + 'with_components=true';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Yumi Music Sidecar', flags: 1 << 15, components, allowed_mentions }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) console.error('[sidecar] webhook failed:', r.status, (await r.text()).slice(0, 300));
  } catch (e) {
    console.error('[sidecar] webhook failed:', e.message);
  }
}

function setYoutubeDisabled(off) {
  const cfg = readJson(OVERRIDE_FILE, {});
  const disabled = new Set(cfg.disabled || []);
  const was = disabled.has('youtube');
  if (off === was) return false;
  off ? disabled.add('youtube') : disabled.delete('youtube');
  cfg.disabled = [...disabled];
  writeJson(OVERRIDE_FILE, cfg);
  return true;
}

function containerStats() {
  if (!CONTAINERS.length) return {};
  try {
    const out = execFileSync(DOCKER[0], [...DOCKER.slice(1), 'stats', '--no-stream', '--format', '{{.Name}}\t{{.MemPerc}}\t{{.MemUsage}}', ...CONTAINERS],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return Object.fromEntries(out.trim().split('\n').filter(Boolean).map(l => {
      const [name, pct, usage] = l.split('\t');
      return [name, { memPct: parseFloat(pct), mem: usage.split(' / ')[0] }];
    }));
  } catch (e) {
    console.error('[sidecar] docker stats failed:', e.message);
    return {};
  }
}

function appendHistory(entry) {
  try {
    if (fs.existsSync(HISTORY_FILE) && fs.statSync(HISTORY_FILE).size > 5 * 1024 * 1024) fs.renameSync(HISTORY_FILE, `${HISTORY_FILE}.1`);
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

// Crash-level lines in node container logs since the last round. These do not always show in the
// probes (a NodeLink worker restarts in a second) but every player on it stops.
const LOG_PATTERNS = {
  nodelink: /Uncaught Exception|Worker.?Crash|Worker \d+ failed|unhandledRejection|FATAL|out of memory/i,
  lavalink: /OutOfMemoryError|Exception in thread|FATAL|Application run failed/,
};
const containerOf = n => env(`${n.name}_CONTAINER`) || `yumi_${n.name.toLowerCase()}`;
function nodeLogErrors(n, sinceSec) {
  try {
    const out = execFileSync(DOCKER[0], [...DOCKER.slice(1), 'logs', '--since', `${sinceSec}s`, containerOf(n)],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const re = LOG_PATTERNS[n.kind];
    return out.split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, '')).filter(l => re?.test(l));
  } catch { return []; }
}

function tokenFingerprint(n) {
  const v = env(`${n.name}_TOKEN_VAR`);
  if (!n.stack || !v) return null;
  try {
    const m = fs.readFileSync(path.join(n.stack, '.env'), 'utf8').match(new RegExp(`^\\s*${v}\\s*=(.*)$`, 'm'));
    return createHash('sha256').update((m?.[1] || '').trim()).digest('hex').slice(0, 12);
  } catch { return null; }
}

let roundNo = 0;
async function round() {
  const alerted = new Set();
  const results = await Promise.all(NODES.map(probeNode));
  const prev = readJson(STATE_FILE, { nodes: {}, ytFailRounds: 0 });
  const next = { at: new Date().toISOString(), nodes: {}, ytFailRounds: prev.ytFailRounds };

  // Voice result wins over load-level results. Between voice rounds keep the last voice verdict
  // for nodes that can only be checked at load level (Lavalink).
  // A failed voice verdict is re-checked every round, so one bad round (node restart) does not stick.
  const voiceFailed = Object.values(prev.nodes || {}).some(n => n.sources?.youtube?.level === 'voice' && !n.sources.youtube.ok);
  const voiceDue = roundNo++ % VOICE_EVERY === 0 || voiceFailed;
  const voice = VOICE_GUILD && VOICE_CHANNEL && voiceDue ? voiceCheck() : null;
  for (const r of results) {
    if (!r.up) continue;
    const v = voice?.[r.name] ?? (VOICE_GUILD && r.sources.youtube?.level === 'load' && prev.nodes[r.name]?.sources?.youtube?.level === 'voice' ? prev.nodes[r.name].sources.youtube : null);
    if (v) r.sources.youtube = v;
    // Soak playback is the strongest signal we have: a real song played to the end in voice.
    // A new burner token (login button) makes older playback results meaningless.
    const nodeDef = NODES.find(x => x.name === r.name);
    r.tokenFp = nodeDef ? tokenFingerprint(nodeDef) : null;
    const prevNode = prev.nodes?.[r.name];
    const tokenChanged = prevNode && 'tokenFp' in prevNode && prevNode.tokenFp !== r.tokenFp;
    r.tokenChangedAt = tokenChanged ? Date.now() : (prevNode?.tokenChangedAt ?? 0);
    const soak = readJson(SOAK_FILE, {})[r.name] || {};
    for (const [src, res] of Object.entries(soak)) {
      // Only sources we probe; "voice" etc. are problems of the test client itself.
      if (!PROBES.some(p => p.source === src)) continue;
      if (Date.parse(res.at) < r.tokenChangedAt) continue;
      if (Date.now() - Date.parse(res.at) > SOAK_MAX_AGE_MS) continue;
      const cur = r.sources[src];
      // A passing soak song does not clear a failed stream check: some videos play without login,
      // so one good song says less than NodeLink falling back to another source.
      if (res.ok && cur && !cur.ok && cur.level === 'stream') continue;
      if (!cur || cur.level !== 'voice') r.sources[src] = { ok: res.ok, error: res.error ? `soak: ${res.error}` : undefined, level: 'soak' };
    }
    // Lavalink finds YouTube songs even without a working account, so a load-level "ok" must not
    // clear a failure seen in real playback. Only a new real playback result clears it.
    const before = prev.nodes?.[r.name]?.sources?.youtube;
    const now = r.sources.youtube;
    if (!tokenChanged && now?.ok && now.level === 'load' && before && !before.ok && ['soak', 'voice', 'stream'].includes(before.level)) r.sources.youtube = before;
  }

  for (const r of results) {
    const was = prev.nodes[r.name];
    next.nodes[r.name] = r;
    if (was && was.up !== r.up) {
      if (r.up) await notify('ok', `${r.name} กลับมาทำงานแล้ว`, [`เวอร์ชัน \`${r.version}\``]);
      else alerted.add(`down:${r.name}`), await notify('error', `${r.name} ล่ม`, [explain(r.error) || 'node ไม่ตอบ', 'บอทจะย้ายเพลงไป node อื่นเอง', rawLine(r.error)]);
    }
    for (const [src, s] of Object.entries(r.sources)) {
      const wasOk = was?.sources?.[src]?.ok;
      // "off" (no key yet) is not a failure: no alert when a source is off or turns off.
      if (s.off || (was?.sources?.[src]?.off && !s.ok)) continue;
      if (wasOk !== undefined && wasOk !== s.ok) {
        if (s.ok) await notify('ok', `${sourceTh(src)} บน ${r.name} ใช้ได้อีกครั้ง`);
        else alerted.add(`${src === 'youtube' ? 'yt' : src}:${r.name}`), await notify('warn', `${sourceTh(src)} บน ${r.name} ใช้ไม่ได้`, [explain(s.error), rawLine(s.error)], src === 'youtube' ? { loginNodes: [r.name] } : {});
      }
    }
    const yt = r.sources.youtube;
    if (yt && !yt.ok && /sign in|login|bot/i.test(yt.error || '') && !/sign in|login|bot/i.test(was?.sources?.youtube?.error || '')) {
      await notify('error', `${r.name}: YouTube ขอให้ login`, [
        'token ของบัญชี burner อาจหมดอายุ หรือ IP โดนสงสัยว่าเป็นบอท',
        '**ต้องทำ:** กดปุ่มด้านล่าง แล้ว login **บัญชี burner** (บัญชีใหม่ถ้าบัญชีเดิมโดนบล็อก)',
      ], { loginNodes: [r.name] });
    }
  }

  const upNodes = results.filter(r => r.up);
  const ytOk = upNodes.some(r => r.sources.youtube?.ok);
  next.ytFailRounds = upNodes.length && !ytOk ? prev.ytFailRounds + 1 : 0;
  if (next.ytFailRounds >= YT_OFF_AFTER && setYoutubeDisabled(true)) {
    await notify('error', 'ปิด YouTube ในบอทชั่วคราว', [`YouTube ใช้ไม่ได้ทุก node ${next.ytFailRounds} รอบติดกัน`, 'บอทจะใช้แหล่งอื่นแทน และเปิดคืนเองเมื่อ YouTube กลับมา'], { loginNodes: upNodes.map(r => r.name) });
  }
  if (ytOk && setYoutubeDisabled(false)) {
    await notify('ok', 'เปิด YouTube ให้บอทใช้อีกครั้ง', ['YouTube กลับมาใช้ได้แล้ว']);
  }

  // Reminders for problems that are still there. The first alert came from the transition checks
  // above (or never, for a node added while broken); repeat every REMIND_MS until fixed.
  const reminders = {};
  const now = Date.now();
  for (const r of results) {
    const issues = [];
    if (!r.up) issues.push([`down:${r.name}`, () => notify('error', `ยังล่มอยู่: ${r.name}`, [explain(r.error) || 'node ไม่ตอบ', since(prev.reminders?.[`down:${r.name}`]?.first), rawLine(r.error)])]);
    else if (r.sources.youtube && !r.sources.youtube.ok) {
      const e = r.sources.youtube.error;
      issues.push([`yt:${r.name}`, () => notify('error', `YouTube บน ${r.name} ยังใช้ไม่ได้`, [
        explain(e) || 'YouTube เล่นไม่ได้', since(prev.reminders?.[`yt:${r.name}`]?.first),
        '**ต้องทำ:** กดปุ่มด้านล่าง แล้ว login **บัญชี burner** ให้ node นี้ (บัญชีใหม่ถ้าบัญชีเดิมโดนบล็อก)', rawLine(e),
      ], { loginNodes: [r.name] })]);
    }
    for (const [key, send] of issues) {
      const old = prev.reminders?.[key];
      // A brand new issue that just got its transition alert waits REMIND_MS; one that never got an
      // alert (node added while broken, sidecar restarted) is sent now.
      let last = old?.last ?? (alerted.has(key) ? now : 0);
      if (now - last >= REMIND_MS) { await send(); last = now; }
      reminders[key] = { first: old?.first ?? now, last };
    }
  }
  next.reminders = reminders;

  // Node crashes from the container logs. One alert per node per round, first lines only.
  const sinceSec = Math.max(60, Math.round((Date.now() - (Date.parse(prev.at) || Date.now() - INTERVAL)) / 1000) + 5);
  for (const n of NODES) {
    const lines = nodeLogErrors(n, sinceSec);
    if (!lines.length) continue;
    const uniq = [...new Set(lines.map(l => l.replace(/^\[[^\]]*\]\s*/, '').replace(/^\S+\s+\S+\s+\d+ --- \[[^\]]*\] \[[^\]]*\]\s*/, '').slice(0, 200)))];
    await notify('error', `${n.name} มี error ร้ายแรงใน log`, [
      `${lines.length} บรรทัดในรอบนี้ (ตั้งแต่ ${Math.round(sinceSec / 60)} นาทีก่อน)`,
      'เพลงที่เล่นอยู่บน node นี้อาจหลุด ให้ดู log: `sudo docker logs ' + containerOf(n) + '`',
      ...uniq.slice(0, 3).map(rawLine),
    ]);
  }

  next.containers = containerStats();
  for (const [name, c] of Object.entries(next.containers)) {
    const wasHigh = (prev.containers?.[name]?.memPct ?? 0) >= MEM_ALERT_PCT;
    if (c.memPct >= MEM_ALERT_PCT && !wasHigh) await notify('warn', `${name} ใช้ RAM สูง`, [`ใช้ไป **${c.memPct}%** ของที่กำหนด (${c.mem})`, 'อาจมี memory leak ถ้าเต็ม container จะรีสตาร์ทเอง']);
  }
  appendHistory({
    at: next.at,
    nodes: Object.fromEntries(results.map(r => [r.name, { up: r.up, ...Object.fromEntries(Object.entries(r.sources).map(([k, v]) => [k, v.ok])) }])),
    containers: next.containers,
  });

  writeJson(STATE_FILE, { ...prev, ...next });
  return results;
}

async function setToken(kind, refreshToken, a, b) {
  const n = NODES.find(x => x.kind === kind);
  if (!n) throw new Error(`no ${kind} node configured`);
  const rt = refreshToken && refreshToken !== '-' ? refreshToken : undefined;
  if (kind === 'nodelink') {
    const r = await call(n, 'PATCH', '/v4/youtube/config', { refreshToken: rt, visitorData: a });
    if (!r.ok) throw new Error(`PATCH failed ${r.status}: ${r.text}`);
    const check = await call(n, 'GET', '/v4/youtube/config?validate=true');
    console.log(JSON.stringify(check.json, null, 2));
  } else {
    const body = { ...(rt ? { refreshToken: rt, skipInitialization: true } : {}), ...(a ? { poToken: a, visitorData: b } : {}) };
    const r = await call(n, 'POST', '/youtube', body);
    if (!r.ok) throw new Error(`POST /youtube failed ${r.status}: ${r.text}`);
    console.log('ok');
  }
}

// --- daily report ----------------------------------------------------------

// Daily status card per node, like the main bot's "Yumi Status" report.
// SIDECAR_REPORT_TIME is Bangkok time (HH:MM), default 19:00. Empty = off.
const REPORT_TIME = env('SIDECAR_REPORT_TIME', '19:00');
const MENTION = MENTION_ROLE ? `<@&${MENTION_ROLE}>` : '';

const tsTag = (ms, f = 'f') => `<t:${Math.floor(ms / 1000)}:${f}>`;
const row = (label, value) => `${value == null ? '-# ' : ''}- **${label}**: ${value ?? 'N/A'}`;

// Two largest units, like the main bot: "15 วัน 4 ชม.", "38 นาที 57 วิ", "3 วิ".
function durTh(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const parts = [[Math.floor(sec / 86400), 'วัน'], [Math.floor(sec % 86400 / 3600), 'ชม.'], [Math.floor(sec % 3600 / 60), 'นาที'], [sec % 60, 'วิ']];
  const i = parts.findIndex(([v]) => v > 0);
  if (i < 0) return '0 วิ';
  return parts.slice(i, i + 2).filter(([v]) => v > 0).map(([v, u]) => `${v} ${u}`).join(' ');
}

function containerInfo(name) {
  try {
    const out = execFileSync(DOCKER[0], [...DOCKER.slice(1), 'inspect', '-f', '{{.State.StartedAt}}|{{.RestartCount}}|{{.Config.Image}}', name],
      { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const [started, restarts, image] = out.split('|');
    return { startedAt: Date.parse(started), restarts: Number(restarts), image };
  } catch { return null; }
}

function containerUsage(name) {
  try {
    const out = execFileSync(DOCKER[0], [...DOCKER.slice(1), 'stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}', name],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const [cpu, mem, memPct] = out.split('|');
    // "247.3MiB / 1.5GiB" -> "247.30 MB / 1.50 GB" like the main bot's report.
    const fmt = v => { const m = v.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/); if (!m) return v.trim();
      const unit = { B: 'B', KiB: 'KB', MiB: 'MB', GiB: 'GB', TiB: 'TB', kB: 'KB', MB: 'MB', GB: 'GB' }[m[2]] || m[2];
      return `${Number(m[1]).toFixed(2)} ${unit}`; };
    return { cpu, mem: mem.split('/').map(fmt).join(' / '), memPct, raw: mem };
  } catch { return null; }
}

// Availability over the last 24 h from sidecar-history.jsonl (one line per 5-minute round).
function history24(name) {
  const since = Date.now() - 86_400_000;
  let rounds = 0, up = 0, yt = 0, ytRounds = 0, lastDown = null, downStart = null;
  try {
    for (const line of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
      if (!line) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const at = Date.parse(d.at), n = d.nodes?.[name];
      if (!n) continue;
      if (!n.up && downStart === null) downStart = at;
      if (n.up && downStart !== null) { lastDown = { start: downStart, end: at }; downStart = null; }
      if (at < since) continue;
      rounds++; if (n.up) up++;
      if (n.youtube !== undefined) { ytRounds++; if (n.youtube) yt++; }
    }
  } catch {}
  const pct = (a, b) => b ? `${(a / b * 100).toFixed(1)}%` : null;
  return { uptime: pct(up, rounds), youtube: pct(yt, ytRounds), lastDown, downSince: downStart };
}

function burnerSet(n) {
  if (!n.stack || !env(`${n.name}_TOKEN_VAR`)) return null;
  try {
    const m = fs.readFileSync(path.join(n.stack, '.env'), 'utf8').match(new RegExp(`^\\s*${env(`${n.name}_TOKEN_VAR`)}\\s*=(.*)$`, 'm'));
    const v = (m?.[1] || '').trim();
    return !!v && v !== '[""]' && v !== '[]';
  } catch { return null; }
}

const srcIcon = s => !s ? '⚪ ไม่มี' : s.ok ? '🟢 ใช้ได้' : '🔴 ใช้ไม่ได้';

async function nodeCard(n, r) {
  const stats = r.up ? (await call(n, 'GET', '/v4/stats').catch(() => null))?.json : null;
  const c = containerInfo(containerOf(n));
  const u = containerUsage(containerOf(n));
  const h = history24(n.name);
  const state = !r.up ? 'down' : r.sources.youtube && !r.sources.youtube.ok ? 'warn' : 'up';
  // Same rows and wording as the main bot's "Yumi Status" (status/src/send.ts), plus Player and YouTube.
  const L = [];
  L.push(state === 'up' ? '**:green_circle:  กำลังทำงาน**' : state === 'warn' ? '**:yellow_circle:  กำลังทำงาน (YouTube ใช้ไม่ได้)**' : '**:red_circle:  หยุดทำงาน**');
  if (!r.up) L.push(row('สาเหตุ', explain(r.error) || r.error || 'ไม่ทราบสาเหตุ'));
  if (r.up) {
    L.push(row('Uptime', c?.startedAt ? durTh(Date.now() - c.startedAt) : null));
    L.push(h.lastDown ? row('Downtime ล่าสุด', `${durTh(h.lastDown.end - h.lastDown.start)} (${tsTag(h.lastDown.end, 'R')})`) : '- **Downtime ล่าสุด**: ยังไม่เคยล่มตั้งแต่เริ่มบันทึก');
  } else {
    L.push(row('Downtime', h.downSince ? `${durTh(Date.now() - h.downSince)} (ตั้งแต่ ${tsTag(h.downSince, 'R')})` : null));
  }
  L.push(row('Ping', typeof r.pingMs === 'number' ? `${r.pingMs} ms` : null));
  L.push(row('CPU', u?.cpu ?? null));
  L.push(row('หน่วยความจำ', u ? `${u.mem} \`(${u.memPct})\`` : null));
  L.push(row('Player', stats ? `${stats.playingPlayers} กำลังเล่น / ${stats.players} ทั้งหมด` : null));
  const burner = burnerSet(n);
  L.push(row('YouTube', `${r.sources.youtube?.ok ? 'ใช้ได้' : 'ใช้ไม่ได้'}${burner === false ? ' (ยังไม่มีบัญชี burner)' : ''}`));
  const color = state === 'up' ? 0x32cd32 : state === 'warn' ? 0xfee75c : 0xff4c4c;
  return { state, card: {
    type: 17, accent_color: color,
    components: [
      { type: 10, content: `## ${n.name}` },
      { type: 10, content: L.join('\n') },
      ...(state !== 'up' || burner === false ? [{ type: 1, components: [loginButton(n.name)] }] : []),
    ],
  } };
}

async function report() {
  const results = await Promise.all(NODES.map(probeNode));
  // Source verdicts from the last round include real playback (soak), which a fresh probe does not.
  const st = readJson(STATE_FILE, {});
  if (Date.now() - Date.parse(st.at || 0) < 15 * 60_000) {
    for (const r of results) if (r.up && st.nodes?.[r.name]?.sources) r.sources = st.nodes[r.name].sources;
  }
  const cards = [];
  for (const n of NODES) cards.push(await nodeCard(n, results.find(r => r.name === n.name)));
  const anyDown = cards.some(c => c.state === 'down');
  const now = Date.now();
  const components = [
    { type: 10, content: `${anyDown && MENTION ? `${MENTION}\n` : ''}# Yumi Music Status` },
    { type: 10, content: `รายงานสถานะ node เพลงประจำวัน\n-# ${tsTag(now)}` },
    ...cards.map(c => c.card),
  ];
  await postComponents(components, anyDown && MENTION_ROLE ? { parse: [], roles: [MENTION_ROLE] } : { parse: [] });
  console.log(`[sidecar] daily report sent (${cards.map(c => c.state).join(', ')})`);
}

// Bangkok "YYYY-MM-DD HH:MM" without depending on the host timezone.
function bangkokNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

async function maybeReport() {
  if (!REPORT_TIME) return;
  const { date, time } = bangkokNow();
  const st = readJson(STATE_FILE, {});
  if (time < REPORT_TIME || st.reportSentDate === date) return;
  await report();
  writeJson(STATE_FILE, { ...readJson(STATE_FILE, {}), reportSentDate: date });
}

// --- status endpoint for the status site ----------------------------------

// GET /status -> JSON with every node (read by /home/yumi/status, which runs in Docker).
// Listens on the docker0 address only (host.docker.internal from containers), never public.
const HTTP_HOST = env('SIDECAR_HTTP_HOST', '10.0.0.1');
const HTTP_PORT = Number(env('SIDECAR_HTTP_PORT', 30065));

function parseBytes(v) {
  const m = String(v).trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return null;
  const k = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()] ?? 1;
  return Math.round(Number(m[1]) * k);
}

const usageCache = new Map();
function usageCached(name) {
  const c = usageCache.get(name);
  if (c && Date.now() - c.at < 30_000) return c.v;
  const u = containerUsage(name);
  const v = u ? {
    cpu: parseFloat(u.cpu) || 0,
    memUsed: parseBytes(u.raw?.split('/')[0] ?? ''),
    memTotal: parseBytes(u.raw?.split('/')[1] ?? ''),
    memPercent: parseFloat(u.memPct) || 0,
  } : null;
  usageCache.set(name, { at: Date.now(), v });
  return v;
}

let snapshot = { at: 0, body: null, running: null };
async function buildSnapshot() {
  const results = await Promise.all(NODES.map(probeNode));
  const st = readJson(STATE_FILE, {});
  const fresh = Date.now() - Date.parse(st.at || 0) < 15 * 60_000;
  const nodes = [];
  for (const n of NODES) {
    const r = results.find(x => x.name === n.name);
    if (r.up && fresh && st.nodes?.[n.name]?.sources) r.sources = st.nodes[n.name].sources;
    const stats = r.up ? (await call(n, 'GET', '/v4/stats').catch(() => null))?.json : null;
    const c = containerInfo(containerOf(n));
    const u = usageCached(containerOf(n));
    const h = history24(n.name);
    nodes.push({
      name: n.name, kind: n.kind, up: r.up,
      error: r.up ? null : r.error, errorTh: r.up ? null : (explain(r.error) || null),
      pingMs: r.pingMs ?? null, version: r.version ?? null,
      startedAt: c?.startedAt ?? null, restarts: c?.restarts ?? null, image: c?.image ?? null,
      players: stats?.players ?? null, playingPlayers: stats?.playingPlayers ?? null,
      nodeUptimeMs: stats?.uptime ?? null,
      cpu: u?.cpu ?? null, mem: u ? { used: u.memUsed, total: u.memTotal, percent: u.memPercent } : null,
      sources: Object.fromEntries(Object.entries(r.sources || {}).map(([k, v]) => [k, { ok: !!v.ok, off: !!v.off, level: v.level ?? null, error: v.error ?? null, errorTh: v.ok || v.off ? null : (explain(v.error) || null) }])),
      burner: burnerSet(n),
      history24: { uptime: h.uptime, youtube: h.youtube },
      lastDown: h.lastDown,
    });
  }
  return { at: Date.now(), up: nodes.filter(x => x.up).length, total: nodes.length, nodes };
}

async function getSnapshot() {
  if (snapshot.body && Date.now() - snapshot.at < 10_000) return snapshot.body;
  if (!snapshot.running) snapshot.running = buildSnapshot().then(b => { snapshot = { at: Date.now(), body: b, running: null }; return b; })
    .catch(e => { snapshot.running = null; throw e; });
  return snapshot.running;
}

async function startHttp() {
  const http = await import('node:http');
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/status')) { res.writeHead(404).end(); return; }
    try {
      const body = JSON.stringify(await getSnapshot());
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
    }
  });
  server.on('error', e => console.error('[sidecar] http:', e.message));
  server.listen(HTTP_PORT, HTTP_HOST, () => console.log(`[sidecar] status endpoint http://${HTTP_HOST}:${HTTP_PORT}/status`));
}

// --- releases -------------------------------------------------------------

async function gh(p) {
  const r = await fetch(`https://api.github.com${p}`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`GitHub ${p} ${r.status}`);
  return r.json();
}

async function ghcrDigest(repo, tag) {
  const t = await (await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`)).json();
  const r = await fetch(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' },
  });
  return r.headers.get('docker-content-digest');
}

async function releases() {
  const pinned = {
    nodelink: env('PIN_NODELINK', 'v3.9.0'),
    lavalink: env('PIN_LAVALINK', '4.2.2'),
    // Commit of the Lavalink dev image in use (LAVALINK_TAG in ../lavalink/.env). Compared with the dev branch head.
    lavalinkDev: env('PIN_LAVALINK_DEV', ''),
    youtubeSource: env('PIN_YT_PLUGIN', '2be8e542d3f6f178e048dca565892684c2e40177'),
    ytCipher: env('PIN_YT_CIPHER', 'sha256:4c5ec381ff57336cfc24822d2b526a5ad7cd0171f61065a1bbc87bb736842449'),
  };
  const latest = {};
  const errors = [];
  const tryGet = async (k, fn) => { try { latest[k] = await fn(); } catch (e) { errors.push(`${k}: ${e.message}`); } };
  await tryGet('nodelink', async () => (await gh('/repos/PerformanC/NodeLink/releases/latest')).tag_name);
  await tryGet('lavalink', async () => (await gh('/repos/lavalink-devs/Lavalink/releases/latest')).tag_name);
  if (pinned.lavalinkDev) await tryGet('lavalinkDev', async () => (await gh('/repos/lavalink-devs/Lavalink/commits?sha=dev&per_page=1'))[0].sha);
  await tryGet('youtubeSource', async () => (await gh('/repos/lavalink-devs/youtube-source/commits?per_page=1'))[0].sha);
  await tryGet('ytCipher', () => ghcrDigest('kikkia/yt-cipher', 'master'));

  const prev = readJson(STATE_FILE, {});
  const seen = prev.releasesSeen || {};
  const lines = [];
  for (const k of Object.keys(pinned)) {
    if (!pinned[k] || !latest[k] || latest[k].startsWith(pinned[k]) || seen[k] === latest[k]) continue;
    lines.push(`- **${k}**: ใช้อยู่ \`${pinned[k].slice(0, 19)}\` → มีใหม่ \`${latest[k].slice(0, 19)}\``);
    seen[k] = latest[k];
  }
  if (lines.length) await notify('info', 'มีเวอร์ชันใหม่', [...lines, '', 'ยังไม่ได้อัปเดต ให้ทดสอบด้วย `sidecar.mjs update` ก่อน (มี rollback)']);
  writeJson(STATE_FILE, { ...readJson(STATE_FILE, {}), releasesSeen: seen });
  console.log(JSON.stringify({ pinned, latest, errors }, null, 2));
}

// --- update with rollback ---------------------------------------------------

function setEnvLine(file, key, value) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  // The active (last uncommented) line wins in compose; a commented example only when none is active.
  const active = lines.map((l, i) => new RegExp(`^\\s*${key}\\s*=`).test(l) ? i : -1).filter(i => i >= 0).pop();
  const i = active ?? lines.findIndex(l => new RegExp(`^\\s*#\\s*${key}\\s*=`).test(l));
  if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join('\n'));
}

async function waitHealthy(nodeName, ms) {
  const n = NODES.find(x => x.name === nodeName);
  if (!n) throw new Error(`unknown node ${nodeName}`);
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, 15_000));
    last = await probeNode(n);
    // Require the node up and at least one non-YouTube source working. YouTube itself may be blocked
    // for reasons the update did not cause, so it is reported, not required.
    if (last.up && Object.entries(last.sources).some(([s, v]) => s !== 'youtube' && v.ok)) return last;
  }
  throw new Error(`not healthy: ${JSON.stringify(last)}`);
}

async function update(stackDir, key, value, nodeName) {
  const dir = path.resolve(stackDir);
  const envFile = path.join(dir, '.env');
  const backup = `${envFile}.bak-${Date.now()}`;
  if (fs.existsSync(envFile)) fs.copyFileSync(envFile, backup);
  const compose = (...args) => execFileSync(DOCKER[0], [...DOCKER.slice(1), 'compose', ...args], { cwd: dir, stdio: 'inherit' });
  // Default: the first registry node whose STACK is this directory.
  const target = nodeName || NODES.find(n => n.stack && path.resolve(n.stack) === dir)?.name || NODES[0]?.name;

  // Notifications go to Discord: never print secret values.
  const shown = /PASS|TOKEN|SECRET|KEY|AUTH/i.test(key) ? '***' : value.slice(0, 19);
  setEnvLine(envFile, key, value);
  try {
    compose('up', '-d', '--build');
    const h = await waitHealthy(target, Number(env('SIDECAR_UPDATE_WAIT_MS', 180_000)));
    await notify('ok', `อัปเดต ${target} สำเร็จ`, [`ตั้ง \`${key}\` = \`${shown}\``, `ผ่านการตรวจหลังอัปเดต • YouTube ${h.sources.youtube?.ok ? 'ใช้ได้' : '**ใช้ไม่ได้**'}`]);
  } catch (e) {
    await notify('error', `อัปเดต ${target} ไม่สำเร็จ ย้อนกลับเป็นค่าเดิมแล้ว`, [`ลองตั้ง \`${key}\` = \`${shown}\``, explain(e.message), rawLine(e.message)]);
    if (fs.existsSync(backup)) fs.copyFileSync(backup, envFile);
    compose('up', '-d', '--build');
    process.exitCode = 1;
  } finally {
    // The backup holds secrets; the rollback above already used it.
    fs.rmSync(backup, { force: true });
  }
}

// --- main -------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);
if (!NODES.length && cmd !== 'releases' && cmd !== 'test-notify') {
  console.error('No nodes configured (MUSIC_NODES + <NAME>_HOST).');
  process.exit(2);
}
switch (cmd) {
  case 'check': {
    const r = await round();
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.every(x => x.up) ? 0 : 1;
    break;
  }
  case 'watch': {
    if (HTTP_PORT) await startHttp();
    let lastReleaseCheck = 0;
    for (;;) {
      try { await round(); } catch (e) { console.error('[sidecar] round failed:', e); }
      try { await maybeReport(); } catch (e) { console.error('[sidecar] report failed:', e); }
      if (Date.now() - lastReleaseCheck > 86_400_000) {
        lastReleaseCheck = Date.now();
        try { await releases(); } catch (e) { console.error('[sidecar] releases failed:', e.message); }
      }
      await new Promise(r => setTimeout(r, INTERVAL));
    }
  }
  case 'token': await setToken(args[0], args[1], args[2], args[3]); break;
  case 'releases': await releases(); break;
  case 'report': await report(); break;
  case 'snapshot': console.log(JSON.stringify(await buildSnapshot(), null, 2)); break;
  // Posts the node status with one login button per node (use any time, e.g. to log in a new node).
  case 'panel': {
    const results = await Promise.all(NODES.map(probeNode));
    const lines = results.map(r => {
      const yt = r.sources.youtube;
      const ytText = !r.up ? '🔴 node ล่ม' : !yt ? '⚪ ไม่มี YouTube' : yt.ok ? '🟢 YouTube ใช้ได้' : `🔴 YouTube ใช้ไม่ได้ — ${explain(yt.error) || yt.error}`;
      return `**${r.name}** (${r.kind}) • ${ytText}`;
    });
    await notify('info', 'สถานะ node เพลง', [...lines, '', 'กดปุ่มเพื่อ login บัญชี burner ให้ node นั้น (ใช้คนละบัญชีต่อ node)'], { loginNodes: NODES.map(n => n.name) });
    break;
  }
  // Sends one sample of each notification style to the webhook.
  case 'test-notify':
    await notify('info', 'ทดสอบการแจ้งเตือน', ['ข้อความตัวอย่างจากระบบเฝ้าดูเพลง ไม่มีอะไรผิดปกติ']);
    await notify('warn', 'YouTube บน LAVALINK ใช้ไม่ได้ (ตัวอย่าง)', [explain('Sign in to confirm you’re not a bot'), rawLine('Sign in to confirm you’re not a bot')]);
    await notify('error', 'อัปเดต LAVALINK ไม่สำเร็จ ย้อนกลับเป็นค่าเดิมแล้ว (ตัวอย่าง)', ['ลองตั้ง `LAVALINK_TAG` = `9.9.9`', explain('failed to resolve reference'), rawLine('failed to resolve reference "ghcr.io/lavalink-devs/lavalink:9.9.9": not found')]);
    await notify('ok', 'NODELINK กลับมาทำงานแล้ว (ตัวอย่าง)', ['เวอร์ชัน `3.9.0`']);
    break;
  case 'update': await update(args[0], args[1], args[2], args[3]); break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n'));
}

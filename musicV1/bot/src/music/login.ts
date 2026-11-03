import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import Env from "../utils/env.js";
import { MusicNode } from "./nodes.js";

// YouTube OAuth device login for a node's burner account, started from a Discord button.
// Same Google client as NodeLink / youtube-source (YouTube on TV), so the refresh token works on both.
const CLIENT_ID = '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com';
const CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT';
const SCOPES = 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube';
const run = promisify(execFile);

export type LoginStart = { userCode: string; url: string; expiresAt: number; done: Promise<LoginResult> };
export type LoginResult = { ok: boolean; message: string };

const pending = new Map<string, LoginStart>();

async function post(url: string, body: Record<string, string>) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> };
}

// One login at a time per node. Pressing the button again shows the same code.
export async function startLogin(node: MusicNode): Promise<LoginStart> {
  const running = pending.get(node.name);
  if (running && running.expiresAt > Date.now()) return running;

  const r = await post('https://www.youtube.com/o/oauth2/device/code', { client_id: CLIENT_ID, scope: SCOPES });
  if (r.status !== 200 || !r.json.user_code) throw new Error(`Google ไม่ให้รหัส: ${r.json.error_description || r.json.error || r.status}`);
  const expiresAt = Date.now() + (r.json.expires_in ?? 1800) * 1000;
  const start: LoginStart = {
    userCode: r.json.user_code,
    url: r.json.verification_url || 'https://www.google.com/device',
    expiresAt,
    done: (async () => {
      try {
        const token = await pollToken(r.json.device_code, r.json.interval ?? 5, expiresAt);
        return await applyToken(node, token);
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      } finally {
        pending.delete(node.name);
      }
    })(),
  };
  pending.set(node.name, start);
  return start;
}

async function pollToken(deviceCode: string, interval: number, expiresAt: number): Promise<string> {
  while (Date.now() < expiresAt) {
    await new Promise(res => setTimeout(res, interval * 1000));
    const r = await post('https://www.youtube.com/o/oauth2/token', {
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: deviceCode,
      grant_type: 'http://oauth.net/grant_type/device/1.0',
    }).catch(() => null);
    if (!r) continue;
    if (r.json.refresh_token) return r.json.refresh_token;
    if (r.json.error === 'authorization_pending') continue;
    if (r.json.error === 'slow_down') { interval += 5; continue; }
    if (r.json.error === 'access_denied') throw new Error('ถูกปฏิเสธ (กดไม่อนุญาตในหน้า Google)');
    if (r.json.error === 'expired_token') break;
    throw new Error(`Google ตอบ error: ${r.json.error_description || r.json.error || r.status}`);
  }
  throw new Error('รหัสหมดอายุแล้ว กดปุ่มเพื่อสร้างรหัสใหม่');
}

// Writes KEY=value into the stack's .env (active line, else a new line). The stack keeps the token
// across container restarts this way.
function setEnvLine(file: string, key: string, value: string) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let i = -1;
  lines.forEach((l, n) => { if (re.test(l)) i = n; });
  if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join('\n'));
}

const base = (n: MusicNode) => `${n.secure ? 'https' : 'http'}://${n.url}`;

async function waitUp(node: MusicNode, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise(res => setTimeout(res, 3000));
    const ok = await fetch(`${base(node)}/version`, { headers: { Authorization: node.auth }, signal: AbortSignal.timeout(5000) })
      .then(r => r.ok).catch(() => false);
    if (ok) return true;
  }
  return false;
}

// Plays nothing, but asks YouTube for a song that needs login from this IP.
async function youtubeWorks(node: MusicNode) {
  const q = `ytsearch:${Env('SIDECAR_YT_PROBE_ID') || 'ff7ao5s0heQ'}`;
  const h = { Authorization: node.auth };
  const r = await fetch(`${base(node)}/v4/loadtracks?identifier=${encodeURIComponent(q)}`, { headers: h, signal: AbortSignal.timeout(30_000) })
    .then(r => r.json()).catch(() => null) as any;
  const t = r?.loadType === 'search' ? r.data[0] : null;
  if (!t) return false;
  if (node.kind !== 'nodelink') return true; // Lavalink: playback is checked by the soak client
  const s = await fetch(`${base(node)}/v4/trackstream?encodedTrack=${encodeURIComponent(t.encoded)}`, { headers: h, signal: AbortSignal.timeout(30_000) })
    .then(r => r.json()).catch(() => null) as any;
  return !!s?.url && !s?.newTrack;
}

export async function applyToken(node: MusicNode, token: string): Promise<LoginResult> {
  if (!node.stack || !node.tokenVar) return { ok: false, message: `ยังไม่ได้ตั้ง ${node.name}_STACK / ${node.name}_TOKEN_VAR ใน .env เลยบันทึก token ไม่ได้` };
  const envFile = path.join(node.stack, '.env');
  setEnvLine(envFile, node.tokenVar, node.kind === 'nodelink' ? JSON.stringify([token]) : token);

  if (node.kind === 'lavalink') {
    // youtube-source takes a new token at runtime, no restart.
    const r = await fetch(`${base(node)}/youtube`, {
      method: 'POST',
      headers: { Authorization: node.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: token, skipInitialization: true }),
      signal: AbortSignal.timeout(30_000),
    }).catch(e => ({ ok: false, status: (e as Error).message }));
    if (!r.ok) return { ok: false, message: `บันทึก token แล้ว แต่ส่งเข้า ${node.name} ไม่ได้ (${r.status}) ให้รีสตาร์ท ${node.service || 'container'}` };
  } else {
    // NodeLink's PATCH /v4/youtube/config hangs while it validates the token, so recreate the
    // container instead. Its players move to another node by themselves meanwhile.
    const docker = (Env('SIDECAR_DOCKER') || 'docker').split(' ');
    try {
      await run(docker[0], [...docker.slice(1), 'compose', 'up', '-d', '--no-build', ...(node.service ? [node.service] : [])], { cwd: node.stack, timeout: 120_000 });
    } catch (e) {
      return { ok: false, message: `บันทึก token แล้ว แต่รีสตาร์ท ${node.name} ไม่ได้: ${(e as Error).message.slice(0, 200)}` };
    }
    if (!await waitUp(node, 120_000)) return { ok: false, message: `${node.name} ไม่กลับมาหลังรีสตาร์ท` };
  }
  return await youtubeWorks(node)
    ? { ok: true, message: `${node.name} login สำเร็จ YouTube ใช้ได้แล้ว` }
    : { ok: false, message: `บันทึก token แล้ว แต่ ${node.name} ยังเล่น YouTube ไม่ได้ (บัญชีนี้อาจโดนบล็อก ลองบัญชีอื่น)` };
}

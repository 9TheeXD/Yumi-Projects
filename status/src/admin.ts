import crypto from 'node:crypto';
import express, { type Express } from 'express';
import type { StatusData } from 'global/types';
import { getActiveError } from './check.js';
import { getBanner, getMaintenance, getSegment, getSetting, getUpdating, getUpdatingNow, recentDowns, setSegmentNote, setSetting, setUpdating, UPDATE_MAX_MS, type Banner } from './history.js';
import { adminCounts, adminDeleteSubscriber, adminListSubscribers, adminRevoke } from './subscribers.js';
import { sendRaw } from './mail.js';
import { displayName, fmtDateTh, fmtDurTh } from './format.js';
import { prefs } from './i18n.js';
import { GEAR, SET_CSS, firstVisitScript, settingsModal, settingsScript } from './settings-ui.js';

/* ------------------------------------------------------------------ */
/*  ตั้งค่า                                                             */
/*  STATUS_DB_PASSWORD  รหัสผ่านเข้าหน้า /admin (ถ้าไม่ตั้ง หน้านี้จะปิดใช้งาน)  */
/* ------------------------------------------------------------------ */
const PASSWORD = process.env.STATUS_DB_PASSWORD ?? '';
const COOKIE = 'ys_admin';
const SESSION_MS = 8 * 3_600_000;
const LOCK_MS = 15 * 60_000;
const MAX_FAILS = 5;
const SERVICE_RE = /^[a-z_]{1,40}$/;
const LEVELS = ['info', 'warn', 'danger'] as const;
const LOGO = 'https://assets.yumistack.net/photos/logo/yumi/001.webp';

type Session = { csrf: string; exp: number };
const sessions = new Map<string, Session>();
const fails = new Map<string, { n: number; until: number; at: number }>();

setInterval(() => {
	const now = Date.now();
	for (const [k, s] of sessions) if (s.exp < now) sessions.delete(k);
	for (const [k, f] of fails) if (f.until < now && now - f.at > LOCK_MS) fails.delete(k);
}, 10 * 60_000).unref();

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
/** เทียบรหัสแบบ constant-time (hash ก่อนเทียบ เพื่อไม่ให้ความยาวเป็นตัวบอกใบ้) */
const same = (a: string, b: string) => crypto.timingSafeEqual(sha(a), sha(b));
const rnd = () => crypto.randomBytes(32).toString('base64url');

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** แสดงอีเมลโดยเข้ารหัส @ และ . เพื่อไม่ให้ Cloudflare แทนที่เป็น [email protected] */
const eml = (s: string) => esc(s).replace(/@/g, '&#64;').replace(/\./g, '&#46;');
const form = express.urlencoded({ extended: false, limit: '16kb' });
const ipOf = (req: any) => String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0].trim();

/** โฮสต์สาธารณะของหน้าสถานะ (อยู่หลัง reverse proxy host ที่เซิร์ฟเวอร์เห็นอาจไม่ตรงกับโดเมนจริง) */
const PUBLIC_HOST = (() => { try { return new URL(process.env.STATUS_PAGE_URL || '').host; } catch { return ''; } })();

function sameOrigin(req: any): boolean {
	if (req.headers['sec-fetch-site'] === 'same-origin') return true;
	const o = req.headers.origin;
	if (!o) return true; // ไม่มี Origin ให้พึ่ง CSRF token
	let oh = '';
	try { oh = new URL(String(o)).host; } catch { return false; }
	const hosts = [req.headers.host, req.headers['x-forwarded-host'], PUBLIC_HOST]
		.filter(Boolean)
		.map(h => String(h).split(',')[0].trim());
	return hosts.includes(oh);
}

function sessionOf(req: any): { token: string; s: Session } | null {
	const raw = String(req.headers.cookie ?? '');
	const part = raw.split(';').map(p => p.trim()).find(p => p.startsWith(`${COOKIE}=`));
	if (!part) return null;
	const token = part.slice(COOKIE.length + 1);
	const s = sessions.get(token);
	if (!s) return null;
	if (s.exp < Date.now()) { sessions.delete(token); return null; }
	return { token, s };
}

/** ตรวจ session + CSRF + origin สำหรับ POST ไม่ผ่าน = ส่งกลับหน้าแอดมิน */
function authedPost(req: any, res: any): Session | null {
	const x = sessionOf(req);
	if (!x || !sameOrigin(req) || !same(String(req.body?._csrf ?? ''), x.s.csrf)) {
		res.redirect(303, '/admin');
		return null;
	}
	return x.s;
}

/** สำหรับหน้า GET: ถ้ายังไม่ล็อกอินจะแสดงหน้าเข้าสู่ระบบแทน */
function gate(req: any, res: any): { token: string; s: Session } | null {
	if (!PASSWORD) { sendPage(res, 503, loginPage('ยังไม่ได้ตั้งค่า STATUS_DB_PASSWORD')); return null; }
	const x = sessionOf(req);
	if (!x) { sendPage(res, 200, loginPage()); return null; }
	return x;
}

function sendPage(res: any, status: number, html: string) {
	// สคริปต์ของหน้าต่างตั้งค่าใช้ nonce เฉพาะคำขอนี้ สคริปต์อื่นยังถูกบล็อก
	const nonce = crypto.randomBytes(16).toString('base64');
	html = html.split('<script>').join(`<script nonce="${nonce}">`);
	res.status(status).set({
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
		'X-Frame-Options': 'DENY',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https: data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
	}).send(html);
}

/* ---------- บันทึกกิจกรรมของแอดมิน (เก็บ 50 รายการล่าสุด) ---------- */
type AuditEntry = { at: number; ip: string; text: string };
async function audit(req: any, text: string) {
	const ip = ipOf(req);
	console.log(`[admin] ${text} จาก ${ip}`);
	try {
		const list = await getSetting<AuditEntry[]>('audit', []);
		list.unshift({ at: Date.now(), ip, text });
		await setSetting('audit', list.slice(0, 50));
	} catch (e) { console.error('[admin] บันทึกกิจกรรมไม่สำเร็จ', e); }
}

/* ---------- ไอคอน (SVG เส้น) ---------- */
const ICONS: Record<string, string> = {
	pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
	trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
	ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
	mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
	out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
	home: '<path d="M3 11l9-8 9 8M5 10v10h14V10"/>',
	download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
	search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
	back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
	logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
};
const ic = (name: string) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

const CSS = `
:root{color-scheme:dark;--ink:#fff3f1;--muted:#b99a97;--dim:#8a706d;--brand:#f13b3b;--ok:#3ddc97;--warn:#fbbf24;--load:#4cc9f0;--down:#ff5a5f}
*{box-sizing:border-box}
html{background:#060203}
body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.6 'Kanit',system-ui,sans-serif;background:radial-gradient(1000px 600px at 10% -15%,rgba(241,59,59,.25),transparent 60%),radial-gradient(800px 600px at 110% 110%,rgba(130,0,0,.3),transparent 60%),#060203;background-attachment:fixed}
a{color:inherit;text-decoration:none}
.wrap{max-width:1120px;margin:0 auto;padding:0 18px 70px}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:14px 18px;margin:0 -18px 26px;background:rgba(6,2,3,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid rgba(255,255,255,.07)}
.brand{display:flex;align-items:center;gap:12px;font-weight:600;font-size:1.05rem}
.brand img{width:34px;height:34px;border-radius:10px;box-shadow:0 8px 22px -8px rgba(241,59,59,.6)}
.badge{font-size:.7rem;letter-spacing:.08em;color:#ff9ea1;border:1px solid rgba(241,59,59,.4);padding:1px 9px;border-radius:99px;margin-left:4px;font-weight:400}
.nav{display:flex;gap:4px;flex-wrap:wrap}
.nav a{padding:7px 14px;border-radius:99px;color:var(--muted);font-size:.9rem;transition:background .15s,color .15s}
.nav a:hover{color:var(--ink);background:rgba(255,255,255,.07)}
.glass{background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.025));border:1px solid rgba(255,255,255,.09);border-radius:20px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 24px 50px -28px rgba(0,0,0,.85)}
.card{padding:22px 24px;margin-bottom:18px;scroll-margin-top:96px}
.card h2{margin:0;font-size:1.08rem;font-weight:600}
.card .sub{margin:3px 0 0;color:var(--dim);font-size:.85rem;font-weight:300}
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:18px}
.stat{padding:18px 20px}
.stat .k{color:var(--muted);font-size:.85rem;font-weight:300}
.stat .v{font-size:2rem;font-weight:700;line-height:1.25;font-variant-numeric:tabular-nums}
.stat .v small{font-size:.9rem;color:var(--dim);font-weight:300}
.stat.upd .v{color:#1f9d5c}.stat.ok .v{color:var(--ok)}.stat.down .v{color:var(--down)}.stat.load .v{color:var(--load)}.stat.warn .v{color:var(--warn)}
.grid2{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:18px;align-items:start}
.grid2>*{min-width:0}
.svc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.svc{padding:18px;display:flex;flex-direction:column;gap:10px;border-radius:18px;border:1px solid rgba(255,255,255,.08);border-left:3px solid var(--dim);background:rgba(0,0,0,.22)}
.svc.upd{border-left-color:#1f9d5c}.svc.ok{border-left-color:var(--ok)}.svc.down{border-left-color:var(--down)}.svc.load{border-left-color:var(--load)}
.svc header{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.svc header b{font-weight:600}
.svc form{display:flex;flex-direction:column;gap:8px;margin:0}
.svc input{width:100%}
.errline{margin:0;color:#ff9ea1;font-size:.85rem;word-break:break-word}
.mnote{display:flex;gap:8px;align-items:flex-start;color:var(--load);font-size:.88rem}
.mnote .ic{margin-top:3px}
.wide{width:100%;justify-content:center}
.tw{overflow-x:auto;border-radius:14px;border:1px solid rgba(255,255,255,.07);background:rgba(0,0,0,.18)}
table{width:100%;border-collapse:collapse;min-width:560px}
th,td{padding:12px 14px;text-align:left;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:middle;font-size:.9rem;white-space:nowrap}
th{font-size:.78rem;color:var(--muted);font-weight:400;background:rgba(255,255,255,.035);position:sticky;top:0}
tr:last-child td{border-bottom:0}
tbody tr:hover td{background:rgba(255,255,255,.025)}
td.clip{white-space:normal;min-width:180px;max-width:280px;word-break:break-word}
.muted{color:var(--dim);font-size:.85rem;font-weight:300}
.pill{display:inline-flex;align-items:center;gap:7px;padding:3px 11px;border-radius:99px;font-size:.8rem;border:1px solid;white-space:nowrap}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}
.pill.upd{color:#4fd48e;border-color:rgba(31,157,92,.55);background:rgba(31,157,92,.16)}
.pill.ok{color:var(--ok);border-color:rgba(61,220,151,.4);background:rgba(61,220,151,.1)}
.pill.down{color:var(--down);border-color:rgba(255,90,95,.45);background:rgba(255,90,95,.1)}
.pill.load,.pill.maint{color:var(--load);border-color:rgba(76,201,240,.4);background:rgba(76,201,240,.1)}
.pill.warn{color:var(--warn);border-color:rgba(251,191,36,.45);background:rgba(251,191,36,.1)}
.pill.mute{color:var(--muted);border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.04)}
input,select,textarea{width:100%;padding:11px 14px;border-radius:13px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.35);color:var(--ink);font:inherit;outline:none;transition:border-color .2s,box-shadow .2s}
input:focus,select:focus,textarea:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(241,59,59,.18)}
input::placeholder,textarea::placeholder{color:#6f5856}
select option{background:#1a0b0d}
textarea{resize:vertical;min-height:84px}
label{display:block;color:var(--muted);font-size:.85rem;font-weight:300;margin:14px 0 6px}
button,.btn{font:inherit;font-weight:600;font-size:.9rem;padding:10px 16px;border-radius:13px;border:0;color:#fff;background:linear-gradient(180deg,#ff5a4d,var(--brand));box-shadow:0 8px 20px -10px rgba(241,59,59,.8);cursor:pointer;display:inline-flex;align-items:center;gap:8px;white-space:nowrap;transition:filter .15s,transform .1s}
button:hover,.btn:hover{filter:brightness(1.08)}
button:active,.btn:active{transform:scale(.98)}
.ghost{background:rgba(255,255,255,.06)!important;border:1px solid rgba(255,255,255,.14);color:#d8b9b5!important;box-shadow:none!important}
.ghost:hover{background:rgba(255,255,255,.1)!important}
.danger{background:#5c1619!important;box-shadow:none!important}
.icon{padding:0;width:36px;height:36px;justify-content:center;border-radius:11px}
button:disabled{opacity:.4;cursor:not-allowed;filter:none}
.ic{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.row>input,.row>select{flex:1;min-width:170px}
.acts{display:flex;gap:8px;align-items:center}
.inline{display:inline}
.flash{padding:13px 18px;border-radius:15px;margin-bottom:18px;border:1px solid;font-weight:500}
.flash.ok{background:rgba(61,220,151,.1);border-color:rgba(61,220,151,.35);color:var(--ok)}
.flash.err{background:rgba(255,90,95,.1);border-color:rgba(255,90,95,.4);color:#ff9ea1}
.feed{list-style:none;margin:0;padding:0;max-height:360px;overflow:auto}
.feed li{display:grid;grid-template-columns:130px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:.9rem}
.feed li:last-child{border-bottom:0}
.feed time{color:var(--dim);font-size:.82rem;white-space:nowrap}
.feed b{font-weight:500}
.feed em{font-style:normal;color:var(--dim);font-size:.8rem;margin-left:6px}
.crumb{color:var(--muted);font-size:.9rem;display:inline-flex;align-items:center;gap:6px;margin-bottom:14px}
.crumb:hover{color:var(--ink)}
.info{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin:6px 0 4px}
.info div{padding:12px 14px;border-radius:14px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.06)}
.info .k{color:var(--dim);font-size:.8rem;font-weight:300}
.info .v{font-weight:600;margin-top:2px}
.search{display:flex;gap:8px;align-items:center}
.search input{width:220px}
.login-wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.login{width:100%;max-width:400px;padding:36px 32px}
.login .logo{width:54px;height:54px;border-radius:17px;box-shadow:0 12px 30px -10px rgba(241,59,59,.7)}
.login h1{margin:16px 0 4px;font-size:1.5rem;font-weight:700}
.err{color:#ff9ea1}
.foot{text-align:center;color:var(--dim);font-size:.8rem;margin-top:24px}
@media (max-width:900px){.grid2{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){.top{position:static}.nav{width:100%}.search input{width:100%}.search{width:100%}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const page = (title: string, body: string) => `<!doctype html>
<html lang="${prefs().lang}"${prefs().calm ? ' class="calm"' : ''}><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<link rel="icon" href="${LOGO}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>${CSS}${SET_CSS}
.gear svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.gear-fixed{position:fixed;top:16px;right:16px;z-index:5}</style>
${firstVisitScript()}</head>
<body>${body}
${settingsModal(prefs().user ?? null)}
<script>${settingsScript()}</script></body></html>`;

const loginPage = (err?: string) => page('เข้าสู่ระบบผู้ดูแล - Yumi Status', `
<button class="ghost gear gear-fixed" type="button" data-set-open aria-label="ตั้งค่า">${GEAR}</button>
<div class="login-wrap"><section class="glass login">
	<img class="logo" src="${LOGO}" alt="">
	<h1>ผู้ดูแลระบบ</h1>
	${err ? `<p class="err">${esc(err)}</p>` : '<p class="muted">Yumi Status · กรุณาใส่รหัสผ่านเพื่อเข้าสู่ระบบ</p>'}
	<form method="post" action="/admin/login" autocomplete="off" style="margin-top:18px">
		<label for="pw">รหัสผ่าน</label>
		<input id="pw" type="password" name="password" required maxlength="200" autofocus>
		<div style="margin-top:18px"><button type="submit" style="width:100%;justify-content:center">เข้าสู่ระบบ</button></div>
	</form>
	<p class="foot">การเข้าถึงทุกครั้งถูกบันทึกไว้</p>
</section></div>`);

const FLASH: Record<string, ['ok' | 'err', string]> = {
	banner: ['ok', 'บันทึกประกาศแล้ว'],
	maint: ['ok', 'อัปเดตโหมดปรับปรุงแล้ว'],
	updating: ['ok', 'เปลี่ยนสถานะอัปเดตแล้ว'],
	incident: ['ok', 'บันทึกสาเหตุแล้ว'],
	sub: ['ok', 'อัปเดตผู้รับการแจ้งเตือนแล้ว'],
	logoutall: ['ok', 'ออกจากระบบทุกเครื่องแล้ว'],
	test: ['ok', 'ส่งอีเมลทดสอบแล้ว ตรวจสอบกล่องจดหมายได้เลย'],
	testerr: ['err', 'ส่งอีเมลทดสอบไม่สำเร็จ ตรวจสอบการตั้งค่า SMTP'],
	bad: ['err', 'ข้อมูลไม่ถูกต้อง ลองใหม่อีกครั้ง'],
};
const STATUS_TH: Record<string, string> = { active: 'รับการแจ้งเตือน', pending: 'รอยืนยัน', revoked: 'ยกเลิกแล้ว' };
const LEVEL_TH: Record<string, string> = { info: 'ข้อมูล', warn: 'ระวัง', danger: 'สำคัญ' };
const SECTIONS = [['#overview', 'ภาพรวม'], ['#banner', 'ประกาศ'], ['#services', 'บริการ'], ['#incidents', 'เหตุการณ์'], ['#subs', 'ผู้รับ'], ['#activity', 'กิจกรรม']];

const topbar = (csrf: string) => `
<header class="top">
	<a class="brand" href="/admin"><img src="${LOGO}" alt="">Yumi Status <span class="badge">ADMIN</span></a>
	<nav class="nav">${SECTIONS.map(([h, t]) => `<a href="/admin${h}">${t}</a>`).join('')}</nav>
	<div class="row">
		<a class="btn ghost" href="/">${ic('home')} หน้าสถานะ</a>
		<button class="ghost gear" type="button" data-set-open title="ตั้งค่า" aria-label="ตั้งค่า">${GEAR}</button>
		<form method="post" action="/admin/logout" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}">
			<button class="ghost" type="submit">${ic('logout')} ออก</button></form>
	</div>
</header>`;

const flashHtml = (ok: string) => {
	const f = FLASH[ok];
	return f ? `<div class="flash ${f[0]}">${esc(f[1])}</div>` : '';
};

async function dashboard(csrf: string, ok: string, q: string, statuses: StatusData[]): Promise<string> {
	const [banner, maint, downs, counts, subs, activity, updFlags, updNow] = await Promise.all([
		getBanner(), getMaintenance(), recentDowns(60), adminCounts(), adminListSubscribers(500), getSetting<AuditEntry[]>('audit', []),
		getUpdating(), getUpdatingNow(),
	]);
	const hidden = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
	const b = banner as Banner;
	const now = Date.now();

	const up = statuses.filter(s => s.status === 1).length;
	const down = statuses.filter(s => s.status === 0 && !updNow[s.name]).length;
	const updCount = statuses.filter(s => updNow[s.name]).length;
	const mcount = statuses.filter(s => maint[s.name] !== undefined).length;
	const inc24 = downs.filter(d => d.start > now - 86_400_000).length;

	const stats = `
	<div class="stats" id="overview">
		<div class="glass stat ok"><div class="k">บริการที่ทำงาน</div><div class="v">${up}<small> / ${statuses.length}</small></div></div>
		<div class="glass stat down"><div class="k">หยุดทำงานตอนนี้</div><div class="v">${down}</div></div>
		<div class="glass stat upd"><div class="k">กำลังอัปเดต</div><div class="v">${updCount}</div></div>
		<div class="glass stat load"><div class="k">กำลังปรับปรุง</div><div class="v">${mcount}</div></div>
		<div class="glass stat warn"><div class="k">เหตุการณ์ใน 24 ชม.</div><div class="v">${inc24}</div></div>
		<div class="glass stat ok"><div class="k">ผู้รับการแจ้งเตือน</div><div class="v">${counts.active}<small> คน</small></div></div>
	</div>`;

	const bannerCard = `
	<section class="glass card" id="banner">
		<div class="head"><div><h2>ประกาศบนหน้าสถานะ</h2><p class="sub">แสดงเป็นแถบด้านบนของหน้าแรกและหน้ารายละเอียด เว้นข้อความว่างเพื่อซ่อน</p></div>
		${b ? `<span class="pill ${b.level === 'danger' ? 'down' : b.level === 'warn' ? 'warn' : 'load'}">${LEVEL_TH[b.level]}</span>` : '<span class="pill mute">ไม่มีประกาศ</span>'}</div>
		<form method="post" action="/admin/banner">${hidden}
			<div class="row">
				<select name="level" style="max-width:150px">${LEVELS.map(l => `<option value="${l}" ${b?.level === l ? 'selected' : ''}>${LEVEL_TH[l]}</option>`).join('')}</select>
				<input name="text" maxlength="300" value="${esc(b?.text ?? '')}" placeholder="เช่น ระบบจะอัปเดตเวลา 02:00 น.">
				<button type="submit">${ic('pencil')} บันทึก</button>
			</div>
		</form>
	</section>`;

	const svcCards = statuses.length
		? statuses.map(st => {
			const m = maint[st.name];
			const upd = updNow[st.name];
			const cls = upd ? 'upd' : st.status === 1 ? 'ok' : st.status === -1 ? 'load' : 'down';
			const label = upd ? 'กำลังอัปเดต' : st.status === 1 ? 'ทำงานปกติ' : st.status === -1 ? 'กำลังเริ่มระบบ' : 'หยุดทำงาน';
			const err = st.status === 0 ? (upd ? { message: upd.cause ?? 'อัปเดตระบบ' } : getActiveError(st.name)) : null;
			const flagged = updFlags[st.name] !== undefined;
			const updControl = `<form method="post" action="/admin/updating">${hidden}
						<input type="hidden" name="service" value="${esc(st.name)}"><input type="hidden" name="enable" value="${flagged || upd ? 'off' : 'on'}">
						<button class="ghost wide" type="submit">${ic('pencil')} ${flagged || upd ? 'ยกเลิกสถานะอัปเดต' : 'ตั้งเป็นสถานะอัปเดต'}</button></form>`;
			const control = m !== undefined
				? `<div class="mnote">${ic('pencil')}<span>${esc(m)}</span></div>
					<form method="post" action="/admin/maintenance">${hidden}
						<input type="hidden" name="service" value="${esc(st.name)}"><input type="hidden" name="enable" value="off">
						<button class="ghost wide" type="submit">${ic('back')} เลิกโหมดปรับปรุง</button></form>`
				: `<form method="post" action="/admin/maintenance">${hidden}
						<input type="hidden" name="service" value="${esc(st.name)}"><input type="hidden" name="enable" value="on">
						<input name="message" maxlength="200" placeholder="ข้อความที่จะแสดง เช่น อัปเดตเซิร์ฟเวอร์ ~30 นาที">
						<button class="ghost wide" type="submit">${ic('pencil')} เปิดโหมดปรับปรุง</button></form>`;
			return `<article class="svc ${cls}">
				<header><div><b>${esc(displayName(st.name))}</b><div class="muted">${esc(st.name)}</div></div>
				<span class="pill ${cls}">${label}</span></header>
				${err ? `<p class="errline">${esc(err.message)}</p>` : ''}
				${m !== undefined ? '<span class="pill maint" style="align-self:flex-start">กำลังปรับปรุง</span>' : ''}
				${flagged && !upd ? '<span class="pill upd" style="align-self:flex-start">ตั้งสถานะอัปเดตไว้ (รอบริการหยุด)</span>' : ''}
				${control}
				${updControl}
			</article>`;
		}).join('')
		: `<p class="muted">กำลังตรวจสอบบริการ…</p>`;

	const servicesCard = `
	<section class="glass card" id="services">
		<div class="head"><div><h2>บริการ และโหมดปรับปรุง</h2><p class="sub">โหมดปรับปรุงจะแสดงป้ายบนหน้าเว็บ และหยุดการแจ้งเตือนของบริการนั้นชั่วคราว</p></div></div>
		<div class="svc-grid">${svcCards}</div>
	</section>`;

	const incRows = downs.length
		? downs.map(d => `<tr>
			<td><b>${esc(displayName(d.service))}</b></td>
			<td>${fmtDateTh(d.start)}</td>
			<td>${d.end ? fmtDateTh(d.end) : '<span class="pill down">กำลังล่ม</span>'}</td>
			<td>${d.end ? fmtDurTh(d.end - d.start) : '—'}</td>
			<td class="clip">${d.cause ? esc(d.cause) : '<span class="muted">ไม่ทราบ</span>'}</td>
			<td class="clip muted">${d.note ? esc(d.note) : '—'}</td>
			<td><a class="btn ghost icon" href="/admin/incident/${d.id}" title="แก้ไข" aria-label="แก้ไข">${ic('pencil')}</a></td>
		</tr>`).join('')
		: `<tr><td colspan="7" class="muted">ยังไม่มีเหตุการณ์หยุดทำงาน</td></tr>`;

	const incidentsCard = `
	<section class="glass card" id="incidents">
		<div class="head"><div><h2>เหตุการณ์หยุดทำงาน</h2><p class="sub">สาเหตุบันทึกอัตโนมัติ กดดินสอเพื่อแก้ไขสาเหตุและหมายเหตุ</p></div>
			<a class="btn ghost" href="/admin/export.csv">${ic('download')} ส่งออก CSV</a></div>
		<div class="tw"><table style="min-width:900px">
			<thead><tr><th>บริการ</th><th>เริ่มหยุด</th><th>จนถึง</th><th>ระยะเวลา</th><th>สาเหตุ</th><th>หมายเหตุ</th><th style="width:60px"></th></tr></thead>
			<tbody>${incRows}</tbody>
		</table></div>
	</section>`;

	const needle = q.trim().toLowerCase();
	const shown = needle ? subs.filter(u => u.email.toLowerCase().includes(needle)) : subs;
	const subRows = shown.length
		? shown.map(u => `<tr>
			<td class="clip" style="max-width:280px">${eml(u.email)}</td>
			<td><span class="pill ${u.status === 'active' ? 'ok' : u.status === 'pending' ? 'load' : 'mute'}">${esc(STATUS_TH[u.status] ?? u.status)}</span></td>
			<td class="muted">${fmtDateTh(Number(u.created_at))}</td>
			<td><div class="acts">
				<form method="post" action="/admin/subscriber/${u.id}/revoke" class="inline">${hidden}
					<button class="ghost icon" type="submit" title="ยกเลิกการรับ" aria-label="ยกเลิกการรับ" ${u.status === 'revoked' ? 'disabled' : ''}>${ic('ban')}</button></form>
				<form method="post" action="/admin/subscriber/${u.id}/delete" class="inline">${hidden}
					<button class="danger icon" type="submit" title="ลบออกจากระบบ" aria-label="ลบ">${ic('trash')}</button></form>
			</div></td></tr>`).join('')
		: `<tr><td colspan="4" class="muted">${needle ? 'ไม่พบอีเมลที่ค้นหา' : 'ยังไม่มีผู้รับการแจ้งเตือน'}</td></tr>`;

	const subsCard = `
	<section class="glass card" id="subs">
		<div class="head"><div>
			<h2>ผู้รับการแจ้งเตือน</h2>
			<p class="sub">รับอยู่ ${counts.active} · รอยืนยัน ${counts.pending} · ยกเลิกแล้ว ${counts.revoked}</p>
		</div>
		<form method="get" action="/admin" class="search">
			<input type="search" name="q" value="${esc(q)}" placeholder="ค้นหาอีเมล">
			<button class="ghost" type="submit">${ic('search')} ค้นหา</button>
		</form></div>
		<div class="tw"><table>
			<thead><tr><th>อีเมล</th><th>สถานะ</th><th>สมัครเมื่อ</th><th style="width:110px">จัดการ</th></tr></thead>
			<tbody>${subRows}</tbody>
		</table></div>
	</section>`;

	const tools = `
	<section class="glass card">
		<h2>เครื่องมือ</h2>
		<p class="sub">ทดสอบการส่งอีเมลและจัดการการเข้าถึง</p>
		<form method="post" action="/admin/test-mail" style="margin-top:12px">${hidden}
			<label for="tm">ส่งอีเมลทดสอบไปที่</label>
			<div class="row"><input id="tm" type="email" name="email" placeholder="you@example.com" required maxlength="254">
			<button class="ghost" type="submit">${ic('mail')} ส่งทดสอบ</button></div>
		</form>
		<form method="post" action="/admin/logout-all" style="margin-top:18px">${hidden}
			<button class="danger" type="submit">${ic('logout')} ออกจากระบบทุกเครื่อง</button>
		</form>
	</section>`;

	const feed = activity.length
		? `<ul class="feed">${activity.map(a => `<li><time>${fmtDateTh(a.at)}</time><div><b>${esc(a.text)}</b><em>${esc(a.ip)}</em></div></li>`).join('')}</ul>`
		: `<p class="muted">ยังไม่มีกิจกรรม</p>`;

	const activityCard = `
	<section class="glass card" id="activity">
		<h2>กิจกรรมล่าสุด</h2>
		<p class="sub">บันทึกการกระทำของผู้ดูแล 50 รายการล่าสุด</p>
		<div style="margin-top:12px">${feed}</div>
	</section>`;

	return page('ผู้ดูแลระบบ - Yumi Status', `
	${topbar(csrf)}
	<main class="wrap">
		${flashHtml(ok)}
		${stats}
		<div class="grid2">
			<div>${bannerCard}${incidentsCard}</div>
			<div>${tools}${subsCard}${activityCard}</div>
		</div>
		${servicesCard}
	</main>`);
}

async function incidentPage(csrf: string, id: number): Promise<string | null> {
	const d = await getSegment(id);
	if (!d) return null;
	const hidden = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
	return page(`แก้ไขเหตุการณ์ #${id} - Yumi Status`, `
	${topbar(csrf)}
	<main class="wrap" style="max-width:760px">
		<a class="crumb" href="/admin#incidents">${ic('back')} กลับไปที่เหตุการณ์หยุดทำงาน</a>
		<section class="glass card" style="padding:28px">
			<h2 style="font-size:1.3rem">${esc(displayName(d.service))} · แก้ไขเหตุการณ์</h2>
			<div class="info" style="margin-top:14px">
				<div><div class="k">เริ่มหยุด</div><div class="v" style="font-size:.95rem">${fmtDateTh(d.start)}</div></div>
				<div><div class="k">จนถึง</div><div class="v" style="font-size:.95rem">${d.end ? fmtDateTh(d.end) : 'ยังล่มอยู่'}</div></div>
				<div><div class="k">ระยะเวลา</div><div class="v" style="font-size:.95rem">${d.end ? fmtDurTh(d.end - d.start) : '—'}</div></div>
			</div>
			<form method="post" action="/admin/incident/${d.id}">${hidden}
				<label for="cause">สาเหตุ</label>
				<input id="cause" name="cause" maxlength="300" value="${esc(d.cause ?? '')}" placeholder="เช่น หมดเวลารอการตอบกลับระหว่างโหลดหน้าเว็บ">
				<label for="note">หมายเหตุ (แสดงในไทม์ไลน์ของหน้ารายละเอียด)</label>
				<textarea id="note" name="note" maxlength="1000" rows="5">${esc(d.note ?? '')}</textarea>
				<div class="row" style="margin-top:20px;justify-content:flex-end">
					<a class="btn ghost" href="/admin#incidents">ยกเลิก</a>
					<button type="submit">${ic('pencil')} บันทึกการแก้ไข</button>
				</div>
			</form>
		</section>
	</main>`);
}

/** ลงทะเบียนเส้นทาง /admin ทั้งหมด (ต้องเรียกก่อนเส้นทาง /:name) */
export function registerAdmin(app: Express, getStatuses: () => StatusData[]) {
	if (!PASSWORD) console.warn('[admin] ไม่ได้ตั้งค่า STATUS_DB_PASSWORD จึงปิดหน้า /admin');

	app.get('/admin', async (req: any, res: any) => {
		const x = gate(req, res);
		if (!x) return;
		try {
			sendPage(res, 200, await dashboard(x.s.csrf, String(req.query.ok ?? ''), String(req.query.q ?? '').slice(0, 100), getStatuses()));
		} catch (e) {
			console.error('[admin] แสดงหน้าไม่สำเร็จ:', e);
			sendPage(res, 500, page('ผิดพลาด', `<div class="login-wrap"><section class="glass login"><p class="err">โหลดหน้าผู้ดูแลไม่สำเร็จ ดู log ของเซิร์ฟเวอร์</p></section></div>`));
		}
	});

	app.get('/admin/incident/:id', async (req: any, res: any) => {
		const x = gate(req, res);
		if (!x) return;
		const id = Number(req.params.id);
		const html = Number.isSafeInteger(id) && id > 0 ? await incidentPage(x.s.csrf, id) : null;
		if (!html) return res.redirect(303, '/admin?ok=bad');
		sendPage(res, 200, html);
	});

	app.get('/admin/export.csv', async (req: any, res: any) => {
		const x = gate(req, res);
		if (!x) return;
		const rows = await recentDowns(5000);
		const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
		const lines = [['บริการ', 'เริ่มหยุด', 'สิ้นสุด', 'ระยะเวลา(วินาที)', 'สาเหตุ', 'หมายเหตุ'].map(cell).join(',')];
		for (const r of rows) {
			lines.push([
				r.service,
				new Date(r.start).toISOString(),
				r.end ? new Date(r.end).toISOString() : 'กำลังล่ม',
				r.end ? Math.round((r.end - r.start) / 1000) : '',
				r.cause ?? '',
				r.note ?? '',
			].map(cell).join(','));
		}
		res.set({
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="yumi-incidents-${new Date().toISOString().slice(0, 10)}.csv"`,
			'Cache-Control': 'no-store',
		}).send('\ufeff' + lines.join('\r\n'));
	});

	app.post('/admin/login', form, async (req: any, res: any) => {
		if (!PASSWORD) return sendPage(res, 503, loginPage('ยังไม่ได้ตั้งค่ารหัสผ่าน'));
		const key = ipOf(req);
		const f = fails.get(key);
		if (f && f.until > Date.now()) return sendPage(res, 429, loginPage('ลองผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่'));
		if (!sameOrigin(req)) return sendPage(res, 403, loginPage('คำขอไม่ถูกต้อง'));

		await new Promise(r => setTimeout(r, 600)); // หน่วงกันการเดารหัสรัว ๆ
		const pw = String(req.body?.password ?? '');
		if (same(pw, PASSWORD)) {
			fails.delete(key);
			const token = rnd();
			sessions.set(token, { csrf: rnd(), exp: Date.now() + SESSION_MS });
			res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
			await audit(req, 'เข้าสู่ระบบสำเร็จ');
			return res.redirect(303, '/admin');
		}

		const cur = fails.get(key) ?? { n: 0, until: 0, at: 0 };
		cur.n += 1;
		cur.at = Date.now();
		if (cur.n >= MAX_FAILS) { cur.until = Date.now() + LOCK_MS; cur.n = 0; }
		fails.set(key, cur);
		console.warn(`[admin] เข้าสู่ระบบไม่สำเร็จ จาก ${key}`);
		return sendPage(res, 401, loginPage('รหัสผ่านไม่ถูกต้อง'));
	});

	app.post('/admin/logout', form, (req: any, res: any) => {
		const x = sessionOf(req);
		if (x && sameOrigin(req) && same(String(req.body?._csrf ?? ''), x.s.csrf)) sessions.delete(x.token);
		res.setHeader('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
		res.redirect(303, '/admin');
	});

	app.post('/admin/logout-all', form, async (req: any, res: any) => {
		if (!authedPost(req, res)) return;
		sessions.clear();
		res.setHeader('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
		await audit(req, 'ออกจากระบบทุกเครื่อง');
		res.redirect(303, '/admin');
	});

	app.post('/admin/banner', form, async (req: any, res: any) => {
		if (!authedPost(req, res)) return;
		const level = (LEVELS as readonly string[]).includes(req.body?.level) ? req.body.level : 'info';
		const text = String(req.body?.text ?? '').trim().slice(0, 300);
		await setSetting('banner', text ? { level, text } : null);
		await audit(req, text ? `ตั้งประกาศ (${LEVEL_TH[level]}): ${text.slice(0, 60)}` : 'ซ่อนประกาศ');
		res.redirect(303, '/admin?ok=banner');
	});

	app.post('/admin/maintenance', form, async (req: any, res: any) => {
		if (!authedPost(req, res)) return;
		const service = String(req.body?.service ?? '');
		if (!SERVICE_RE.test(service)) return res.redirect(303, '/admin?ok=bad');
		const maint = await getMaintenance();
		const on = req.body?.enable === 'on';
		if (on) maint[service] = String(req.body?.message ?? '').trim().slice(0, 200) || 'กำลังปรับปรุงระบบ';
		else delete maint[service];
		await setSetting('maintenance', maint);
		await audit(req, `${on ? 'เปิด' : 'ปิด'}โหมดปรับปรุง: ${service}`);
		res.redirect(303, '/admin?ok=maint');
	});

	app.post('/admin/updating', form, async (req: any, res: any) => {
		if (!authedPost(req, res)) return;
		const service = String(req.body?.service ?? '');
		if (!SERVICE_RE.test(service)) return res.redirect(303, '/admin?ok=bad');
		const on = req.body?.enable === 'on';
		await setUpdating(service, on, getActiveError(service)?.message ?? null);
		await audit(req, `${on ? 'ตั้ง' : 'ยกเลิก'}สถานะอัปเดต: ${service}`);
		res.redirect(303, '/admin?ok=updating');
	});

	app.post('/admin/incident/:id', form, async (req: any, res: any) => {
		if (!authedPost(req, res)) return;
		const id = Number(req.params.id);
		if (!Number.isSafeInteger(id) || id <= 0) return res.redirect(303, '/admin?ok=bad');
		const cause = String(req.body?.cause ?? '').trim().slice(0, 300) || null;
		const note = String(req.body?.note ?? '').trim().slice(0, 1000) || null;
		await setSegmentNote(id, cause, note);
		await audit(req, `แก้ไขสาเหตุเหตุการณ์ #${id}`);
		res.redirect(303, '/admin?ok=incident');
	});

	app.post('/admin/test-mail', form, async (req: any, res: any) => {
		if (!authedPost(req, res)) return;
		const to = String(req.body?.email ?? '').trim().slice(0, 254);
		if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(to)) return res.redirect(303, '/admin?ok=bad');
		try {
			await sendRaw(to, '[Yumi Status] ทดสอบการส่งอีเมล',
				`<p style="font-family:Kanit,Tahoma,sans-serif">นี่คืออีเมลทดสอบจากระบบ Yumi Status ถ้าคุณเห็นข้อความนี้ การส่งอีเมลทำงานปกติ</p>`,
				'นี่คืออีเมลทดสอบจากระบบ Yumi Status ถ้าคุณเห็นข้อความนี้ การส่งอีเมลทำงานปกติ');
			await audit(req, 'ส่งอีเมลทดสอบ');
			res.redirect(303, '/admin?ok=test');
		} catch (e) {
			console.error('[admin] ส่งอีเมลทดสอบไม่สำเร็จ', e);
			res.redirect(303, '/admin?ok=testerr');
		}
	});

	app.post('/admin/subscriber/:id/revoke', form, async (req: any, res: any) => {
		if (!authedPost(req, res)) return;
		const id = Number(req.params.id);
		if (Number.isSafeInteger(id)) await adminRevoke(id);
		await audit(req, `ยกเลิกผู้รับการแจ้งเตือน #${id}`);
		res.redirect(303, '/admin?ok=sub');
	});

	app.post('/admin/subscriber/:id/delete', form, async (req: any, res: any) => {
		if (!authedPost(req, res)) return;
		const id = Number(req.params.id);
		if (Number.isSafeInteger(id)) await adminDeleteSubscriber(id);
		await audit(req, `ลบผู้รับการแจ้งเตือน #${id}`);
		res.redirect(303, '/admin?ok=sub');
	});
}
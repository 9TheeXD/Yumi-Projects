import cron from 'node-cron';
import { send } from './send.js';
import { checkAll as _checkAll, getRateLimits } from './check.js';
import { recordStatus, getReport, getBrief, getSeries, firstSampleTs, getBanner, getMaintenance, parseRange, initHistory } from './history.js';
import { renderIndex, renderDetail, renderNotFound } from './pages.js';
import { confirmSubscribe, unsubscribe, initSubscribers } from './subscribers.js';
import { initAccounts, logout, mergePrefs, requestCode, saveUserPrefs, SESSION_DAYS, setSubscribed, userBySession, verifyCode, type User } from './accounts.js';
import { isLang, isTimeZone, parseCookies, prefs, prefsFromRequest, t, withPrefs, type Prefs } from './i18n.js';
import { renderConfirmResult, renderUnsubResult } from './subscribe-page.js';
import { renderMetricsPage } from './chart.js';
import { registerAdmin } from './admin.js';
import { getMusic, musicError, nodeStatusData, renderMusicIndex, renderMusicNode } from './music.js';
import chalk from 'chalk';
import { StatusData } from 'global/types';
import express from 'express';

let allS: StatusData[] = [];
let prevS: StatusData[] = [];
/** สถานะล่าสุด (ทำงาน/หยุด) ที่รู้แน่ของแต่ละ service ไว้ตัดสินว่าจะส่งอีเมลไหม */
const mailState = new Map<string, number>();
let changedStatus: StatusData[] = [];
const isDev = process.env.IS_DEV === 'true';
const port = isDev ? 30006 : 3006;
const app = express();

/** service ที่มีกราฟ */
const METRIC_SERVICES = ['bot', 'backend', 'frontend_main', 'database', 'nodes'];

/** ประกาศและโหมดปรับปรุงที่แอดมินตั้งไว้ ส่งให้หน้าเว็บแสดงผล */
const pageCtx = async () => ({ banner: await getBanner(), maint: await getMaintenance() });

async function checkAll() {
	console.log(`${chalk.gray(`[${(new Date()).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', })}]`)} Checking status...`);
	try{
		allS = await _checkAll(false);

		// บันทึก timeline และตัวอย่างค่า (ต้องทำก่อน send เพื่อให้ข้อความแจ้งเตือนมีข้อมูล downtime/uptime ล่าสุดครบ)
		const updates = await recordStatus(allS);
		// ประวัติของแต่ละ node เพลงเก็บแยก (service "nodes:<NODE>") ไม่ขึ้นในรายการหน้าแรก
		const m = getMusic();
		if (m) recordStatus(m.nodes.map(nodeStatusData));

		const maint = await getMaintenance();
		changedStatus = allS.filter(current => {
			const prevStatus = prevS.find(s => s.name === current.name)?.status;
			// service ที่กำลังปรับปรุงไม่ส่งการแจ้งเตือน (แต่ประวัติยังถูกบันทึกตามจริง)
			return prevStatus !== current.status && !(current.name in maint);
		});
		console.log(changedStatus);

		// Discord: ทุกการเปลี่ยนสถานะ (รวมตอนเริ่มโปรแกรม) เหมือนเดิม
		if(changedStatus.length > 0){
			await send(true, false, false, changedStatus, updates);
		};
		// อีเมล: เฉพาะ service ที่สลับระหว่างทำงาน <-> หยุดทำงาน จริง
		// ไม่ส่งตอนเริ่มโปรแกรม และไม่นับสถานะ "ไม่ทราบ/กำลังเริ่ม" (-1) ระหว่างทาง
		const mailChanged = allS.filter(current => {
			if (current.status !== 0 && current.status !== 1) return false;
			const before = mailState.get(current.name);
			mailState.set(current.name, current.status);
			return before !== undefined && before !== current.status && !(current.name in maint);
		});
		if(mailChanged.length > 0){
			await send(false, true, false, mailChanged, updates);
		};

		// เวอร์ชันเปลี่ยนโดยไม่มี downtime (rebuild แบบไม่หยุด): แจ้งอย่างเดียว ไม่ได้ล่มจึงไม่ต้องบอกว่ากลับมาทำงาน
		const quiet = updates.filter(u => u.noDowntime && !(u.service in maint) && !changedStatus.some(c => c.name === u.service) && !mailChanged.some(c => c.name === u.service));
		if(quiet.length > 0){
			await send(true, true, false, allS.filter(s => quiet.some(u => u.service === s.name)), quiet);
		};

		if(allS.some(s => s.status === 0))throw new Error('Some service down');
	}catch(err: any){
		console.error(`Error during status check: ${err}`);
	}finally{
		prevS = [...allS];
	}
};
function startWatcher() {
	(async () => {
		while(true){
			try{
				await checkAll();
			}catch(e){
				console.error(e);
			}
			await new Promise(res => setTimeout(res, 1000));
		}
	})();
}

app.use(express.json({ limit: '2kb' }));

// การตั้งค่าของผู้ใช้ (ภาษา เขตเวลา ฯลฯ) ใช้ได้ทุกที่ในคำขอนี้ผ่าน i18n.prefs()
// ยังไม่เข้าสู่ระบบ: จาก cookie ys_* / เข้าสู่ระบบแล้ว (cookie ys_auth): ค่าในบัญชีทับค่าใน cookie
app.use((req: any, res: any, next: () => void) => {
	(async () => {
		let p: Prefs = prefsFromRequest(req);
		const user = await userBySession(parseCookies(req.headers.cookie).ys_auth).catch(() => null);
		if (user) p = mergePrefs(p, user);
		p.user = user ? { email: user.email, subscribed: user.subscribed } : null;
		req.user = user;
		withPrefs(p, next);
	})().catch(() => next());
});
const SECURE = (process.env.STATUS_PAGE_URL || '').startsWith('https') ? '; Secure' : '';
const AUTH_COOKIE = (v: string, maxAge: number) => `ys_auth=${v}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${SECURE}`;
const ipOf = (req: any) => String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0].trim();
/** คำขอที่เปลี่ยนข้อมูลบัญชีต้องมาจากหน้าเว็บนี้เท่านั้น (กัน CSRF) */
const sameOrigin = (req: any) => {
	const o = req.headers.origin;
	if (!o) return req.is('application/json') !== false;
	try { return new URL(o).host === req.headers.host; } catch { return false; }
};

// rate limit ต่อ IP สำหรับขอรหัสและยืนยันรหัส (กัน spam อีเมลและการเดารหัส)
const hits = new Map<string, number[]>();
const WINDOW_MS = 10 * 60_000;
function rateOk(key: string, max: number): boolean {
	const now = Date.now();
	const arr = (hits.get(key) ?? []).filter(t => now - t < WINDOW_MS);
	if (arr.length >= max) { hits.set(key, arr); return false; }
	arr.push(now); hits.set(key, arr);
	if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > WINDOW_MS) hits.delete(k);
	return true;
}

app.use((req: any, res: any, next: () => void) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	if (req.method === 'OPTIONS') {
		res.sendStatus(200);
		return;
	};
	next();
});

// JSON สำหรับเอาไปใช้ต่อ: /api/status?range=24h|7d|30d|all
const wrap = (fn: (req: any, res: any) => Promise<void>) =>
	(req: any, res: any) => { fn(req, res).catch((e: unknown) => { console.error(e); if (!res.headersSent) res.status(500).send('Internal error'); }); };

app.get('/api/status', wrap(async (req, res) => {
	const range = parseRange(req.query.range);
	const limits = getRateLimits();
	const out = await Promise.all(allS.map(async s => {
		const [r, b] = await Promise.all([getReport(s.name, range), getBrief(s)]);
		return { ...s, rateLimitedUntil: limits[s.name] ?? null, brief: b, range, stat: r.stat, incidents: r.incidents };
	}));
	res.json(out);
}));

// JSON ข้อมูลกราฟ: /api/metrics?service=bot&range=24h
app.get('/api/metrics', wrap(async (req, res) => {
	const service = String(req.query.service ?? '');
	if (!METRIC_SERVICES.includes(service)) { res.status(400).json({ error: 'unknown service' }); return; }
	res.json(await getSeries(service, parseRange(req.query.range)));
}));

// หน้ากราฟ CPU / RAM / Ping: /metrics?range=24h|7d|30d|all
app.get('/metrics', wrap(async (req, res) => {
	const range = parseRange(req.query.range);
	// ทั้งหมด: ทุกกราฟเริ่มที่ตัวอย่างแรกสุดของทุก service (ไม่เว้นว่างทางซ้าย)
	const firsts = (await Promise.all(METRIC_SERVICES.map(firstSampleTs))).filter((x): x is number => x !== null);
	const start = firsts.length ? Math.min(...firsts) : undefined;
	const entries = await Promise.all(METRIC_SERVICES.map(async n => [n, await getSeries(n, range, Date.now(), start)] as const));
	res.send(await renderMetricsPage(Object.fromEntries(entries), range));
}));

// หน้าสำหรับฝังใน iframe: เหมือนหน้าแรกแต่ไม่มีพื้นหลัง และลิงก์รายละเอียดเปิดแท็บใหม่
app.get('/iframe', wrap(async (req, res) => {
	const range = parseRange(req.query.range);
	const items = await Promise.all(allS.map(async s => ({ s, r: await getReport(s.name, range), b: await getBrief(s) })));
	res.set('Content-Security-Policy', "frame-ancestors *");
	res.send(renderIndex(items, getRateLimits(), range, true, await pageCtx()));
}));

app.get('/', wrap(async (req, res) => {
	const range = parseRange(req.query.range);
	const items = await Promise.all(allS.map(async s => ({ s, r: await getReport(s.name, range), b: await getBrief(s) })));
	res.send(renderIndex(items, getRateLimits(), range, false, await pageCtx()));
}));

// หน้ารับการแจ้งเตือนเป็น popup ในหน้าแรกแล้ว ลิงก์เดิมจะพาไปเปิด popup
app.get('/subscribe', (req: any, res: any) => {
	res.redirect(302, '/?subscribe=1');
});

app.get('/subscribe/confirm', wrap(async (req, res) => {
	// ลิงก์ยืนยันแบบเดิม (ก่อนมีระบบเข้าสู่ระบบ) ยังใช้ได้จนหมดอายุ
	const r = await confirmSubscribe(req.query.token);
	res.send(await renderConfirmResult(r.result));
}));

app.all('/subscribe/unsubscribe', wrap(async (req, res) => {
	const tok = (req.method === 'POST' ? req.body?.token ?? req.query.token : req.query.token);
	const ok = await unsubscribe(tok);
	res.send(await renderUnsubResult(ok));
}));

/* ---------- บัญชี: เข้าสู่ระบบด้วยรหัส 6 หลักทางอีเมล ---------- */

app.post('/api/auth/code', wrap(async (req, res) => {
	if (!sameOrigin(req)) { res.status(403).json({ ok: false }); return; }
	if (!rateOk(`code:${ipOf(req)}`, 8)) { res.status(429).json({ ok: false, error: t('sub_rate_10') }); return; }
	const r = await requestCode(req.body?.email);
	if (r.ok) { res.json({ ok: true }); return; }
	if (r.error === 'invalid') { res.status(400).json({ ok: false, error: t('sub_invalid') }); return; }
	res.status(429).json({ ok: false, wait: r.wait, error: t('lg_wait', { s: r.wait }) });
}));

app.post('/api/auth/verify', wrap(async (req, res) => {
	if (!sameOrigin(req)) { res.status(403).json({ ok: false }); return; }
	if (!rateOk(`verify:${ipOf(req)}`, 30)) { res.status(429).json({ ok: false, error: t('sub_rate_10') }); return; }
	const r = await verifyCode(req.body?.email, req.body?.code);
	if (!r.ok) { res.status(400).json({ ok: false, error: t(r.error === 'bad' ? 'lg_bad' : 'lg_expired'), expired: r.error === 'expired' }); return; }
	if (req.body?.subscribe === true) await setSubscribed(r.user, true, mergePrefs(prefs(), r.user));
	res.setHeader('Set-Cookie', AUTH_COOKIE(r.token, SESSION_DAYS * 86400));
	res.json({ ok: true });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
	if (!sameOrigin(req)) { res.status(403).json({ ok: false }); return; }
	await logout(parseCookies(req.headers.cookie).ys_auth);
	res.setHeader('Set-Cookie', AUTH_COOKIE('', 0));
	res.json({ ok: true });
}));

// หน้าตั้งค่าเรียกทุกครั้งที่เปลี่ยนค่า: ถ้าเข้าสู่ระบบอยู่ บันทึกลงบัญชีด้วย (ไม่ได้เข้าสู่ระบบ ใช้แค่ cookie)
app.post('/api/prefs', wrap(async (req, res) => {
	const user: User | null = req.user;
	if (!user || !sameOrigin(req)) { res.json({ ok: false }); return; }
	const b = req.body ?? {};
	if (b.reset === true) { await saveUserPrefs(user, null); res.json({ ok: true }); return; }
	const cur = prefs();
	await saveUserPrefs(user, {
		...cur,
		lang: isLang(b.lang) ? b.lang : cur.lang,
		tz: isTimeZone(b.tz) ? b.tz : cur.tz,
		h12: b.h12 === '12' ? true : b.h12 === '24' ? false : b.h12 === 'auto' ? null : cur.h12,
		refresh: typeof b.refresh === 'boolean' ? b.refresh : cur.refresh,
		calm: typeof b.calm === 'boolean' ? b.calm : cur.calm,
	});
	res.json({ ok: true });
}));

app.post('/api/account/subscribe', wrap(async (req, res) => {
	const user: User | null = req.user;
	if (!user || !sameOrigin(req)) { res.status(401).json({ ok: false }); return; }
	await setSubscribed(user, req.body?.on === true, prefs());
	res.json({ ok: true });
}));

// หน้าผู้ดูแล /admin (ต้องลงทะเบียนก่อน /:name)
registerAdmin(app, () => allS);

// node เพลง: /nodes (การ์ดแต่ละ node) และ /nodes/:node (รายละเอียด) (/music เก็บไว้ให้บอทเพลงในอนาคต) ส่ง 503 เมื่อไม่ทำงาน แต่ยังส่งหน้าเว็บ
app.get('/api/nodes', wrap(async (req, res) => {
	const m = getMusic();
	if (!m) { res.status(503).json({ error: 'ไม่ได้รับข้อมูลจากระบบเฝ้าดูเพลง', cause: musicError() }); return; }
	// JSON สาธารณะ: ไม่ส่งช่องที่ตัดทิ้งแล้ว (burner, image, error ดิบ)
	const nodes = m.nodes.map(({ burner: _b, image: _i, error: _e, ...n }) => ({
		...n, sources: Object.fromEntries(Object.entries(n.sources).map(([k, v]) => [k, { ok: v.ok, reason: v.errorTh }])),
	}));
	res.status(m.nodes.some(n => n.up) ? 200 : 503).json({ ...m, nodes });
}));

app.get('/nodes', wrap(async (req, res) => {
	const range = parseRange(req.query.range);
	const m = getMusic();
	const items = await Promise.all((m?.nodes ?? []).map(async n => {
		const s = nodeStatusData(n);
		const [r, b] = await Promise.all([getReport(s.name, range), getBrief(s)]);
		return { n, r, b };
	}));
	const agg = allS.find(s => s.name === 'nodes');
	res.status(agg?.status === 0 ? 503 : 200).send(renderMusicIndex(agg, items, range, await pageCtx()));
}));

app.get('/nodes/:node', wrap(async (req, res) => {
	const range = parseRange(req.query.range);
	const n = getMusic()?.nodes.find(x => x.name.toLowerCase() === String(req.params.node).toLowerCase());
	if (!n) { res.status(getMusic() ? 404 : 503).send(renderNotFound(String(req.params.node))); return; }
	const s = nodeStatusData(n);
	const [r, b, series, ctx] = await Promise.all([getReport(s.name, range), getBrief(s), getSeries(s.name, range), pageCtx()]);
	res.status(n.up ? 200 : 503).send(renderMusicNode(n, r, b, range, series, ctx));
}));

// ต้องอยู่หลัง /metrics และ /api/* เพื่อไม่ให้ถูกจับเป็นชื่อ service
app.get(`/:name`, wrap(async (req, res) => {
	const range = parseRange(req.query.range);
	const status = allS.find(s => s.name === req.params.name);
	if (!status) { res.status(404).send(renderNotFound(req.params.name)); return; }
	const [r, b, series, ctx] = await Promise.all([getReport(status.name, range), getBrief(status), getSeries(status.name, range), pageCtx()]);
	res.status(status.status === 1 ? 200 : 503).send(renderDetail(status, r, b, getRateLimits()[status.name] ?? 0, range, series, ctx));
}));

// เริ่มเฝ้าดูหลังเชื่อมต่อ DB สำเร็จ เพื่อไม่ให้บันทึกประวัติหาย
initHistory()
	.then(() => initSubscribers())
	.then(() => initAccounts())
	.then(() => {
		try {
			app.listen(port);
			console.log(`Status server running on PORT: ${port}`);
		} catch (err) {
			console.log(err);
		}
		startWatcher();
	})
	.catch(e => {
		console.error('เชื่อมต่อฐานข้อมูลไม่สำเร็จ:', e);
		process.exit(1);
	});

// รายงานประจำวัน 19:00 น. (เวลาไทย) ส่งเฉพาะ Discord ไม่ส่งอีเมล
cron.schedule('0 12 * * *', () => send(true, false));
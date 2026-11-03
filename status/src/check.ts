import { StatusData } from "global/types";
import axios from "axios";
import mysql from "mysql2/promise";
import { sendEmailAlert } from "global/backend-functions";
import https from "https";
import { reasonText, refreshMusic } from "./music.js";
import { HOST_MEM, hostResources, memOfHost } from "./host.js";

const mailText = {
	default: `สถานะการทำงานของ Yumi`,
	online: `แจ้งเตือนสถานะการทำงาน: เซิร์ฟเวอร์ทำงานปกติ`,
	error: `แจ้งเตือนสถานะการทำงาน: เซิร์ฟเวอร์ทำงานผิดปกติ`
};

const httpsAgent = new https.Agent({ family: 4 });

/* ------------------------------------------------------------------ */
/*  ตั้งค่า                                                             */
/* ------------------------------------------------------------------ */
/** ต้องพังติดกันกี่รอบ ถึงจะถือว่า "หยุดทำงานจริง" (กันแจ้งเตือนจาก timeout ชั่วคราว) */
const CONFIRM_FAILS = 3;
/** เวลารอสูงสุดของแต่ละ service (Next.js บางครั้งโหลดนาน) */
const SERVICE_TIMEOUT_MS = 10_000;
const FRONTEND_TIMEOUT_MS = 20_000;

/* ------------------------------------------------------------------ */
/*  สาเหตุที่พัง (ใช้แสดงในการแจ้งเตือน Discord / อีเมล)                 */
/* ------------------------------------------------------------------ */
export type Failure = { message: string; at: number };
/** error ของรอบที่กำลังพังอยู่ (ถูกลบเมื่อกลับมาทำงานได้) */
const active = new Map<string, Failure>();
/** error ล่าสุดที่เคยเกิดขึ้น (ไม่ถูกลบ) */
const lastFail = new Map<string, Failure>();

export function getActiveError(name: string): Failure | null { return active.get(name) ?? null; }
export function getLastError(name: string): Failure | null { return lastFail.get(name) ?? null; }

/** แปลง error จาก axios / mysql ให้เป็นข้อความที่อ่านรู้เรื่อง */
function describeError(err: unknown): string {
	if (axios.isAxiosError(err)) {
		if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return 'หมดเวลารอการตอบกลับ (timeout)';
		if (err.response) return `เซิร์ฟเวอร์ตอบกลับด้วย HTTP ${err.response.status}`;
		if (err.code) return `เชื่อมต่อไม่ได้ (${err.code})`;
		return `เชื่อมต่อไม่ได้: ${err.message}`;
	}
	if (err instanceof Error) return err.message;
	return String(err);
}

/** บันทึกว่าพังเพราะอะไร แล้วคืนสถานะ "หยุดทำงาน" */
function failed(name: string, message: string, send2mail: boolean): StatusData {
	const f: Failure = { message, at: Date.now() };
	active.set(name, f);
	lastFail.set(name, f);
	console.error(`[${name}] ${message}`);
	if (send2mail) sendEmailAlert(`thirphathrphlphun@gmail.com`, mailText.error, `${name}: ${message}`);
	return { name, status: 0, ping: undefined, uptime: undefined, startTime: undefined, host: undefined, version: undefined, resources: undefined };
}

/* ------------------------------------------------------------------ */
/*  429 protection                                                     */
/*  ถ้าโดน 429 จะไม่ถือว่า offline: พักการเช็ค service นั้นตาม           */
/*  Retry-After (หรือ backoff) แล้วใช้ผลล่าสุดที่รู้ไปก่อน จากนั้นลองใหม่ */
/* ------------------------------------------------------------------ */
const DEFAULT_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60_000;

class RateLimitError extends Error {
	constructor(public retryAfterMs: number) { super('rate limited (429)'); }
}

function parseRetryAfter(h: unknown): number {
	if (h == null) return 0;
	const n = Number(h);
	if (Number.isFinite(n)) return Math.max(0, n) * 1000;
	const d = Date.parse(String(h));
	return Number.isNaN(d) ? 0 : Math.max(0, d - Date.now());
}

function asRateLimit(err: unknown): RateLimitError | null {
	if (err instanceof RateLimitError) return err;
	if (axios.isAxiosError(err) && err.response?.status === 429) {
		return new RateLimitError(parseRetryAfter(err.response.headers?.['retry-after']));
	}
	return null;
}

type Guard = { blockedUntil: number; strikes: number; checkedAt: number; fails: number; last?: StatusData };
const guards = new Map<string, Guard>();

/** service ไหนกำลังพักเพราะ 429 อยู่ (ค่า = เวลาที่จะลองใหม่ เป็น epoch ms) */
export function getRateLimits(): Record<string, number> {
	const out: Record<string, number> = {};
	const now = Date.now();
	for (const [k, g] of guards) if (g.blockedUntil > now) out[k] = g.blockedUntil;
	return out;
}

async function guarded(key: string, fn: () => Promise<StatusData>, minIntervalMs = 0): Promise<StatusData> {
	let g = guards.get(key);
	if (!g) { g = { blockedUntil: 0, strikes: 0, checkedAt: 0, fails: 0 }; guards.set(key, g); }

	const unknown: StatusData = { name: key, status: -1, ping: undefined, uptime: undefined, startTime: undefined, host: undefined, version: undefined, resources: undefined };
	const now = Date.now();
	if (now < g.blockedUntil) return g.last ?? unknown;
	if (minIntervalMs && g.last && now - g.checkedAt < minIntervalMs) return g.last;

	try {
		g.checkedAt = now;
		const r = await fn();
		g.strikes = 0;

		if (r.status === 0) {
			g.fails++;
			// ยังไม่ถึงจำนวนที่ยืนยัน: คงสถานะเดิมไว้ ยังไม่เปลี่ยนเป็นหยุดทำงาน (ไม่แจ้งเตือน)
			if (g.fails < CONFIRM_FAILS) {
				console.warn(`[${key}] พังรอบที่ ${g.fails}/${CONFIRM_FAILS} ยังไม่ยืนยันว่าหยุดทำงาน`);
				return g.last ?? unknown;
			}
		} else {
			g.fails = 0;
			active.delete(key);
		}

		g.last = r;
		return r;
	} catch (err) {
		const rl = asRateLimit(err);
		if (!rl) throw err;
		g.strikes++;
		const wait = rl.retryAfterMs > 0
			? Math.min(Math.max(rl.retryAfterMs, 1000), MAX_BACKOFF_MS)
			: Math.min(DEFAULT_BACKOFF_MS * 2 ** (g.strikes - 1), MAX_BACKOFF_MS);
		g.blockedUntil = Date.now() + wait;
		console.warn(`[${key}] ติด rate limit (429) รอ ${Math.round(wait / 1000)} วินาทีแล้วลองใหม่ (ครั้งที่ ${g.strikes})`);
		return g.last ?? unknown; // ใช้สถานะล่าสุดที่รู้ ไม่ทำเครื่องหมายว่า offline
	}
}

/* ------------------------------------------------------------------ */

export async function checkAll(send2mail: boolean = true) {
	return Promise.all([bot_main(send2mail), backend(send2mail), frontend_main(send2mail), database(send2mail), music(send2mail)]);
};

/** node เพลงทั้งหมดรวมเป็นบริการเดียว: ทำงานถ้ามี node ทำงานอย่างน้อย 1 ตัว (รายละเอียดแต่ละ node อยู่ที่ /nodes) */
export function music(send2mail: boolean = true): Promise<StatusData> {
	return guarded('nodes', () => _music(send2mail), 5000);
}

async function _music(send2mail: boolean): Promise<StatusData> {
	const m = await refreshMusic();
	// ติดต่อ sidecar ไม่ได้ ไม่ได้แปลว่า node ล่ม: แสดงเป็น "ไม่ทราบสถานะ" แทน
	if (!m) return { name: 'nodes', status: -1, ping: undefined, uptime: undefined, startTime: undefined, host: undefined, version: undefined, resources: undefined };
	const up = m.nodes.filter(n => n.up);
	if (!up.length) {
		const why = m.nodes.map(n => `${n.name}: ${reasonText(n.errorTh)}`).join(', ');
		return { ...failed('nodes', `node เพลงหยุดทำงานทั้งหมด (${why})`, send2mail) };
	}
	active.delete('nodes');
	const pings = up.map(n => n.pingMs).filter((p): p is number => typeof p === 'number');
	// รวมทุก node ที่ทำงานอยู่: CPU และ RAM บวกกัน (เทียบทั้งเครื่องแล้ว), ping เฉลี่ย
	const withRes = up.filter(n => n.cpu !== null && n.mem && n.mem.used !== null);
	const memUsed = withRes.reduce((a, n) => a + (n.mem!.used ?? 0), 0);
	return {
		name: 'nodes',
		status: 1,
		ping: pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : undefined,
		uptime: undefined,
		startTime: undefined,
		host: undefined,
		version: `${up.length}/${m.nodes.length} node`,
		resources: withRes.length
			? { cpu: { percent: Math.round(withRes.reduce((a, n) => a + (n.cpu ?? 0), 0) * 100) / 100 }, memory: { percent: memOfHost(memUsed), used: memUsed, total: HOST_MEM } }
			: undefined,
	};
}

export function bot_main(send2mail: boolean = true): Promise<StatusData> {
	return guarded('bot', () => _bot_main(send2mail));
}
export function backend(send2mail: boolean = true): Promise<StatusData> {
	return guarded('backend', () => _backend(send2mail));
}
export function frontend_main(send2mail: boolean = true): Promise<StatusData> {
	return guarded('frontend_main', () => _frontend_main(send2mail), 5000); // เว็บภายนอก เช็คไม่ถี่เกิน 5 วินาที
}
export function database(send2mail: boolean = true): Promise<StatusData> {
	return guarded('database', () => _database(send2mail));
}

async function _bot_main(send2mail: boolean): Promise<StatusData> {
	try{
		const res = await axios.get<StatusData>(`http://${process.env.LOCALHOST}:30061/`, { timeout: SERVICE_TIMEOUT_MS });
		const loadData = res.data;
		if(!loadData || !loadData.name || !loadData.status) throw new Error('ข้อมูลที่ได้รับไม่ถูกต้อง');

		return {
			name: loadData.name,
			status: loadData.status,
			ping: loadData.ping,
			uptime: loadData.uptime,
			startTime: loadData.startTime,
			host: loadData.host,
			version: loadData.version,
			resources: hostResources(loadData.resources)
		};
	}catch(err){
		const rl = asRateLimit(err); if(rl) throw rl;
		return failed('bot', describeError(err), send2mail);
	}
};

export async function getDatabasePing(send2mail: boolean = true) {
	try{
		const connection = await mysql.createConnection({
			host: process.env.MYSQL_DB_HOST,
			user: process.env.MYSQL_DB_USER,
			password: process.env.MYSQL_DB_PASSWORD,
			database: process.env.MYSQL_DB_DATABASE,
		});

		const start = Date.now();
		await connection.query(`SELECT 1`);
		const ping = Date.now() - start;

		await connection.end();
		return ping;
	}catch(error){
		const m = `ไม่สามารถเชื่อมต่อฐานข้อมูลได้: ${error}`;
		console.error(m);
		if(send2mail){sendEmailAlert(`thirphathrphlphun@gmail.com`, mailText.error, m)};
		return undefined;
	}
};

async function _backend(send2mail: boolean): Promise<StatusData> {
	try{
		const res = await axios.get<StatusData>(`http://${process.env.LOCALHOST}:30063/`, { timeout: SERVICE_TIMEOUT_MS });
		const loadData = res.data;
		if(!loadData || !loadData.name || !loadData.status) throw new Error('ข้อมูลที่ได้รับไม่ถูกต้อง');

		return {
			name: loadData.name,
			status: loadData.status,
			ping: loadData.ping,
			uptime: loadData.uptime,
			startTime: loadData.startTime,
			host: loadData.host,
			version: loadData.version,
			resources: hostResources(loadData.resources)
		};
	}catch(err){
		const rl = asRateLimit(err); if(rl) throw rl;
		return failed('backend', describeError(err), send2mail);
	}
};

async function _frontend_main(send2mail: boolean): Promise<StatusData> {
	const startTime = Date.now();
	try{
		const res = await axios.get(`https://yumistack.net/`, { httpsAgent, timeout: FRONTEND_TIMEOUT_MS });
		if (res.status < 200 || res.status >= 400) throw new Error(`HTTP ${res.status}`);

		active.delete('frontend_main');
		return {
			name: `frontend_main`,
			status: 1,
			ping: (Date.now() - startTime),
			uptime: undefined,
			startTime: undefined,
			host: `https://yumistack.net/`,
			version: undefined,
			resources: undefined
		};
	}catch(err){
		const rl = asRateLimit(err); if(rl) throw rl;
		return failed('frontend_main', describeError(err), send2mail);
	}
};

async function _database(send2mail: boolean): Promise<StatusData> {
	const startTime = Date.now();
	const version = `0.2`;
	const name = `database`;
	try{
		const connection = await mysql.createConnection({
			host: process.env.MYSQL_DB_HOST,
			user: process.env.MYSQL_DB_USER,
			password: process.env.MYSQL_DB_PASSWORD,
			database: process.env.MYSQL_DB_DATABASE,
		});

		const uptime = await connection.query(`SHOW STATUS LIKE "Uptime"`) as mysql.RowDataPacket[];
		const uptimeSeconds = parseInt(uptime[0][0]?.Value);

		await connection.end();

		if(isNaN(uptimeSeconds)) throw new Error('ค่า Uptime ของฐานข้อมูลไม่ถูกต้อง');

		active.delete(name);
		return {
			name,
			status: uptimeSeconds ? 1 : 0,
			ping: (Date.now() - startTime),
			uptime: uptimeSeconds,
			startTime: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
			host: `https://yumistack.net/`,
			version
		};
	}catch(err){
		const s = failed(name, describeError(err), send2mail);
		return { ...s, version };
	}
};
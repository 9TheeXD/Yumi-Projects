import pg from 'pg';
import type { StatusData } from 'global/types';
import { getActiveError } from './check.js';
import { HOST_CORES, HOST_MEM } from './host.js';

/**
 * ประวัติสถานะเก็บใน PostgreSQL (DATABASE_URL)
 * - segments: ช่วงเวลาที่ service อยู่ในสถานะหนึ่ง (1 = running, 0 = down, -1 = loading) เก็บถาวร
 *             + cause (สาเหตุที่พังตอนเริ่มช่วง) + note (หมายเหตุจากแอดมิน)
 * - pings:    ตัวอย่าง ping ทุก 60 วินาที (เก็บ 90 วัน) ใช้สำหรับสถิติเดิม
 * - samples:  ตัวอย่างทุก SAMPLE_EVERY_MS: ping, uptime, cpu, ram, version (เก็บ 90 วัน) ใช้สำหรับกราฟ
 * - settings: ค่าที่แอดมินตั้งเอง (ประกาศ, โหมดปรับปรุง)
 *
 * ต้องเรียก `await initHistory()` ก่อนเริ่มรับ request หรือเช็คสถานะ
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TOUCH_MS = 10_000;
const PING_EVERY_MS = 60_000;
const SAMPLE_EVERY_MS = 10_000;
const PRUNE_EVERY_MS = HOUR;
const SEG_KEEP_MS = 3650 * DAY;
const PING_KEEP_MS = 90 * DAY;
const SAMPLE_KEEP_MS = 90 * DAY;
const SERIES_POINTS = 300;
/** ช่วงที่ระบบ status ไม่ได้บันทึกนานกว่านี้ถือว่า "ไม่มีข้อมูล" (ปกติบันทึกถี่กว่านี้มาก) */
const GAP_MS = 30_000;
/** ช่วงอัปเดตที่ยาวเกินนี้ถือว่าผิดปกติ: กลับไปแสดงเป็นหยุดทำงาน (สีแดง) ตั้งได้ด้วย env UPDATE_MAX_MIN */
export const UPDATE_MAX_MS = (Number(process.env.UPDATE_MAX_MIN) > 0 ? Number(process.env.UPDATE_MAX_MIN) : 15) * 60_000;
/** แอดมินตั้งสถานะอัปเดตไว้แต่บริการยังไม่ล่ม: รอได้นานเท่านี้ก่อนยกเลิกเอง */
const UPDATE_FLAG_TTL_MS = HOUR;

export type Range = '24h' | '7d' | '30d' | 'all';
export const RANGE_LIST: Range[] = ['24h', '7d', '30d', 'all'];
export const parseRange = (v: unknown): Range => (RANGE_LIST as string[]).includes(String(v)) ? (String(v) as Range) : '30d';
const RANGE_MS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
const BUCKETS: Record<Range, number> = { '24h': 24, '7d': 28, '30d': 30, all: 30 };

const pool = new pg.Pool({
	connectionString: process.env.DATABASE_URL,
	max: 5,
	idleTimeoutMillis: 30_000,
	connectionTimeoutMillis: 5_000,
});
pool.on('error', e => console.error('PostgreSQL pool error:', e));

const SEG_COLS = 'id, status, started_at, ended_at, last_seen, cause, note, kind';
type SegRow = { id: string; status: number; started_at: string; ended_at: string | null; last_seen: string; cause: string | null; note: string | null; kind: string | null };
// pg คืนค่า bigint เป็น string จึงแปลงเป็น number ทุกครั้ง
type Seg = { id: number; status: number; start: number; end: number | null; lastSeen: number; cause: string | null; note: string | null; kind: string | null };
const toSeg = (r: SegRow): Seg => ({
	id: Number(r.id),
	status: r.status,
	start: Number(r.started_at),
	end: r.ended_at === null ? null : Number(r.ended_at),
	lastSeen: Number(r.last_seen),
	cause: r.cause,
	note: r.note,
	kind: r.kind,
});

let ready: Promise<void> | null = null;

/** สร้างตารางและปิด segment ที่ค้างจากการดับครั้งก่อน (เรียกครั้งเดียวตอนเริ่มระบบ) */
export function initHistory(): Promise<void> {
	if (!ready) {
		ready = (async () => {
			if (!process.env.DATABASE_URL) throw new Error('ยังไม่ได้ตั้งค่า DATABASE_URL');
			await pool.query(`
				CREATE TABLE IF NOT EXISTS segments(
					id BIGSERIAL PRIMARY KEY,
					service TEXT NOT NULL,
					status SMALLINT NOT NULL,
					started_at BIGINT NOT NULL,
					ended_at BIGINT,
					last_seen BIGINT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_seg_service_start ON segments(service, started_at);
				CREATE INDEX IF NOT EXISTS idx_seg_open ON segments(service) WHERE ended_at IS NULL;
				CREATE TABLE IF NOT EXISTS pings(
					service TEXT NOT NULL,
					ts BIGINT NOT NULL,
					ping INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_pings_service_ts ON pings(service, ts);
				CREATE TABLE IF NOT EXISTS samples(
					service TEXT NOT NULL,
					ts BIGINT NOT NULL,
					status SMALLINT NOT NULL,
					ping INTEGER,
					uptime BIGINT,
					version TEXT,
					cpu REAL,
					mem_used BIGINT,
					mem_total BIGINT,
					mem_percent REAL,
					PRIMARY KEY (service, ts)
				);
				ALTER TABLE samples ADD COLUMN IF NOT EXISTS net_in REAL;
				ALTER TABLE samples ADD COLUMN IF NOT EXISTS net_out REAL;
				ALTER TABLE segments ADD COLUMN IF NOT EXISTS cause TEXT;
				ALTER TABLE segments ADD COLUMN IF NOT EXISTS note TEXT;
				ALTER TABLE segments ADD COLUMN IF NOT EXISTS note_at BIGINT;
				ALTER TABLE segments ADD COLUMN IF NOT EXISTS kind TEXT;
				CREATE TABLE IF NOT EXISTS gaps(
					id BIGSERIAL PRIMARY KEY,
					service TEXT NOT NULL,
					started_at BIGINT NOT NULL,
					ended_at BIGINT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_gaps_service_start ON gaps(service, started_at);
				CREATE TABLE IF NOT EXISTS settings(
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL,
					updated_at BIGINT NOT NULL
				);
			`);
			await migrateHostBasis();
			// ช่วงที่ค้างเปิดอยู่ตอนโปรแกรมดับ: ไม่ปิด รอบแรกที่เช็คสถานะเสร็จจะต่อจากเดิมตามนาฬิกา
			// (ช่วงที่โปรแกรมดับบันทึกเป็น gap = ไม่มีข้อมูล ไม่นับว่า up หรือ down)
			// เวอร์ชันล่าสุดที่เคยเห็นของแต่ละ service (ไว้จับการเปลี่ยนเวอร์ชันหลังจากเริ่มระบบใหม่)
			const vs = await pool.query<{ service: string; version: string }>(
				`SELECT DISTINCT ON (service) service, version FROM samples WHERE version IS NOT NULL ORDER BY service, ts DESC`);
			for (const v of vs.rows) lastVer.set(v.service, v.version);
		})();
		ready.catch(() => { ready = null; }); // ลองใหม่ได้ถ้าเชื่อมต่อไม่สำเร็จ
	}
	return ready;
}

/**
 * ครั้งเดียว: ตัวอย่างเก่าเก็บ CPU เป็น % ของ 1 core (bot, backend, node เพลง) และ RAM ของ node เทียบ limit ของ container
 * แปลงให้เทียบทั้งเครื่องเหมือนค่าที่บันทึกตั้งแต่นี้ไป กราฟเก่ากับใหม่จะได้ต่อกันได้
 */
async function migrateHostBasis() {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const done = await client.query(`INSERT INTO settings(key, value, updated_at) VALUES ('migr_host_basis', 'true', $1) ON CONFLICT (key) DO NOTHING`, [Date.now()]);
		if (done.rowCount) {
			await client.query(`UPDATE samples SET cpu = ROUND((cpu / $1::real)::numeric, 2) WHERE cpu IS NOT NULL AND (service IN ('bot', 'backend') OR service LIKE 'nodes:%')`, [HOST_CORES]);
			await client.query(`UPDATE samples SET mem_total = $1::bigint, mem_percent = ROUND((mem_used * 100.0 / $1::bigint)::numeric, 2) WHERE mem_used IS NOT NULL AND (service IN ('bot', 'backend') OR service LIKE 'nodes:%')`, [HOST_MEM]);
		}
		await client.query('COMMIT');
	} catch (e) {
		await client.query('ROLLBACK').catch(() => {});
		throw e;
	} finally {
		client.release();
	}
}

/* ---------- การตั้งค่าที่แอดมินแก้ได้ ---------- */
export type Banner = { level: 'info' | 'warn' | 'danger'; text: string } | null;

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
	await initHistory();
	const r = (await pool.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [key])).rows[0];
	if (!r) return fallback;
	try { return JSON.parse(r.value) as T; } catch { return fallback; }
}
export async function setSetting(key: string, value: unknown): Promise<void> {
	await initHistory();
	await pool.query(
		`INSERT INTO settings(key, value, updated_at) VALUES ($1, $2, $3)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
		[key, JSON.stringify(value), Date.now()],
	);
}
export const getBanner = () => getSetting<Banner>('banner', null);
/** service ที่กำลังปรับปรุง: { ชื่อ service: ข้อความ } */
export const getMaintenance = () => getSetting<Record<string, string>>('maintenance', {});
/** service ที่แอดมินตั้งเป็นสถานะอัปเดต: { ชื่อ service: เวลาที่ตั้ง } เคลียร์เองเมื่อกลับมาทำงาน */
export const getUpdating = () => getSetting<Record<string, number>>('updating', {});

const UPDATE_ADMIN_CAUSE = 'อัปเดตระบบ (ผู้ดูแลระบุ)';
const trackVersion = (name: string) => !name.startsWith('nodes');
/** เวอร์ชันล่าสุดที่เห็นตอนทำงานปกติ และ segment หยุดทำงานล่าสุดที่ยังไม่กลับมา */
const lastVer = new Map<string, string>();
const lastDown = new Map<string, { id: string; start: number }>();

/** ผลของการอัปเดตที่เพิ่งเสร็จ (บริการกลับมาทำงานแล้ว) */
export interface UpdateEvent { service: string; from: string | null; to: string | null; ms: number; auto: boolean; /** เวอร์ชันเปลี่ยนโดยไม่มี downtime (rebuild แบบไม่หยุด) */ noDowntime?: boolean }

/**
 * แอดมินสลับสถานะอัปเดตของ service
 * เปิด: ถ้าหยุดทำงานอยู่ ช่วงนี้กลายเป็นอัปเดตทันที ถ้ายังไม่ล่ม ช่วงที่ล่มภายใน 1 ชม. จะถูกนับเป็นอัปเดต
 * ปิด: ช่วงหยุดทำงานที่ค้างอยู่กลับเป็นหยุดทำงานปกติ
 */
export async function setUpdating(service: string, on: boolean, realCause: string | null): Promise<void> {
	const map = await getUpdating();
	if (on) map[service] = Date.now(); else delete map[service];
	await setSetting('updating', map);
	await initHistory();
	if (on) await pool.query(`UPDATE segments SET kind = 'update', cause = $2 WHERE service = $1 AND ended_at IS NULL AND status = 0`, [service, UPDATE_ADMIN_CAUSE]);
	else await pool.query(`UPDATE segments SET kind = NULL, cause = $2 WHERE service = $1 AND ended_at IS NULL AND status = 0 AND kind = 'update'`, [service, realCause]);
	cache.clear();
}

/** service ที่อยู่ในสถานะอัปเดตตอนนี้ (หยุดทำงานเพราะอัปเดต และยังไม่นานเกิน UPDATE_MAX_MS) */
export async function getUpdatingNow(now = Date.now()): Promise<Record<string, { start: number; cause: string | null }>> {
	await initHistory();
	const rows = (await pool.query<{ service: string; started_at: string; cause: string | null }>(
		`SELECT service, started_at, cause FROM segments WHERE ended_at IS NULL AND status = 0 AND kind = 'update' AND started_at >= $1::bigint`,
		[now - UPDATE_MAX_MS])).rows;
	return Object.fromEntries(rows.map(r => [r.service, { start: Number(r.started_at), cause: r.cause }]));
}

/* ---------- การเขียน (cache สถานะที่เปิดอยู่ในหน่วยความจำ ลดการ query) ---------- */
const open = new Map<string, { id: string; status: number; touched: number }>();
/** สถานะที่บันทึก: node เพลงมีความเร็วเครือข่ายเพิ่ม (bytes/วินาที) */
export type SampleStatus = StatusData & { net?: { in: number | null; out: number | null } };

const lastPing = new Map<string, number>();
const lastSample = new Map<string, number>();
let lastPrune = 0;
let writing: Promise<void> = Promise.resolve();

/** เรียกทุกครั้งที่เช็คสถานะเสร็จ (คิวการเขียนตามลำดับ ไม่ทำให้การเฝ้าดูค้าง) */
export function recordStatus(list: SampleStatus[], now = Date.now()): Promise<UpdateEvent[]> {
	const job = writing.then(() => write(list, now));
	writing = job.then(() => {}, e => { console.error('บันทึกประวัติสถานะไม่สำเร็จ:', e); });
	return job.catch(() => []);
}

/** ถ้าระบบ status หยุดบันทึกนานเกิน GAP_MS: จดเป็นช่วง "ไม่มีข้อมูล" แล้วขยับ last_seen เพื่อไม่ให้จดซ้ำ */
async function recordGap(client: pg.PoolClient, service: string, row: { id: string; last_seen: string }, now: number) {
	const last = Number(row.last_seen);
	if (now - last <= GAP_MS) return;
	await client.query(`INSERT INTO gaps(service, started_at, ended_at) VALUES ($1, $2, $3)`, [service, last, now]);
	await client.query(`UPDATE segments SET last_seen = $1 WHERE id = $2`, [now, row.id]);
}

async function write(list: SampleStatus[], now: number): Promise<UpdateEvent[]> {
	await initHistory();
	const events: UpdateEvent[] = [];
	let flagsChanged = false;
	let flags: Record<string, number> | null = null;
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		for (const s of list) {
			let cur = open.get(s.name);
			if (!cur) {
				// เพิ่งเริ่มระบบ (หรือโหลดใหม่หลังบันทึกพลาด): ต่อจากช่วงที่ค้างเปิดอยู่ใน DB
				const row = (await client.query<{ id: string; status: number; started_at: string; last_seen: string }>(
					`SELECT id, status, started_at, last_seen FROM segments WHERE service = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`, [s.name])).rows[0];
				if (row) {
					// ยังไม่รู้สถานะแน่ชัด (-1) ระหว่างรอยืนยัน: รอไปก่อน ไม่ตัดช่วงเดิมทิ้ง
					if (s.status === -1 && row.status !== -1) { await recordGap(client, s.name, row, now); continue; }
					await recordGap(client, s.name, row, now);
					cur = { id: row.id, status: row.status, touched: now };
					open.set(s.name, cur);
					if (row.status === 0) lastDown.set(s.name, { id: row.id, start: Number(row.started_at) });
				}
			}
			if (!cur || cur.status !== s.status) {
				if (cur) await client.query(`UPDATE segments SET ended_at = $1, last_seen = $1 WHERE id = $2`, [now, cur.id]);
				let cause = s.status === 0 ? (getActiveError(s.name)?.message ?? null) : null;
				let kind: string | null = null;
				if (s.status === 0) {
					flags ??= await getUpdating();
					const at = flags[s.name];
					if (at !== undefined && now - at <= UPDATE_FLAG_TTL_MS) { kind = 'update'; cause = UPDATE_ADMIN_CAUSE; }
				}
				const r = await client.query<{ id: string }>(
					`INSERT INTO segments(service, status, started_at, last_seen, cause, kind) VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
					[s.name, s.status, now, cause, kind],
				);
				open.set(s.name, { id: r.rows[0].id, status: s.status, touched: now });
				if (s.status === 0) lastDown.set(s.name, { id: r.rows[0].id, start: now });
				else if (s.status === 1 && cur) {
					// กลับมาทำงานหลังหยุด: เป็นการอัปเดตถ้าแอดมินตั้งไว้ หรือเวอร์ชันที่ service ส่งมาไม่เหมือนเดิม (ขึ้นหรือย้อนก็ตาม)
					const down = lastDown.get(s.name);
					lastDown.delete(s.name);
					const to = s.version?.trim() || null;
					const from = lastVer.get(s.name) ?? null;
					const changed = trackVersion(s.name) && !!to && !!from && to !== from;
					if (down) {
						const seg = (await client.query<{ kind: string | null }>(`SELECT kind FROM segments WHERE id = $1`, [down.id])).rows[0];
						if (changed || seg?.kind === 'update') {
							if (changed) await client.query(`UPDATE segments SET kind = 'update', cause = $2 WHERE id = $1`, [down.id, `อัปเดตเวอร์ชันจาก ${from} -> ${to}`]);
							events.push({ service: s.name, from: changed ? from : to, to, ms: now - down.start, auto: changed });
							flags ??= await getUpdating();
							if (s.name in flags) { delete flags[s.name]; flagsChanged = true; }
						}
					}
				}
			} else if (now - cur.touched >= TOUCH_MS) {
				await client.query(`UPDATE segments SET last_seen = $1 WHERE id = $2`, [now, cur.id]);
				cur.touched = now;
			}
			if (s.status === 1 && s.version && trackVersion(s.name)) {
				const to = s.version.trim(), from = lastVer.get(s.name);
				// เวอร์ชันเปลี่ยนแต่ไม่มีช่วงหยุดทำงานให้ผูก: แจ้งว่าอัปเดต (ไม่ใช่ "กลับมาทำงาน")
				if (from && from !== to && !events.some(e => e.service === s.name)) events.push({ service: s.name, from, to, ms: 0, auto: true, noDowntime: true });
				lastVer.set(s.name, to);
			}
			if (s.status === 1 && typeof s.ping === 'number' && now - (lastPing.get(s.name) ?? 0) >= PING_EVERY_MS) {
				await client.query(`INSERT INTO pings(service, ts, ping) VALUES ($1, $2, $3)`, [s.name, now, Math.round(s.ping)]);
				lastPing.set(s.name, now);
			}
			if (now - (lastSample.get(s.name) ?? 0) >= SAMPLE_EVERY_MS) {
				const r = s.resources;
				await client.query(
					`INSERT INTO samples(service, ts, status, ping, uptime, version, cpu, mem_used, mem_total, mem_percent, net_in, net_out)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (service, ts) DO NOTHING`,
					[
						s.name, now, s.status,
						typeof s.ping === 'number' ? Math.round(s.ping) : null,
						typeof s.uptime === 'number' ? Math.round(s.uptime) : null,
						s.version ?? null,
						r?.cpu?.percent ?? null,
						r?.memory?.used ?? null,
						r?.memory?.total ?? null,
						r?.memory?.percent ?? null,
						s.net?.in ?? null,
						s.net?.out ?? null,
					],
				);
				lastSample.set(s.name, now);
			}
		}
		await client.query('COMMIT');
	} catch (e) {
		await client.query('ROLLBACK').catch(() => {});
		open.clear(); // ให้โหลดสถานะใหม่จาก DB ในรอบถัดไป
		throw e;
	} finally {
		client.release();
	}

	if (flagsChanged && flags) await setSetting('updating', flags).catch(e => console.error(e));
	cache.clear();

	if (now - lastPrune > PRUNE_EVERY_MS) {
		lastPrune = now;
		await pool.query(`DELETE FROM segments WHERE ended_at IS NOT NULL AND ended_at < $1`, [now - SEG_KEEP_MS]);
		await pool.query(`DELETE FROM pings WHERE ts < $1`, [now - PING_KEEP_MS]);
		await pool.query(`DELETE FROM samples WHERE ts < $1`, [now - SAMPLE_KEEP_MS]);
	}
	return events;
}

/* ------------------------------------------------------------------ */
/*  Brief: สรุปสถานะปัจจุบัน + ครั้งล่าสุดของสถานะตรงข้าม               */
/* ------------------------------------------------------------------ */
export interface Brief {
	state: 'up' | 'down' | 'loading';
	since: number | null;
	ms: number | null;
	last: { kind: 'down' | 'up'; start: number; end: number; duration: number } | null;
	/** หยุดทำงานเพราะอัปเดต (ยังไม่นานเกิน UPDATE_MAX_MS): แสดงสีเขียวเข้ม ไม่ถือว่าระบบล่ม */
	upd: boolean;
	updCause: string | null;
}

/** หมายเหตุ: อ่านจาก DB แบบ async จึงเรียกผ่าน `await getBrief(...)` */
export async function getBrief(s: StatusData, now = Date.now()): Promise<Brief> {
	await initHistory();
	const state = s.status === 1 ? 'up' : s.status === 0 ? 'down' : 'loading';

	const cur = (await pool.query<SegRow>(
		`SELECT ${SEG_COLS} FROM segments WHERE service = $1 ORDER BY started_at DESC LIMIT 1`,
		[s.name],
	)).rows[0];
	const isOpen = cur && cur.ended_at === null ? toSeg(cur) : null;

	let since: number | null = null;
	if (state === 'up') since = s.uptime ? now - s.uptime * 1000 : isOpen && isOpen.status === 1 ? isOpen.start : null;
	else if (state === 'down') since = isOpen && isOpen.status === 0 ? isOpen.start : null;

	let last: Brief['last'] = null;
	if (state !== 'loading') {
		const r = (await pool.query<SegRow>(
			`SELECT ${SEG_COLS} FROM segments WHERE service = $1 AND status = $2 ORDER BY started_at DESC LIMIT 1`,
			[s.name, state === 'up' ? 0 : 1],
		)).rows[0];
		if (r) {
			const g = toSeg(r);
			const end = g.end ?? g.lastSeen;
			last = { kind: state === 'up' ? 'down' : 'up', start: g.start, end, duration: Math.max(0, end - g.start) };
		}
	}
	const upd = state === 'down' && !!isOpen && isOpen.status === 0 && isOpen.kind === 'update' && now - isOpen.start <= UPDATE_MAX_MS;
	return { state, since, ms: since !== null ? Math.max(0, now - since) : null, last, upd, updCause: upd ? isOpen!.cause : null };
}

/* ------------------------------------------------------------------ */
/*  Series: ข้อมูลสำหรับกราฟ (รวมเป็น SERIES_POINTS + 1 จุดในช่วงเวลา)    */
/* ------------------------------------------------------------------ */
export interface SeriesPoint {
	ts: number;
	cpu: number | null;
	memMb: number | null;
	ping: number | null;
	uptimeH: number | null;
	downPct: number | null;
	status: number | null;
	/** kbps (เฉพาะ node เพลง) */
	netIn: number | null;
	netOut: number | null;
}

const r1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);

/** คืน SERIES_POINTS + 1 จุดเสมอ ช่วงที่ไม่มีข้อมูลเป็น null (กราฟจะขาดตรงนั้น) */
/** เวลาของตัวอย่างแรกสุดที่เคยบันทึกของ service นี้ (null ถ้ายังไม่มีข้อมูล) */
export async function firstSampleTs(service: string): Promise<number | null> {
	await initHistory();
	const r = (await pool.query<{ t: string | null }>(`SELECT MIN(ts) AS t FROM samples WHERE service = $1`, [service])).rows[0];
	return r?.t == null ? null : Number(r.t);
}

/**
 * startOverride: เวลาเริ่มของช่วง "ทั้งหมด" (ใช้ร่วมกันทุก service ในหน้ากราฟ)
 * ถ้าไม่ระบุ จะเริ่มจากตัวอย่างแรกของ service นั้นเอง
 */
export async function getSeries(service: string, range: Range = '24h', now = Date.now(), startOverride?: number): Promise<SeriesPoint[]> {
	await initHistory();
	let span: number;
	if (range === 'all') {
		const first = startOverride ?? (await firstSampleTs(service)) ?? now;
		span = Math.max(now - first, HOUR);
	} else {
		span = RANGE_MS[range as '24h' | '7d' | '30d'];
	}
	const from = now - span;
	const size = Math.max(span / SERIES_POINTS, 1000);

	const rows = (await pool.query<{ k: number; cpu: number | null; mem: number | null; ping: number | null; up: number | null; dn: number | null; st: number | null; ni: number | null; no: number | null }>(
		`SELECT FLOOR((ts - $2::bigint)::float8 / $3::float8)::int AS k,
		        AVG(cpu)::float8 AS cpu,
		        AVG(mem_used)::float8 AS mem,
		        AVG(ping)::float8 AS ping,
		        AVG(uptime)::float8 AS up,
		        AVG(CASE WHEN status = 0 THEN 100.0 ELSE 0.0 END)::float8 AS dn,
		        MIN(status)::int AS st,
		        AVG(net_in)::float8 AS ni,
		        AVG(net_out)::float8 AS no
		 FROM samples
		 WHERE service = $1 AND ts >= $2::bigint
		 GROUP BY k`,
		[service, from, size],
	)).rows;

	const byK = new Map(rows.map(r => [r.k, r]));
	const out: SeriesPoint[] = [];
	for (let k = 0; k <= SERIES_POINTS; k++) {
		const r = byK.get(k);
		out.push({
			ts: from + k * size + size / 2,
			cpu: r && r.cpu != null ? Math.round(r.cpu * 100) / 100 : null,
			memMb: r && r.mem != null ? r1(r.mem / 1048576) : null,
			ping: r && r.ping != null ? Math.round(r.ping) : null,
			uptimeH: r && r.up != null ? r1(r.up / 3600) : null,
			downPct: r ? r1(r.dn) : null,
			status: r?.st ?? null,
			netIn: r && r.ni != null ? r1(r.ni * 8 / 1000) : null,
			netOut: r && r.no != null ? r1(r.no * 8 / 1000) : null,
		});
	}
	return out;
}

/* ------------------------------------------------------------------ */
/*  Report: ข้อมูลสำหรับหน้าเว็บตามช่วงเวลาที่เลือก                     */
/* ------------------------------------------------------------------ */
export interface Stat { observed: number; down: number; incidents: number; longest: number; pct: number | null }
export interface StripItem {
	left: number;
	width: number;
	status: number;
	start: number;
	end: number;
	open: boolean;
	cause: string | null;
	note: string | null;
	/** ช่วงหยุดทำงานเพราะอัปเดต (ไม่นานเกินกำหนด) */
	upd: boolean;
	/** ช่วงที่ระบบ status ไม่ได้บันทึก = ไม่มีข้อมูล (status = -2) */
	gap: boolean;
}
export interface Incident {
	id: number;
	start: number;
	end: number | null;
	duration: number;
	cause: string | null;
	note: string | null;
	upd: boolean;
}
export interface Report {
	now: number;
	range: Range;
	from: number;
	stat: Stat;
	buckets: { start: number; end: number; observed: number; down: number; upd: number }[];
	strip: StripItem[];
	incidents: Incident[];
	pingFrom: number;
	pings: { ts: number; ping: number }[];
	pingStats: { min: number; avg: number; max: number } | null;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
/** เหมือน overlap แต่หักช่วง "ไม่มีข้อมูล" ออก (ไม่นับเป็น up หรือ down) */
const effOverlap = (a0: number, a1: number, b0: number, b1: number, gaps: { s: number; e: number }[]) => {
	const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
	if (hi <= lo) return 0;
	let o = hi - lo;
	for (const g of gaps) o -= overlap(g.s, g.e, lo, hi);
	return Math.max(0, o);
};
const cache = new Map<string, { at: number; rep: Report }>();

/** หมายเหตุ: อ่านจาก DB แบบ async จึงเรียกผ่าน `await getReport(...)` */
export async function getReport(service: string, range: Range = '30d', now = Date.now()): Promise<Report> {
	const key = `${service}|${range}`;
	const hit = cache.get(key);
	if (hit && now - hit.at < 1500) return hit.rep;
	await initHistory();

	const first = (await pool.query<{ t: string | null }>(`SELECT MIN(started_at) AS t FROM segments WHERE service = $1`, [service])).rows[0]?.t;
	const firstT = first === null || first === undefined ? null : Number(first);
	const span = range === 'all' ? Math.max(now - (firstT ?? now), HOUR) : RANGE_MS[range];
	const from = now - span;

	const segs = (await pool.query<SegRow>(
		`SELECT ${SEG_COLS} FROM segments WHERE service = $1 AND (ended_at IS NULL OR ended_at > $2::bigint) ORDER BY started_at`,
		[service, from],
	)).rows.map(toSeg).map(g => ({
		id: g.id,
		status: g.status,
		start: g.start,
		end: g.end ?? now,
		open: g.end === null,
		cause: g.cause,
		note: g.note,
		// อัปเดตที่ไม่นานเกินกำหนด: นับเป็น downtime ในสถิติ แต่ไม่แสดงว่าระบบล่ม
		upd: g.kind === 'update' && (g.end ?? now) - g.start <= UPDATE_MAX_MS,
	}));

	const gaps = (await pool.query<{ s: string; e: string }>(
		`SELECT started_at AS s, ended_at AS e FROM gaps WHERE service = $1 AND ended_at > $2::bigint ORDER BY started_at`,
		[service, from],
	)).rows.map(r => ({ s: Number(r.s), e: Number(r.e) }));

	let observed = 0, down = 0, incidents = 0, longest = 0;
	for (const g of segs) {
		const o = effOverlap(g.start, g.end, from, now, gaps);
		if (!o) continue;
		observed += o;
		if (g.status === 0) { down += o; incidents++; longest = Math.max(longest, o); }
	}
	const stat: Stat = { observed, down, incidents, longest, pct: observed ? ((observed - down) / observed) * 100 : null };

	const n = BUCKETS[range], size = span / n;
	const buckets = Array.from({ length: n }, (_, i) => {
		const start = from + i * size, end = start + size;
		let ob = 0, dn = 0, up = 0;
		for (const g of segs) {
			const o = effOverlap(g.start, g.end, start, end, gaps);
			ob += o;
			if (g.status === 0) { if (g.upd) up += o; else dn += o; }
		}
		return { start, end, observed: ob, down: dn, upd: up };
	});

	const gapItems: StripItem[] = gaps.filter(g => overlap(g.s, g.e, from, now) > 0).map(g => {
		const s = Math.max(g.s, from), e = Math.min(g.e, now);
		const width = Math.max(((e - s) / span) * 100, 0.3);
		return { left: Math.min(((s - from) / span) * 100, 100 - width), width, status: -2, start: g.s, end: g.e, open: false, cause: null, note: null, upd: false, gap: true };
	});
	const strip: StripItem[] = segs
		.filter(g => overlap(g.start, g.end, from, now) > 0)
		.slice(-500)
		.map(g => {
			const s = Math.max(g.start, from), e = Math.min(g.end, now);
			const width = Math.max(((e - s) / span) * 100, g.status === 0 ? 0.6 : 0.3);
			return {
				left: Math.min(((s - from) / span) * 100, 100 - width),
				width,
				status: g.status,
				start: g.start,
				end: g.end,
				open: g.open,
				cause: g.cause,
				note: g.note,
				upd: g.upd,
				gap: false,
			};
		}).concat(gapItems);

	const incs: Incident[] = segs
		.filter(g => g.status === 0)
		.reverse()
		.slice(0, 10)
		.map(g => ({
			id: g.id,
			start: g.start,
			end: g.open ? null : g.end,
			duration: g.end - g.start,
			cause: g.cause,
			note: g.note,
			upd: g.upd,
		}));

	// ping: รวมเป็น 120 จุดในช่วง (AVG ใน SQL)
	// หมายเหตุ: ต้องกำหนดชนิดพารามิเตอร์ให้ชัด เพราะ psize เป็นทศนิยมได้
	const pingFrom = Math.max(from, now - PING_KEEP_MS);
	const N = 120, psize = Math.max((now - pingFrom) / N, 1);
	const pings = (await pool.query<{ k: number; p: number }>(
		`SELECT CAST(FLOOR((ts - $2::bigint)::float8 / $3::float8) AS INTEGER) AS k, AVG(ping)::float AS p
		 FROM pings WHERE service = $1 AND ts >= $2::bigint GROUP BY k ORDER BY k`,
		[service, pingFrom, psize],
	)).rows.map((r: { k: number; p: number }) => ({ ts: pingFrom + Math.min(r.k, N - 1) * psize + psize / 2, ping: Math.round(r.p) }));

	const ps = (await pool.query<{ mn: number | null; mx: number | null; av: number | null; n: string }>(
		`SELECT MIN(ping) AS mn, MAX(ping) AS mx, AVG(ping)::float AS av, COUNT(*) AS n FROM pings WHERE service = $1 AND ts >= $2::bigint`,
		[service, pingFrom],
	)).rows[0];
	const pingStats = Number(ps.n) > 0 ? { min: ps.mn!, avg: Math.round(ps.av!), max: ps.mx! } : null;

	const rep: Report = { now, range, from, stat, buckets, strip, incidents: incs, pingFrom, pings, pingStats };
	cache.set(key, { at: now, rep });
	return rep;
}

/* ------------------------------------------------------------------ */
/*  Timeline: เหตุการณ์ละเอียดของ service ใน 30 วันล่าสุด (ใหม่สุดก่อน)    */
/* ------------------------------------------------------------------ */
export type TimelineKind = 'up' | 'down' | 'warn' | 'upd' | 'updated' | 'load' | 'gap';
export interface TimelineItem {
	kind: TimelineKind;
	start: number;
	/** null = ยังดำเนินอยู่ */
	end: number | null;
	duration: number;
	cause: string | null;
	note: string | null;
	/** ช่วงนี้เป็นส่วนที่ต่อเนื่องจากช่วงที่เริ่มเมื่อเวลานี้ (ถูกตัดด้วย "ไม่มีข้อมูล") */
	since?: number;
}
const TIMELINE_DAYS = 30;
const TIMELINE_MAX = 400;

export async function getTimeline(service: string, now = Date.now()): Promise<TimelineItem[]> {
	await initHistory();
	const from = now - TIMELINE_DAYS * DAY;
	const segs = (await pool.query<SegRow>(
		`SELECT ${SEG_COLS} FROM segments WHERE service = $1 AND (ended_at IS NULL OR ended_at > $2::bigint) ORDER BY started_at`,
		[service, from])).rows.map(toSeg);
	const gaps = (await pool.query<{ s: string; e: string }>(
		`SELECT started_at AS s, ended_at AS e FROM gaps WHERE service = $1 AND ended_at > $2::bigint`, [service, from])).rows;
	const gapList = gaps.map(x => ({ s: Number(x.s), e: Number(x.e) })).sort((a, b) => a.s - b.s);
	const items: TimelineItem[] = segs.flatMap(g => {
		const end = g.end;
		const dur = (end ?? now) - g.start;
		let kind: TimelineKind;
		if (g.status === 1) kind = 'up';
		else if (g.status === -1) kind = 'load';
		// อัปเดตที่ไม่นานเกินกำหนด: กำลังอัปเดต (เขียวเข้ม) / อัปเดตแล้ว (เขียวเข้ม) นานเกิน: แดงเหมือนล่มจริง
		else if (g.kind === 'update' && dur <= UPDATE_MAX_MS) kind = end === null ? 'upd' : 'updated';
		else kind = dur < 5 * 60_000 ? 'warn' : 'down';
		// ช่วง "ไม่มีข้อมูล" ที่อยู่ในช่วงนี้ตัดช่วงออกเป็นส่วนๆ เพื่อให้เรียงตามเวลาจริง (ต่อเนื่องตามนาฬิกา แต่แสดงแยกตามรอยขาด)
		const pieces: { a: number; b: number }[] = [];
		let cur = g.start;
		const segEnd = end ?? now;
		for (const x of gapList) {
			if (x.e <= cur || x.s >= segEnd) continue;
			if (x.s > cur) pieces.push({ a: cur, b: x.s });
			cur = Math.max(cur, x.e);
		}
		if (cur < segEnd || !pieces.length) pieces.push({ a: cur, b: segEnd });
		return pieces.map((p, i) => ({
			kind, start: p.a, end: end === null && i === pieces.length - 1 ? null : p.b, duration: p.b - p.a,
			cause: g.status === 0 ? g.cause : null, note: g.note, since: p.a !== g.start ? g.start : undefined,
		}));
	});
	for (const x of gapList) items.push({ kind: 'gap', start: x.s, end: x.e, duration: x.e - x.s, cause: null, note: null });
	return items.sort((a, b) => b.start - a.start).slice(0, TIMELINE_MAX);
}

/* ---------- ฟังก์ชันสำหรับหน้าแอดมิน ---------- */

/** เหตุการณ์หยุดทำงานล่าสุดของทุก service (สำหรับให้แอดมินใส่สาเหตุ/หมายเหตุ) */
export async function recentDowns(limit = 40): Promise<{ id: number; service: string; start: number; end: number | null; cause: string | null; note: string | null; kind: string | null }[]> {
	await initHistory();
	const rows = (await pool.query<SegRow & { service: string }>(
		`SELECT id, service, status, started_at, ended_at, last_seen, cause, note, kind
		 FROM segments WHERE status = 0 ORDER BY started_at DESC LIMIT $1`,
		[limit],
	)).rows;
	return rows.map(r => ({
		id: Number(r.id),
		service: r.service,
		start: Number(r.started_at),
		end: r.ended_at === null ? null : Number(r.ended_at),
		cause: r.cause,
		note: r.note,
		kind: r.kind,
	}));
}

/** แก้สาเหตุ/หมายเหตุของช่วงหยุดทำงาน 1 ครั้ง */
export async function setSegmentNote(id: number, cause: string | null, note: string | null, kind: 'update' | null = null): Promise<boolean> {
	await initHistory();
	const r = await pool.query(`UPDATE segments SET cause = $2, note = $3, kind = $5, note_at = $4 WHERE id = $1`, [id, cause, note, Date.now(), kind]);
	cache.clear();
	return (r.rowCount ?? 0) > 0;
}

/** ช่วงหยุดทำงาน 1 รายการ (สำหรับหน้าแก้ไขของแอดมิน) */
export async function getSegment(id: number): Promise<{ id: number; service: string; start: number; end: number | null; cause: string | null; note: string | null; kind: string | null } | null> {
	await initHistory();
	const r = (await pool.query<SegRow & { service: string }>(
		`SELECT id, service, status, started_at, ended_at, last_seen, cause, note, kind FROM segments WHERE id = $1 AND status = 0`,
		[id],
	)).rows[0];
	if (!r) return null;
	return {
		id: Number(r.id),
		service: r.service,
		start: Number(r.started_at),
		end: r.ended_at === null ? null : Number(r.ended_at),
		cause: r.cause,
		note: r.note,
		kind: r.kind,
	};
}
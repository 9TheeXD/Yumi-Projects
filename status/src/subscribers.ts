import pg from 'pg';
import crypto from 'node:crypto';
import { sendRaw } from './mail.js';
import { initHistory } from './history.js';
import { FONT, mailButton, mailDoc, mailHeader, nowTh } from './mail-theme.js';
import { DEFAULT_PREFS, isLang, isTimeZone, prefs, t, type Prefs } from './i18n.js';

/**
 * ระบบผู้รับอีเมลแบบ double opt-in
 *   pending  -> ใส่อีเมลแล้ว รอกดลิงก์ยืนยัน
 *   active   -> ยืนยันแล้ว ได้รับอีเมลทั้งหมด
 *   revoked  -> กดยกเลิกแล้ว ไม่ได้รับอีกจนกว่าจะสมัครใหม่
 */
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 5_000 });

const PUBLIC_URL = (process.env.STATUS_PAGE_URL || '').replace(/\/$/, '');
const TOKEN_TTL_MS = 48 * 3_600_000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export const normalizeEmail = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
export const isValidEmail = (e: string) => e.length <= 254 && EMAIL_RE.test(e);

let ready: Promise<void> | null = null;
export function initSubscribers(): Promise<void> {
	if (!ready) {
		ready = (async () => {
			await initHistory();
			await pool.query(`
				CREATE TABLE IF NOT EXISTS subscribers(
					id BIGSERIAL PRIMARY KEY,
					email TEXT NOT NULL UNIQUE,
					status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
					confirm_token TEXT,
					confirm_expires BIGINT,
					unsub_token TEXT NOT NULL UNIQUE,
					created_at BIGINT NOT NULL,
					confirmed_at BIGINT,
					revoked_at BIGINT
				);
				CREATE INDEX IF NOT EXISTS idx_sub_status ON subscribers(status);
				CREATE INDEX IF NOT EXISTS idx_sub_confirm ON subscribers(confirm_token);
				-- ภาษาและเขตเวลาของอีเมลแต่ละคน (ตามการตั้งค่าบนหน้าเว็บ)
				ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS lang TEXT;
				ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS tz TEXT;
				ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS h12 BOOLEAN;
			`);
		})();
		ready.catch(() => { ready = null; });
	}
	return ready;
}

const token = () => crypto.randomBytes(32).toString('base64url');

/** ผลลัพธ์ให้หน้าเว็บแสดงผล โดยไม่บอกว่าอีเมลนี้มีในระบบหรือไม่ (กันการไล่หาอีเมล) */
export type SubscribeResult = 'sent' | 'invalid' | 'already';

export async function requestSubscribe(raw: unknown): Promise<SubscribeResult> {
	await initSubscribers();
	const email = normalizeEmail(raw);
	if (!isValidEmail(email)) return 'invalid';
	const p = prefs();

	const existing = (await pool.query<{ status: string }>(`SELECT status FROM subscribers WHERE email = $1`, [email])).rows[0];
	if (existing?.status === 'active') {
		// ไม่บอกว่ามีอยู่แล้ว ส่งอีเมลเตือนแทน เพื่อไม่ให้รู้ว่าใครสมัครอยู่
		await sendRaw(email, t('ma_subject'), `<p>${t('ma_body')}</p>`, t('ma_body'));
		return 'already';
	}

	const confirm = token();
	const now = Date.now();
	const row = (await pool.query<{ unsub_token: string }>(
		`INSERT INTO subscribers(email, status, confirm_token, confirm_expires, unsub_token, created_at, lang, tz, h12)
		 VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (email) DO UPDATE SET status = 'pending', confirm_token = EXCLUDED.confirm_token,
		   confirm_expires = EXCLUDED.confirm_expires, revoked_at = NULL,
		   lang = EXCLUDED.lang, tz = EXCLUDED.tz, h12 = EXCLUDED.h12
		 RETURNING unsub_token`,
		[email, confirm, now + TOKEN_TTL_MS, token(), now, p.lang, p.tz, p.h12],
	)).rows[0];

	const link = `${PUBLIC_URL}/subscribe/confirm?token=${confirm}`;
	await sendRaw(email, t('mc_subject'), confirmHtml(link), confirmText(link), { 'List-Unsubscribe': `<${PUBLIC_URL}/subscribe/unsubscribe?token=${row.unsub_token}>` });
	return 'sent';
}

/** กดลิงก์ยืนยันในอีเมล */
/** กดลิงก์ยืนยันในอีเมล: คืน unsub token ด้วย เพื่อให้อุปกรณ์นี้จัดการการรับอีเมลได้จากหน้าตั้งค่า */
export async function confirmSubscribe(tok: unknown): Promise<{ result: 'ok' | 'invalid' | 'expired'; unsubToken?: string }> {
	await initSubscribers();
	if (typeof tok !== 'string' || tok.length < 20) return { result: 'invalid' };
	const r = (await pool.query<{ unsub_token: string }>(
		`UPDATE subscribers SET status = 'active', confirmed_at = $2, confirm_token = NULL
		 WHERE confirm_token = $1 AND status = 'pending' AND confirm_expires > $2
		 RETURNING unsub_token`,
		[tok, Date.now()],
	)).rows[0];
	if (r) return { result: 'ok', unsubToken: r.unsub_token };
	const expired = (await pool.query(`SELECT 1 FROM subscribers WHERE confirm_token = $1 AND status = 'pending'`, [tok])).rowCount;
	return { result: expired ? 'expired' : 'invalid' };
}

/** ผู้รับที่ยังรับอยู่ จาก unsub token (cookie ys_sub ของอุปกรณ์) */
export async function subscriberByToken(tok: unknown): Promise<{ email: string } | null> {
	if (typeof tok !== 'string' || tok.length < 20) return null;
	await initSubscribers();
	const r = (await pool.query<{ email: string }>(`SELECT email FROM subscribers WHERE unsub_token = $1 AND status = 'active'`, [tok])).rows[0];
	return r ?? null;
}

/** อัปเดตภาษาและเขตเวลาของอีเมล ตามที่ผู้ใช้ตั้งบนหน้าเว็บ */
export async function updateSubscriberPrefs(tok: unknown, p: { lang: string; tz: string; h12: boolean | null }): Promise<boolean> {
	if (typeof tok !== 'string' || tok.length < 20) return false;
	await initSubscribers();
	const r = await pool.query(`UPDATE subscribers SET lang = $2, tz = $3, h12 = $4 WHERE unsub_token = $1 AND status = 'active'`, [tok, p.lang, p.tz, p.h12]);
	return (r.rowCount ?? 0) > 0;
}

/** กดลิงก์ยกเลิกในอีเมลหรือจาก List-Unsubscribe */
export async function unsubscribe(t: unknown): Promise<boolean> {
	await initSubscribers();
	if (typeof t !== 'string' || t.length < 20) return false;
	const r = await pool.query(
		`UPDATE subscribers SET status = 'revoked', revoked_at = $2 WHERE unsub_token = $1 AND status <> 'revoked'`,
		[t, Date.now()],
	);
	return (r.rowCount ?? 0) > 0;
}

/** อีเมลทุกคนที่ยืนยันแล้ว พร้อมลิงก์ยกเลิกของแต่ละคน */
export async function activeRecipients(): Promise<{ email: string; unsubUrl: string; prefs: Prefs }[]> {
	await initSubscribers();
	const rows = (await pool.query<{ email: string; unsub_token: string; lang: string | null; tz: string | null; h12: boolean | null }>(
		`SELECT email, unsub_token, lang, tz, h12 FROM subscribers WHERE status = 'active' ORDER BY id`,
	)).rows;
	return rows.map(r => ({
		email: r.email,
		unsubUrl: `${PUBLIC_URL}/subscribe/unsubscribe?token=${r.unsub_token}`,
		prefs: { ...DEFAULT_PREFS, lang: isLang(r.lang) ? r.lang : DEFAULT_PREFS.lang, tz: isTimeZone(r.tz) ? r.tz : DEFAULT_PREFS.tz, h12: r.h12 ?? DEFAULT_PREFS.h12 },
	}));
}

export async function countActive(): Promise<number> {
	await initSubscribers();
	return Number((await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM subscribers WHERE status = 'active'`)).rows[0].n);
}

const confirmHtml = (link: string) => mailDoc(t('mc_subject'), `
${mailHeader(nowTh())}
<tr><td style="padding:0 0 18px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="card" style="background:#ffffff;border:1px solid #e7e0e1;border-radius:20px">
<tr><td style="padding:28px 26px;font-family:${FONT}">
	<div class="t-load" style="font-size:13px;color:#0b6e99">${t('mc_kicker')}</div>
	<div class="ink" style="margin-top:6px;font-size:24px;font-weight:700;line-height:1.3;color:#1d1719">${t('mc_title')}</div>
	<div class="mut" style="margin-top:10px;font-size:15px;font-weight:300;line-height:1.7;color:#5f5355">${t('mc_body')}</div>
	<div style="margin:24px 0 6px 0;text-align:center">${mailButton(link, t('mc_button'))}</div>
	<div class="dim" style="margin-top:14px;font-size:12px;line-height:1.7;color:#7d7072">${t('mc_copy')} <span style="word-break:break-all">${link}</span></div>
	<div class="dim" style="margin-top:12px;font-size:12px;line-height:1.7;color:#7d7072">${t('mc_ignore')}</div>
</td></tr></table>
</td></tr>`, t('mc_pre'));

const confirmText = (link: string) => `${t('mc_subject')}\n\n${t('mc_text')}\n${link}\n\n${t('mc_ignore')}`;

/* ---------- ฟังก์ชันสำหรับหน้าแอดมิน ---------- */

export async function adminCounts(): Promise<{ active: number; pending: number; revoked: number }> {
	await initSubscribers();
	const rows = (await pool.query<{ status: string; n: string }>(`SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status`)).rows;
	const out = { active: 0, pending: 0, revoked: 0 };
	for (const r of rows) if (r.status === 'active' || r.status === 'pending' || r.status === 'revoked') out[r.status] = Number(r.n);
	return out;
}

export async function adminListSubscribers(limit = 100): Promise<{ id: string; email: string; status: string; created_at: string }[]> {
	await initSubscribers();
	return (await pool.query<{ id: string; email: string; status: string; created_at: string }>(
		`SELECT id, email, status, created_at FROM subscribers ORDER BY id DESC LIMIT $1`,
		[Math.min(Math.max(limit, 1), 500)],
	)).rows;
}

/** ยกเลิกการรับอีเมลของผู้ใช้คนหนึ่ง (ไม่ส่งอีเมลอีก) */
export async function adminRevoke(id: number): Promise<void> {
	await initSubscribers();
	await pool.query(`UPDATE subscribers SET status = 'revoked', revoked_at = $2 WHERE id = $1 AND status <> 'revoked'`, [id, Date.now()]);
}

/** ลบผู้ใช้ออกจากระบบทั้งหมด */
export async function adminDeleteSubscriber(id: number): Promise<void> {
	await initSubscribers();
	await pool.query(`DELETE FROM subscribers WHERE id = $1`, [id]);
}

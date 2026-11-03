import crypto from 'node:crypto';
import { pool, initSubscribers, isValidEmail, normalizeEmail } from './subscribers.js';
import { sendRaw } from './mail.js';
import { FONT, mailDoc, mailHeader, nowTh } from './mail-theme.js';
import { isLang, isTimeZone, prefs, t, type Prefs } from './i18n.js';

/**
 * บัญชีผู้ใช้หน้า status (ไม่บังคับ) เข้าสู่ระบบด้วยรหัส 6 หลักทางอีเมล ไม่มีรหัสผ่าน
 *   - ยังไม่เข้าสู่ระบบ: การตั้งค่าอยู่ใน cookie ของเบราว์เซอร์
 *   - เข้าสู่ระบบแล้ว: การตั้งค่าเก็บใน users และซิงก์ทุกอุปกรณ์ เปิด/ปิดอีเมลแจ้งเตือนได้
 * รหัสและ session เก็บเป็น hash เท่านั้น
 */

const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_TRIES = 5;
const RESEND_MS = 60_000;
const SENDS_PER_HOUR = 5;
export const SESSION_DAYS = 180;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const codeHash = (email: string, code: string) => sha(`${email}\n${code}`);

let ready: Promise<void> | null = null;
export function initAccounts(): Promise<void> {
	if (!ready) {
		ready = (async () => {
			await initSubscribers();
			await pool.query(`
				CREATE TABLE IF NOT EXISTS users(
					id BIGSERIAL PRIMARY KEY,
					email TEXT NOT NULL UNIQUE,
					-- ค่า NULL = ใช้ค่าของอุปกรณ์
					lang TEXT, tz TEXT, h12 TEXT, refresh BOOLEAN, calm BOOLEAN,
					created_at BIGINT NOT NULL,
					last_login_at BIGINT
				);
				CREATE TABLE IF NOT EXISTS user_sessions(
					token_hash TEXT PRIMARY KEY,
					user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
					created_at BIGINT NOT NULL,
					expires_at BIGINT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_sess_user ON user_sessions(user_id);
				CREATE TABLE IF NOT EXISTS login_codes(
					email TEXT PRIMARY KEY,
					code_hash TEXT NOT NULL,
					expires_at BIGINT NOT NULL,
					tries INT NOT NULL DEFAULT 0,
					sent_at BIGINT NOT NULL,
					hour_start BIGINT NOT NULL,
					hour_sends INT NOT NULL DEFAULT 1
				);
			`);
		})();
		ready.catch(() => { ready = null; });
	}
	return ready;
}

/* ---------- ขอรหัส ---------- */

export type CodeResult = { ok: true } | { ok: false; error: 'invalid' } | { ok: false; error: 'wait'; wait: number };

export async function requestCode(raw: unknown): Promise<CodeResult> {
	await initAccounts();
	const email = normalizeEmail(raw);
	if (!isValidEmail(email)) return { ok: false, error: 'invalid' };
	const now = Date.now();
	const prev = (await pool.query<{ sent_at: string; hour_start: string; hour_sends: number }>(
		`SELECT sent_at, hour_start, hour_sends FROM login_codes WHERE email = $1`, [email])).rows[0];
	let hourStart = now, hourSends = 1;
	if (prev) {
		const sentAt = Number(prev.sent_at), hs = Number(prev.hour_start);
		if (now - sentAt < RESEND_MS) return { ok: false, error: 'wait', wait: Math.ceil((RESEND_MS - (now - sentAt)) / 1000) };
		if (now - hs < 3_600_000) {
			if (prev.hour_sends >= SENDS_PER_HOUR) return { ok: false, error: 'wait', wait: Math.ceil((3_600_000 - (now - hs)) / 1000) };
			hourStart = hs; hourSends = prev.hour_sends + 1;
		}
	}
	const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
	await pool.query(
		`INSERT INTO login_codes(email, code_hash, expires_at, tries, sent_at, hour_start, hour_sends)
		 VALUES ($1, $2, $3, 0, $4, $5, $6)
		 ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, tries = 0,
		   sent_at = EXCLUDED.sent_at, hour_start = EXCLUDED.hour_start, hour_sends = EXCLUDED.hour_sends`,
		[email, codeHash(email, code), now + CODE_TTL_MS, now, hourStart, hourSends],
	);
	await sendRaw(email, t('lo_subject', { code }), codeHtml(code), `${t('lo_title')}: ${code}\n\n${t('lo_body')}\n\n${t('lo_ignore')}`);
	return { ok: true };
}

/* ---------- ยืนยันรหัส ---------- */

export type VerifyResult = { ok: true; token: string; user: User; created: boolean } | { ok: false; error: 'bad' | 'expired' };

export async function verifyCode(rawEmail: unknown, rawCode: unknown): Promise<VerifyResult> {
	await initAccounts();
	const email = normalizeEmail(rawEmail);
	const code = String(rawCode ?? '').replace(/\D/g, '');
	if (!isValidEmail(email) || code.length !== 6) return { ok: false, error: 'bad' };
	const now = Date.now();
	const row = (await pool.query<{ code_hash: string; expires_at: string; tries: number }>(
		`SELECT code_hash, expires_at, tries FROM login_codes WHERE email = $1`, [email])).rows[0];
	if (!row || Number(row.expires_at) < now || row.tries >= CODE_MAX_TRIES) return { ok: false, error: 'expired' };
	const good = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(codeHash(email, code)));
	if (!good) {
		await pool.query(`UPDATE login_codes SET tries = tries + 1 WHERE email = $1`, [email]);
		return { ok: false, error: row.tries + 1 >= CODE_MAX_TRIES ? 'expired' : 'bad' };
	}
	// ใช้รหัสได้ครั้งเดียว แต่เก็บเวลาส่งไว้ให้ rate limit ยังทำงาน
	await pool.query(`UPDATE login_codes SET expires_at = 0 WHERE email = $1`, [email]);

	// บัญชีใหม่รับการตั้งค่าปัจจุบันของอุปกรณ์นี้ไปเลย
	const p = prefs();
	const ins = await pool.query<{ id: string }>(
		`INSERT INTO users(email, lang, tz, h12, refresh, calm, created_at, last_login_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
		 ON CONFLICT (email) DO NOTHING RETURNING id`,
		[email, p.lang, p.tz, h12Text(p.h12), p.refresh, p.calm, now],
	);
	const created = (ins.rowCount ?? 0) > 0;
	if (!created) await pool.query(`UPDATE users SET last_login_at = $2 WHERE email = $1`, [email, now]);
	const user = (await loadUser(`u.email = $1`, [email]))!;

	const token = crypto.randomBytes(32).toString('base64url');
	await pool.query(`INSERT INTO user_sessions(token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
		[sha(token), user.id, now, now + SESSION_DAYS * 86_400_000]);
	await pool.query(`DELETE FROM user_sessions WHERE expires_at < $1`, [now]);
	return { ok: true, token, user, created };
}

/* ---------- ผู้ใช้และ session ---------- */

export type User = {
	id: string; email: string; subscribed: boolean;
	lang: string | null; tz: string | null; h12: string | null; refresh: boolean | null; calm: boolean | null;
};

async function loadUser(where: string, args: unknown[]): Promise<User | null> {
	const r = (await pool.query<User>(
		`SELECT u.id::text AS id, u.email, u.lang, u.tz, u.h12, u.refresh, u.calm,
		        COALESCE(s.status = 'active', false) AS subscribed
		 FROM users u LEFT JOIN subscribers s ON s.email = u.email WHERE ${where}`, args)).rows[0];
	return r ?? null;
}

// cache สั้น ๆ เพราะทุกหน้าเว็บต้องรู้ว่าใครเข้าสู่ระบบอยู่
const cache = new Map<string, { at: number; user: User | null }>();
export function forgetSession(token?: string) { if (token) cache.delete(sha(token)); else cache.clear(); }

export async function userBySession(token: unknown): Promise<User | null> {
	if (typeof token !== 'string' || token.length < 30 || token.length > 100) return null;
	const h = sha(token);
	const c = cache.get(h);
	if (c && Date.now() - c.at < 30_000) return c.user;
	await initAccounts();
	const user = await loadUser(`u.id = (SELECT user_id FROM user_sessions WHERE token_hash = $1 AND expires_at > $2)`, [h, Date.now()]);
	if (cache.size > 2000) cache.clear();
	cache.set(h, { at: Date.now(), user });
	return user;
}

export async function logout(token: unknown): Promise<void> {
	if (typeof token !== 'string') return;
	await initAccounts();
	await pool.query(`DELETE FROM user_sessions WHERE token_hash = $1`, [sha(token)]);
	forgetSession(token);
}

const h12Text = (v: boolean | null) => (v === null ? 'auto' : v ? '12' : '24');

/** การตั้งค่าที่ใช้จริง: ค่าในบัญชี (ถ้ามี) ทับค่าใน cookie */
export function mergePrefs(p: Prefs, u: User): Prefs {
	return {
		...p,
		lang: isLang(u.lang) ? u.lang : p.lang,
		tz: isTimeZone(u.tz) ? u.tz : p.tz,
		h12: u.h12 === '12' ? true : u.h12 === '24' ? false : u.h12 === 'auto' ? null : p.h12,
		refresh: u.refresh ?? p.refresh,
		calm: u.calm ?? p.calm,
	};
}

/** บันทึกการตั้งค่าลงบัญชี (reset = กลับไปใช้ค่าของอุปกรณ์) และให้อีเมลแจ้งเตือนใช้ภาษา/เขตเวลาเดียวกัน */
export async function saveUserPrefs(u: User, p: Prefs | null): Promise<void> {
	if (p) {
		await pool.query(`UPDATE users SET lang = $2, tz = $3, h12 = $4, refresh = $5, calm = $6 WHERE id = $1`,
			[u.id, p.lang, p.tz, h12Text(p.h12), p.refresh, p.calm]);
		await pool.query(`UPDATE subscribers SET lang = $2, tz = $3, h12 = $4 WHERE email = $1`, [u.email, p.lang, p.tz, p.h12]);
	} else {
		await pool.query(`UPDATE users SET lang = NULL, tz = NULL, h12 = NULL, refresh = NULL, calm = NULL WHERE id = $1`, [u.id]);
	}
	forgetSession();
}

/** เปิด/ปิดอีเมลแจ้งเตือนของบัญชี (อีเมลยืนยันแล้วตอนเข้าสู่ระบบ จึงไม่ต้องส่งลิงก์ยืนยันอีก) */
export async function setSubscribed(u: User, on: boolean, p: Prefs): Promise<void> {
	const now = Date.now();
	if (on) {
		await pool.query(
			`INSERT INTO subscribers(email, status, unsub_token, created_at, confirmed_at, lang, tz, h12)
			 VALUES ($1, 'active', $2, $3, $3, $4, $5, $6)
			 ON CONFLICT (email) DO UPDATE SET status = 'active', confirmed_at = $3, confirm_token = NULL, revoked_at = NULL,
			   lang = EXCLUDED.lang, tz = EXCLUDED.tz, h12 = EXCLUDED.h12`,
			[u.email, crypto.randomBytes(32).toString('base64url'), now, p.lang, p.tz, p.h12],
		);
	} else {
		await pool.query(`UPDATE subscribers SET status = 'revoked', revoked_at = $2 WHERE email = $1 AND status <> 'revoked'`, [u.email, now]);
	}
	forgetSession();
}

const codeHtml = (code: string) => mailDoc(t('lo_subject', { code }), `
${mailHeader(nowTh())}
<tr><td style="padding:0 0 18px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="card" style="background:#ffffff;border:1px solid #e7e0e1;border-radius:20px">
<tr><td style="padding:28px 26px;font-family:${FONT}">
	<div class="ink" style="font-size:22px;font-weight:700;line-height:1.3;color:#1d1719">${t('lo_title')}</div>
	<div class="mut" style="margin-top:10px;font-size:15px;font-weight:300;line-height:1.7;color:#5f5355">${t('lo_body')}</div>
	<div style="margin:22px 0 4px 0;text-align:center"><span class="ink" style="display:inline-block;padding:14px 22px;border-radius:14px;background:#f6f1f2;border:1px solid #e7e0e1;font-family:Consolas,'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:#1d1719">${code}</span></div>
	<div class="dim" style="margin-top:18px;font-size:12px;line-height:1.7;color:#7d7072">${t('lo_ignore')}</div>
</td></tr></table>
</td></tr>`, t('lo_title'));

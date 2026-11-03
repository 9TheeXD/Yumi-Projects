import { AsyncLocalStorage } from 'node:async_hooks';
import { STRINGS } from './strings.js';

/* ------------------------------------------------------------------ */
/*  การตั้งค่าของผู้ใช้ (ภาษา, เขตเวลา, รูปแบบเวลา ฯลฯ)                    */
/*  เก็บใน cookie ของเบราว์เซอร์ และของผู้รับอีเมลเก็บใน DB                */
/*  ใช้ AsyncLocalStorage: ทุกฟังก์ชันจัดรูปแบบอ่านค่าของคำขอนั้นเอง       */
/*  นอกคำขอ (Discord, งานเบื้องหลัง) ใช้ค่าเริ่มต้น ไทย / Asia/Bangkok      */
/* ------------------------------------------------------------------ */

export const LANGS = [
	{ code: 'th', name: 'ไทย', en: 'Thai', flag: 'th', locale: 'th-TH' },
	{ code: 'en', name: 'English', en: 'English', flag: 'gb', locale: 'en-GB' },
	{ code: 'ja', name: '日本語', en: 'Japanese', flag: 'jp', locale: 'ja-JP' },
	{ code: 'ko', name: '한국어', en: 'Korean', flag: 'kr', locale: 'ko-KR' },
	{ code: 'zh', name: '简体中文', en: 'Chinese (Simplified)', flag: 'cn', locale: 'zh-CN' },
	{ code: 'vi', name: 'Tiếng Việt', en: 'Vietnamese', flag: 'vn', locale: 'vi-VN' },
	{ code: 'id', name: 'Bahasa Indonesia', en: 'Indonesian', flag: 'id', locale: 'id-ID' },
	{ code: 'es', name: 'Español', en: 'Spanish', flag: 'es', locale: 'es-ES' },
	{ code: 'fr', name: 'Français', en: 'French', flag: 'fr', locale: 'fr-FR' },
	{ code: 'de', name: 'Deutsch', en: 'German', flag: 'de', locale: 'de-DE' },
] as const;
export type Lang = typeof LANGS[number]['code'];
const LANG_CODES = LANGS.map(l => l.code) as readonly string[];
export const isLang = (v: unknown): v is Lang => typeof v === 'string' && LANG_CODES.includes(v);

export type Prefs = {
	lang: Lang;
	/** IANA time zone เช่น Asia/Bangkok */
	tz: string;
	/** true = 12 ชม., false = 24 ชม., null = ตามภาษา */
	h12: boolean | null;
	/** อัปเดตหน้าอัตโนมัติทุก 5 วินาที */
	refresh: boolean;
	/** ลดภาพเคลื่อนไหว */
	calm: boolean;
	/** ผู้ใช้ที่เข้าสู่ระบบอยู่ (cookie ys_auth) */
	user?: { email: string; subscribed: boolean } | null;
};
export const DEFAULT_PREFS: Prefs = { lang: 'th', tz: 'Asia/Bangkok', h12: false, refresh: true, calm: false };

const als = new AsyncLocalStorage<Prefs>();
export const prefs = (): Prefs => als.getStore() ?? DEFAULT_PREFS;
export const withPrefs = <T>(p: Prefs, fn: () => T): T => als.run(p, fn);
export const localeOf = (lang: Lang = prefs().lang) => LANGS.find(l => l.code === lang)?.locale ?? 'th-TH';

export function isTimeZone(tz: unknown): tz is string {
	if (typeof tz !== 'string' || tz.length > 64) return false;
	try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** ภาษาที่ใกล้ที่สุดจาก Accept-Language (ใช้ตอนที่ยังไม่มี cookie) */
export function negotiateLang(header: unknown): Lang {
	const list = String(header ?? '').split(',').map(p => {
		const [tag, q] = p.trim().split(';q=');
		return { tag: tag.toLowerCase(), q: q ? Number(q) : 1 };
	}).filter(x => x.tag).sort((a, b) => b.q - a.q);
	for (const { tag } of list) {
		const base = tag.split('-')[0];
		if (isLang(base)) return base;
	}
	return DEFAULT_PREFS.lang;
}

export function parseCookies(header: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of String(header ?? '').split(';')) {
		const i = part.indexOf('=');
		if (i < 0) continue;
		const k = part.slice(0, i).trim();
		try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ข้ามค่าที่เสีย */ }
	}
	return out;
}

/** ค่าจาก cookie (ys_lang, ys_tz, ys_h12, ys_refresh, ys_calm) แล้วเติมค่าที่ขาดจาก header */
export function prefsFromRequest(req: { headers: Record<string, unknown> }): Prefs & { known: boolean } {
	const c = parseCookies(req.headers.cookie);
	const lang = isLang(c.ys_lang) ? c.ys_lang : negotiateLang(req.headers['accept-language']);
	const tz = isTimeZone(c.ys_tz) ? c.ys_tz : DEFAULT_PREFS.tz;
	const h12 = c.ys_h12 === '12' ? true : c.ys_h12 === '24' ? false : null;
	return {
		lang, tz, h12,
		refresh: c.ys_refresh !== '0',
		calm: c.ys_calm === '1',
		known: isTimeZone(c.ys_tz) && isLang(c.ys_lang),
	};
}

/* ------------------------------------------------------------------ */
/*  ข้อความ                                                              */
/* ------------------------------------------------------------------ */

export type Key = keyof typeof STRINGS;

/** ข้อความตามภาษาของผู้ใช้ แทนค่า {name} จาก vars (ถ้าภาษานั้นไม่มี ใช้อังกฤษ แล้วไทย) */
export function t(key: Key, vars: Record<string, string | number> = {}, lang: Lang = prefs().lang): string {
	const row = STRINGS[key] as Partial<Record<Lang, string>>;
	const s = row[lang] ?? row.en ?? row.th ?? String(key);
	return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** ข้อความหลายคีย์สำหรับสคริปต์ฝั่งเบราว์เซอร์ */
export const tMany = (keys: Key[]) => Object.fromEntries(keys.map(k => [k, t(k)]));

/* ------------------------------------------------------------------ */
/*  วันที่ เวลา และระยะเวลา ตามภาษาและเขตเวลาของผู้ใช้                       */
/* ------------------------------------------------------------------ */

const hourOpt = () => (prefs().h12 === null ? {} : { hour12: prefs().h12 as boolean });

/** "20 ต.ค. 14:03" */
export const fmtDate = (ts: number) => new Date(ts).toLocaleString(localeOf(), {
	timeZone: prefs().tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...hourOpt(),
});
/** "20 ต.ค." */
export const fmtDay = (ts: number) => new Date(ts).toLocaleDateString(localeOf(), { timeZone: prefs().tz, day: 'numeric', month: 'short' });
/** "30 ตุลาคม 2569 เวลา 14:03" */
export const fmtLong = (ts: number = Date.now()) => new Date(ts).toLocaleString(localeOf(), {
	timeZone: prefs().tz, dateStyle: 'long', timeStyle: 'short', ...hourOpt(),
});

/** ชื่อเขตเวลาสำหรับแสดง เช่น "Asia/Bangkok (GMT+7)" */
export function tzLabel(tz: string = prefs().tz): string {
	try {
		const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
			.formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? '';
		return `${tz.replace(/_/g, ' ')} (${off})`;
	} catch { return tz; }
}

/** ระยะเวลา 2 หน่วยบนสุด เช่น "3 วัน 4 ชม." / "3 d 4 h" (ใช้ Intl ของแต่ละภาษา) */
export function fmtDur(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const parts: [number, 'day' | 'hour' | 'minute' | 'second'][] = [
		[Math.floor(s / 86400), 'day'], [Math.floor((s % 86400) / 3600), 'hour'], [Math.floor((s % 3600) / 60), 'minute'], [s % 60, 'second'],
	];
	const loc = localeOf();
	const one = (v: number, unit: string) => new Intl.NumberFormat(loc, { style: 'unit', unit, unitDisplay: 'short' }).format(v);
	const shown = parts.filter(([v]) => v > 0).slice(0, 2).map(([v, u]) => one(v, u));
	return shown.length ? shown.join(' ') : one(0, 'second');
}

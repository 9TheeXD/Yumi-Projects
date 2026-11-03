import { capitalize } from 'global/common-functions';
import { fmtDate, fmtDay, fmtDur, t } from './i18n.js';

/** ชื่อแสดงผลภาษาไทยของแต่ละ service (ถ้าไม่อยู่ในรายการจะใช้ชื่อเดิมจัดรูปแบบให้) */
const NAMES_TH: Record<string, string> = {
	bot: 'Main Bot',
	backend: 'Backend',
	frontend_main: 'Website',
	database: 'Database',
	nodes: 'Music Nodes',
};
export const displayName = (n: string) => NAMES_TH[n] ?? capitalize(n.split('_').join(' '));

/* ชื่อเดิมยังใช้ได้ทุกที่ แต่ตอนนี้แสดงตามภาษาและเขตเวลาของผู้ใช้ (i18n.ts)
 * นอกคำขอของผู้ใช้ (Discord, งานเบื้องหลัง) ยังเป็นภาษาไทย เวลาไทยเหมือนเดิม */
export const fmtDurTh = (ms: number) => fmtDur(ms);
export const fmtDateTh = (ts: number) => fmtDate(ts);
export const fmtDayTh = (ts: number) => fmtDay(ts);

export const stateTh = (s: number) =>
	s === 1 ? { key: 'ok', label: t('state_ok') } : s === -1 ? { key: 'load', label: t('state_load') } : { key: 'down', label: t('state_down') };

/** 99.9876 -> "99.98%" (ปัดลง เพื่อไม่ให้โชว์ 100% ทั้งที่เคยล่ม) */
export const fmtPct = (p: number | null) => (p === null ? '—' : p >= 100 ? '100%' : `${(Math.floor(p * 100) / 100).toFixed(2)}%`);
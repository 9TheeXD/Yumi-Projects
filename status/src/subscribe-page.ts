import { t } from './i18n.js';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const ICON = {
	mail: '<svg viewBox="0 0 24 24"><path d="M4 6h16v12H4zM4 7l8 6 8-6"/></svg>',
	check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
	x: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
	clock: '<svg viewBox="0 0 24 24"><path d="M12 6v6l4 2"/><circle cx="12" cy="12" r="9"/></svg>',
	bell: '<svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7M10 19a2 2 0 0 0 4 0"/></svg>',
};

/* หน้าเหล่านี้ใช้โครงหน้าเดียวกับหน้าสถานะ (ปุ่มตั้งค่า ภาษา เขตเวลา ฯลฯ) */
async function page(title: string, color: string, svg: string, h: string, p: string, actions: string): Promise<string> {
	const { shell, backBtn, brand } = await import('./pages.js');
	const main = `<section class="dhero glass" style="--c:${color}">
	<div class="beacon"><div class="core">${svg}</div></div>
	<div class="ttl"><h1>${esc(h)}</h1><p style="margin:10px 0 0;color:var(--muted);font-weight:300;line-height:1.7">${esc(p)}</p>
	<div style="margin-top:20px;display:flex;flex-wrap:wrap;gap:10px">${actions}</div></div></section>`;
	return shell(`${title} - Yumi Status`, backBtn() + brand, main, 'ok');
}
const action = (href: string, label: string, attrs = '') => `<a class="pill" style="--c:var(--brand);margin:0" href="${href}"${attrs}>${esc(label)}</a>`;

/** หน้ากรอกอีเมล: ใช้ popup ในหน้าแรกแทน (ลิงก์เดิมพาไปที่ /?subscribe=1) */
export async function renderSubscribePage(): Promise<string> {
	return page(t('sub_title'), 'var(--brand)', ICON.bell, t('sub_title'), t('sub_lead'), action('/?subscribe=1', t('sub_button'), ' data-sub-open'));
}

/** ผลการกดลิงก์ยืนยัน */
export async function renderConfirmResult(kind: 'ok' | 'invalid' | 'expired'): Promise<string> {
	const map = {
		ok: { c: 'var(--ok)', i: ICON.check, t: t('conf_ok_t'), p: t('conf_ok_p'), a: action('/', t('to_status')) },
		expired: { c: 'var(--warn)', i: ICON.clock, t: t('conf_exp_t'), p: t('conf_exp_p'), a: action('/?subscribe=1', t('resub'), ' data-sub-open') },
		invalid: { c: 'var(--down)', i: ICON.x, t: t('conf_bad_t'), p: t('conf_bad_p'), a: action('/?subscribe=1', t('resub'), ' data-sub-open') },
	}[kind];
	return page(map.t, map.c, map.i, map.t, map.p, map.a);
}

/** ผลการยกเลิก */
export async function renderUnsubResult(ok: boolean): Promise<string> {
	return ok
		? page(t('unsub_ok_t'), 'var(--muted)', ICON.bell, t('unsub_ok_t'), t('unsub_ok_p'), action('/?subscribe=1', t('resub'), ' data-sub-open'))
		: page(t('conf_bad_t'), 'var(--down)', ICON.x, t('conf_bad_t'), t('unsub_bad_p'), action('/', t('to_status')));
}

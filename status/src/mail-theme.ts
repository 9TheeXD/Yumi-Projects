import { fmtLong, prefs } from './i18n.js';
/**
 * ธีมอีเมลกลาง: พื้นหลังโปร่งใส และสีตัวอักษร/การ์ดปรับตามธีมของผู้ใช้
 *  - ค่าเริ่มต้น (inline) เป็นสีสว่าง ใช้กับไคลเอนต์ที่ไม่รองรับ <style>
 *  - @media (prefers-color-scheme: dark) เปลี่ยนเป็นสีมืด ด้วย !important เพื่อชนะ inline style
 */
export const LOGO = 'https://assets.yumistack.net/photos/logo/yumi/001.webp';
export const FONT = `'Kanit','Noto Sans Thai',Tahoma,'Segoe UI',Arial,sans-serif`;

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** เวลาตอนนี้ ตามภาษาและเขตเวลาของผู้รับ (i18n prefs) */
export const nowTh = () => fmtLong();

export const MAIL_STYLE = `
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
body{margin:0;padding:0;width:100%!important}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
a{text-decoration:none}
.t-upd{color:#0a5c37}.t-ok{color:#0d7a4b}.t-down{color:#b42323}.t-load{color:#0b6e99}
.ink{color:#1d1719}.mut{color:#5f5355}.dim{color:#7d7072}
.card{background:#ffffff;border-color:#e7e0e1}
.hero-ok{background:#e9f8f1;border-color:#7fd9a9}
.hero-upd{background:#dcf3e5;border-color:#4fb87d}
.hero-down{background:#fdeeee;border-color:#f29a9d}
.hero-load{background:#e7f5fb;border-color:#7fc9e6}
.b-ok{background:#dff5ea;color:#0d7a4b}
.b-upd{background:#cdeedb;color:#0a5c37}
.b-down{background:#fde3e3;color:#a11d1d}
.b-load{background:#dcf0f9;color:#0b6e99}
.chip{background:#f6eff0;border-color:#eadfe1;color:#5c4d4f}
.rule{border-color:#eee6e7}
@media (prefers-color-scheme: dark){
	.t-ok{color:#6ff0b8!important}
	.t-upd{color:#5fd99a!important}
	.t-down{color:#ff9ea1!important}
	.t-load{color:#8fdcf6!important}
	.ink{color:#fff3f1!important}
	.mut{color:#d2b8b5!important}
	.dim{color:#a8928f!important}
	.card{background:#1d1517!important;border-color:#3a2629!important}
	.hero-ok{background:#10261d!important;border-color:#2f7a58!important}
	.hero-upd{background:#0d2a19!important;border-color:#237a49!important}
	.hero-down{background:#2e1417!important;border-color:#8a3a3e!important}
	.hero-load{background:#0f2730!important;border-color:#2b6f8a!important}
	.b-ok{background:#0f3a2a!important;color:#6ff0b8!important}
	.b-upd{background:#0c3a21!important;color:#5fd99a!important}
	.b-down{background:#431316!important;color:#ff9ea1!important}
	.b-load{background:#0e3340!important;color:#8fdcf6!important}
	.chip{background:#2a1a1d!important;border-color:#4a2a2e!important;color:#e3c7c3!important}
	.rule{border-color:#3a2629!important}
}`;

/** เลย์เอาต์หลักของอีเมลทุกฉบับ */
export function mailDoc(title: string, inner: string, preheader = ''): string {
	return `<!doctype html>
<html lang="${prefs().lang}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>${MAIL_STYLE}</style>
</head>
<body style="margin:0;padding:0;background:transparent;font-family:${FONT}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:transparent">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
${inner}
</table>
</td></tr></table>
</body></html>`;
}

/** หัวอีเมล: โลโก้ + ชื่อ + เวลา */
export const mailHeader = (time: string) => `
<tr><td style="padding:0 4px 18px 4px">
	<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
		<td width="46" valign="middle"><img src="${LOGO}" width="38" height="38" alt="Yumi" style="display:block;border-radius:11px;border:0"></td>
		<td valign="middle" class="ink" style="font-family:${FONT};font-size:17px;font-weight:600;color:#1d1719">Yumi Status</td>
		<td align="right" valign="middle" class="dim" style="font-family:${FONT};font-size:12px;color:#7d7072">${esc(time)}</td>
	</tr></table>
</td></tr>`;

/** ท้ายอีเมล (html ได้ เช่นลิงก์ยกเลิก) */
export const mailFooter = (html: string) => `
<tr><td align="center" class="dim" style="padding:22px 10px 0 10px;font-family:${FONT};font-size:12px;line-height:1.7;color:#7d7072">${html}</td></tr>`;

/** ปุ่มหลัก (สีแดงเดียวกันทั้งสองธีม ตัวอักษรขาว) */
export const mailButton = (href: string, label: string) => `
<a href="${esc(href)}" style="display:inline-block;padding:13px 32px;border-radius:14px;background:#e5484d;color:#ffffff;font-family:${FONT};font-size:15px;font-weight:600;text-decoration:none">${esc(label)}</a>`;

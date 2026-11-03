import type { StatusData } from 'global/types';
import { formatDataSize } from 'global/common-functions';
import { RANGE_LIST, type Banner, type Brief, type Range, type Report, type SeriesPoint, type TimelineItem } from './history.js';
import { COLORS, UI_BODY, UI_CSS, UI_SCRIPT, seriesLine, svgChart } from './chart.js';
import { displayName, fmtDateTh, fmtDayTh, fmtDurTh, fmtPct, stateTh } from './format.js';
import { localeOf, prefs, t, tMany, tzLabel } from './i18n.js';
import { SET_CSS, firstVisitScript, gearButton, settingsModal, settingsScript } from './settings-ui.js';

export type Item = { s: StatusData; r: Report; b: Brief };
/** ประกาศและโหมดปรับปรุงที่แอดมินตั้งไว้ */
export type PageCtx = { banner: Banner | null; maint: Record<string, string> };

const LOGO = 'https://assets.yumistack.net/photos/logo/yumi/001.webp';
export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// อ่านค่าตามภาษาของคำขอนั้นทุกครั้ง (getter)
const RANGE_LABEL: Record<Range, string> = {
	get '24h'() { return t('range_24h'); }, get '7d'() { return t('range_7d'); }, get '30d'() { return t('range_30d'); }, get all() { return t('range_all'); },
};
export const RANGE_LONG: Record<Range, string> = {
	get '24h'() { return t('rangel_24h'); }, get '7d'() { return t('rangel_7d'); }, get '30d'() { return t('rangel_30d'); }, get all() { return t('rangel_all'); },
};

export const ICON = {
	back: '<svg viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
	refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5"/></svg>',
	ok: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
	load: '<svg viewBox="0 0 24 24"><path d="M12 6v6l4 2"/></svg>',
	down: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
};

const NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E")`;

const CSS = `
:root{--bg:#060203;--ink:#fff3f1;--muted:#b99a97;--dim:#8a706d;--brand:#f13b3b;--ok:#3ddc97;--warn:#fbbf24;--load:#4cc9f0;--down:#ff5a5f;--upd:#1f9d5c;--c:var(--brand);color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
[data-state=ok]{--c:var(--ok)}[data-state=load]{--c:var(--load)}[data-state=down]{--c:var(--down)}[data-state=upd]{--c:var(--upd)}
html{background:var(--bg)}
body{margin:0;min-height:100vh;color:var(--ink);font-family:'Kanit',system-ui,sans-serif;
	background:radial-gradient(1000px 600px at 12% -15%,rgba(241,59,59,.34),transparent 65%),radial-gradient(800px 600px at 105% 105%,rgba(130,0,0,.35),transparent 60%),var(--bg);
	background-attachment:fixed;padding:max(24px,env(safe-area-inset-top)) 20px max(32px,env(safe-area-inset-bottom))}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background-image:${NOISE};opacity:.07;mix-blend-mode:overlay}
a{color:inherit;text-decoration:none}button{font:inherit}
:focus-visible{outline:2px solid #fff;outline-offset:3px;border-radius:12px}
.wrap{position:relative;max-width:960px;margin:0 auto}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:32px}
.l,.r{display:flex;align-items:center;gap:12px}
.brand{display:flex;align-items:center;gap:12px;font-weight:600;font-size:1.05rem}
.brand img{width:38px;height:38px;border-radius:11px;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 8px 24px -8px rgba(241,59,59,.6)}
.upd{color:var(--dim);font-size:.85rem;font-weight:300}
.btn{width:42px;height:42px;display:grid;place-items:center;border-radius:12px;cursor:pointer;color:var(--ink);background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);transition:background .2s,border-color .2s}
.btn:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.28)}
.btn svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.glass{background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.025));border:1px solid rgba(255,255,255,.09);border-radius:22px;
	box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 24px 50px -24px rgba(0,0,0,.8);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
@keyframes ping{0%{transform:scale(1);opacity:.8}100%{transform:scale(2.6);opacity:0}}
@keyframes ring{0%{transform:scale(.65);opacity:.9}100%{transform:scale(1.35);opacity:0}}

/* ตัวเลือกช่วงเวลา */
.toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin:26px 4px 14px}
.toolbar .tt{margin:0;font-size:1.05rem;font-weight:600}
.seg{display:inline-flex;gap:2px;padding:4px;border-radius:14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1)}
.seg a{padding:7px 16px;border-radius:10px;color:var(--muted);font-size:.92rem;transition:color .2s,background .2s}
.seg a:hover{color:var(--ink)}
.seg a.on{color:#fff;background:linear-gradient(180deg,#ff5a4d,var(--brand));box-shadow:0 6px 18px -6px rgba(241,59,59,.7)}

/* หน้าแรก */
.hero{position:relative;overflow:hidden;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:24px;padding:30px 32px}
.hero::after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(520px 220px at 0% 0%,color-mix(in srgb,var(--c) 26%,transparent),transparent 70%)}
.hero>*{position:relative;z-index:1}
.hl{display:flex;align-items:center;gap:20px}
.pulse{position:relative;width:18px;height:18px;border-radius:50%;background:var(--c);box-shadow:0 0 24px var(--c);flex:none}
[data-state=ok] .pulse::after,[data-state=upd] .pulse::after,[data-state=load] .pulse::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--c);animation:ping 2.4s ease-out infinite}
.hero h1{margin:0;font-size:clamp(1.6rem,5vw,2.5rem);font-weight:700;line-height:1.2}
.hero p{margin:6px 0 0;color:var(--muted);font-weight:300}
.bigpct{text-align:right}.bigpct b{display:block;font-size:2.5rem;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.bigpct span{color:var(--muted);font-size:.88rem;font-weight:300}
.list{padding:8px}
.svc{display:grid;grid-template-columns:minmax(230px,1.15fr) minmax(0,1.6fr) 84px;gap:22px;align-items:center;padding:18px 20px;border-radius:16px;transition:background .2s}
.svc+.svc{border-top:1px solid rgba(255,255,255,.06)}
.svc:hover{background:rgba(255,255,255,.05)}
.who{display:flex;align-items:flex-start;gap:14px;min-width:0}
.who .dot{margin-top:9px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--c);box-shadow:0 0 14px var(--c);flex:none}
.nm{font-weight:600;font-size:1.08rem}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;color:var(--muted);font-weight:300;font-size:.88rem}
.meta .st{color:var(--c);font-weight:400}
.meta b{font-weight:400;color:var(--ink);font-variant-numeric:tabular-nums}
.last{margin-top:2px;color:var(--dim);font-weight:300;font-size:.82rem}
.tag{padding:0 9px;border-radius:99px;background:rgba(251,191,36,.14);color:var(--warn);border:1px solid rgba(251,191,36,.35);font-size:.76rem}
.bars{display:flex;gap:3px;height:36px}
.bars i{flex:1;min-width:0;border-radius:4px;background:rgba(255,255,255,.1);transition:transform .15s,filter .15s}
.bars i.ok{background:var(--ok);opacity:.85}.bars i.warn{background:var(--warn)}.bars i.upd{background:var(--upd)}.bars i.bad{background:var(--down)}
.bars i:hover{transform:scaleY(1.15);filter:brightness(1.25)}
.pct{text-align:right}.pct b{display:block;font-size:1.15rem;font-weight:600;font-variant-numeric:tabular-nums}.pct span{color:var(--dim);font-size:.78rem;font-weight:300}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;justify-content:center;margin-top:18px;color:var(--dim);font-size:.82rem;font-weight:300}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}

/* หน้ารายละเอียด */
.dhero{position:relative;overflow:hidden;display:flex;flex-wrap:wrap;align-items:center;gap:26px;padding:30px 32px;margin-bottom:16px}
.dhero::after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(520px 240px at 0% 0%,color-mix(in srgb,var(--c) 24%,transparent),transparent 70%)}
.dhero>*{position:relative;z-index:1}
.beacon{position:relative;width:104px;height:104px;display:grid;place-items:center;flex:none}
.beacon::before,.beacon::after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--c);opacity:0}
[data-state=ok] .beacon::before,[data-state=upd] .beacon::before,[data-state=load] .beacon::before{animation:ring 2.8s ease-out infinite}
[data-state=ok] .beacon::after,[data-state=upd] .beacon::after,[data-state=load] .beacon::after{animation:ring 2.8s ease-out 1.4s infinite}
[data-state=down] .beacon::before{opacity:.45}
.core{width:66px;height:66px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 35% 30%,color-mix(in srgb,var(--c) 70%,#fff),var(--c));box-shadow:0 0 50px color-mix(in srgb,var(--c) 55%,transparent)}
.core svg{width:30px;height:30px;fill:none;stroke:#0c0506;stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round}
.ttl{flex:1;min-width:200px}
.ttl h1{margin:0;font-size:clamp(2rem,6vw,3rem);font-weight:700;line-height:1.15}
.pill{display:inline-flex;align-items:center;gap:8px;margin:12px 8px 0 0;padding:5px 16px;border-radius:999px;color:var(--c);background:color-mix(in srgb,var(--c) 14%,transparent);border:1px solid color-mix(in srgb,var(--c) 45%,transparent)}
.clock{text-align:right;max-width:100%}.clock .k{color:var(--muted);font-weight:300;font-size:.9rem}
.clock .big{font-size:clamp(1.8rem,5vw,2.7rem);font-weight:700;color:var(--c);font-variant-numeric:tabular-nums;line-height:1.2}
.clock .last{margin-top:6px;font-size:.88rem;color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
.tile{padding:20px 22px}.tile .k{color:var(--muted);font-weight:300;font-size:.9rem}
.tile .v{margin-top:6px;font-size:1.6rem;font-weight:600;font-variant-numeric:tabular-nums;word-break:break-word}.tile .v.na{color:rgba(255,255,255,.3)}
.meter{margin-top:12px;height:6px;border-radius:99px;background:rgba(255,255,255,.1);overflow:hidden}
.meter i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--brand),#ff9a8a)}
.panel{padding:24px 26px;margin-bottom:16px}.panel h2{margin:0 0 18px;font-size:1.05rem;font-weight:600}
.avail{display:grid;grid-template-columns:repeat(4,1fr);gap:18px 0}
.avail>div{padding:0 20px}.avail>div:first-child{padding-left:0}.avail>div+div{border-left:1px solid rgba(255,255,255,.08)}
.avail .k{color:var(--muted);font-weight:300;font-size:.9rem}
.avail b{display:block;margin:4px 0 4px;font-size:1.7rem;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.25}
.avail small{display:block;color:var(--dim);font-weight:300;font-size:.82rem}
.strip{position:relative;height:40px;border-radius:10px;background:rgba(255,255,255,.06);overflow:hidden}
.strip i{position:absolute;top:0;bottom:0;background:var(--ok);opacity:.85}.strip i.down{background:var(--down);opacity:1;z-index:1}.strip i.load{background:var(--load)}
.axis{display:flex;justify-content:space-between;margin-top:8px;color:var(--dim);font-size:.8rem;font-weight:300}
.spark svg{display:block;width:100%;height:140px}
.stats{display:flex;flex-wrap:wrap;gap:6px 28px;margin-top:14px;color:var(--muted);font-weight:300;font-size:.9rem}.stats b{color:var(--ink);font-weight:600}
.tl{max-height:480px;overflow-y:auto;position:relative;padding:4px 10px 4px 4px;margin:0 -4px}
.tl::-webkit-scrollbar{width:8px}.tl::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:8px}
.tl-it{position:relative;display:grid;grid-template-columns:22px 1fr;gap:0 12px;padding:0 0 18px}
.tl-it::before{content:"";position:absolute;left:10px;top:20px;bottom:-2px;width:2px;background:rgba(255,255,255,.1)}
.tl-it:last-child::before{display:none}
.tl-dot{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--c) 22%,transparent);border:2px solid var(--c);margin-top:1px}
.tl-dot::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--c)}
.tl-it.live .tl-dot::after{animation:ping 2s ease-out infinite}
.tl-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.tl-t{font-weight:600;color:var(--c)}.tl-d{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums}
.tl-w{color:var(--muted);font-weight:300;font-size:.88rem;margin-top:2px}
.tl-c{margin-top:6px;font-size:.9rem;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.04);border-left:3px solid var(--c)}
.tl-n{margin-top:4px;color:var(--muted);font-size:.86rem;font-weight:300}
.tl-it.k-up{--c:var(--ok)}.tl-it.k-down{--c:var(--down)}.tl-it.k-warn{--c:#ff9f43}.tl-it.k-upd,.tl-it.k-updated{--c:var(--upd)}.tl-it.k-load{--c:var(--load)}.tl-it.k-gap{--c:#8a7f7f}
.tl-leg{display:flex;flex-wrap:wrap;gap:6px 16px;margin:-6px 0 14px;color:var(--muted);font-size:.8rem}.tl-leg i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:var(--c)}
.inc{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 16px;padding:14px 0}.inc+.inc{border-top:1px solid rgba(255,255,255,.07)}
.inc .w{color:var(--muted);font-weight:300;font-size:.92rem}.inc .d{font-weight:600;font-variant-numeric:tabular-nums}.inc .d.on{color:var(--down)}
.none{color:var(--muted);font-weight:300}
.links{display:flex;flex-wrap:wrap;justify-content:center;gap:10px 22px;margin-top:16px;font-size:.92rem}
.links a{color:var(--muted);text-decoration:underline;text-underline-offset:4px}
.links a:hover{color:var(--ink)}
.banner{margin:0 0 18px;padding:14px 18px;border-radius:16px;font-weight:500;border:1px solid}
.banner.info{background:rgba(76,201,240,.12);border-color:rgba(76,201,240,.4);color:#8fdcf6}
.banner.warn{background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.4);color:#fbbf24}
.banner.danger{background:rgba(255,90,95,.12);border-color:rgba(255,90,95,.45);color:#ff9ea1}
.tag.maint{background:rgba(76,201,240,.14);color:#8fdcf6;border-color:rgba(76,201,240,.35)}
.strip i.warn{background:var(--warn);opacity:1;z-index:1}.strip i.upd{background:var(--upd);opacity:1;z-index:1}.strip i.na{background:#5a4f4f;opacity:1;z-index:2}
.strip i{cursor:pointer;transition:filter .15s}
.strip i:hover{filter:brightness(1.35)}
.strip i.load{background:var(--load)}
${UI_CSS}${SET_CSS}
.foot{margin-top:28px;text-align:center;color:var(--dim);font-size:.82rem;font-weight:300}
@media (max-width:720px){
	.svc{grid-template-columns:1fr auto;gap:14px}.svc .bars{grid-column:1/-1;order:3}
	.hero,.dhero{padding:24px 22px}.bigpct,.clock{text-align:left}
	.avail{grid-template-columns:1fr 1fr}.avail>div,.avail>div:first-child{padding:0}.avail>div+div{border-left:0}
	.seg a{padding:7px 12px}
}
html.embed,body.embed{background:transparent!important;background-image:none!important}
body.embed::before{display:none}
body.embed{padding:0;min-height:0}
body.embed .wrap{max-width:none}
body.embed .top{margin-bottom:16px}
body.embed .foot{margin-top:16px}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

// อัปเดตหน้าแบบเงียบ ๆ ทุก 5 วินาที (ไม่กะพริบ, คงช่วงเวลาที่เลือก) + ตัวนับเวลาเดินทุกวินาที
// ภาษาและหน่วยเวลาตามการตั้งค่าของผู้ใช้ ปิดการอัปเดตอัตโนมัติได้ในหน้าตั้งค่า
const script = () => {
	const p = prefs();
	const cfg = JSON.stringify({ loc: localeOf(), refresh: p.refresh, s: tMany(['live', 'updated_ago', 'paused']) });
	return `(function(){
var C=${cfg},app=document.getElementById('app'),upd=document.getElementById('updated'),last=Date.now();
var off=Number(app.getAttribute('data-now'))-Date.now();
var U=['day','hour','minute','second'];
function one(v,u){try{return new Intl.NumberFormat(C.loc,{style:'unit',unit:u,unitDisplay:'short'}).format(v);}catch(e){return v+' '+u;}}
function fmt(ms){var t=Math.max(0,Math.floor(ms/1000)),v=[Math.floor(t/86400),Math.floor(t%86400/3600),Math.floor(t%3600/60),t%60],p=[];for(var i=0;i<4;i++){if(v[i]>0)p.push(one(v[i],U[i]));}return p.slice(0,2).join(' ')||one(0,'second');}
function tick(){var n=document.querySelectorAll('[data-since]');for(var i=0;i<n.length;i++){n[i].textContent=fmt(Date.now()+off-Number(n[i].getAttribute('data-since')));}
if(upd){if(!C.refresh){upd.textContent=C.s.paused;return;}var s=Math.floor((Date.now()-last)/1000);upd.textContent=s<2?C.s.live:C.s.updated_ago.replace('{s}',s);}}
function refresh(){if(document.hidden)return;return fetch(location.pathname+location.search,{cache:'no-store'}).then(function(r){return r.text()}).then(function(t){
var d=new DOMParser().parseFromString(t,'text/html'),n=d.getElementById('app');if(!n)return;
var sc=[].map.call(app.querySelectorAll('.tl'),function(e){return e.scrollTop});app.innerHTML=n.innerHTML;[].forEach.call(app.querySelectorAll('.tl'),function(e,i){if(sc[i])e.scrollTop=sc[i]});app.setAttribute('data-state',n.getAttribute('data-state')||'');off=Number(n.getAttribute('data-now'))-Date.now();document.title=d.title;last=Date.now();tick();}).catch(function(){});}
setInterval(tick,1000);if(C.refresh)setInterval(refresh,5000);tick();
document.addEventListener('visibilitychange',function(){if(!document.hidden&&C.refresh)refresh();});
var b=document.getElementById('reload');if(b)b.addEventListener('click',refresh);
})();`;
};

export const shell = (title: string, left: string, main: string, state: string, embed = false) => `<!doctype html>
<html lang="${prefs().lang}" class="${[embed ? 'embed' : '', prefs().calm ? 'calm' : ''].join(' ').trim()}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#060203" />
<title>${title}</title>
<link rel="icon" href="${LOGO}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Kanit:wght@300;400;600;700&display=swap" rel="stylesheet" />
<style>${CSS}</style>
${firstVisitScript()}
</head>
<body${embed ? ' class="embed"' : ''}>
<div class="wrap">
<header class="top">
	<div class="l">${left}</div>
	<div class="r"><span class="upd" id="updated">${t('live')}</span><button class="btn" id="reload" aria-label="${t('refresh')}" title="${t('refresh')}">${ICON.refresh}</button>${gearButton()}</div>
</header>
<main id="app" data-state="${state}" data-now="${Date.now()}">
${main}
</main>
<p class="foot">${esc(t('footer_tz', { tz: tzLabel() }))}</p>
</div>
${settingsModal(prefs().user ?? null)}
${UI_BODY}
<script>${script()}</script>
<script>${settingsScript()}</script>
<script>${UI_SCRIPT()}</script>
</body>
</html>`;

export const brand = `<div class="brand"><img src="${LOGO}" alt="" />Yumi Status</div>`;
export const backBtn = (href = '/') => `<a class="btn" href="${href}" target="_top" aria-label="${t('back_home')}" title="${t('back_home')}">${ICON.back}</a>`;

export const rangeBar = (base: string, range: Range) =>
	`<nav class="seg" aria-label="${t('range_label')}">${RANGE_LIST.map(k => `<a href="${base}?range=${k}" class="${k === range ? 'on' : ''}"${k === range ? ' aria-current="true"' : ''}>${RANGE_LABEL[k]}</a>`).join('')}</nav>`;

/** ข้อความ "ครั้งล่าสุดของสถานะตรงข้าม" */
export function lastLine(b: Brief): string {
	if (b.state === 'loading') return '';
	if (b.state === 'up') {
		return b.last ? t('last_down', { d: fmtDurTh(b.last.duration), at: fmtDateTh(b.last.start) }) : t('never_down');
	}
	return b.last ? t('last_up', { d: fmtDurTh(b.last.duration), at: fmtDateTh(b.last.end) }) : t('no_prev_up');
}

/** ลิงก์ท้ายหน้า: กราฟรวม และรับการแจ้งเตือนทางอีเมล (มีทุกหน้า) */
export const pageLinks = (range: Range, home = true) => `<nav class="links">${home ? `<a href="/?range=${range}">${t('link_all_status')}</a>` : ''}<a href="/metrics?range=${range}">${t('link_metrics')}</a><a class="linkbtn" href="/?subscribe=1" data-sub-open>${t('link_subscribe')}</a></nav>`;

/* ------------------------------------------------------------------ */

export function renderIndex(items: Item[], limits: Record<string, number>, range: Range, embed = false, ctx: PageCtx = { banner: null, maint: {} }): string {
	const base = embed ? '/iframe' : '/';
	const bannerHtml = ctx.banner && !embed ? `<div class="banner ${ctx.banner.level}">${esc(ctx.banner.text)}</div>` : '';
	const linkTarget = embed ? ' target="_blank" rel="noopener noreferrer"' : '';
	const now = Date.now();
	const down = items.filter(i => i.s.status === 0 && !i.b.upd).length;
	const updating = items.filter(i => i.b.upd).length;
	const loading = items.filter(i => i.s.status === -1).length;
	const n = items.length;

	const overall = n === 0
		? { key: 'load', title: t('ov_checking'), sub: t('ov_checking_sub') }
		: down > 0
			? { key: 'down', title: down === n ? t('ov_all_down') : t('ov_some_down', { n: down, total: n }), sub: t('ov_down_sub') }
			: updating > 0
				? { key: 'upd', title: t('ov_updating'), sub: t('ov_updating_sub', { n: updating }) }
			: loading > 0
				? { key: 'load', title: t('ov_loading'), sub: t('ov_loading_sub', { n: loading, total: n }) }
				: { key: 'ok', title: t('ov_ok'), sub: t('ov_ok_sub', { n, total: n }) };

	let obs = 0, dn = 0;
	for (const { r } of items) { obs += r.stat.observed; dn += r.stat.down; }
	const total = obs ? ((obs - dn) / obs) * 100 : null;

	const rows = items.map(({ s, r, b }) => {
		const st = b.upd ? { key: 'upd', label: t('state_upd') } : stateTh(s.status);
		const limited = (limits[s.name] ?? 0) > now;
		const cur = b.ms !== null && b.since !== null
			? `<span>${b.state === 'up' ? 'Uptime' : 'Downtime'} <b data-since="${b.since}">${fmtDurTh(b.ms)}</b></span>` : '';
		const ping = typeof s.ping === 'number' && s.status === 1 ? `<span>${s.ping} ms</span>` : '';
		const bars = r.buckets.map(k => {
			const cls = k.observed <= 0 ? 'na' : k.down > 0 ? (k.down < 5 * 60_000 ? 'warn' : 'bad') : k.upd > 0 ? 'upd' : 'ok';
			const tip = k.observed <= 0 ? t('no_data') : k.down > 0 ? t('down_for', { d: fmtDurTh(k.down + k.upd) }) : k.upd > 0 ? t('upd_for', { d: fmtDurTh(k.upd) }) : t('no_downtime');
			const sp = k.end - k.start;
			const label = sp >= 36 * 3_600_000 ? `${fmtDayTh(k.start)} - ${fmtDayTh(k.end - 1)}` : sp >= 20 * 3_600_000 ? fmtDayTh(k.end - 1) : fmtDateTh(k.start);
			return `<i class="${cls}" title="${label}: ${tip}"></i>`;
		}).join('');
		return `<a class="svc" data-state="${st.key}" translate="no" href="/${encodeURIComponent(s.name)}?range=${range}"${linkTarget}>
	<div class="who"><span class="dot"></span><div><div class="nm">${esc(displayName(s.name))}</div>
		<div class="meta"><span class="st">${st.label}</span>${ctx.maint[s.name] !== undefined ? `<span class="tag maint">${t('maint_tag')}</span>` : ''}${cur}${ping}${limited ? `<span class="tag" title="${t('rate_tip')}">${t('rate_tag')}</span>` : ''}</div>
		<div class="last">${lastLine(b)}</div></div></div>
	<div class="bars">${bars}</div>
	<div class="pct"><b>${fmtPct(r.stat.pct)}</b><span>${t('uptime_word')}</span></div>
</a>`;
	}).join('\n');

	const main = `
${bannerHtml}
<section class="hero glass">
	<div class="hl"><span class="pulse"></span><div><h1>${overall.title}</h1><p>${overall.sub}</p></div></div>
	<div class="bigpct"><b>${fmtPct(total)}</b><span>${t('uptime_in', { range: RANGE_LONG[range] })}</span></div>
</section>
<div class="toolbar"><h2 class="tt">${t('all_services')}</h2>${rangeBar(base, range)}</div>
${n ? `<section class="list glass">${rows}</section>` : ''}
<div class="legend">
	<span><i style="background:var(--ok)"></i>${t('legend_ok')}</span>
	<span><i style="background:var(--upd)"></i>${t('legend_upd')}</span>
	<span><i style="background:var(--warn)"></i>${t('legend_warn')}</span>
	<span><i style="background:var(--down)"></i>${t('legend_bad')}</span>
	<span><i style="background:rgba(255,255,255,.12)"></i>${t('no_data')}</span>
</div>
${embed ? '' : pageLinks(range, false)}`;
	return shell(t('site_title'), embed ? '' : brand, main, overall.key, embed);
}

/** กราฟ CPU และ RAM ของบริการ (แสดงเฉพาะบริการที่ส่งค่าเหล่านี้มา) */
export const resourcePanels = (series: SeriesPoint[]) => {
	if (!series.some(p => p.cpu !== null || p.memMb !== null)) return '';
	return `<section class="panel glass"><h2>${t('cpu_chart')}</h2>${svgChart([seriesLine(series, 'cpu', 'CPU', COLORS[0])], '%')}</section>
<section class="panel glass"><h2>${t('ram_chart')}</h2>${svgChart([seriesLine(series, 'memMb', 'RAM', COLORS[2])], ' MB')}</section>`;
};

/** รายละเอียดของแต่ละช่วงในไทม์ไลน์: สี เวลา ระยะเวลา สาเหตุ และหมายเหตุ */
export const segTip = (g: Report['strip'][number], label: string, k: string) => {
	const col = k === 'na' ? '#9a8a88' : k === 'down' ? '#ff5a5f' : k === 'warn' ? '#fbbf24' : k === 'upd' ? '#1f9d5c' : k === 'load' ? '#4cc9f0' : '#3ddc97';
	const lines = [
		`<div style="color:${col};font-weight:600">● ${esc(label)}${k === 'warn' ? ` ${t('seg_short')}` : ''}</div>`,
		`<div>${t('seg_since', { t: fmtDateTh(g.start) })}</div>`,
		`<div>${t('seg_until', { t: g.open ? t('now') : fmtDateTh(g.end) })}</div>`,
		`<div>${t('seg_dur', { d: fmtDurTh(g.end - g.start) })}</div>`,
	];
	if (g.status === 0) lines.push(`<div style="color:${g.upd ? '#5fd99a' : '#ff9ea1'}">${t('seg_cause', { c: g.cause ? esc(g.cause) : t('unknown_cause') })}</div>`);
	if (g.note) lines.push(`<div style="color:#b99a97">${t('seg_note', { n: esc(g.note) })}</div>`);
	return lines.join('');
};

/** ไทม์ไลน์เหตุการณ์แบบเส้นเวลาแนวตั้ง (สูงจำกัด เลื่อนดูได้) */
export function renderTimeline(items: TimelineItem[]): string {
	const label = (k: TimelineItem['kind']) => ({ up: t('state_ok'), down: t('tl_down_long'), warn: t('tl_down_short'), upd: t('state_upd'), updated: t('tl_updated'), load: t('state_load'), gap: t('no_data') }[k]);
	const legend = (['up', 'warn', 'down', 'upd', 'updated'] as const).map(k => `<span class="tl-it k-${k}" style="padding:0;display:inline-block"><i></i>${label(k)}</span>`).join('');
	const list = items.length ? items.map(i => {
		const live = i.end === null;
		const when = live ? t('seg_since', { t: fmtDateTh(i.start) }) : t('from_to', { a: fmtDateTh(i.start), b: fmtDateTh(i.end!) });
		const dur = live ? `<span data-since="${i.start}">${fmtDurTh(i.duration)}</span>` : fmtDurTh(i.duration);
		const down = i.kind === 'down' || i.kind === 'warn' || i.kind === 'upd' || i.kind === 'updated';
		const cause = down ? `<div class="tl-c">${t('seg_cause', { c: i.cause ? esc(i.cause) : t('unknown_cause') })}</div>` : '';
		const note = i.note ? `<div class="tl-n">${t('seg_note', { n: esc(i.note) })}</div>` : '';
		return `<div class="tl-it k-${i.kind}${live ? ' live' : ''}"><span class="tl-dot"></span><div>
	<div class="tl-h"><span class="tl-t">${label(i.kind)}</span>${live ? `<span class="tl-w">${t('now')}</span>` : ''}<span class="tl-d">${dur}</span></div>
	<div class="tl-w">${when}</div>${i.since ? `<div class="tl-w">${t('tl_since', { t: fmtDateTh(i.since) })}</div>` : ''}${cause}${note}</div></div>`;
	}).join('') : `<div class="none">${t('tl_empty')}</div>`;
	return `<section class="panel glass"><h2>${t('tl_title')}</h2><div class="tl-leg">${legend}</div><div class="tl">${list}</div></section>`;
}

export function renderDetail(s: StatusData, r: Report, b: Brief, limitedUntil: number, range: Range, series: SeriesPoint[] = [], ctx: PageCtx = { banner: null, maint: {} }, timeline: TimelineItem[] = []): string {
	const now = Date.now();
	const st = b.upd ? { key: 'upd', label: t('state_upd') } : stateTh(s.status);
	const limited = limitedUntil > now;
	const base = `/${encodeURIComponent(s.name)}`;

	const clock = b.since !== null && b.ms !== null
		? `<div class="k">${b.state === 'up' ? 'Uptime' : 'Downtime'}</div><div class="big" data-since="${b.since}">${fmtDurTh(b.ms)}</div><div class="last">${lastLine(b)}</div>`
		: `<div class="last">${lastLine(b)}</div>`;

	const na = (v: string | undefined | null) => (v ? `<div class="v">${esc(v)}</div>` : '<div class="v na">N/A</div>');
	const cpu = s.resources?.cpu?.percent;
	const mem = s.resources?.memory;
	const tiles = `
	<div class="tile glass"><div class="k">${t('tile_ping')}</div>${na(typeof s.ping === 'number' ? `${s.ping} ms` : null)}</div>
	<div class="tile glass"><div class="k">${t('tile_version')}</div>${na(s.version ? `v${s.version}` : null)}</div>
	${cpu !== undefined ? `<div class="tile glass"><div class="k">${t('tile_cpu')}</div><div class="v">${cpu}%</div><div class="meter"><i style="width:${Math.min(100, Number(cpu))}%"></i></div></div>` : ''}
	${mem ? `<div class="tile glass"><div class="k">${t('tile_mem')}</div><div class="v">${esc(formatDataSize('byte', mem.used, 'short'))} / ${esc(formatDataSize('byte', mem.total, 'short'))}</div><div class="meter"><i style="width:${Math.min(100, Number(mem.percent))}%"></i></div></div>` : ''}`;

	const stt = r.stat;
	const avail = `
	<div><div class="k">Uptime</div><b>${fmtPct(stt.pct)}</b><small>${stt.observed ? t('av_from', { d: fmtDurTh(stt.observed) }) : t('av_none')}</small></div>
	<div><div class="k">${t('av_down_total')}</div><b>${stt.down ? fmtDurTh(stt.down) : t('av_none_short')}</b><small>${stt.down ? t('av_down_acc') : t('av_never')}</small></div>
	<div><div class="k">${t('av_count')}</div><b>${t('av_times', { n: stt.incidents })}</b><small>${t('av_count_note')}</small></div>
	<div><div class="k">${t('av_longest')}</div><b>${stt.longest ? fmtDurTh(stt.longest) : t('av_none_short')}</b><small>${t('av_longest_note')}</small></div>`;

	const span = now - r.from;
	const strip = r.strip.map(g => {
		const k = g.gap ? 'na' : g.status === 1 ? 'ok' : g.status === 0 ? (g.upd ? 'upd' : g.end - g.start < 5 * 60_000 ? 'warn' : 'down') : 'load';
		const label = g.gap ? t('no_data') : g.status === 1 ? t('state_ok') : g.status === 0 ? (g.upd ? t('state_upd') : t('state_down')) : t('state_load');
		return `<i class="${k}" style="left:${g.left.toFixed(3)}%;width:${g.width.toFixed(3)}%" data-tip="${esc(segTip(g, label, k))}"></i>`;
	}).join('');

	let spark = `<div class="none">${t('ping_wait')}</div>`;
	if (r.pings.length >= 2 && r.pingStats) {
		const vals = r.pings.map(p => p.ping);
		const min = Math.min(...vals), max = Math.max(...vals), sp = max - min || 1, pspan = now - r.pingFrom || 1;
		const pts = r.pings.map(p => [((p.ts - r.pingFrom) / pspan) * 600, 125 - ((p.ping - min) / sp) * 105] as const);
		const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
		const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} 140 L${pts[0][0].toFixed(1)} 140 Z`;
		spark = `<svg viewBox="0 0 600 140" preserveAspectRatio="none" role="img" aria-label="${t('ping_title')} ${RANGE_LONG[range]}">
	<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f13b3b" stop-opacity=".45"/><stop offset="1" stop-color="#f13b3b" stop-opacity="0"/></linearGradient></defs>
	<path d="${area}" fill="url(#sg)"/><path d="${line}" fill="none" stroke="#ff7a6e" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>
	<div class="stats"><span>${t('min')} <b>${r.pingStats.min} ms</b></span><span>${t('avg')} <b>${r.pingStats.avg} ms</b></span><span>${t('max')} <b>${r.pingStats.max} ms</b></span></div>`;
	}

	const incidents = r.incidents.length
		? r.incidents.map(i => `<div class="inc"><div class="w">${i.end ? t('from_to', { a: fmtDateTh(i.start), b: fmtDateTh(i.end) }) : fmtDateTh(i.start)}</div>
		${i.end ? `<div class="d">${fmtDurTh(i.duration)}</div>` : `<div class="d on">${t('down_now')} <span data-since="${i.start}">${fmtDurTh(now - i.start)}</span></div>`}</div>`).join('')
		: `<div class="none">${t('no_down_range')}</div>`;

	const main = `
${ctx.banner ? `<div class="banner ${ctx.banner.level}">${esc(ctx.banner.text)}</div>` : ''}
<section class="dhero glass">
	<div class="beacon"><div class="core">${ICON[(st.key === 'upd' ? 'ok' : st.key) as 'ok' | 'load' | 'down']}</div></div>
	<div class="ttl"><h1 translate="no">${esc(displayName(s.name))}</h1>
		<span class="pill">${st.label}</span>${ctx.maint[s.name] !== undefined ? `<span class="pill" style="--c:var(--load)">${t('maint_pill', { m: esc(ctx.maint[s.name]) })}</span>` : ''}${limited ? `<span class="pill" style="--c:var(--warn)">${t('rate_pill')}</span>` : ''}</div>
	<div class="clock">${clock}</div>
</section>
<section class="tiles">${tiles}</section>
<div class="toolbar"><h2 class="tt">${t('history')}</h2>${rangeBar(base, range)}</div>
<section class="panel glass"><h2>${t('availability', { range: RANGE_LONG[range] })}</h2><div class="avail">${avail}</div></section>
<section class="panel glass"><h2>${t('timeline')}</h2>
	<div class="strip">${strip}</div>
	<div class="axis"><span>${fmtDateTh(r.from)}</span><span>${fmtDateTh(r.from + span / 2)}</span><span>${t('now')}</span></div></section>
<section class="panel glass"><h2>${t('ping_title')}</h2>${svgChart([seriesLine(series, 'ping', 'Ping', COLORS[2])], ' ms')}</section>
${resourcePanels(series)}
${renderTimeline(timeline)}
${pageLinks(range)}`;

	return shell(t('detail_title', { n: esc(displayName(s.name)) }), backBtn() + brand, main, st.key);
}

export function renderNotFound(name: string): string {
	const main = `<section class="dhero glass" data-state="down">
	<div class="beacon"><div class="core">${ICON.down}</div></div>
	<div class="ttl"><h1>${t('not_found')}</h1><span class="pill">${t('no_service', { n: esc(name) })}</span></div></section>`;
	return shell(t('site_title'), backBtn() + brand, main, 'down');
}
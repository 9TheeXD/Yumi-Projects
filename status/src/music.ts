import axios from 'axios';
import type { StatusData } from 'global/types';
import { formatDataSize } from 'global/common-functions';
import type { Brief, Range, Report, SampleStatus, SeriesPoint, TimelineItem } from './history.js';
import { COLORS, seriesLine, svgChart } from './chart.js';
import { fmtDateTh, fmtDayTh, fmtDurTh, fmtPct } from './format.js';
import { ICON, RANGE_LONG, backBtn, brand, esc, lastLine, pageLinks, rangeBar, renderTimeline, resourcePanels, segTip, shell, type PageCtx } from './pages.js';
import { t, type Key } from './i18n.js';
import { STRINGS } from './strings.js';
import { HOST_MEM, cpuOfHost, memOfHost } from './host.js';

/* ------------------------------------------------------------------ */
/*  ข้อมูล node เพลง (Lavalink / NodeLink)                               */
/*  มาจาก sidecar ของบอทเพลง (musicV1/sidecar/sidecar.mjs) ที่ฟังอยู่บน   */
/*  docker0 เท่านั้น: http://host.docker.internal:30065/status            */
/* ------------------------------------------------------------------ */

export type MusicSource = { ok: boolean; off?: boolean; level: string | null; error: string | null; errorTh: string | null };
export type MusicNode = {
	name: string; kind: 'nodelink' | 'lavalink'; up: boolean;
	error: string | null; errorTh: string | null;
	pingMs: number | null; version: string | null;
	startedAt: number | null; restarts: number | null; image: string | null;
	players: number | null; playingPlayers: number | null; nodeUptimeMs: number | null;
	cpu: number | null; mem: { used: number | null; total: number | null; percent: number } | null;
	/** bytes/วินาที และ bytes รวมตั้งแต่ container เริ่ม (sidecar รุ่นเก่าไม่มี) */
	net?: { rxBps: number | null; txBps: number | null; rxTotal: number | null; txTotal: number | null } | null;
	sources: Record<string, MusicSource>;
	burner: boolean | null;
	history24: { uptime: string | null; youtube: string | null };
	lastDown: { start: number; end: number } | null;
};
export type MusicSnapshot = { at: number; up: number; total: number; nodes: MusicNode[] };

const MUSIC_URL = process.env.MUSIC_STATUS_URL || `http://${process.env.LOCALHOST}:30065/status`;
/** ข้อมูลเก่ากว่านี้ถือว่าไม่รู้สถานะ (sidecar หยุดทำงาน) */
const STALE_MS = 90_000;

let snap: MusicSnapshot | null = null;
let snapAt = 0;
let lastError: string | null = null;

/** ดึงข้อมูลล่าสุดจาก sidecar (ไม่ถี่เกิน 10 วินาที) */
export async function refreshMusic(): Promise<MusicSnapshot | null> {
	if (snap && Date.now() - snapAt < 10_000) return snap;
	try {
		const r = await axios.get<MusicSnapshot>(MUSIC_URL, { timeout: 20_000 });
		if (!r.data || !Array.isArray(r.data.nodes)) throw new Error('ข้อมูลที่ได้รับไม่ถูกต้อง');
		snap = toPublic(r.data); snapAt = Date.now(); lastError = null;
	} catch (e) {
		lastError = axios.isAxiosError(e) ? (e.code ?? e.message) : String(e);
	}
	return getMusic();
}

/* ------------------------------------------------------------------ */
/*  หน้าเว็บนี้เป็นสาธารณะ: ตัดข้อมูลภายในทิ้งตั้งแต่รับเข้ามา            */
/*  (บัญชีที่ใช้, image, ข้อความ error ดิบ, วิธีตรวจ) เหลือแค่ข้อความกลาง ๆ */
/* ------------------------------------------------------------------ */
const SAFE_REASONS = [
	{ re: /เชื่อมต่อ node ไม่ได้/, text: 'r_connect' },
	{ re: /ไม่ตอบ/, text: 'r_timeout' },
	{ re: /เพลงค้าง/, text: 'r_stall' },
] as const;
/** สาเหตุเก็บเป็นคีย์ข้อความ (r_*) แล้วแปลตอนแสดงผลตามภาษาของผู้ชม */
export const reasonText = (k: string | null | undefined) => t((k && k in STRINGS ? k : 'r_temp') as Key);
function publicReason(th: string | null, up: boolean): string | null {
	if (up && !th) return null;
	for (const r of SAFE_REASONS) if (th && r.re.test(th)) return r.text;
	return 'r_temp';
}
function toPublic(m: MusicSnapshot): MusicSnapshot {
	return {
		...m,
		nodes: m.nodes.map(({ burner: _b, image: _i, ...n }) => ({
			...n,
			burner: null,
			image: null,
			error: null,
			errorTh: n.up ? null : publicReason(n.errorTh, false),
			// sidecar ส่ง CPU เป็น % ของ 1 core และ RAM เทียบ limit ของ container: แปลงเป็นเทียบทั้งเครื่อง เหมือน service อื่น
			cpu: n.cpu !== null ? cpuOfHost(n.cpu) : null,
			mem: n.mem && n.mem.used !== null ? { used: n.mem.used, total: HOST_MEM, percent: memOfHost(n.mem.used) } : n.mem,
			sources: Object.fromEntries(Object.entries(n.sources).map(([k, v]) => [k, { ok: v.ok, off: !!v.off, level: null, error: null, errorTh: v.ok || v.off ? null : publicReason(v.errorTh, false) }])),
		})),
	};
}

/** ข้อมูลที่ยังไม่เก่าเกินไป หรือ null */
export const getMusic = (): MusicSnapshot | null => (snap && Date.now() - snapAt < STALE_MS ? snap : null);
export const musicError = () => lastError;

/** ชื่อที่ใช้เก็บประวัติของแต่ละ node (แยกจากรายการบริการหลัก) */
export const nodeKey = (name: string) => `nodes:${name}`;
export const KIND_LABEL: Record<MusicNode['kind'], string> = { nodelink: 'NodeLink', lavalink: 'Lavalink' };

export function nodeStatusData(n: MusicNode): SampleStatus {
	return {
		name: nodeKey(n.name),
		status: n.up ? 1 : 0,
		ping: n.pingMs ?? undefined,
		uptime: n.up && n.startedAt ? Math.floor((Date.now() - n.startedAt) / 1000) : undefined,
		startTime: n.startedAt ? new Date(n.startedAt).toISOString() : undefined,
		version: n.version ?? undefined,
		resources: n.cpu !== null && n.mem && n.mem.used !== null && n.mem.total !== null
			? { cpu: { percent: n.cpu }, memory: { percent: n.mem.percent, used: n.mem.used, total: n.mem.total } }
			: undefined,
		net: n.up && n.net ? { in: n.net.rxBps, out: n.net.txBps } : undefined,
	};
}

/* ------------------------------------------------------------------ */
/*  หน้าเว็บ                                                            */
/* ------------------------------------------------------------------ */

export type NodeItem = { n: MusicNode; r: Report; b: Brief };

const MUSIC_CSS = `<style>
.kind{display:inline-flex;align-items:center;padding:2px 10px;border-radius:99px;font-size:.78rem;font-weight:400;letter-spacing:.02em;
	color:#ffd9d4;background:rgba(241,59,59,.14);border:1px solid rgba(241,59,59,.35)}
.kind.lavalink{color:#cfe9ff;background:rgba(76,201,240,.12);border-color:rgba(76,201,240,.35)}
.ngrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.ncard{position:relative;overflow:hidden;display:flex;flex-direction:column;gap:16px;padding:22px 24px;transition:transform .2s,border-color .2s}
.ncard::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:var(--c);box-shadow:0 0 18px var(--c)}
.ncard:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--c) 50%,transparent)}
.nhead{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.nhead .nm{font-size:1.25rem;font-weight:700;letter-spacing:.02em}
.nhead .st{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:4px;color:var(--c);font-size:.9rem;white-space:nowrap}
.players{text-align:right}.players b{display:block;font-size:2.1rem;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.players span{color:var(--muted);font-size:.78rem;font-weight:300}
.nstats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.nstats>div{padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06)}
.nstats.net{grid-template-columns:repeat(2,1fr)}
.nstats .k{color:var(--dim);font-size:.76rem;font-weight:300}.nstats .v{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:3px 11px;border-radius:99px;font-size:.8rem;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:var(--muted)}
.chip i{width:7px;height:7px;border-radius:50%;background:var(--dim)}
.chip.ok{color:#bdf5dd;border-color:rgba(61,220,151,.35)}.chip.ok i{background:var(--ok)}
.chip.bad{color:#ffc2c4;border-color:rgba(255,90,95,.4)}.chip.bad i{background:var(--down)}
.chip.off{color:var(--dim);border-color:rgba(255,255,255,.12)}.chip.off i{background:rgba(255,255,255,.25)}
.nfoot{display:flex;justify-content:space-between;align-items:center;gap:10px;color:var(--dim);font-size:.82rem;font-weight:300}
.nfoot b{color:var(--ink);font-weight:600}
.ncard .bars{height:24px}
.srow{display:grid;grid-template-columns:150px 1fr auto;gap:14px;align-items:center;padding:14px 0}
.srow+.srow{border-top:1px solid rgba(255,255,255,.07)}
.srow .sn{font-weight:600}.srow .sd{color:var(--muted);font-weight:300;font-size:.9rem}
.srow .sd small{display:block;color:var(--dim);font-size:.8rem;word-break:break-word}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 24px}
.kv div{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.kv span{color:var(--muted);font-weight:300}.kv b{font-weight:600;text-align:right;word-break:break-all}
.warnbox{margin-bottom:16px;padding:16px 20px;border-radius:16px;background:rgba(255,90,95,.1);border:1px solid rgba(255,90,95,.4);color:#ffc2c4}
@media (max-width:720px){.srow{grid-template-columns:1fr auto}.srow .sd{grid-column:1/-1;order:3}}
</style>`;

const SOURCE_NAME: Record<string, () => string> = { youtube: () => 'YouTube', soundcloud: () => 'SoundCloud', http: () => t('src_http'), spotify: () => 'Spotify', applemusic: () => 'Apple Music', deezer: () => 'Deezer' };
const srcName = (k: string) => SOURCE_NAME[k]?.() ?? k;
const memText = (m: MusicNode['mem']) => (m && m.used !== null && m.total !== null
	? `${formatDataSize('byte', m.used, 'short')} / ${formatDataSize('byte', m.total, 'short')}` : null);

/** bytes/วินาที เป็น kbps / Mbps */
const rateText = (bps: number | null | undefined) => {
	if (bps == null) return '–';
	const b = bps * 8;
	return b >= 1e6 ? `${(b / 1e6).toFixed(2)} Mbps` : `${Math.round(b / 1e3)} kbps`;
};

const bars = (r: Report) => r.buckets.map(k => {
	const cls = k.observed <= 0 ? 'na' : k.down <= 0 ? 'ok' : k.down < 5 * 60_000 ? 'warn' : 'bad';
	const tip = k.observed <= 0 ? t('no_data') : k.down <= 0 ? t('no_downtime') : t('down_for', { d: fmtDurTh(k.down) });
	const sp = k.end - k.start;
	const label = sp >= 36 * 3_600_000 ? `${fmtDayTh(k.start)} - ${fmtDayTh(k.end - 1)}` : sp >= 20 * 3_600_000 ? fmtDayTh(k.end - 1) : fmtDateTh(k.start);
	return `<i class="${cls}" title="${label}: ${tip}"></i>`;
}).join('');

const nodeState = (n: MusicNode) => (!n.up ? 'down' : n.sources.youtube && !n.sources.youtube.ok ? 'warn' : 'ok');
const stateLabel: Record<string, string> = { get ok() { return t('state_ok'); }, get warn() { return t('node_warn'); }, get down() { return t('state_down'); }, get load() { return t('state_unknown'); } };

/** หน้ารวม /nodes: การ์ดของแต่ละ node */
export function renderMusicIndex(s: StatusData | undefined, items: NodeItem[], range: Range, ctx: PageCtx): string {
	const m = getMusic();
	const up = items.filter(i => i.n.up).length;
	const total = items.length;
	const key = !m ? 'load' : up === 0 ? 'down' : 'ok';
	const title = !m ? t('nodes_nodata') : up === total ? t('nodes_all_up') : up === 0 ? t('nodes_all_down') : t('nodes_some_up', { n: up, total });
	const sub = !m
		? `${t('nodes_unreachable')}${musicError() ? ` (${esc(musicError()!)})` : ''}`
		: t('nodes_sub');

	const players = items.reduce((a, i) => a + (i.n.playingPlayers ?? 0), 0);
	const cards = items.map(({ n, r }) => {
		const k = nodeState(n);
				const chips = Object.entries(n.sources).map(([src, v]) =>
			`<span class="chip ${v.ok ? 'ok' : v.off ? 'off' : 'bad'}"><i></i>${esc(srcName(src))}</span>`).join('');
		return `<a class="ncard glass" data-state="${k === 'warn' ? 'load' : k}" style="${k === 'warn' ? '--c:var(--warn)' : ''}" href="/nodes/${encodeURIComponent(n.name)}?range=${range}" translate="no">
	<div class="nhead"><div><div class="nm">${esc(n.name)}</div><div class="st"><span class="dot"></span>${stateLabel[k]} <span class="kind ${n.kind}">${KIND_LABEL[n.kind]}</span></div></div>
		<div class="players"><b>${n.up ? (n.playingPlayers ?? 0) : '–'}</b><span>${t('node_playing')}${n.up && n.players !== null ? ` / ${t('node_players', { n: n.players })}` : ''}</span></div></div>
	${n.up ? `<div class="nstats">
		<div><div class="k">Ping</div><div class="v">${n.pingMs ?? '–'} ms</div></div>
		<div><div class="k">CPU</div><div class="v">${n.cpu !== null ? `${n.cpu.toFixed(2)}%` : '–'}</div></div>
		<div><div class="k">RAM</div><div class="v">${n.mem ? `${n.mem.percent.toFixed(1)}%` : '–'}</div></div></div>
	${n.net ? `<div class="nstats net">
		<div><div class="k">${t('net_in')}</div><div class="v">↓ ${rateText(n.net.rxBps)}</div></div>
		<div><div class="k">${t('net_out')}</div><div class="v">↑ ${rateText(n.net.txBps)}</div></div></div>` : ''}`
		: `<div class="nstats" style="grid-template-columns:1fr"><div><div class="k">${t('node_cause')}</div><div class="v">${esc(reasonText(n.errorTh))}</div></div></div>`}
	<div class="chips">${chips}</div>
	<div class="bars">${bars(r)}</div>
	<div class="nfoot"><span>uptime ${RANGE_LONG[range]}</span><b>${fmtPct(r.stat.pct)}</b></div>
</a>`;
	}).join('\n');

	const main = `${MUSIC_CSS}
${ctx.banner ? `<div class="banner ${ctx.banner.level}">${esc(ctx.banner.text)}</div>` : ''}
<section class="hero glass">
	<div class="hl"><span class="pulse"></span><div><h1>${title}</h1><p>${sub}</p></div></div>
	<div class="bigpct"><b>${players}</b><span>${t('nodes_playing_now')}</span></div>
</section>
<div class="toolbar"><h2 class="tt">${t('nodes_all')}</h2>${rangeBar('/nodes', range)}</div>
${total ? `<section class="ngrid">${cards}</section>` : `<section class="panel glass"><div class="none">${t('nodes_none')}</div></section>`}
${pageLinks(range)}
${s ? '' : ''}`;
	return shell(t('nodes_title'), backBtn() + brand, main, key);
}

/** หน้ารายละเอียด /nodes/:node */
export function renderMusicNode(n: MusicNode, r: Report, b: Brief, range: Range, series: SeriesPoint[], ctx: PageCtx, timeline: TimelineItem[] = []): string {
	const now = Date.now();
	const k = nodeState(n);
	const stKey = k === 'ok' ? 'ok' : k === 'down' ? 'down' : 'load';
	const base = `/nodes/${encodeURIComponent(n.name)}`;

	const clock = b.since !== null && b.ms !== null
		? `<div class="k">${b.state === 'up' ? 'Uptime' : 'Downtime'}</div><div class="big" data-since="${b.since}">${fmtDurTh(b.ms)}</div><div class="last">${lastLine(b)}</div>`
		: `<div class="last">${lastLine(b)}</div>`;

	const meter = (label: string, value: string, pct: number | null) =>
		`<div class="tile glass"><div class="k">${label}</div><div class="v">${value}</div>${pct !== null ? `<div class="meter"><i style="width:${Math.min(100, pct)}%"></i></div>` : ''}</div>`;
	const netTile = (label: string, arrow: string, bps: number | null, total: number | null) =>
		`<div class="tile glass"><div class="k">${label}</div><div class="v">${arrow} ${rateText(bps)}</div>${total !== null ? `<div class="k" style="margin-top:6px">${t('net_total', { n: formatDataSize('byte', total, 'short') })}</div>` : ''}</div>`;
	const tile = (label: string, value: string | null) => `<div class="tile glass"><div class="k">${label}</div>${value ? `<div class="v">${value}</div>` : '<div class="v na">N/A</div>'}</div>`;
	const tiles = n.up ? `
	${tile(t('node_songs'), n.playingPlayers !== null ? `${n.playingPlayers} <small style="font-size:.9rem;color:var(--muted);font-weight:300">/ ${t('node_players', { n: n.players ?? 0 })}</small>` : null)}
	${tile('Ping', n.pingMs !== null ? `${n.pingMs} ms` : null)}
	${n.cpu !== null ? meter(t('tile_cpu'), `${n.cpu.toFixed(2)}%`, n.cpu) : tile(t('tile_cpu'), null)}
	${n.mem ? meter(t('tile_mem'), esc(memText(n.mem) ?? `${n.mem.percent}%`), n.mem.percent) : tile(t('tile_mem'), null)}
	${n.net ? `${netTile(t('net_in'), '↓', n.net.rxBps, n.net.rxTotal)}${netTile(t('net_out'), '↑', n.net.txBps, n.net.txTotal)}` : ''}`
		: tile(t('node_down_cause'), esc(reasonText(n.errorTh)));

	const srcRows = Object.entries(n.sources).map(([src, v]) => `<div class="srow">
	<div class="sn">${esc(srcName(src))}</div>
	<div class="sd">${v.ok ? t('src_ok') : v.off ? t('src_off') : esc(v.errorTh ? reasonText(v.errorTh) : t('src_bad'))}</div>
	<span class="chip ${v.ok ? 'ok' : v.off ? 'off' : 'bad'}"><i></i>${v.ok ? t('src_okchip') : v.off ? t('src_offchip') : t('src_badchip')}</span></div>`).join('')
		|| `<div class="none">${t('src_none')}</div>`;

	const kv = (label: string, value: string | null) => `<div><span>${label}</span><b>${value ? esc(value) : '–'}</b></div>`;
	const info = [
		kv(t('node_kind'), KIND_LABEL[n.kind]),
		kv(t('tile_version'), n.version),
		kv(t('node_started'), n.startedAt ? fmtDateTh(n.startedAt) : null),
		kv(t('node_uptime'), n.nodeUptimeMs !== null ? fmtDurTh(n.nodeUptimeMs) : null),
		kv(t('node_restarts'), n.restarts !== null ? t('node_times', { n: n.restarts }) : null),
		kv(t('node_yt24'), n.history24.youtube),
		kv(t('node_up24'), n.history24.uptime),
		kv(t('node_lastdown'), n.lastDown ? `${fmtDurTh(n.lastDown.end - n.lastDown.start)} (${fmtDateTh(n.lastDown.end)})` : t('node_neverdown')),
	].join('');

	const stt = r.stat;
	const avail = `
	<div><div class="k">Uptime</div><b>${fmtPct(stt.pct)}</b><small>${stt.observed ? t('av_from', { d: fmtDurTh(stt.observed) }) : t('av_none')}</small></div>
	<div><div class="k">${t('av_down_total')}</div><b>${stt.down ? fmtDurTh(stt.down) : t('av_none_short')}</b><small>${stt.down ? t('av_down_acc') : t('av_never')}</small></div>
	<div><div class="k">${t('av_count')}</div><b>${t('av_times', { n: stt.incidents })}</b><small>${t('av_count_note')}</small></div>
	<div><div class="k">${t('av_longest')}</div><b>${stt.longest ? fmtDurTh(stt.longest) : t('av_none_short')}</b><small>${t('av_longest_note')}</small></div>`;

	const span = now - r.from;
	const strip = r.strip.map(g => {
		const kk = g.gap ? 'na' : g.status === 1 ? 'ok' : g.status === 0 ? (g.upd ? 'upd' : g.end - g.start < 5 * 60_000 ? 'warn' : 'down') : 'load';
		const label = g.gap ? t('no_data') : g.status === 1 ? t('state_ok') : g.status === 0 ? (g.upd ? t('state_upd') : t('state_down')) : t('state_unknown');
		return `<i class="${kk}" style="left:${g.left.toFixed(3)}%;width:${g.width.toFixed(3)}%" data-tip="${esc(segTip(g, label, kk))}"></i>`;
	}).join('');

	const incidents = r.incidents.length
		? r.incidents.map(i => `<div class="inc"><div class="w">${i.end ? t('from_to', { a: fmtDateTh(i.start), b: fmtDateTh(i.end) }) : fmtDateTh(i.start)}</div>
		${i.end ? `<div class="d">${fmtDurTh(i.duration)}</div>` : `<div class="d on">${t('down_now')} <span data-since="${i.start}">${fmtDurTh(now - i.start)}</span></div>`}</div>`).join('')
		: `<div class="none">${t('no_down_range')}</div>`;

	const main = `${MUSIC_CSS}
${ctx.banner ? `<div class="banner ${ctx.banner.level}">${esc(ctx.banner.text)}</div>` : ''}
<section class="dhero glass" style="${k === 'warn' ? '--c:var(--warn)' : ''}">
	<div class="beacon"><div class="core">${ICON[stKey as 'ok' | 'load' | 'down']}</div></div>
	<div class="ttl"><h1 translate="no">${esc(n.name)}</h1>
		<span class="pill">${stateLabel[k]}</span><span class="kind ${n.kind}">${KIND_LABEL[n.kind]}</span></div>
	<div class="clock">${clock}</div>
</section>
${!n.up ? `<div class="warnbox">${t('node_moved')}</div>` : ''}
<section class="tiles">${tiles}</section>
<section class="panel glass" style="margin-top:16px"><h2>${t('node_sources')}</h2>${srcRows}</section>
<section class="panel glass"><h2>${t('node_info')}</h2><div class="kv">${info}</div></section>
<div class="toolbar"><h2 class="tt">${t('history')}</h2>${rangeBar(base, range)}</div>
<section class="panel glass"><h2>${t('availability', { range: RANGE_LONG[range] })}</h2><div class="avail">${avail}</div></section>
<section class="panel glass"><h2>${t('timeline')}</h2>
	<div class="strip">${strip}</div>
	<div class="axis"><span>${fmtDateTh(r.from)}</span><span>${fmtDateTh(r.from + span / 2)}</span><span>${t('now')}</span></div></section>
<section class="panel glass"><h2>${t('ping_title')}</h2>${svgChart([seriesLine(series, 'ping', 'Ping', COLORS[2])], ' ms')}</section>
${resourcePanels(series)}
${series.some(p => p.netIn !== null || p.netOut !== null) ? `<section class="panel glass"><h2>${t('net_chart')}</h2>${svgChart([seriesLine(series, 'netIn', t('net_in'), COLORS[2]), seriesLine(series, 'netOut', t('net_out'), COLORS[3])], ' kbps')}</section>` : ''}
${renderTimeline(timeline)}
${pageLinks(range)}`;

	return shell(`Yumi - ${esc(n.name)}`, backBtn(`/nodes?range=${range}`) + brand, main, stKey);
}

import type { SeriesPoint, Range } from './history.js';
import { RANGE_LIST } from './history.js';
import { displayName, fmtDateTh } from './format.js';
import { localeOf, prefs, t } from './i18n.js';

const W = 720, H = 210, PL = 56, PR = 14, PT = 14, PB = 28;
export const COLORS = ['#ff5a5f', '#3ddc97', '#4cc9f0', '#fbbf24', '#b388ff'];
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export type Line = { name: string; color: string; points: { ts: number; v: number | null }[] };
export type SeriesKey = 'cpu' | 'memMb' | 'ping' | 'uptimeH' | 'downPct' | 'netIn' | 'netOut';

/** แปลงข้อมูลช่วงเวลาเป็นเส้นหนึ่งเส้น */
export function seriesLine(points: SeriesPoint[], key: SeriesKey, name: string, color: string): Line {
	return { name, color, points: points.map(p => ({ ts: p.ts, v: p[key] })) };
}

function niceStep(x: number): number {
	if (!(x > 0)) return 1;
	const e = Math.pow(10, Math.floor(Math.log10(x)));
	const f = x / e;
	const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
	return Math.max(1, m * e);
}

/**
 * ช่วงแกน Y จากค่าที่เห็นในกราฟจริง:
 * - ไม่เริ่มที่ 0 ถ้าค่าต่ำสุดไม่ใช่ 0 (เริ่มจากค่าต่ำสุดที่มี)
 * - ด้านล่างปัดลง ด้านบนปัดขึ้น ให้ลงตัวกับขั้นบอกค่า
 * - เป็นจำนวนเต็มเสมอ ไม่มีทศนิยมบนแกน
 */
export function niceRange(values: number[]): { lo: number; hi: number; step: number } {
	let lo = Math.min(...values), hi = Math.max(...values);
	if (hi === lo) hi = lo + 1;
	const step = niceStep((hi - lo) / 5);
	lo = Math.floor(lo / step) * step;
	hi = Math.ceil(hi / step) * step;
	if (hi === lo) hi = lo + step;
	return { lo, hi, step };
}

/** วาดกราฟเส้น; ช่วงที่ค่าเป็น null จะขาดเส้น; เส้นที่ไม่มีข้อมูลเลยจะไม่แสดง */
export function svgChart(lines: Line[], unit: string): string {
	const live = lines.filter(l => l.points.some(p => p.v !== null));
	if (!live.length) return `<p class="empty">${t('chart_empty')}</p>`;

	const n = live[0].points.length;
	const ts = live[0].points.map(p => p.ts);
	const vals = live.flatMap(l => l.points.map(p => p.v).filter((v): v is number => v !== null));
	const { lo, hi, step } = niceRange(vals);

	const X = (i: number) => PL + (i / (n - 1)) * (W - PL - PR);
	const Y = (v: number) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);

	const grid: string[] = [];
	for (let v = lo; v <= hi + 1e-9; v += step) {
		const y = Y(v).toFixed(1);
		grid.push(`<line class="g" x1="${PL}" x2="${W - PR}" y1="${y}" y2="${y}"/>`);
		grid.push(`<text class="ax" x="${PL - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v)}${esc(unit)}</text>`);
	}

	const paths = live.map(l => {
		let d = '', pen = false;
		l.points.forEach((p, i) => {
			if (p.v === null) { pen = false; return; }
			d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`;
			pen = true;
		});
		return `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
	}).join('');

	const dots = live.map(l => `<circle class="pt" r="4" fill="${l.color}"/>`).join('');

	const xLabels =
		`<text class="ax" x="${PL}" y="${H - 6}">${esc(fmtDateTh(ts[0]))}</text>` +
		`<text class="ax" x="${W - PR}" y="${H - 6}" text-anchor="end">${esc(fmtDateTh(ts[n - 1]))}</text>`;

	const data = {
		ts,
		unit,
		lo,
		hi,
		g: [W, H, PL, PR, PT, PB],
		lines: live.map(l => ({ name: l.name, color: l.color, v: l.points.map(p => p.v) })),
	};

	// ค่าน้อยกว่า 1 (เช่น CPU 0.03%) แสดง 2 ตำแหน่ง ไม่ให้ปัดเป็น 0
	const f1 = (v: number) => String(Math.abs(v) < 1 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10);
	const legend = live.map(l => {
		const vs = l.points.map(p => p.v).filter((v): v is number => v !== null);
		const mn = Math.min(...vs), mx = Math.max(...vs), av = vs.reduce((a, b) => a + b, 0) / vs.length;
		return `<span class="lg" style="color:${l.color}">● ${esc(l.name)} <em>${t('min')}</em> <b>${f1(mn)}${esc(unit)}</b> <em>${t('avg')}</em> <b>${f1(av)}${esc(unit)}</b> <em>${t('max')}</em> <b>${f1(mx)}${esc(unit)}</b></span>`;
	}).join('');

	return `<div class="ch" data-chart="${esc(JSON.stringify(data))}">` +
		`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${grid.join('')}${paths}` +
		`<line class="cur" x1="0" x2="0" y1="${PT}" y2="${H - PB}"/>${dots}${xLabels}` +
		`<rect class="hit" x="${PL}" y="${PT}" width="${W - PL - PR}" height="${H - PT - PB}"/>` +
		`</svg><div class="legend">${legend}</div></div>`;
}

/* ---------- ส่วนที่ใช้ร่วมกันระหว่างหน้ากราฟและหน้ารายละเอียด ---------- */

/** CSS ของกราฟและ tooltip (ใส่ใน <style> ของทุกหน้าที่มีกราฟหรือไทม์ไลน์) */
export const UI_CSS = `
.ch{position:relative}
.ch svg{display:block;width:100%;height:auto;overflow:visible}
.ch .g{stroke:rgba(255,255,255,.07)}
.ch .ax{font-size:11px;fill:#8a706d;font-variant-numeric:tabular-nums;font-family:'Kanit',system-ui,sans-serif}
.ch .legend{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px;font-size:12.5px;color:#b99a97}
.ch .legend em{font-style:normal;color:#8a706d;margin-left:4px}
.ch .legend b{color:#fff3f1;font-weight:500;margin-left:2px}
.ch .cur{stroke:rgba(255,255,255,.35);stroke-dasharray:3 3;display:none}
.ch circle.pt{display:none;stroke:#0b0405;stroke-width:2}
.ch .hit{fill:transparent;cursor:crosshair}
.tip{position:fixed;z-index:60;pointer-events:none;min-width:150px;max-width:300px;padding:10px 13px;border-radius:12px;background:rgba(22,9,11,.97);border:1px solid rgba(255,255,255,.12);box-shadow:0 16px 36px -12px rgba(0,0,0,.85);color:#fff3f1;font:13px/1.6 'Kanit',system-ui,sans-serif}
.tip[hidden]{display:none}
.tip .tt-h{color:#b99a97;font-size:12px;margin-bottom:4px}
`;

/** element ของ tooltip (วางไว้นอกพื้นที่ที่รีเฟรชอัตโนมัติ) */
export const UI_BODY = `<div id="tip" class="tip" hidden></div>`;

/** ตัวจัดการเมาส์: กราฟแสดงค่า ณ จุดที่ชี้ และองค์ประกอบที่มี data-tip แสดงรายละเอียด */
export const UI_SCRIPT = () => `(function(){
var tip=document.getElementById('tip');
if(!tip)return;
var fmtT=new Intl.DateTimeFormat(${JSON.stringify(localeOf())},${JSON.stringify({ timeZone: prefs().tz, day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', ...(prefs().h12 === null ? {} : { hour12: prefs().h12 }) })});
var NODATA=${JSON.stringify(t('no_data'))};
var activeCh=null,lastEl=null;
function place(e){
	var w=tip.offsetWidth,h=tip.offsetHeight,x=e.clientX+16,y=e.clientY+16;
	if(x+w>innerWidth-8)x=e.clientX-w-16;
	if(y+h>innerHeight-8)y=e.clientY-h-16;
	tip.style.left=Math.max(8,x)+'px';tip.style.top=Math.max(8,y)+'px';
}
function show(html,e){tip.innerHTML=html;tip.hidden=false;place(e);}
function hide(){tip.hidden=true;}
function resetCh(c){
	var svg=c.querySelector('svg');
	svg.querySelector('line.cur').style.display='none';
	var dots=svg.querySelectorAll('circle.pt');
	for(var i=0;i<dots.length;i++)dots[i].style.display='none';
}
function fmtVal(v){return String(Math.abs(v)<1?Math.round(v*100)/100:Math.round(v*10)/10);}
function chartAt(c,e){
	var d=c._d||(c._d=JSON.parse(c.getAttribute('data-chart')));
	var svg=c.querySelector('svg'),r=svg.getBoundingClientRect();
	var W=d.g[0],H=d.g[1],PL=d.g[2],PR=d.g[3],PT=d.g[4],PB=d.g[5];
	var vx=(e.clientX-r.left)/r.width*W;
	var f=Math.max(0,Math.min(1,(vx-PL)/(W-PL-PR)));
	var n=d.ts.length,i=Math.round(f*(n-1));
	var x=PL+i/(n-1)*(W-PL-PR);
	var cur=svg.querySelector('line.cur');
	cur.setAttribute('x1',x);cur.setAttribute('x2',x);cur.style.display='';
	var dots=svg.querySelectorAll('circle.pt');
	var rows='';
	for(var k=0;k<d.lines.length;k++){
		var L=d.lines[k],v=L.v[i],dot=dots[k];
		if(v===null||v===undefined){
			dot.style.display='none';
			rows+='<div><span style="color:'+L.color+'">●</span> '+L.name+': <b>'+NODATA+'</b></div>';
		}else{
			var y=PT+(1-(v-d.lo)/(d.hi-d.lo))*(H-PT-PB);
			dot.setAttribute('cx',x);dot.setAttribute('cy',y);dot.style.display='';
			rows+='<div><span style="color:'+L.color+'">●</span> '+L.name+': <b>'+fmtVal(v)+d.unit+'</b></div>';
		}
	}
	show('<div class="tt-h">'+fmtT.format(new Date(d.ts[i]))+'</div>'+rows,e);
}
document.addEventListener('mousemove',function(e){
	var t=e.target;
	if(!t||!t.closest)return;
	var c=t.closest('.ch');
	if(c){
		if(activeCh&&activeCh!==c)resetCh(activeCh);
		activeCh=c;lastEl=null;
		chartAt(c,e);
		return;
	}
	if(activeCh){resetCh(activeCh);activeCh=null;}
	var el=t.closest('[data-tip]');
	if(el){
		if(el!==lastEl){lastEl=el;show(el.getAttribute('data-tip'),e);}
		else place(e);
		return;
	}
	lastEl=null;hide();
});
})();`;

/* ---------- หน้า /metrics ---------- */

const panel = (title: string, body: string) => `<section class="panel glass"><h2>${esc(title)}</h2>${body}</section>`;

/** หน้ากราฟ: /metrics?range=24h|7d|30d|all  (แต่ละกราฟรวมทุก service ที่มีค่านั้น แยกด้วยสี) ใช้โครงหน้าเดียวกับหน้าอื่น */
export async function renderMetricsPage(data: Record<string, SeriesPoint[]>, range: Range): Promise<string> {
	const { shell, backBtn, brand, rangeBar, pageLinks } = await import('./pages.js');
	const services = Object.keys(data);
	const lines = (key: SeriesKey) => services.map((n, i) => seriesLine(data[n] ?? [], key, displayName(n), COLORS[i % COLORS.length]));
	const main = `
<div class="toolbar" style="margin-top:0"><h1 class="tt" style="font-size:1.5rem">${esc(t('metrics_title'))}</h1>${rangeBar('/metrics', range)}</div>
${panel('PING (ms)', svgChart(lines('ping'), ' ms'))}
${panel('CPU (%)', svgChart(lines('cpu'), '%'))}
${panel('RAM (MB)', svgChart(lines('memMb'), ' MB'))}
${pageLinks(range)}`;
	return shell(`${t('metrics_title')} - Yumi Status`, backBtn() + brand, main, 'ok');
}

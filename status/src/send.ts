import 'dotenv/config';
import { formatDataSize } from 'global/common-functions';
import { Client, GatewayIntentBits, GuildTextBasedChannel, MessageFlags, ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { backend, bot_main, database, frontend_main, getActiveError, getLastError, music } from './check.js';
import { getMusic } from './music.js';
import { getBrief, type Brief, type UpdateEvent } from './history.js';
import { displayName, fmtDurTh } from './format.js';
import { sendStatusMail, type MailItem } from './mail.js';
import { StatusData } from 'global/types';

const CHANNEL_ID = '1399765608106688745';
const ALERT_ROLE = '<@&1227999302278713407>';

const ts = (t: number, f: 'f' | 'R' = 'f') => `<t:${Math.floor(t / 1000)}:${f}>`;
/** บรรทัดรายการ: ถ้าไม่มีข้อมูลจะเป็นตัวเล็กสีจาง (-#) เหมือนเดิม */
const row = (label: string, value: string | null | undefined) => `${value == null ? '-# ' : ''}- **${label}**: ${value ?? 'N/A'}`;

const verText = (u: UpdateEvent) => (u.from && u.to && u.from !== u.to ? `${u.from} -> ${u.to}` : u.to ? `v${u.to}` : null);

function body(s: StatusData, b: Brief, u?: UpdateEvent): string {
	const L: string[] = [];
	L.push(u?.noDowntime ? '**:green_circle:  อัปเดตเวอร์ชันแล้ว (ไม่มี downtime)**'
		: u ? '**:green_circle:  อัปเดตสำเร็จ กลับมาทำงานตามปกติแล้ว**'
		: b.upd ? '**:green_circle:  กำลังอัปเดต**'
		: s.status === 1 ? '**:green_circle:  กำลังทำงาน**' : s.status === -1 ? '**:blue_circle:  กำลังเริ่มระบบ**' : '**:red_circle:  หยุดทำงาน**');

	if (u) {
		L.push(row('เวอร์ชัน', verText(u)));
		if (!u.noDowntime) L.push(row('ใช้เวลาอัปเดต', fmtDurTh(u.ms)));
	} else if (b.upd) {
		L.push(row('สาเหตุ', b.updCause ?? 'อัปเดตระบบ'));
	} else if (s.status === 0) {
		const e = getActiveError(s.name);
		L.push(row('สาเหตุ', e ? e.message : 'ไม่ทราบสาเหตุ'));
	} else if (s.status === 1) {
		const e = getLastError(s.name);
		if (e) L.push(`-# ข้อผิดพลาดล่าสุดก่อนหน้า: ${e.message} (${ts(e.at, 'R')})`);
	}

	if (b.state === 'up') {
		// กำลังทำงาน -> Uptime + Downtime ล่าสุด
		L.push(row('Uptime', b.ms !== null ? fmtDurTh(b.ms) : null));
		L.push(b.last
			? row('Downtime ล่าสุด', `${fmtDurTh(b.last.duration)} (${ts(b.last.end, 'R')})`)
			: '- **Downtime ล่าสุด**: ยังไม่เคยล่มตั้งแต่เริ่มบันทึก');
	} else if (b.state === 'down') {
		// หยุดทำงาน -> Downtime + Uptime ล่าสุด
		L.push(row('Downtime', b.ms !== null && b.since !== null ? `${fmtDurTh(b.ms)} (ตั้งแต่ ${ts(b.since, 'R')})` : null));
		L.push(row('Uptime ล่าสุด', b.last ? `${fmtDurTh(b.last.duration)} (จนถึง ${ts(b.last.end, 'f')})` : null));
	}

	if (s.name === 'nodes') {
		// รวมเป็นภาพเดียว: บอทเพลงแจ้งรายละเอียดแต่ละ node ในห้องเองอยู่แล้ว
		const m = getMusic();
		L.push(row('Node ที่ทำงาน', m ? `${m.up} / ${m.total}` : null));
		L.push(row('เพลงที่กำลังเล่น', m ? `${m.nodes.reduce((a, n) => a + (n.playingPlayers ?? 0), 0)}` : null));
	}
	L.push(row('Ping', typeof s.ping === 'number' ? `${s.ping} ms` : null));
	if (s.resources?.cpu || s.resources?.memory) {
		L.push(row('CPU', s.resources?.cpu ? `${s.resources.cpu.percent}%` : null));
		L.push(row('หน่วยความจำ', s.resources?.memory
			? `${formatDataSize('byte', s.resources.memory.used, 'short')} / ${formatDataSize('byte', s.resources.memory.total, 'short')} \`(${s.resources.memory.percent}%)\``
			: null));
	}
	return L.join('\n');
}

function buildComponents(items: MailItem[], full: boolean) {
	const now = Date.now();
	const anyDown = items.some(i => i.s.status === 0 && !i.b.upd);
	const head = [
		new TextDisplayBuilder().setContent(`${anyDown ? `${ALERT_ROLE}\n` : ''}# Yumi Status`),
		new TextDisplayBuilder().setContent(`${full ? 'รายงานสถานะประจำวัน' : 'แจ้งเตือนการเปลี่ยนแปลงสถานะ'}\n-# ${ts(now, 'f')}`),
	];
	const cards = items.map(({ s, b, u }) =>
		new ContainerBuilder()
			.setAccentColor(u || b.upd ? 0x1f8a52 : s.status === 1 ? 0x32cd32 : s.status === -1 ? 0x4cc9f0 : 0xff4c4c)
			.addTextDisplayComponents(t => t.setContent(`## ${displayName(s.name)}`))
			.addTextDisplayComponents(t => t.setContent(body(s, b, u)))
	);
	return [...head, ...cards];
}

async function sendDiscord(items: MailItem[], full: boolean) {
	const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
	try {
		await new Promise<void>((resolve, reject) => {
			client.once('ready', async () => {
				try {
					const channel = (await client.channels.fetch(CHANNEL_ID)) as GuildTextBasedChannel | null;
					if (!channel) { console.error('ไม่พบช่องใน Discord เพื่อส่งแจ้งเตือน'); resolve(); return; }
					await channel.send({ components: buildComponents(items, full), flags: MessageFlags.IsComponentsV2 });
					resolve();
				} catch (e) { reject(e); }
			});
			client.login(process.env.BOT_TOKEN).catch(reject);
		});
	} finally {
		client.destroy();
	}
}

export async function send(to_discord: boolean = true, to_mail: boolean = true, full: boolean = true, data?: StatusData[], updates: UpdateEvent[] = []) {
	let list: StatusData[];
	if (full) {
		list = [
			data?.find(v => v.name == 'bot') || await bot_main(),
			data?.find(v => v.name == 'database') || await database(),
			data?.find(v => v.name == 'frontend_main') || await frontend_main(),
			data?.find(v => v.name == 'backend') || await backend(),
			data?.find(v => v.name == 'nodes') || await music(),
		];
	} else {
		list = data ?? [];
	}
	if (!list.length) return;

	const items: MailItem[] = await Promise.all(list.map(async s => ({ s, b: await getBrief(s), u: updates.find(e => e.service === s.name) })));
	const tasks: Promise<unknown>[] = [];
	if (to_discord) tasks.push(sendDiscord(items, full).catch(e => console.error('ไม่สามารถส่งข้อความไปที่ Discord ได้:', e)));
	if (to_mail) tasks.push(sendStatusMail(items, full ? 'daily' : 'change').catch(e => console.error('ไม่สามารถส่งอีเมลได้:', e)));
	await Promise.all(tasks);
};
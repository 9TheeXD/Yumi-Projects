import os from 'os';
import { NextResponse } from 'next/server';
import pkg from '../../../package.json';

// ส่งสถานะให้ระบบ status (รูปแบบเดียวกับ bot และ backend)
// ต้องเป็น dynamic เสมอ ห้ามถูก cache ตอน build
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** รูปแบบเดียวกับ StatusData ใน global (ประกาศไว้ที่นี่เพื่อไม่ผูกกับเวอร์ชันของ package global ที่ติดตั้ง) */
type StatusData = {
	name: string;
	status: -1 | 0 | 1;
	ping?: number;
	uptime?: number;
	startTime?: string;
	host?: string;
	version?: string;
	resources?: { cpu: { percent: number }; memory: { percent: number; used: number; total: number } };
};

/** ตัวอย่าง CPU ก่อนหน้า: คิดจากส่วนต่างระหว่างคำขอ ไม่ต้องรอระหว่างวัด */
type Sample = { cpu: NodeJS.CpuUsage; at: number };
const g = globalThis as typeof globalThis & { __statusSample?: Sample };

function cpuPercent(): number {
	const now = Date.now();
	const prev = g.__statusSample;
	const cpu = process.cpuUsage();
	g.__statusSample = { cpu, at: now };
	// คำขอแรก: ใช้ค่าเฉลี่ยตั้งแต่เริ่มโปรเซส
	const elapsedMs = prev ? now - prev.at : process.uptime() * 1000;
	const used = prev ? (cpu.user - prev.cpu.user) + (cpu.system - prev.cpu.system) : cpu.user + cpu.system;
	if (elapsedMs <= 0) return 0;
	return +((used / (elapsedMs * 1000)) * 100).toFixed(2);
}

export async function GET() {
	const uptime = Math.floor(process.uptime());
	const usedMem = process.memoryUsage().rss;
	const totalMem = os.totalmem();

	const data: StatusData = {
		name: pkg.name,
		version: pkg.version,
		status: 1,
		uptime,
		startTime: new Date(Date.now() - uptime * 1000).toISOString(),
		host: os.hostname(),
		resources: {
			cpu: { percent: cpuPercent() },
			memory: {
				percent: +(usedMem / totalMem * 100).toFixed(2),
				used: usedMem,
				total: totalMem,
			},
		},
	};
	return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
}

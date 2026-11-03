import os from 'node:os';

/* ------------------------------------------------------------------ */
/*  CPU / RAM ทุก service คิดเทียบกับทั้งเครื่อง (status อยู่เครื่องเดียวกับ service)  */
/*  ค่าที่ service ส่งมา: CPU เป็น % ของ 1 core (process.cpuUsage, docker stats)    */
/*  แปลงเป็น % ของทุก core รวมกัน และ RAM เป็นส่วนของ RAM ทั้งเครื่อง                */
/* ------------------------------------------------------------------ */

export const HOST_CORES = Math.max(1, Number(process.env.HOST_CPU_CORES) || os.availableParallelism?.() || os.cpus().length || 1);
export const HOST_MEM = Number(process.env.HOST_MEM_BYTES) || os.totalmem();

const r2 = (n: number) => Math.round(n * 100) / 100;

/** CPU % ของ 1 core เป็น % ของทั้งเครื่อง */
export const cpuOfHost = (perCore: number) => r2(perCore / HOST_CORES);

/** RAM ที่ใช้ เป็น % ของทั้งเครื่อง */
export const memOfHost = (used: number) => r2((used / HOST_MEM) * 100);

/** resources ที่ service ส่งมา (CPU ต่อ core) เป็นแบบเทียบทั้งเครื่อง */
export function hostResources(r: { cpu?: { percent?: number }; memory?: { used?: number } } | undefined) {
	if (!r || typeof r.cpu?.percent !== 'number' || typeof r.memory?.used !== 'number') return undefined;
	return { cpu: { percent: cpuOfHost(r.cpu.percent) }, memory: { percent: memOfHost(r.memory.used), used: r.memory.used, total: HOST_MEM } };
}

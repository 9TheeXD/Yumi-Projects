import { musicConfig } from "./config.js";

// Sliding window per user and kind. Returns false when the user is over the limit.
const hits = new Map<string, number[]>();

export function userAllow(userId: string | undefined, kind: 'play' | 'autocomplete') {
  if (!userId) return true;
  const c = musicConfig().userLimit;
  const max = kind === 'play' ? c.play : c.autocomplete;
  const key = `${kind}:${userId}`;
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < c.windowMs);
  if (list.length >= max) { hits.set(key, list); return false; }
  list.push(now);
  hits.set(key, list);
  return true;
}
setInterval(() => {
  const now = Date.now(), w = musicConfig().userLimit.windowMs;
  for (const [k, v] of hits) if (!v.some(t => now - t < w)) hits.delete(k);
}, 60_000).unref();

// Limits concurrent requests to one backend (YouTube). Waiters past the timeout get rejected.
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private max: () => number) {}

  async run<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.active >= this.max()) {
      // The releasing caller hands its slot to us, so `active` is not incremented here.
      await new Promise<void>((res, rej) => {
        const w = () => { clearTimeout(t); res(); };
        const t = setTimeout(() => {
          this.waiters = this.waiters.filter(x => x !== w);
          rej(new Error('queue timeout'));
        }, timeoutMs);
        this.waiters.push(w);
      });
    } else {
      this.active++;
    }
    try { return await fn(); }
    finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

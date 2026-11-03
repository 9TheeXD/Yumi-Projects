import chalk from "chalk";
import { EventEmitter } from "events";
import { musicConfig } from "./config.js";

type State = 'closed' | 'open' | 'half-open';
type Breaker = { state: State; failures: number[]; openedAt: number; cooldownMs: number; probing: boolean; lastError?: string };

const head = chalk.magenta.bold('[Breaker]');
const breakers = new Map<string, Breaker>();

// Emits 'open' / 'close' (key, lastError) so the bot can alert or tell users.
export const breakerEvents = new EventEmitter();

function get(key: string): Breaker {
  let b = breakers.get(key);
  if (!b) {
    b = { state: 'closed', failures: [], openedAt: 0, cooldownMs: musicConfig().breaker.cooldownMs, probing: false };
    breakers.set(key, b);
  }
  return b;
}

// true = request may go to this source now.
export function breakerAllow(key: string): boolean {
  const b = get(key);
  if (b.state === 'closed') return true;
  if (b.state === 'open' && Date.now() - b.openedAt >= b.cooldownMs) {
    b.state = 'half-open';
    b.probing = false;
  }
  if (b.state === 'half-open' && !b.probing) {
    b.probing = true;
    return true;
  }
  return false;
}

export function breakerSuccess(key: string) {
  const b = get(key);
  // In closed state old failures expire by window, so a mix of success and failure can still open it.
  if (b.state === 'closed') return;
  console.log(head, `${chalk.bold(key)} closed again`);
  breakerEvents.emit('close', key);
  b.state = 'closed';
  b.failures = [];
  b.probing = false;
  b.cooldownMs = musicConfig().breaker.cooldownMs;
}

export function breakerFailure(key: string, error?: string) {
  const c = musicConfig().breaker;
  const b = get(key);
  const now = Date.now();
  b.lastError = error;
  if (b.state === 'half-open') {
    // Probe failed: stay open longer.
    b.state = 'open';
    b.openedAt = now;
    b.probing = false;
    b.cooldownMs = Math.min(b.cooldownMs * 2, c.maxCooldownMs);
    console.warn(head, `${chalk.bold(key)} probe failed, open for ${Math.round(b.cooldownMs / 1000)}s:`, error);
    return;
  }
  b.failures = b.failures.filter(t => now - t < c.windowMs);
  b.failures.push(now);
  if (b.state === 'closed' && b.failures.length >= c.failures) {
    b.state = 'open';
    b.openedAt = now;
    console.warn(head, `${chalk.bold(key)} opened after ${b.failures.length} failures:`, error);
    breakerEvents.emit('open', key, error);
  }
}

export function breakerStatus() {
  return Object.fromEntries([...breakers].map(([k, b]) => [k, {
    state: b.state, recentFailures: b.failures.length, cooldownMs: b.cooldownMs,
    retryAt: b.state === 'closed' ? null : b.openedAt + b.cooldownMs, lastError: b.lastError ?? null,
  }]));
}

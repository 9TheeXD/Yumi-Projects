import { execFile } from "node:child_process";
import chalk from "chalk";
import { Semaphore } from "./limiter.js";

const head = chalk.cyan.bold('[Extract]');

// Sites the nodes have no source for. yt-dlp finds the media file; the node then plays that file
// through its http source. Only sites whose media link works without request headers are listed:
// a TikTok link answers 403 to a plain request, and the nodes cannot send the headers it needs.
const HOSTS = /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/i;

export type Extracted = { title: string; author: string; durationMs: number; artwork?: string; direct: string };

export function isExtractUrl(url: string) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && HOSTS.test(u.hostname);
  } catch { return false; }
}

// yt-dlp is a Python program: two at a time at most, the host has little free memory.
const gate = new Semaphore(() => 2);
const TIMEOUT_MS = 30_000;

export function extract(url: string): Promise<Extracted | null> {
  return gate.run(() => new Promise<Extracted | null>(resolve => {
    // Arguments go in an array (no shell), after `--` so the URL can never be read as an option.
    execFile('yt-dlp', ['--no-warnings', '--no-update', '--no-playlist', '-J', '-f', 'ba/b', '--', url],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) { console.warn(head, `yt-dlp failed:`, err.message.split('\n')[0].slice(0, 160)); return resolve(null); }
        try {
          const j = JSON.parse(stdout) as { title?: string; uploader?: string; channel?: string; duration?: number; thumbnail?: string; url?: string };
          if (!j.url || !/^https?:\/\//i.test(j.url)) return resolve(null);
          resolve({
            title: (j.title || 'Facebook video').slice(0, 200),
            author: j.uploader || j.channel || 'Facebook',
            durationMs: Math.round((j.duration ?? 0) * 1000),
            artwork: j.thumbnail,
            direct: j.url,
          });
        } catch { resolve(null); }
      });
  }), TIMEOUT_MS + 5_000);
}

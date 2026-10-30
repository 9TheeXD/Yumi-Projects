import fs from "fs";
import path from "path";
import Env from "../utils/env.js";

// One search source. `key` groups sources that share a backend for the circuit breaker
// (youtube + youtube_music hit the same YouTube infrastructure).
export type SourceDef = {
  id: string;
  prefix: string;
  key: string;
  // Results from a non-final source must look like the query, otherwise we fall through.
  strict: boolean;
  // Name in the node's /v4/info sourceManagers.
  manager: string;
};

export const SOURCES: Record<string, SourceDef> = {
  soundcloud:    { id: 'soundcloud',    prefix: 'scsearch:',  key: 'soundcloud', strict: true, manager: 'soundcloud' },
  bandcamp:      { id: 'bandcamp',      prefix: 'bcsearch:',  key: 'bandcamp',   strict: true, manager: 'bandcamp' },
  deezer:        { id: 'deezer',        prefix: 'dzsearch:',  key: 'deezer',     strict: true, manager: 'deezer' },
  // NodeLink only. Free full-length streams (mp3), good for Western/K-pop, weak for mixed Thai queries.
  audiomack:     { id: 'audiomack',     prefix: 'admsearch:', key: 'audiomack',  strict: true, manager: 'audiomack' },
  jiosaavn:      { id: 'jiosaavn',      prefix: 'jssearch:',  key: 'jiosaavn',   strict: true, manager: 'jiosaavn' },
  // Metadata catalogs (good Thai + international matching). The node plays them from YouTube by ISRC/title,
  // and NodeLink falls back to SoundCloud etc. when YouTube fails.
  spotify:       { id: 'spotify',       prefix: 'spsearch:',  key: 'spotify',    strict: true, manager: 'spotify' },
  applemusic:    { id: 'applemusic',    prefix: 'amsearch:',  key: 'applemusic', strict: true, manager: 'applemusic' },
  youtube_music: { id: 'youtube_music', prefix: 'ytmsearch:', key: 'youtube',    strict: false, manager: 'youtube' },
  youtube:       { id: 'youtube',       prefix: 'ytsearch:',  key: 'youtube',    strict: false, manager: 'youtube' },
};

export type MusicConfig = {
  order: string[];
  disabled: string[];
  autocompleteOrder: string[];
  negativeTtlMs: number;
  breaker: { failures: number; windowMs: number; cooldownMs: number; maxCooldownMs: number };
  youtubeConcurrency: number;
  youtubeQueueTimeoutMs: number;
  userLimit: { play: number; autocomplete: number; windowMs: number };
  minTrackMs: number;
  matchRatio: number;
};

const list = (v: string | undefined, def: string[]) =>
  v ? v.split(',').map(s => s.trim()).filter(Boolean) : def;
const num = (v: string | undefined, def: number) => {
  const n = Number(v);
  return v && !Number.isNaN(n) ? n : def;
};

function fromEnv(): MusicConfig {
  return {
    // YouTube is last on purpose. See handoff-music-bot.md section 3.
    order: list(Env('MUSIC_SOURCE_ORDER'), ['spotify', 'soundcloud', 'audiomack', 'applemusic', 'deezer', 'youtube_music', 'youtube']),
    disabled: list(Env('MUSIC_SOURCE_DISABLED'), []),
    autocompleteOrder: list(Env('MUSIC_AUTOCOMPLETE_ORDER'), ['spotify', 'soundcloud', 'applemusic', 'youtube_music']),
    negativeTtlMs: num(Env('MUSIC_NEGATIVE_TTL_MS'), 30 * 60_000),
    breaker: {
      failures: num(Env('MUSIC_BREAKER_FAILURES'), 5),
      windowMs: num(Env('MUSIC_BREAKER_WINDOW_MS'), 2 * 60_000),
      cooldownMs: num(Env('MUSIC_BREAKER_COOLDOWN_MS'), 5 * 60_000),
      maxCooldownMs: num(Env('MUSIC_BREAKER_MAX_COOLDOWN_MS'), 60 * 60_000),
    },
    youtubeConcurrency: num(Env('MUSIC_YOUTUBE_CONCURRENCY'), 2),
    youtubeQueueTimeoutMs: num(Env('MUSIC_YOUTUBE_QUEUE_TIMEOUT_MS'), 15_000),
    userLimit: {
      play: num(Env('MUSIC_USER_PLAY_LIMIT'), 6),
      autocomplete: num(Env('MUSIC_USER_AUTOCOMPLETE_LIMIT'), 15),
      windowMs: num(Env('MUSIC_USER_LIMIT_WINDOW_MS'), 30_000),
    },
    // SoundCloud Go+ previews are 30s clips.
    minTrackMs: num(Env('MUSIC_MIN_TRACK_MS'), 31_000),
    matchRatio: num(Env('MUSIC_MATCH_RATIO'), 0.6),
  };
}

// Optional JSON file that overrides env at runtime (no redeploy). Same keys as MusicConfig.
// Example: { "disabled": ["youtube", "youtube_music"] }
export const OVERRIDE_FILE = path.resolve(Env('MUSIC_CONFIG_FILE') || path.join(process.cwd(), 'music-sources.json'));

let cached: MusicConfig = fromEnv();
let loadedAt = 0;
let fileMtime = 0;

export function musicConfig(): MusicConfig {
  if (Date.now() - loadedAt < 10_000) return cached;
  loadedAt = Date.now();
  try {
    const st = fs.statSync(OVERRIDE_FILE);
    if (st.mtimeMs === fileMtime) return cached;
    fileMtime = st.mtimeMs;
    const override = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
    const base = fromEnv();
    cached = { ...base, ...override, breaker: { ...base.breaker, ...override.breaker }, userLimit: { ...base.userLimit, ...override.userLimit } };
  } catch {
    if (fileMtime !== 0) { fileMtime = 0; cached = fromEnv(); }
  }
  return cached;
}

export function sourceEnabled(id: string) {
  const c = musicConfig();
  const def = SOURCES[id];
  return !!def && !c.disabled.includes(id) && !c.disabled.includes(def.key);
}

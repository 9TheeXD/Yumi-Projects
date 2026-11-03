import path from "path";
import { DatabaseSync } from "node:sqlite";
import { Track } from "shoukaku";
import Env, { isDev, isM } from "../utils/env.js";

// Persistent query -> track cache. Never stores stream URLs or audio, only metadata
// plus the encoded track (node specific, so we remember which node encoded it).
const DB_FILE = Env('MUSIC_CACHE_DB') || path.join(process.cwd(), `music_cache_${isDev ? 'dev' : isM ? 'music' : 'main'}.db`);
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS track_cache (
    query_norm   TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    uri          TEXT,
    title        TEXT,
    artist       TEXT,
    duration_ms  INTEGER,
    node         TEXT,
    raw_json     TEXT,
    fail_count   INTEGER DEFAULT 0,
    hit_count    INTEGER DEFAULT 1,
    pinned       INTEGER DEFAULT 0,
    last_used_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS track_cache_uri ON track_cache(uri);
  CREATE TABLE IF NOT EXISTS negative_cache (
    query_norm TEXT NOT NULL,
    source     TEXT NOT NULL,
    until      INTEGER NOT NULL,
    PRIMARY KEY (query_norm, source)
  );
`);

const NOISE = /\b(official\s+(music\s+)?video|official\s+audio|official\s+mv|lyrics?\s+video|lyrics?|mv|m\/v|hd|4k|audio)\b/g;

export function normalizeQuery(q: string) {
  if (/^https?:\/\//i.test(q.trim())) return q.trim();
  return q.toLowerCase()
    .replace(/[\[\(【].*?[\]\)】]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type CacheRow = {
  query_norm: string; source: string; source_id: string; uri: string | null;
  title: string | null; artist: string | null; duration_ms: number | null;
  node: string | null; raw_json: string | null; fail_count: number; hit_count: number; pinned: number;
};

const getStmt = db.prepare(`SELECT * FROM track_cache WHERE query_norm = ?`);
const touchStmt = db.prepare(`UPDATE track_cache SET hit_count = hit_count + 1, last_used_at = ? WHERE query_norm = ?`);
const putStmt = db.prepare(`
  INSERT INTO track_cache (query_norm, source, source_id, uri, title, artist, duration_ms, node, raw_json, last_used_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(query_norm) DO UPDATE SET source = excluded.source, source_id = excluded.source_id, uri = excluded.uri,
    title = excluded.title, artist = excluded.artist, duration_ms = excluded.duration_ms, node = excluded.node,
    raw_json = excluded.raw_json, fail_count = 0, last_used_at = excluded.last_used_at
`);
const dropUriStmt = db.prepare(`DELETE FROM track_cache WHERE uri = ? AND pinned = 0`);
const failUriStmt = db.prepare(`UPDATE track_cache SET fail_count = fail_count + 1 WHERE uri = ?`);
const negGetStmt = db.prepare(`SELECT until FROM negative_cache WHERE query_norm = ? AND source = ?`);
const negPutStmt = db.prepare(`INSERT OR REPLACE INTO negative_cache (query_norm, source, until) VALUES (?, ?, ?)`);
const titleSearchStmt = db.prepare(`
  SELECT * FROM track_cache WHERE fail_count < 3 AND (title LIKE ? OR artist LIKE ? OR query_norm LIKE ?)
  ORDER BY pinned DESC, hit_count DESC LIMIT ?
`);

export function cacheGet(queryNorm: string): CacheRow | undefined {
  const row = getStmt.get(queryNorm) as CacheRow | undefined;
  if (row) touchStmt.run(Date.now(), queryNorm);
  return row;
}

export function cachePut(queryNorm: string, source: string, node: string, raw: Track) {
  putStmt.run(queryNorm, source, raw.info.identifier, raw.info.uri ?? null, raw.info.title, raw.info.author,
    raw.info.length, node, JSON.stringify(raw), Date.now());
}

// Called when a cached track fails to play: forget it so the next search goes through the source order again.
export function cacheDropUri(uri: string) {
  failUriStmt.run(uri);
  dropUriStmt.run(uri);
}

export function negativeHas(queryNorm: string, source: string) {
  const row = negGetStmt.get(queryNorm, source) as { until: number } | undefined;
  return !!row && row.until > Date.now();
}

export function negativePut(queryNorm: string, source: string, ttlMs: number) {
  negPutStmt.run(queryNorm, source, Date.now() + ttlMs);
}

export function cacheSearchTitles(q: string, limit: number): CacheRow[] {
  const like = `%${q.replace(/[%_]/g, '')}%`;
  return titleSearchStmt.all(like, like, like, limit) as CacheRow[];
}

// Daily cleanup. Pinned rows survive.
export function cachePrune() {
  const cutoff = Date.now() - 90 * 86_400_000;
  db.prepare(`DELETE FROM track_cache WHERE pinned = 0 AND last_used_at < ? AND hit_count < 3`).run(cutoff);
  db.prepare(`DELETE FROM negative_cache WHERE until < ?`).run(Date.now());
}
setInterval(cachePrune, 86_400_000).unref();
cachePrune();

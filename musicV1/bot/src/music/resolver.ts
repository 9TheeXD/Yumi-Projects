import chalk from "chalk";
import { Kazagumo, KazagumoPlayer, KazagumoSearchResult, KazagumoTrack } from "kazagumo";
import { Constants, LavalinkResponse, LoadType, Node, Track } from "shoukaku";
import { breakerAllow, breakerFailure, breakerSuccess } from "./breaker.js";
import { cacheDropUri, cacheGet, cachePut, cacheSearchTitles, negativeHas, negativePut, normalizeQuery } from "./cache.js";
import { musicConfig, SOURCES, sourceEnabled, type SourceDef } from "./config.js";
import { Semaphore, userAllow } from "./limiter.js";
import Env from "../utils/env.js";

const head = chalk.cyan.bold('[Resolver]');
const youtubeGate = new Semaphore(() => musicConfig().youtubeConcurrency);

export type MusicNotice = 'youtube_unavailable' | 'rate_limited';
export type MusicSearchResult = KazagumoSearchResult & { notice?: MusicNotice; fromCache?: boolean };
export type MusicSearchOptions = {
  requester?: unknown;
  userId?: string;
  // Search on the node that will play the track. Encoded tracks are not guaranteed to move between NodeLink and Lavalink.
  nodeName?: string;
  kind?: 'play' | 'autocomplete';
  // Source keys to skip (used when a track from that source just failed).
  exclude?: string[];
  // Source keys to try before the configured order.
  prefer?: string[];
};

// Errors that belong to one video, not to YouTube blocking us. They must not trip the breaker.
const TRACK_SPECIFIC = /unavailable|private|age|removed|copyright|not available in your country|members only|premiere|no valid transcoding|preview url/i;

export function sourceKeyOf(sourceName: string | undefined) {
  if (!sourceName) return 'unknown';
  if (sourceName.startsWith('youtube')) return 'youtube';
  return SOURCES[sourceName]?.key ?? sourceName;
}

// Position of a source in the configured order: Spotify first, then SoundCloud, and so on.
function sourceRank(sourceName: string | undefined) {
  const key = sourceKeyOf(sourceName);
  const i = musicConfig().order.findIndex(id => SOURCES[id]?.key === key);
  return i < 0 ? musicConfig().order.length : i;
}

function urlSourceKey(url: string) {
  const host = (() => { try { return new URL(url).hostname.replace(/^www\.|^m\.|^music\./, ''); } catch { return ''; } })();
  if (host === 'youtube.com' || host === 'youtu.be') return 'youtube';
  if (host.endsWith('soundcloud.com')) return 'soundcloud';
  // Spotify/Apple/Deezer links are mirrored by the node, usually to YouTube.
  if (/spotify\.com|apple\.com|deezer\.com|tidal\.com/.test(host)) return 'mirror';
  return host || 'http';
}

export function pickNode(kazagumo: Kazagumo, nodeName?: string): Node | undefined {
  const nodes = kazagumo.shoukaku.nodes;
  const wanted = nodeName ? nodes.get(nodeName) : undefined;
  if (wanted && wanted.state === Constants.State.CONNECTED) return wanted;
  return kazagumo.shoukaku.options.nodeResolver(nodes);
}

// Source managers each node reports in /v4/info. Lavalink and NodeLink ship different sources,
// so a source missing on the current node is skipped instead of counted as a failure.
const nodeSources = new Map<string, { at: number; managers: Set<string> | null }>();

function refreshNodeSources(node: Node) {
  const known = nodeSources.get(node.name);
  if (known && Date.now() - known.at < 10 * 60_000) return;
  nodeSources.set(node.name, { at: Date.now(), managers: known?.managers ?? null });
  Promise.resolve().then(() => node.rest.getLavalinkInfo())
    .then(info => { if (info?.sourceManagers) nodeSources.set(node.name, { at: Date.now(), managers: new Set(info.sourceManagers) }); })
    .catch(() => {});
}

export function nodeSupports(node: Node, manager: string) {
  refreshNodeSources(node);
  const managers = nodeSources.get(node.name)?.managers;
  return !managers || managers.has(manager);
}

type Load = { ok: true; res: LavalinkResponse | undefined } | { ok: false; error: string };

async function load(node: Node, identifier: string, key: string): Promise<Load> {
  const run = async (): Promise<Load> => {
    const res = await node.rest.resolve(identifier).catch((e: Error) => ({ loadType: LoadType.ERROR, data: { message: e.message } }) as LavalinkResponse);
    if (!res) return { ok: false, error: 'no response from node' };
    if (res.loadType === LoadType.ERROR) return { ok: false, error: (res.data as { message?: string })?.message || 'load error' };
    return { ok: true, res };
  };
  try {
    return key === 'youtube' ? await youtubeGate.run(run, musicConfig().youtubeQueueTimeoutMs) : await run();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function report(key: string, r: Load) {
  if (r.ok) return breakerSuccess(key);
  if (!TRACK_SPECIFIC.test(r.error)) breakerFailure(key, r.error);
}

function tracksOf(res: LavalinkResponse | undefined): { type: KazagumoSearchResult['type']; playlistName?: string; tracks: Track[] } {
  switch (res?.loadType) {
    case LoadType.TRACK: return { type: 'TRACK', tracks: [res.data] };
    case LoadType.PLAYLIST: return { type: 'PLAYLIST', playlistName: res.data.info.name, tracks: res.data.tracks };
    case LoadType.SEARCH: return { type: 'SEARCH', tracks: res.data };
    default: return { type: 'SEARCH', tracks: [] };
  }
}

function matches(queryNorm: string, t: Track) {
  const tokens = queryNorm.split(' ').filter(Boolean);
  if (!tokens.length) return true;
  const hay = normalizeQuery(`${t.info.title} ${t.info.author}`);
  const hit = tokens.filter(tok => hay.includes(tok)).length;
  return hit / tokens.length >= musicConfig().matchRatio;
}

function acceptable(t: Track, strict: boolean, queryNorm: string) {
  if (!t.info.isStream && t.info.length > 0 && t.info.length < musicConfig().minTrackMs) return false;
  return !strict || matches(queryNorm, t);
}

// Same as kazagumo.search(): the player attaches the Kazagumo instance when the track is queued.
const wrap = (_kazagumo: Kazagumo, raw: Track[], requester: unknown) =>
  raw.map(t => new KazagumoTrack(t, requester));

const empty = (notice?: MusicNotice): MusicSearchResult => ({ type: 'SEARCH', tracks: [], notice });

function youtubeVideoId(url: string) {
  try {
    const u = new URL(url);
    const id = u.hostname.endsWith('youtu.be') ? u.pathname.slice(1) : u.searchParams.get('v') || u.pathname.match(/\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

// Lavalink's youtube-source loads a video URL only with non-OAuth clients, which a flagged IP gets
// "This video requires login" for. Search uses another path and playback still goes through the
// OAuth TV client, so searching the video id and keeping the exact match plays the same video.
async function loadYoutubeById(node: Node, url: string): Promise<Track | null> {
  const id = youtubeVideoId(url);
  if (!id) return null;
  const r = await load(node, `ytsearch:${id}`, 'youtube');
  return r.ok ? tracksOf(r.res).tracks.find(t => t.info.identifier === id) ?? null : null;
}

async function nodeManagers(node: Node): Promise<Set<string> | null> {
  const known = nodeSources.get(node.name)?.managers;
  if (known) return known;
  const info = await node.rest.getLavalinkInfo().catch(() => null);
  if (!info?.sourceManagers) return null;
  const managers = new Set(info.sourceManagers);
  nodeSources.set(node.name, { at: Date.now(), managers });
  return managers;
}

// An encoded track only decodes on a node that has its source manager. NodeLink tracks such as
// "ytmusic", "audiomack" or SoundCloud fail on Lavalink ("Failed to decode track"), so before a
// track moves to another node (failover, restore) turn it into a track of that node.
const CATALOG_SOURCES = new Set(['spotify', 'applemusic', 'deezer']);

export async function portTrack(kazagumo: Kazagumo, raw: Track, node: Node): Promise<Track | null> {
  const managers = await nodeManagers(node);
  // Catalog tracks (Spotify/Apple/Deezer) carry plugin-specific fields, so a NodeLink track may not decode
  // on Lavalink's LavaSrc and the other way round: always reload them from their link on the target node.
  if (!managers || (managers.has(raw.info.sourceName) && !CATALOG_SOURCES.has(raw.info.sourceName))) return raw;
  const id = raw.info.identifier;
  if ((raw.info.sourceName === 'ytmusic' || raw.info.sourceName.startsWith('youtube')) && id) {
    const t = await loadYoutubeById(node, `https://www.youtube.com/watch?v=${id}`);
    if (t) return t;
  }
  if (raw.info.uri) {
    const r = await load(node, raw.info.uri, sourceKeyOf(raw.info.sourceName));
    const t = r.ok ? tracksOf(r.res).tracks[0] : undefined;
    if (t) return t;
  }
  const res = await musicSearch(kazagumo, `${raw.info.title} ${raw.info.author?.replace(/ - Topic$/, '') ?? ''}`, { nodeName: node.name }).catch(() => null);
  return (res?.tracks[0]?.getRaw() as { _raw?: Track } | undefined)?._raw ?? null;
}

// YouTube oEmbed is a cheap public endpoint. We only need the title to search elsewhere when YouTube is blocked.
async function youtubeTitle(url: string) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json() as { title?: string; author_name?: string };
    return j.title ? `${j.title} ${j.author_name?.replace(/ - Topic$/, '') ?? ''}`.trim() : null;
  } catch { return null; }
}

async function fromCache(kazagumo: Kazagumo, node: Node, queryNorm: string, requester: unknown, exclude: string[]): Promise<MusicSearchResult | null> {
  const row = cacheGet(queryNorm);
  if (!row) return null;
  const key = sourceKeyOf(row.source);
  if (exclude.includes(key) || !sourceEnabled(row.source) && SOURCES[row.source]) return null;
  if (row.raw_json && row.node === node.name) {
    return { type: 'TRACK', tracks: wrap(kazagumo, [JSON.parse(row.raw_json)], requester), fromCache: true };
  }
  if (!row.uri || !breakerAllow(key)) return null;
  const r = await load(node, row.uri, key);
  report(key, r);
  const got = r.ok ? tracksOf(r.res).tracks[0] : undefined;
  if (!got) { cacheDropUri(row.uri); return null; }
  cachePut(queryNorm, row.source, node.name, got);
  return { type: 'TRACK', tracks: wrap(kazagumo, [got], requester), fromCache: true };
}

async function searchSources(kazagumo: Kazagumo, node: Node, queryNorm: string, order: string[], strictAllowed: boolean,
  requester: unknown, exclude: string[]): Promise<MusicSearchResult> {
  let notice: MusicNotice | undefined;
  for (const id of order) {
    const def = SOURCES[id];
    if (!def || !sourceEnabled(id) || exclude.includes(def.key) || !nodeSupports(node, def.manager)) continue;
    if (negativeHas(queryNorm, id)) continue;
    if (!breakerAllow(def.key)) {
      if (def.key === 'youtube') notice = 'youtube_unavailable';
      continue;
    }
    const r = await load(node, `${def.prefix}${queryNorm}`, def.key);
    report(def.key, r);
    if (!r.ok) {
      console.warn(head, `${chalk.bold(id)} failed for "${queryNorm}":`, r.error);
      if (def.key === 'youtube') notice = 'youtube_unavailable';
      continue;
    }
    const found = tracksOf(r.res).tracks;
    const strict = strictAllowed && def.strict;
    const best = found.find(t => acceptable(t, strict, queryNorm));
    if (!best) {
      negativePut(queryNorm, id, musicConfig().negativeTtlMs);
      continue;
    }
    cachePut(queryNorm, id, node.name, best);
    const rest = found.filter(t => t !== best);
    return { type: 'SEARCH', tracks: wrap(kazagumo, [best, ...rest], requester) };
  }
  return empty(notice);
}

const autocompleteMemo = new Map<string, { at: number; tracks: Track[] }>();

async function autocomplete(kazagumo: Kazagumo, node: Node, query: string, opts: MusicSearchOptions): Promise<MusicSearchResult> {
  // A link is loaded, not searched: "ytmsearch:https://youtu.be/..." returns unrelated songs.
  if (/^https?:\/\//i.test(query.trim())) return musicSearch(kazagumo, query, { ...opts, kind: 'play' });
  const queryNorm = normalizeQuery(query);
  if (queryNorm.length < 2) return empty();
  const local = cacheSearchTitles(queryNorm, 3).flatMap(r => r.raw_json ? [JSON.parse(r.raw_json) as Track] : []);
  const memo = autocompleteMemo.get(queryNorm);
  let remote: Track[] = memo && Date.now() - memo.at < 10 * 60_000 ? memo.tracks : [];
  if (!memo && userAllow(opts.userId, 'autocomplete')) {
    remote = await mixedSources(node, queryNorm, musicConfig().autocompleteOrder, opts.exclude || []);
    autocompleteMemo.set(queryNorm, { at: Date.now(), tracks: remote });
    if (autocompleteMemo.size > 2000) autocompleteMemo.delete(autocompleteMemo.keys().next().value!);
  }
  const seen = new Set<string>();
  const all = [...local, ...remote].filter(t => {
    // Same song from two catalogs (Spotify and Apple Music) shows once.
    const keys = [t.info.uri || t.info.identifier, normalizeQuery(`${t.info.title} ${t.info.author}`)];
    if (keys.some(k => seen.has(k))) return false;
    keys.forEach(k => seen.add(k));
    return true;
  });
  // Cached results of earlier searches came first whatever their source. Keep the configured order
  // (Spotify first); the sort is stable, so each source keeps its own ranking.
  all.sort((a, b) => sourceRank(a.info.sourceName) - sourceRank(b.info.sourceName));
  return { type: 'SEARCH', tracks: wrap(kazagumo, all.slice(0, 10), opts.requester) };
}

// Autocomplete: a few results from each source at once instead of only the first source that matches.
// YouTube sources (shared with playback and the burner accounts) are asked only when the others found little.
async function mixedSources(node: Node, queryNorm: string, order: string[], exclude: string[]): Promise<Track[]> {
  const per = musicConfig().autocompletePerSource;
  const usable = order.map(id => SOURCES[id]).filter((def): def is SourceDef => !!def && sourceEnabled(def.id)
    && !exclude.includes(def.key) && nodeSupports(node, def.manager) && !negativeHas(queryNorm, def.id) && breakerAllow(def.key));
  const ask = async (def: SourceDef) => {
    const r = await load(node, `${def.prefix}${queryNorm}`, def.key);
    report(def.key, r);
    if (!r.ok) { console.warn(head, `${chalk.bold(def.id)} failed for "${queryNorm}":`, r.error); return []; }
    const found = tracksOf(r.res).tracks.filter(t => acceptable(t, false, queryNorm)).slice(0, per);
    if (!found.length) negativePut(queryNorm, def.id, musicConfig().negativeTtlMs);
    return found;
  };
  const first = (await Promise.all(usable.filter(d => d.key !== 'youtube').map(ask))).flat();
  if (first.length >= 3) return first;
  const yt = usable.find(d => d.key === 'youtube');
  return yt ? [...first, ...(await ask(yt))] : first;
}

// Discord autocomplete values are limited to 100 characters, and some track URLs are longer
// (SoundCloud/Audiomack slugs, YouTube links with playlist params). Long ones become "pick:<id>"
// and resolve back to the exact track the user picked.
const picks = new Map<string, { at: number; track: Track }>();
export function choiceValue(track: KazagumoTrack, i: number): string {
  const uri = track.uri || '';
  if (uri && uri.length <= 100) return uri;
  const raw = (track.getRaw() as { _raw?: Track })._raw;
  if (!raw) return `unknown${i}`;
  const id = `pick:${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`;
  picks.set(id, { at: Date.now(), track: raw });
  for (const [k, v] of picks) if (Date.now() - v.at > 30 * 60_000) picks.delete(k);
  return id;
}

// Drop-in replacement for kazagumo.search(): cache, source order, breaker, limits.
export async function musicSearch(kazagumo: Kazagumo, query: string, opts: MusicSearchOptions = {}): Promise<MusicSearchResult> {
  const node = pickNode(kazagumo, opts.nodeName);
  if (!node) throw new Error('No node is available');
  const picked = query.startsWith('pick:') ? picks.get(query.trim()) : undefined;
  if (picked) {
    const t = await portTrack(kazagumo, picked.track, node);
    if (t) return { type: 'TRACK', tracks: wrap(kazagumo, [t], opts.requester) };
  }
  if (opts.kind === 'autocomplete') return autocomplete(kazagumo, node, query, opts);

  const exclude = opts.exclude || [];
  const queryNorm = normalizeQuery(query);
  if (!queryNorm) return empty();

  // A cached result from a source that ranks below Spotify does not stop a Spotify search; the new
  // result replaces the cache row, and a Spotify miss is remembered (negative cache) so it is not repeated.
  const cachedRow = cacheGet(queryNorm);
  const spotifyFirst = !!cachedRow && !/^https?:\/\//i.test(queryNorm) && !exclude.includes('spotify') && sourceEnabled('spotify')
    && nodeSupports(node, SOURCES.spotify.manager) && !negativeHas(queryNorm, 'spotify') && breakerAllow('spotify')
    && sourceRank(cachedRow.source) > sourceRank('spotify');
  const cached = spotifyFirst ? null : await fromCache(kazagumo, node, queryNorm, opts.requester, exclude);
  if (cached) return cached;

  if (!userAllow(opts.userId, 'play')) return empty('rate_limited');

  if (/^https?:\/\//i.test(queryNorm)) {
    const key = urlSourceKey(queryNorm);
    if (!exclude.includes(key) && breakerAllow(key) && !(key === 'youtube' && !sourceEnabled('youtube'))) {
      const r = await load(node, queryNorm, key);
      // A failed YouTube URL load is reported only after the search-by-id fallback below also fails.
      if (r.ok || key !== 'youtube') report(key, r);
      if (r.ok) {
        const res = tracksOf(r.res);
        if (res.type === 'TRACK' && res.tracks[0]) cachePut(queryNorm, res.tracks[0].info.sourceName, node.name, res.tracks[0]);
        return { ...res, tracks: wrap(kazagumo, res.tracks, opts.requester) };
      }
      console.warn(head, `URL load failed (${key}):`, r.error);
      if (key === 'youtube' && !TRACK_SPECIFIC.test(r.error)) {
        const t = await loadYoutubeById(node, queryNorm);
        if (t) {
          cachePut(queryNorm, t.info.sourceName, node.name, t);
          return { type: 'TRACK', tracks: wrap(kazagumo, [t], opts.requester) };
        }
      }
      if (key === 'youtube') report(key, r);
    }
    if (key !== 'youtube') return empty();
    // YouTube link while YouTube is down: find the same song elsewhere by title.
    const title = await youtubeTitle(queryNorm);
    if (!title) return empty('youtube_unavailable');
    const alt = await searchSources(kazagumo, node, normalizeQuery(title), musicConfig().order, true, opts.requester, [...exclude, 'youtube']);
    return { ...alt, notice: 'youtube_unavailable' };
  }

  const order = opts.prefer ? [...opts.prefer, ...musicConfig().order.filter(id => !opts.prefer!.includes(id))] : musicConfig().order;
  return searchSources(kazagumo, node, queryNorm, order, true, opts.requester, exclude);
}

const PLAYLIST_MAX = Number(Env('MUSIC_PLAYLIST_MAX')) || 500;

/** Adds a search result to the queue: every track of a playlist/album (up to PLAYLIST_MAX), else the first. Returns a label for the reply. */
export function queueResult(player: KazagumoPlayer, result: MusicSearchResult): string {
  if (result.type === 'PLAYLIST' && result.tracks.length > 1) {
    const list = result.tracks.slice(0, PLAYLIST_MAX) as KazagumoTrack[];
    player.queue.add(list);
    return `${result.playlistName || 'Playlist'} (${list.length})`;
  }
  player.queue.add(result.tracks[0] as KazagumoTrack);
  return result.tracks[0].title;
}

// A track failed during playback. Forget it and look for the same song on another source.
export async function findAlternative(kazagumo: Kazagumo, track: KazagumoTrack, nodeName?: string) {
  if (track.uri) cacheDropUri(track.uri);
  const key = sourceKeyOf(track.sourceName);
  const q = `${track.title} ${track.author?.replace(/ - Topic$/, '') ?? ''}`;
  // Spotify / Apple Music / Deezer carry metadata only: the same official song is on YouTube Music.
  // SoundCloud first would often pick a cover, a remix or a 30 s preview.
  const prefer = CATALOG_SOURCES.has(track.sourceName) ? ['youtube_music'] : undefined;
  const res = await musicSearch(kazagumo, q, { requester: track.requester, nodeName, exclude: [key], prefer }).catch(() => null);
  return res?.tracks[0] ?? null;
}

export function recordPlayback(sourceName: string | undefined, error?: string) {
  const key = sourceKeyOf(sourceName);
  if (!error) return breakerSuccess(key);
  if (!TRACK_SPECIFIC.test(error)) breakerFailure(key, error);
}

const NOTICE_TEXT: Record<MusicNotice, { th: string; en: string }> = {
  youtube_unavailable: { th: 'YouTube ใช้ไม่ได้ตอนนี้ ใช้แหล่งอื่นแทน', en: 'YouTube is unavailable right now, using other sources.' },
  rate_limited: { th: 'ค้นหาถี่เกินไป รอสักครู่แล้วลองใหม่', en: 'Too many searches, please wait a moment.' },
};

export function noticeText(notice: MusicNotice | undefined, locale?: string) {
  if (!notice) return '';
  return locale === 'th' ? NOTICE_TEXT[notice].th : NOTICE_TEXT[notice].en;
}

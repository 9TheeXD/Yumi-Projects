import assert from 'node:assert/strict';
process.env.MUSIC_CACHE_DB = ':memory:';
process.env.MUSIC_BREAKER_FAILURES = '2';
const R = await import('../src/music/resolver.ts');
const B = await import('../src/music/breaker.ts');
const C = await import('../src/music/cache.ts');

const mk = (title: string, author: string, src: string, len = 200000) => ({ encoded: `enc-${src}-${title}`, info: { identifier: title, isSeekable: true, author, length: len, isStream: false, position: 0, title, uri: `https://${src}.test/${encodeURIComponent(title)}`, sourceName: src }, pluginInfo: {} });
const calls: string[] = [];
let ytMode: 'ok' | 'block' = 'ok';
const node: any = { name: 'N1', state: 1, rest: { resolve: async (id: string) => {
  calls.push(id);
  if (id.startsWith('scsearch:')) {
    if (id.includes('preview')) return { loadType: 'search', data: [mk('preview song', 'x', 'soundcloud', 30000)] };
    if (id.includes('lofi')) return { loadType: 'search', data: [mk('lofi beats', 'chill', 'soundcloud')] };
    return { loadType: 'search', data: [mk('totally different', 'nobody', 'soundcloud')] };
  }
  if (id.startsWith('ytmsearch:') || id.startsWith('ytsearch:') || id.includes('youtube')) {
    if (ytMode === 'block') return { loadType: 'error', data: { message: 'Sign in to confirm you’re not a bot' } };
    return { loadType: 'search', data: [mk(id.split(':')[1], 'yt artist', 'youtube')] };
  }
  return { loadType: 'empty', data: {} };
} } };
const kaz: any = { shoukaku: { nodes: new Map([['N1', node]]), options: { nodeResolver: (m: Map<string, any>) => [...m.values()][0] } } };

assert.equal(C.normalizeQuery('Song A (Official Music Video) [HD]'), 'song a');
assert.equal(C.normalizeQuery('เพลงไทย Official MV'), 'เพลงไทย');

// SoundCloud match wins, YouTube not touched
let r = await R.musicSearch(kaz, 'lofi beats', { userId: 'u1' });
assert.equal(r.tracks[0].sourceName, 'soundcloud');
assert.ok(!calls.some(c => c.startsWith('yt')));

// SoundCloud mismatch -> falls to ytmsearch
calls.length = 0;
r = await R.musicSearch(kaz, 'some thai song', { userId: 'u1' });
assert.equal(r.tracks[0].sourceName, 'youtube');
assert.deepEqual(calls, ['scsearch:some thai song', 'admsearch:some thai song', 'ytmsearch:some thai song']);

// Preview (30s) rejected
r = await R.musicSearch(kaz, 'preview song', { userId: 'u2' });
assert.equal(r.tracks[0].sourceName, 'youtube');

// Cache hit: zero node calls, and negative cache skips soundcloud next time anyway
calls.length = 0;
r = await R.musicSearch(kaz, 'Some Thai Song (Official Video)', { userId: 'u3' });
assert.equal(r.fromCache, true);
assert.equal(calls.length, 0);

// YouTube URL that the node will not load directly -> search by video id, keep the exact match
const vid = 'ff7ao5s0heQ';
const urlCalls: string[] = [];
const node2: any = { name: 'N2', state: 1, rest: { resolve: async (id: string) => {
  urlCalls.push(id);
  if (id.startsWith('https://')) return { loadType: 'error', data: { message: 'Something went wrong while looking up the track.' } };
  if (id === `ytsearch:${vid}`) return { loadType: 'search', data: [mk('other', 'x', 'youtube'), { ...mk('the song', 'band', 'youtube'), info: { ...mk('the song', 'band', 'youtube').info, identifier: vid } }] };
  return { loadType: 'empty', data: {} };
} } };
const kaz2: any = { shoukaku: { nodes: new Map([['N2', node2]]), options: { nodeResolver: (m: Map<string, any>) => [...m.values()][0] } } };
r = await R.musicSearch(kaz2, `https://www.youtube.com/watch?v=${vid}`, { userId: 'u6' });
assert.equal(r.type, 'TRACK');
assert.equal(r.tracks[0].identifier, vid);
assert.deepEqual(urlCalls, [`https://www.youtube.com/watch?v=${vid}`, `ytsearch:${vid}`]);
assert.notEqual(B.breakerStatus().youtube?.state, 'open');

// Block YouTube -> breaker opens after 2 failures -> notice + no more YouTube calls
ytMode = 'block';
await R.musicSearch(kaz, 'block one', { userId: 'u4' });
await R.musicSearch(kaz, 'block two', { userId: 'u4' });
assert.equal(B.breakerStatus().youtube.state, 'open');
calls.length = 0;
r = await R.musicSearch(kaz, 'block three', { userId: 'u5' });
assert.equal(r.notice, 'youtube_unavailable');
assert.ok(!calls.some(c => c.startsWith('yt')), calls.join());

// Rate limit
for (let i = 0; i < 6; i++) await R.musicSearch(kaz, `rl ${i}`, { userId: 'rl' });
r = await R.musicSearch(kaz, 'rl x', { userId: 'rl' });
assert.equal(r.notice, 'rate_limited');

// Autocomplete uses cached titles + memo
ytMode = 'ok';
r = await R.musicSearch(kaz, 'lofi', { kind: 'autocomplete', userId: 'ac' });
assert.ok(r.tracks.some(t => t.title === 'lofi beats'));
calls.length = 0;
await R.musicSearch(kaz, 'lofi', { kind: 'autocomplete', userId: 'ac' });
assert.equal(calls.length, 0);

// Track-specific error does not trip breaker
B.breakerSuccess('soundcloud');
R.recordPlayback('soundcloud', 'This video is unavailable');
R.recordPlayback('soundcloud', 'Video unavailable');
assert.notEqual(B.breakerStatus().soundcloud?.state, 'open');
console.log('ok');

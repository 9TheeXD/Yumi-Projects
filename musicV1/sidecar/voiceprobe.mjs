// Real playback probe: joins a Discord voice channel with the dev bot and plays each query on
// each node, then reports whether the position actually advanced. Search-only checks miss the
// common failure where loadtracks works but the stream does not ("No streaming data found").
//
//   node sidecar/voiceprobe.mjs <guildId> <voiceChannelId> [seconds] < queries.txt
//   node sidecar/voiceprobe.mjs <guildId> <voiceChannelId> 10 "ytsearch:lisa money" "scsearch:lofi"
//
// Nodes come from MUSIC_NODES in ../.env (or PROBE_NODES='[{name,url,auth}]').
// Stop the dev bot first if it uses the same token and guild, two sessions fight over voice.
import { Client, GatewayIntentBits } from 'discord.js';
import { Shoukaku, Connectors } from 'shoukaku';
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
dotenv.config({ path: root + '.env', quiet: true });
const env = (k) => process.env[k]?.trim().replace(/^'|'$/g, '') || '';

const [guildId, channelId, secArg, ...rest] = process.argv.slice(2);
if (!guildId || !channelId) { console.error('usage: voiceprobe.mjs <guildId> <voiceChannelId> [seconds] [query...]'); process.exit(2); }
const seconds = Number(secArg) || 10;
const queries = rest.length ? rest : readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));

const nodes = process.env.PROBE_NODES ? JSON.parse(process.env.PROBE_NODES)
  : (env('MUSIC_NODES') || 'NODELINK,LAVALINK').split(',').map(s => s.trim()).filter(Boolean)
    .map(name => ({ name, url: env(`${name}_HOST`), auth: env(`${name}_PASS`) })).filter(n => n.url);

let target = nodes[0].name;
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), nodes, {
  reconnectTries: 2, restTimeout: 30,
  nodeResolver: (all) => all.get(target),
});
shoukaku.on('error', (name, e) => console.error(`[${name}] error: ${e.message}`));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One voice connection per node, tracks played back to back like a real queue.
// Rejoining between tracks tests Discord voice reconnects, not the source.
async function probe(node, player, state, query) {
  const t0 = Date.now();
  const res = await node.rest.resolve(query).catch(e => ({ loadType: 'error', data: { message: e.message } }));
  const track = res?.loadType === 'track' ? res.data : res?.loadType === 'search' ? res.data[0]
    : res?.loadType === 'playlist' ? res.data.tracks[0] : null;
  if (!track) return { ok: false, stage: 'load', msg: res?.data?.message || res?.loadType || 'no result' };
  const loadMs = Date.now() - t0;

  Object.assign(state, { error: null, started: 0 });
  const t1 = Date.now();
  await player.playTrack({ track: { encoded: track.encoded } });
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until && !state.error) await sleep(500);
  // Ask the node directly, update events are only every few seconds.
  const live = await node.rest.getPlayer(guildId).catch(() => null);
  const pos = live?.state?.position ?? 0;
  await player.stopTrack().catch(() => {});
  await sleep(500);
  const info = track.info;
  return {
    ok: !state.error && pos >= (seconds - 4) * 1000,
    stage: state.error ? 'play' : 'ok',
    msg: state.error || (pos ? '' : `no progress, voice connected=${live?.state?.connected} ping=${live?.state?.ping}`),
    title: `${info.sourceName}:${info.identifier} ${info.title}`.slice(0, 70),
    loadMs, startMs: state.started ? state.started - t1 : null, posMs: pos,
  };
}

client.once('clientReady', async () => {
  await sleep(3000); // nodes connect
  const results = [];
  const log = (r) => {
    results.push(r);
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.node.padEnd(8)} ${r.q.padEnd(40)} ${r.stage} pos=${r.posMs ?? '-'} start=${r.startMs ?? '-'}ms load=${r.loadMs ?? '-'}ms ${r.title || ''} ${r.msg || ''}`);
  };
  for (const n of nodes) {
    const node = shoukaku.nodes.get(n.name);
    if (!node || node.state !== 1) { for (const q of queries) log({ node: n.name, q, ok: false, stage: 'node', msg: 'not connected' }); continue; }
    target = n.name;
    const player = await shoukaku.joinVoiceChannel({ guildId, channelId, shardId: 0, deaf: true });
    const state = { error: null, started: 0 };
    player.on('exception', (e) => { state.error = e.exception?.message || 'exception'; });
    player.on('stuck', () => { state.error = state.error || 'stuck'; });
    player.on('start', () => { state.started = Date.now(); });
    for (const q of queries) {
      const r = await probe(node, player, state, q).catch(e => ({ ok: false, stage: 'crash', msg: e.message }));
      log({ node: n.name, q, ...r });
    }
    await shoukaku.leaveVoiceChannel(guildId);
    await sleep(3000);
  }
  if (process.env.PROBE_JSON) console.log(JSON.stringify(results));
  client.destroy(); process.exit(0);
});
client.login(env('PROBE_TOKEN') || env('BOT_TOKEN_DEV'));

// Long-running test client: plays a playlist on loop in one voice channel and logs every problem.
// Checks every 30 s that the position moved. Same node failover as the bot (move on socket close).
// Alternates nodes track by track, so the backup node gets real playback too, and writes the last
// result per node and source to soak-status.json (read by sidecar.mjs for alerts).
//
//   node sidecar/soak-client.mjs <guildId> <voiceChannelId> [queries.txt]   (default: probe-queries.txt)
//
// Use a guild nobody else uses with this token: two sessions of one bot in the same guild's
// voice fight over the connection.
import { Client, GatewayIntentBits } from 'discord.js';
import { Shoukaku, Connectors } from 'shoukaku';
import dotenv from 'dotenv';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
dotenv.config({ path: root + '.env', quiet: true });
const env = (k) => process.env[k]?.trim().replace(/^'|'$/g, '') || '';
const [guildId, channelId, queryFile = fileURLToPath(new URL('probe-queries.txt', import.meta.url))] = process.argv.slice(2);
if (!channelId) { console.error('usage: soak-client.mjs <guildId> <voiceChannelId> [queries.txt]'); process.exit(2); }
const queries = readFileSync(queryFile, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
const LOG = fileURLToPath(new URL('soak-client.log', import.meta.url));
const STATUS = fileURLToPath(new URL('soak-status.json', import.meta.url));
// Keep earlier results across restarts, so the sidecar does not lose a node's last verdict.
const status = (() => { try { return JSON.parse(readFileSync(STATUS, 'utf8')); } catch { return {}; } })();
const sourceKey = (s) => (s?.startsWith('youtube') || s === 'ytmusic' ? 'youtube' : s || 'unknown');
// Discord voice problems belong to the test client, not to the song's source.
// playerStateChange timeouts: the same songs play fine in voiceprobe, only right after the soak
// rejoins on another node, so they are a voice handshake issue of this client, not of the source.
const VOICE_ERROR = /voice connection|UDP|session is no longer valid|4006|playerStateChange timed out|Voice playback state timed out/i;
function report(node, source, ok, error, title) {
  const key = !ok && VOICE_ERROR.test(error || '') ? 'voice' : sourceKey(source);
  (status[node] ??= {})[key] = { ok, error: error?.split('\n')[0].slice(0, 300), title, at: new Date().toISOString() };
  try { writeFileSync(STATUS, JSON.stringify(status, null, 2)); } catch {}
}
const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
};

// Same registry as the bot (MUSIC_NODES).
const nodes = (env('MUSIC_NODES') || 'NODELINK,LAVALINK').split(',').map(s => s.trim()).filter(Boolean)
  .map(name => ({ name, url: env(`${name}_HOST`), auth: env(`${name}_PASS`) })).filter(n => n.url);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
let wanted = null; // node the next join should use
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), nodes, {
  reconnectTries: 1000, reconnectInterval: 5, restTimeout: 30,
  nodeResolver: (all) => (wanted && all.get(wanted)?.state === 1 ? all.get(wanted) : [...all.values()].filter(n => n.state === 1).shift()),
});
shoukaku.on('error', (name, e) => log(`[${name}] error: ${e.message}`));
shoukaku.on('ready', (name) => log(`[${name}] ready`));
shoukaku.on('close', async (name) => {
  const target = shoukaku.options.nodeResolver(new Map([...shoukaku.nodes].filter(([n]) => n !== name)));
  const p = shoukaku.players.get(guildId);
  if (!target || !p || p.node.name !== name) return;
  p.node = target;
  await p.resume().then(() => log(`moved to ${target.name}`)).catch(e => log('move failed:', e.message));
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Discord sometimes answers a join without a voice endpoint; retry instead of crashing.
async function join() {
  for (let i = 1; ; i++) {
    try { return await shoukaku.joinVoiceChannel({ guildId, channelId, shardId: 0, deaf: true }); }
    catch (e) {
      log(`join failed (${i}): ${e.message}`);
      // A stuck gateway session never gets a voice server again: start over (pm2 restarts us).
      if (i >= 3) { log('giving up on this session, exiting for a fresh one'); client.destroy(); process.exit(1); }
      await shoukaku.leaveVoiceChannel(guildId).catch(() => {});
      await sleep(Math.min(60_000, 5000 * i));
    }
  }
}
const stats = { played: 0, failed: 0, stalls: 0 };

client.once('clientReady', async () => {
  await sleep(3000);
  let player = await join();
  let ended = true, error = null;
  const wire = (p) => {
    p.on('end', () => { ended = true; });
    p.on('exception', (e) => { error = e.exception?.message || 'exception'; ended = true; });
    p.on('stuck', () => { error = 'stuck'; ended = true; });
    p.on('closed', (e) => log(`voice closed ${e.code} ${e.reason}`));
  };
  wire(player);
  for (let i = 0, n = 0; ; i = (i + 1) % queries.length, n++) {
    const q = queries[i];
    // Round robin over connected nodes. Switching = drop the player on the old node and send the
    // voice state with the next track to the new one.
    const live = [...shoukaku.nodes.values()].filter(x => x.state === 1);
    const want = live[n % Math.max(live.length, 1)];
    if (want && want.name !== player.node.name) {
      // A voice session cannot move between nodes as is (Discord closes it with 4006), so leave
      // and join again on the next node: a fresh voice server update goes to that node.
      await shoukaku.leaveVoiceChannel(guildId).catch(() => {});
      await sleep(2000);
      wanted = want.name;
      player = await join();
      wire(player);
      // Give the node a moment to finish the voice handshake (NodeLink can miss it otherwise).
      await sleep(2000);
    }
    const node = player.node;
    const res = await node.rest.resolve(q).catch(e => ({ loadType: 'error', data: { message: e.message } }));
    const track = res?.loadType === 'track' ? res.data : res?.loadType === 'search' ? res.data[0] : null;
    if (!track) {
      stats.failed++;
      const msg = res?.data?.message || res?.exception?.message || res?.loadType;
      log(`LOAD FAIL ${node.name} ${q}: ${msg}`);
      report(node.name, q.startsWith('yt') || q.includes('youtube') ? 'youtube' : q.split(':')[0], false, `load: ${msg}`, q);
      await sleep(10000);
      continue;
    }
    // Same as the bot: a NodeLink voice start timeout is retried once with the same track.
    for (let attempt = 0; attempt < 2; attempt++) {
      ended = false; error = null;
      await player.playTrack({ track: { encoded: track.encoded } }).catch(e => { error = e.message; ended = true; });
      log(`play ${node.name} ${track.info.sourceName}:${track.info.identifier} ${track.info.title}`);
      let last = -1;
      // Long uploads (hour-long mixes) would keep one node busy; 4 verified minutes are enough.
      const stopAt = Date.now() + 4 * 60_000;
      while (!ended) {
        if (Date.now() > stopAt) { await player.stopTrack().catch(() => {}); break; }
        await sleep(30000);
        if (ended) break;
        const live = await player.node.rest.getPlayer(guildId).catch(() => null);
        const pos = live?.state?.position ?? -1;
        if (pos <= last) {
          stats.stalls++;
          log(`STALL ${player.node.name} pos=${pos} last=${last} connected=${live?.state?.connected}`);
          if (pos === last) { error = 'stalled'; break; }
        }
        last = pos;
      }
      if (attempt === 0 && error && /playerStateChange timed out|Voice playback state timed out/i.test(error)) {
        log(`RETRY ${node.name} ${track.info.title}: ${error}`);
        continue;
      }
      break;
    }
    if (error) { stats.failed++; log(`FAIL ${node.name} ${track.info.title}: ${error}`); } else stats.played++;
    report(node.name, track.info.sourceName, !error, error || undefined, track.info.title);
    if (stats.played % 10 === 0 || error) log(`stats played=${stats.played} failed=${stats.failed} stalls=${stats.stalls}`);
    // Voice dropped (e.g. Discord voice server change): join again.
    if (!shoukaku.connections.get(guildId)) {
      log('rejoining voice');
      player = await join();
      wire(player);
    }
  }
});
client.login(env('PROBE_TOKEN') || env('BOT_TOKEN_DEV'));

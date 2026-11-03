// Failover test: play on the first node, stop that node's container mid-song, and check that
// Shoukaku moveOnDisconnect moves the player to the next node and the song keeps going.
// Starts the container again at the end.
//
//   node sidecar/failover-test.mjs <guildId> <voiceChannelId> <container> [query]
//
// Uses PROBE_NODES like voiceprobe.mjs, first entry is the node that gets killed.
// Needs `sudo -n docker` (or SIDECAR_DOCKER).
import { Client, GatewayIntentBits } from 'discord.js';
import { Shoukaku, Connectors } from 'shoukaku';
import dotenv from 'dotenv';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
dotenv.config({ path: root + '.env', quiet: true });
const env = (k) => process.env[k]?.trim().replace(/^'|'$/g, '') || '';
const [guildId, channelId, container, query = 'ytsearch:bodyslam ความเชื่อ'] = process.argv.slice(2);
if (!container) { console.error('usage: failover-test.mjs <guildId> <voiceChannelId> <container> [query]'); process.exit(2); }
const nodes = JSON.parse(process.env.PROBE_NODES || '[]');
const docker = (env('SIDECAR_DOCKER') || 'docker').split(' ');
const dockerRun = (...a) => execFileSync(docker[0], [...docker.slice(1), ...a], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), nodes, {
  moveOnDisconnect: true, reconnectTries: 3, reconnectInterval: 2, restTimeout: 30,
  nodeResolver: (all) => [...all.values()].filter(n => n.state === 1).shift(),
});
shoukaku.on('error', (name, e) => log(`[${name}] error: ${e.message}`));
shoukaku.on('disconnect', (name) => log(`[${name}] disconnected`));
// Same workaround as bot/src/kazagumoManager.ts: Shoukaku's own move fails on a dead node.
shoukaku.on('close', async (name) => {
  const target = shoukaku.options.nodeResolver(new Map([...shoukaku.nodes].filter(([n]) => n !== name)));
  if (!target) return;
  for (const p of shoukaku.players.values()) {
    if (p.node.name !== name) continue;
    p.node = target;
    await p.resume().catch(e => log('resume failed:', e.message));
  }
});

client.once('clientReady', async () => {
  let ok = false;
  try {
    await sleep(3000);
    const first = shoukaku.nodes.get(nodes[0].name);
    const res = await first.rest.resolve(query);
    const track = res.loadType === 'search' ? res.data[0] : res.data;
    const player = await shoukaku.joinVoiceChannel({ guildId, channelId, shardId: 0, deaf: true });
    player.on('exception', (e) => log('exception:', e.exception?.message));
    await player.playTrack({ track: { encoded: track.encoded } });
    log(`playing on ${player.node.name}: ${track.info.title}`);
    await sleep(15000);
    const before = (await player.node.rest.getPlayer(guildId))?.state?.position ?? 0;
    log(`position before kill: ${before}`);

    log(`stopping ${container}`);
    dockerRun('stop', '-t', '1', container);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000 && player.node.name === nodes[0].name) await sleep(500);
    log(`player node now: ${player.node.name} (after ${Date.now() - t0} ms)`);
    await sleep(12000);
    const after = (await player.node.rest.getPlayer(guildId).catch(() => null))?.state?.position ?? 0;
    log(`position on new node: ${after}`);
    ok = player.node.name !== nodes[0].name && after > 5000;
    log(ok ? 'PASS: playback continued on the backup node' : 'FAIL: playback did not continue');
    await shoukaku.leaveVoiceChannel(guildId);
  } catch (e) {
    log('crash:', e.message);
  } finally {
    log(`starting ${container}`);
    try { dockerRun('start', container); } catch (e) { log('start failed:', e.message); }
    client.destroy();
    process.exit(ok ? 0 : 1);
  }
});
client.login(env('PROBE_TOKEN') || env('BOT_TOKEN_DEV'));

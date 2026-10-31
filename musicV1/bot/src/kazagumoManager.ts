import { Client } from "discord.js";
import { Connectors, Constants, Node, NodeOption, Track } from "shoukaku";
import { findAlternative, portTrack, recordPlayback } from "./music/resolver.js";
import Env from "./utils/env.js";
import chalk from "chalk";
import { Kazagumo, Plugins } from "kazagumo";
import { sendPStatus } from "./utils/messages.js";
import { savePlayers } from "./utils/function.js";
import { musicNodes, nodeTiers, youtubeDownNodes } from "./music/nodes.js";


export default class KazagumoManager {
  constructor(client: Client) {
    const headS = chalk.green.bold('[Shoukaku]');
    const headSE = chalk.redBright.bold('[Shoukaku ERROR]');
    const headSD = chalk.yellow.bold('[Shoukaku DEBUG]');
    const headK = chalk.green.bold('[Kazagumo]');
    const headKE = chalk.redBright.bold('[Kazagumo ERROR]');
    const headKD = chalk.yellow.bold('[Kazagumo DEBUG]');
    const Nodes: NodeOption[] = [
      // {
      //   name: 'TH',
      //   url: Env('LAVALINK_HOST_TH') || '',
      //   auth: Env('LAVALINK_PASS_TH') || 'youshallnotpass',
      //   secure: Env('LAVALINK_SECURE_TH')?.toLowerCase() == 'true',
      // },
      // {
      //   name: 'CA',
      //   url: Env('LAVALINK_HOST_CA') || '',
      //   auth: Env('LAVALINK_PASS_CA') || 'youshallnotpass',
      //   secure: Env('LAVALINK_SECURE_CA')?.toLowerCase() == 'true',
      // },
      // {
      //   name: 'SG',
      //   url: Env('LAVALINK_HOST_SG') || '',
      //   auth: Env('LAVALINK_PASS_SG') || 'youshallnotpass',
      //   secure: Env('LAVALINK_SECURE_SG')?.toLowerCase() == 'true',
      // },
      ...musicNodes().map(n => ({ name: n.name, url: n.url, auth: n.auth, secure: n.secure })),
    ];
    // Load balance: the first tier with a connected node wins; inside it the node with the fewest
    // players (ties: Shoukaku penalties). Nodes whose YouTube is failing (sidecar) are skipped while
    // another node in reach still has it working.
    const tiers = nodeTiers();
    const playersOn = (name: string) => [...(shoukakuRef?.players.values() ?? [])].filter(p => p.node.name === name).length;
    let shoukakuRef: { players: Map<string, { node: { name: string } }> } | undefined;
    const pickNode = <N extends { name: string; state: number; penalties: number }>(nodes: Map<string, N>): N | undefined => {
      const connected = [...nodes.values()].filter(n => n.state === Constants.State.CONNECTED);
      const ytDown = youtubeDownNodes();
      const ordered = [...tiers, connected.map(n => n.name).filter(n => !tiers.flat().includes(n))];
      const byLoad = (a: N, b: N) => playersOn(a.name) - playersOn(b.name) || a.penalties - b.penalties;
      for (const preferHealthy of [true, false]) {
        for (const tier of ordered) {
          const cands = connected.filter(n => tier.includes(n.name) && (!preferHealthy || !ytDown.has(n.name)));
          if (cands.length) return cands.sort(byLoad)[0];
        }
      }
      return undefined;
    };
    const kazagumo = new Kazagumo({
      defaultSearchEngine: "youtube_music",
      // Kazagumo re-searches "author - title" before playing any track whose sourceName is not in its
      // own list (NodeLink's "ytmusic", "audiomack", ...). That can swap the song for another upload
      // and costs a YouTube request per play. Our tracks come from the node already encoded: play them as is.
      trackResolver: async function (this: { track?: string }) { return !!this.track; },
      send: (guildId, payload)=>{
          const guild = client.guilds.cache.get(guildId);
          if(guild)guild.shard.send(payload);
      },
      plugins: [new Plugins.PlayerMoved(client)]
    }, new Connectors.DiscordJS(client), Nodes, {
      moveOnDisconnect: true,
      reconnectTries: 10,
      reconnectInterval: 5,
      restTimeout: 20,
      nodeResolver: (nodes) => pickNode(nodes),
    });
    shoukakuRef = kazagumo.shoukaku as unknown as typeof shoukakuRef;
    kazagumo.nodes = Nodes;

    // Join timeout ("not established in 15 seconds"): Discord sent no voice server for the join.
    // Shoukaku drops its connection but leaves Discord's voice state as is, so every later join to
    // the same channel times out too. Leave the channel for real, then try once more.
    const createPlayer = kazagumo.createPlayer.bind(kazagumo);
    kazagumo.createPlayer = (async (options: Parameters<typeof createPlayer>[0]) => {
      try {
        return await createPlayer(options);
      } catch (err) {
        if (!/voice connection is not established/i.test((err as Error)?.message ?? '')) throw err;
        console.warn(headKE, `Voice join timed out in ${chalk.bold(options.guildId)}, leaving and retrying once`);
        client.guilds.cache.get(options.guildId)?.shard.send({ op: 4, d: { guild_id: options.guildId, channel_id: null, self_mute: false, self_deaf: false } });
        await new Promise(r => setTimeout(r, 2_000));
        return createPlayer(options);
      }
    }) as typeof kazagumo.createPlayer;

    kazagumo.shoukaku.on('ready', (name) => console.log(headS, `Node ${chalk.bold(name)} is ready!`));
    kazagumo.shoukaku.on('error', (name, error) => console.error(headSE, `Node ${chalk.bold(name)} error:`, error.message));
    kazagumo.shoukaku.on('disconnect', (name, count) => console.error(headSE, `Node ${chalk.bold(name)} disconnected: ${count}`));
    kazagumo.shoukaku.on('reconnecting', (name, reconnectsLeft, reconnectInterval) => console.debug(headSD, `Node ${chalk.bold(name)} reconnecting in ${reconnectInterval}s`, chalk.yellow(`(${reconnectsLeft})`)));
    // Shoukaku's moveOnDisconnect does not work when a node dies: Player.move() first calls
    // destroyPlayer on the dead node, that request fails and the player stays on the dead node.
    // So move players ourselves as soon as the socket closes. Encoded tracks are identical on
    // NodeLink and Lavalink, so the same track resumes at the same position on the other node.
    kazagumo.shoukaku.on('close', async (name) => {
      // 'close' fires before Shoukaku marks the node as disconnected, so exclude it by name.
      const others = new Map([...kazagumo.shoukaku.nodes].filter(([n]) => n !== name));
      const target = kazagumo.shoukaku.options.nodeResolver(others);
      if (!target) return;
      for (const p of kazagumo.players.values()) {
        const sp = p.shoukaku;
        if (sp.node.name !== name) continue;
        try {
          sp.node = target;
          // Same song in a form the new node can decode (NodeLink-only sources fail on Lavalink).
          const current = p.queue.current;
          const raw = current ? (current.getRaw() as { _raw?: Track })._raw : undefined;
          const ported = raw ? await portTrack(kazagumo, raw, target as unknown as Node) : null;
          if (ported && ported.encoded !== sp.track) {
            const position = sp.position;
            await sp.update({ ...sp.data.playerOptions, track: { encoded: ported.encoded }, position });
          } else {
            await sp.resume();
          }
          console.log(headS, `Moved player ${chalk.bold(p.guildId)} from ${chalk.bold(name)} to ${chalk.bold(target.name)}`);
        } catch (err) {
          console.error(headSE, `Move ${p.guildId} to ${target.name} failed:`, (err as Error).message);
        }
      }
    });

    kazagumo.on('playerCreate', async(p)=>{
      console.log(headK, `Player was created: ${chalk.bold(p.guildId)}`);
      p.setVolume(20);
      p.pause(false);
      p.showInfo = false;
      p.latestUpdate = Date.now();
      savePlayers(kazagumo);
 });kazagumo.on('playerStart', async(p, t)=>{
      console.log(headK, `Player was started: ${chalk.bold(p.guildId)}`);
      recordPlayback(t.sourceName);
      await sendPStatus(client, kazagumo, p, { from: 'playerStart event' });
      savePlayers(kazagumo);
 });kazagumo.on('playerEnd', async(p)=>{
      console.log(headK, `Player was ended: ${chalk.bold(p.guildId)}`);
      await sendPStatus(client, kazagumo, p, { from: 'playerEnd event' });
      if(!p.recovering && p[247] !== true && p.queue.isEmpty && !p.queue.current && p.loop == 'none'){await p.destroy()};
      savePlayers(kazagumo);
 });kazagumo.on('playerException', async(p, data)=>{
      const track = p.queue.current;
      const error = (data as { exception?: { message?: string } })?.exception?.message || 'unknown';
      console.error(headKE, `Track failed in ${chalk.bold(p.guildId)}: ${track?.title} (${track?.sourceName}):`, error);
      if(!track)return;
      // NodeLink sometimes misses the voice-ready event when a track is sent right after joining
      // ("playerStateChange timed out"). Nothing is wrong with the song: play it again once, same source.
      if(/playerStateChange timed out|Voice playback state timed out|UDP secretKey missing/i.test(error) && !(track as { voiceRetry?: boolean }).voiceRetry){
        (track as { voiceRetry?: boolean }).voiceRetry = true;
        console.warn(headKE, `Voice start timeout in ${chalk.bold(p.guildId)}, replaying ${track.title}`);
        p.recovering = true;
        try{ p.queue.unshift(track); if(!p.playing)await p.play(); }catch(err){ console.error(headKE, 'Replay error:', err); }
        finally{ p.recovering = false; };
        return;
      }
      // Discord voice server trouble (voice server crashed: close 4015, node gave up reconnecting,
      // no UDP info, DAVE handshake). The song is fine and every other source would fail the same way.
      // Rejoin the same channel (Discord hands out a new voice server) and play the same song again.
      const VOICE_ERR = /Voice WS closed|reconnection circuit breaker|missing UDP info|Voice connection timed out|\[DAVE\]/i;
      if(VOICE_ERR.test(error) && !(track as { voiceRejoin?: boolean }).voiceRejoin && p.voiceId){
        (track as { voiceRejoin?: boolean }).voiceRejoin = true;
        console.warn(headKE, `Voice server problem in ${chalk.bold(p.guildId)}, rejoining ${p.voiceId} and replaying ${track.title}`);
        p.recovering = true;
        try{
          const conn = kazagumo.shoukaku.connections.get(p.guildId);
          kazagumo.KazagumoOptions.send(p.guildId, { op: 4, d: { guild_id: p.guildId, channel_id: p.voiceId, self_mute: conn?.muted ?? false, self_deaf: conn?.deafened ?? false } });
          await new Promise(r => setTimeout(r, 3000));
          p.queue.unshift(track);
          if(!p.playing)await p.play();
        }catch(err){ console.error(headKE, 'Voice rejoin error:', (err as Error).message); }
        finally{ p.recovering = false; };
        return;
      }
      // Second voice start timeout: the song is still fine, the voice session on this node is not.
      // Move the player to another node and play the same song there (no other version).
      if((/playerStateChange timed out|Voice playback state timed out/i.test(error) || VOICE_ERR.test(error)) && !(track as { nodeRetry?: boolean }).nodeRetry){
        (track as { nodeRetry?: boolean }).nodeRetry = true;
        const sp = p.shoukaku;
        const from = sp.node.name;
        const others = new Map([...kazagumo.shoukaku.nodes].filter(([n]) => n !== from));
        const target = kazagumo.shoukaku.options.nodeResolver(others);
        if(target){
          p.recovering = true;
          try{
            const raw = (track.getRaw() as { _raw?: Track })._raw;
            const ported = raw ? await portTrack(kazagumo, raw, target as unknown as Node) : null;
            await sp.node.rest.destroyPlayer(p.guildId).catch(()=>{});
            sp.node = target;
            await sp.update({ ...sp.data.playerOptions, track: { encoded: ported?.encoded ?? sp.track ?? raw?.encoded ?? null }, position: 0 });
            console.warn(headKE, `Voice start timeout again in ${chalk.bold(p.guildId)}, moved ${track.title} from ${from} to ${target.name}`);
          }catch(err){ console.error(headKE, 'Node retry error:', (err as Error).message); }
          finally{ p.recovering = false; };
          return;
        }
      }
      // Voice problems are not the song's fault: no source fallback, no source failure recorded.
      if(VOICE_ERR.test(error)){ console.warn(headKE, `Voice still failing in ${chalk.bold(p.guildId)} after rejoin and node move`); return; }
      recordPlayback(track.sourceName, error);
      // One retry per song, on a different source.
      if((track as { altRetry?: boolean }).altRetry)return;
      p.recovering = true;
      try{
        const alt = await findAlternative(kazagumo, track, p.shoukaku.node.name);
        if(alt){
          (alt as { altRetry?: boolean }).altRetry = true;
          console.log(headK, `Fallback for ${chalk.bold(track.title)}: ${alt.title} (${alt.sourceName})`);
          p.queue.unshift(alt);
          if(!p.playing && !p.queue.current)await p.play();
        }
      }catch(err){
        console.error(headKE, 'Fallback error:', err);
      }finally{
        p.recovering = false;
      };
 });kazagumo.on('playerStuck', async(p)=>{
      console.warn(headKE, `Track stuck in ${chalk.bold(p.guildId)}: ${p.queue.current?.title}`);
      recordPlayback(p.queue.current?.sourceName, 'track stuck');
      p.skip();
 });kazagumo.on('playerUpdate', async(p, data)=>{
      console.log(headK, `Player was updated: ${chalk.bold(p.guildId)}`);
      const player = kazagumo.players.get(p.guildId);
      if(!player)return;

      console.debug({playing: player.playing, paused: player.paused});

      player.latestUpdate = Date.now();
      // A restored player gets updates before its queue is refilled: do not drop it then.
      if(!player.queue.current && player.queue.size == 0 && player[247] == false && !player.restoring){
        try{player.disconnect();}
        catch{(e: any)=>{console.log('')}};
      };

      savePlayers(kazagumo);
      await sendPStatus(client, kazagumo, player, { from: 'playerUpdate event' });
 });kazagumo.on('playerMoved', async(p, state, channels)=>{
      console.log(headK, `Player was moved: ${chalk.bold(p.guildId)}`);
      if(state === 'LEFT' && channels.oldChannelId){
        console.log(headK, `Bot was kicked from channel ${channels.oldChannelId}`);
        p.shoukaku.clean();
      };
      savePlayers(kazagumo);
 });kazagumo.on('playerDestroy', async(p)=>{
      console.log(headK, `Player was destroy: ${chalk.bold(p.guildId)}`);
      savePlayers(kazagumo);

      const c = p.textId && p.messageId && await client.channels.fetch(p.textId);
      const oldM = c && p.messageId && c.isSendable() && await c.messages.fetch(p.messageId);
      if(oldM && oldM.deletable)await oldM.delete();
 });

    kazagumo.on('debug', async(m)=>{
      console.debug(headKD, m);
    });

    (async()=>{while(true){
      await new Promise(res => setTimeout(res, 10_000));
      try{
        for(const node of Nodes){
          // console.debug(headSD, `Node ${chalk.bold(node.name)} status is ${Array.from(kazagumo.shoukaku.nodes.values()).find(n=>n.name == node.name)?.state}`);
          if(!kazagumo.shoukaku.nodes.has(node.name)){
            kazagumo.shoukaku.addNode(node);
            console.debug(headSD, `Trying to reconnect to Node ${chalk.bold(node.name)}`);
          }
        }
      }catch(err){
        console.error(headSE, 'Loop error:', err);
      };
      await new Promise(res => setTimeout(res, 10_000));
    }})();

    return kazagumo;
  }
};

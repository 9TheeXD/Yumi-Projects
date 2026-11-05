import { Client } from "discord.js";
import { Connectors, Constants, Node, NodeOption, Track } from "shoukaku";
import { findAlternative, portTrack, recordPlayback } from "./music/resolver.js";
import Env from "./utils/env.js";
import chalk from "chalk";
import { Kazagumo, KazagumoPlayer, KazagumoTrack, Plugins } from "kazagumo";
import { sendPStatus } from "./utils/messages.js";
import { savePlayers } from "./utils/function.js";
import { COLOR, NOTICE, notify } from "./utils/friendly.js";
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

    const RETRY_WINDOW = 10 * 60_000;
    const REJOIN_GAP = 5 * 60_000;
    // A Discord voice server can stay unreachable for many minutes (no UDP info on every node, on
    // 2026-11-03 and 2026-11-04). Giving up after 3 minutes left 24/7 players silent all night.
    const VOICE_RETRY_FOR = 60 * 60_000;
    const VOICE_RETRY_MAX_DELAY = 5 * 60_000;
    const humanListeners = (p: KazagumoPlayer) => {
      const channel = p.voiceId ? client.guilds.cache.get(p.guildId)?.channels.cache.get(p.voiceId) : undefined;
      return channel?.isVoiceBased() ? channel.members.filter(m => !m.user.bot).size : 0;
    };
    // Song or voice failed and every quick fix was used. Wait, then play the same song again
    // (rejoining the channel first for voice trouble). Song failures give up after 3 failures in
    // RETRY_WINDOW. Voice failures are not the song's fault: keep retrying with a growing delay
    // while people are in the channel, for up to VOICE_RETRY_FOR. After giving up, keep the player
    // in the channel; autoDisconnect leaves later if nothing is played.
    const retryLater = (p: KazagumoPlayer, track: KazagumoTrack, voice: boolean) => {
      const now = Date.now();
      let delay = 15_000;
      // A failed song ends with a loadFailed end, and Kazagumo then plays the next song in the queue
      // even when the failed one is looped. Hold the queue back so only the looped song is retried
      // (guild 1136970225452068864, 2026-11-04 13:12 UTC: the loop moved on to the next song).
      const hold = p.loop === 'track' ? [...p.queue] : [];
      if(hold.length)p.queue.clear();
      const giveBack = () => { if(hold.length && kazagumo.players.get(p.guildId) === p)p.queue.push(...hold); };
      if(voice){
        p.voiceFailSince ??= now;
        p.voiceFails = (p.voiceFails ?? 0) + 1;
        if(now - p.voiceFailSince > VOICE_RETRY_FOR || !humanListeners(p)){
          console.warn(headKE, `Giving up on ${track.title} in ${chalk.bold(p.guildId)} after ${Math.round((now - p.voiceFailSince) / 60_000)} min of voice failures`);
          p.voiceFailSince = undefined;
          p.voiceFails = 0;
          p.failedTrack = track;
          void notify(client, p.guildId, p.textId, 'gaveup', NOTICE.trackGaveUp(track.title), { color: COLOR.bad, resume: true });
          setTimeout(giveBack, 5_000);
          return;
        }
        delay = Math.min(30_000 * 2 ** (p.voiceFails - 1), VOICE_RETRY_MAX_DELAY);
      }else{
        p.failTimes = [...(p.failTimes ?? []).filter(at => now - at < RETRY_WINDOW), now];
        if(p.failTimes.length > 3){
          console.warn(headKE, `Giving up on ${track.title} in ${chalk.bold(p.guildId)}`);
          p.failedTrack = track;
          void notify(client, p.guildId, p.textId, 'gaveup', NOTICE.trackGaveUp(track.title), { color: COLOR.bad, resume: true });
          setTimeout(giveBack, 5_000);
          return;
        }
      }
      // One voice notice per outage: a long one would post a notice on every retry.
      if(!voice || p.voiceFails === 1)void notify(client, p.guildId, p.textId, voice ? 'voice' : 'retry', voice ? NOTICE.voiceTrouble() : NOTICE.trackRetry(track.title));
      p.recovering = true;
      setTimeout(async () => {
        try{
          if(kazagumo.players.get(p.guildId) !== p || p.queue.current)return;
          if(voice && p.voiceId){
            const conn = kazagumo.shoukaku.connections.get(p.guildId);
            kazagumo.KazagumoOptions.send(p.guildId, { op: 4, d: { guild_id: p.guildId, channel_id: p.voiceId, self_mute: conn?.muted ?? false, self_deaf: conn?.deafened ?? false } });
            await new Promise(r => setTimeout(r, 3000));
          }
          console.warn(headKE, `Retrying ${track.title} in ${chalk.bold(p.guildId)}${voice ? ` (voice attempt ${p.voiceFails})` : ''}`);
          p.queue.unshift(track);
          await p.play();
        }catch(err){ console.error(headKE, 'Retry error:', (err as Error).message); }
        finally{ p.recovering = false; giveBack(); };
      }, delay);
    };

    // A track exception is followed by a loadFailed end, and Kazagumo handles that end by playing the
    // next song itself. Replaying the failed song from the exception handler raced it: both songs
    // started, the end cut the replay off, and a run of songs was skipped within seconds.
    // So hold the rest of the queue back until that end has passed, play the same song again
    // (on another node when one is free), then put the queue back behind it.
    const replayAfterEnd = async (p: KazagumoPlayer, track: KazagumoTrack, opts: { otherNode?: boolean; delay?: number } = {}) => {
      p.recovering = true;
      const rest = [...p.queue];
      p.queue.clear();
      try{
        await new Promise<void>(r => { const t = setTimeout(r, 3000); p.shoukaku.once('end', () => { clearTimeout(t); setImmediate(r); }); });
        if(opts.delay)await new Promise(r => setTimeout(r, opts.delay));
        if(kazagumo.players.get(p.guildId) !== p)return;
        const sp = p.shoukaku;
        const from = sp.node.name;
        const target = opts.otherNode ? kazagumo.shoukaku.options.nodeResolver(new Map([...kazagumo.shoukaku.nodes].filter(([n]) => n !== from))) : undefined;
        if(target){
          const raw = (track.getRaw() as { _raw?: Track })._raw;
          const ported = raw ? await portTrack(kazagumo, raw, target as unknown as Node) : null;
          const encoded = ported?.encoded ?? raw?.encoded ?? track.track;
          await sp.node.rest.destroyPlayer(p.guildId).catch(()=>{});
          sp.node = target;
          p.queue.current = track;
          await sp.update({ ...sp.data.playerOptions, track: { encoded }, position: 0, paused: false });
          console.warn(headKE, `Replaying ${track.title} in ${chalk.bold(p.guildId)} on ${target.name} (was ${from})`);
        }else{
          p.queue.current = null;
          p.queue.unshift(track);
          await p.play();
          console.warn(headKE, `Replaying ${track.title} in ${chalk.bold(p.guildId)} on ${from}`);
        }
      }catch(err){ console.error(headKE, 'Replay error:', (err as Error).message); }
      finally{
        p.queue.push(...rest);
        p.recovering = false;
      }
    };

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
      p.idleSince = undefined;
      p.voiceFailSince = undefined;
      p.voiceFails = 0;
      p.failedTrack = undefined;
      recordPlayback(t?.sourceName); // null when a node move resumes a player that had no current track
      await sendPStatus(client, kazagumo, p, { from: 'playerStart event' });
      savePlayers(kazagumo);
 });kazagumo.on('playerEnd', async(p)=>{
      console.log(headK, `Player was ended: ${chalk.bold(p.guildId)}`);
      await sendPStatus(client, kazagumo, p, { from: 'playerEnd event' });
      if(!p.recovering && p[247] !== true && p.queue.isEmpty && !p.queue.current && p.loop == 'none'){await p.destroy(); return;};
      if(!p.queue.current && p.queue.isEmpty && !p.recovering)p.idleSince ??= Date.now();
      savePlayers(kazagumo);
 });kazagumo.on('playerException', async(p, data)=>{
      const track = p.queue.current;
      const error = (data as { exception?: { message?: string } })?.exception?.message || 'unknown';
      console.error(headKE, `Track failed in ${chalk.bold(p.guildId)}: ${track?.title} (${track?.sourceName}):`, error);
      if(!track)return;
      // Retry marks expire after RETRY_WINDOW. A looped song is the same track object for hours:
      // a voice hiccup hours later must get the same recovery as the first one.
      const tried = (key: string) => { const at = (track as unknown as Record<string, unknown>)[key]; return typeof at === 'number' && Date.now() - at < RETRY_WINDOW; };
      const mark = (key: string) => { (track as unknown as Record<string, unknown>)[key] = Date.now(); };
      // No audio within 15 s ("playerStateChange timed out"): either the node missed the voice-ready
      // event, or its YouTube stream gave nothing (403 on that node's IP or account). Both are about
      // this node, not the song: play the same song again on another node once.
      // A looped song can hit this every few minutes for hours, so the limit is 3 per RETRY_WINDOW
      // (it was 1, and the next timeout then swapped the song for another upload).
      p.startTimeouts = (p.startTimeouts ?? []).filter(at => Date.now() - at < RETRY_WINDOW);
      const startTimeout = /playerStateChange timed out|Voice playback state timed out|UDP secretKey missing/i.test(error);
      // The same song keeps not starting (a slow SoundCloud stream): play its Spotify version instead.
      // Spotify ranks first in the search, and the official upload is what the user would pick.
      if(startTimeout && p.startTimeouts.length >= 2 && track.sourceName !== 'spotify' && !tried('spotifyAlt')){
        mark('spotifyAlt');
        try{
          const alt = await findAlternative(kazagumo, track, p.shoukaku.node.name);
          if(alt?.sourceName === 'spotify'){
            p.startTimeouts = [];
            console.log(headK, `Spotify instead of ${chalk.bold(track.title)} (${track.sourceName}): ${alt.title}`);
            p.queue.unshift(alt);
            if(!p.playing && !p.queue.current)await p.play();
            return;
          }
        }catch(err){ console.error(headKE, 'Spotify fallback error:', (err as Error).message); }
      }
      if(startTimeout && p.startTimeouts.length < 3){
        p.startTimeouts.push(Date.now());
        console.warn(headKE, `Voice start timeout in ${chalk.bold(p.guildId)}, replaying ${track.title}`);
        void replayAfterEnd(p, track, { otherNode: !/UDP secretKey/i.test(error) });
        return;
      }
      // Discord voice server trouble (voice server crashed: close 4015, node gave up reconnecting,
      // no UDP info, DAVE handshake). The song is fine and every other source would fail the same way.
      // Rejoin the same channel (Discord hands out a new voice server) and play the same song again.
      const VOICE_ERR = /Voice WS closed|reconnection circuit breaker|missing UDP info|Voice connection timed out|\[DAVE\]/i;
      if(VOICE_ERR.test(error) && !tried('voiceRejoin') && p.voiceId){
        mark('voiceRejoin');
        void notify(client, p.guildId, p.textId, 'voice', NOTICE.voiceTrouble());
        console.warn(headKE, `Voice server problem in ${chalk.bold(p.guildId)}, rejoining ${p.voiceId} and replaying ${track.title}`);
        const conn = kazagumo.shoukaku.connections.get(p.guildId);
        kazagumo.KazagumoOptions.send(p.guildId, { op: 4, d: { guild_id: p.guildId, channel_id: p.voiceId, self_mute: conn?.muted ?? false, self_deaf: conn?.deafened ?? false } });
        void replayAfterEnd(p, track, { delay: 3000 });
        return;
      }
      // Voice still failing after the rejoin: move to another node once.
      if(VOICE_ERR.test(error) && !tried('nodeRetry')){
        mark('nodeRetry');
        void replayAfterEnd(p, track, { otherNode: true });
        return;
      }
      // Voice problems are not the song's fault: no source fallback, no source failure recorded.
      if(VOICE_ERR.test(error)){
        console.warn(headKE, `Voice still failing in ${chalk.bold(p.guildId)} after rejoin and node move`);
        return retryLater(p, track, true);
      }
      recordPlayback(track.sourceName, error);
      // One retry per song, on a different source. Not for a looped song: the user asked for that
      // exact song, and another upload would replace it without a word.
      if(p.loop !== 'track' && !tried('altRetry')){
        p.recovering = true;
        try{
          const alt = await findAlternative(kazagumo, track, p.shoukaku.node.name);
          if(alt){
            (alt as unknown as Record<string, unknown>).altRetry = Date.now();
            console.log(headK, `Fallback for ${chalk.bold(track.title)}: ${alt.title} (${alt.sourceName})`);
            p.queue.unshift(alt);
            if(!p.playing && !p.queue.current)await p.play();
            return;
          }
        }catch(err){
          console.error(headKE, 'Fallback error:', err);
        }finally{
          p.recovering = false;
        };
      }
      // Nothing worked. A looped song is what the user wants to hear: keep the player and try again later.
      if(p.loop === 'track')return retryLater(p, track, false);
      // Kazagumo moves on to the next song by itself.
      void notify(client, p.guildId, p.textId, 'track', p.queue.length ? NOTICE.trackSkipped(track.title) : NOTICE.trackFailedEnd(track.title));
 });kazagumo.on('playerStuck', async(p)=>{
      console.warn(headKE, `Track stuck in ${chalk.bold(p.guildId)}: ${p.queue.current?.title}`);
      recordPlayback(p.queue.current?.sourceName, 'track stuck');
      p.skip();
 });kazagumo.on('playerClosed', async(p, data)=>{
      // NodeLink sends close code 5001 when the worker that held this player crashed. The node has
      // forgotten the player and no end or exception follows, so it stayed silent until the bot was
      // restarted. Rebuild it at the same position, on another node when one is up.
      if(data.code !== 5001)return;
      const track = p.queue.current;
      if(!track || p.recovering)return;
      const sp = p.shoukaku;
      const from = sp.node.name;
      const position = sp.position;
      console.warn(headKE, `Node ${from} lost the player in ${chalk.bold(p.guildId)} (worker failed), resuming ${track.title}`);
      p.recovering = true;
      try{
        await new Promise(r => setTimeout(r, 2000));
        if(kazagumo.players.get(p.guildId) !== p)return;
        const target = kazagumo.shoukaku.options.nodeResolver(new Map([...kazagumo.shoukaku.nodes].filter(([n]) => n !== from))) ?? sp.node;
        const raw = (track.getRaw() as { _raw?: Track })._raw;
        const ported = raw && target !== sp.node ? await portTrack(kazagumo, raw, target as unknown as Node) : null;
        sp.node = target;
        await sp.update({ ...sp.data.playerOptions, track: { encoded: ported?.encoded ?? sp.track ?? track.track }, position, paused: p.paused });
        console.warn(headKE, `Resumed ${track.title} in ${chalk.bold(p.guildId)} on ${target.name} (was ${from})`);
      }catch(err){ console.error(headKE, 'Resume after worker failure error:', (err as Error).message); }
      finally{ p.recovering = false; }
 });kazagumo.on('playerUpdate', async(p, data)=>{
      console.log(headK, `Player was updated: ${chalk.bold(p.guildId)}`);
      const player = kazagumo.players.get(p.guildId);
      if(!player)return;

      console.debug({playing: player.playing, paused: player.paused});

      player.latestUpdate = Date.now();
      // Nothing to play: autoDisconnect leaves after a few idle minutes. Leaving right away dropped
      // players whose looped song failed once, before any recovery could run.
      if(player.queue.current || player.queue.size || player.recovering || player.restoring)player.idleSince = undefined;
      else player.idleSince ??= Date.now();

      savePlayers(kazagumo);
      await sendPStatus(client, kazagumo, player, { from: 'playerUpdate event' });
 });kazagumo.on('playerMoved', async(p, state, channels)=>{
      console.log(headK, `Player was moved: ${chalk.bold(p.guildId)}`);
      if(state === 'LEFT' && channels.oldChannelId){
        // Discord also drops the bot when a voice server dies. While people are still listening, come
        // back once and continue the song. A second drop within REJOIN_GAP counts as a real kick.
        const channel = client.guilds.cache.get(p.guildId)?.channels.cache.get(channels.oldChannelId);
        const listeners = channel?.isVoiceBased() ? channel.members.filter(m => !m.user.bot).size : 0;
        const track = p.queue.current;
        const recent = p.rejoinedAt && Date.now() - p.rejoinedAt < REJOIN_GAP;
        if(listeners && track && !recent){
          console.warn(headKE, `Bot left channel ${channels.oldChannelId} in ${chalk.bold(p.guildId)} with ${listeners} listener(s), rejoining`);
          p.rejoinedAt = Date.now();
          p.recovering = true;
          try{
            const position = p.shoukaku.position;
            await new Promise(r => setTimeout(r, 3000));
            if(kazagumo.players.get(p.guildId) !== p)return;
            p.voiceId = channels.oldChannelId;
            const conn = kazagumo.shoukaku.connections.get(p.guildId);
            kazagumo.KazagumoOptions.send(p.guildId, { op: 4, d: { guild_id: p.guildId, channel_id: channels.oldChannelId, self_mute: conn?.muted ?? false, self_deaf: conn?.deafened ?? false } });
            await new Promise(r => setTimeout(r, 3000));
            p.queue.unshift(track);
            await p.play();
            if(position > 0 && track.isSeekable)await p.seek(position).catch(()=>{});
            void notify(client, p.guildId, p.textId, 'rejoin', NOTICE.rejoined());
          }catch(err){ console.error(headKE, 'Rejoin error:', (err as Error).message); }
          finally{ p.recovering = false; };
        }else{
          console.log(headK, `Bot was removed from channel ${channels.oldChannelId}`);
          void notify(client, p.guildId, p.textId, 'left', NOTICE.left());
          await p.destroy().catch(()=>{});
          return;
        }
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

import { ActionRowBuilder, APIMessageButtonInteractionData, APIActionRowComponent, APIMessageComponentEmoji, ButtonBuilder, ButtonInteraction, ButtonStyle, CacheType, Client, ComponentType, ContainerBuilder, Interaction, MediaGalleryBuilder, ModalSubmitInteraction, SectionBuilder, SeparatorSpacingSize, TextBasedChannel, TextDisplayBuilder } from "discord.js";
import { Kazagumo, KazagumoPlayer as Player, KazagumoTrack as Track } from "kazagumo";
import { emoji, emojiToString, imageNone } from "global";
import chalk from "chalk";
import { InteractionElements, Locale } from "./interactionElements.js";
import { createMusicCard } from "./function.js";
import { User } from "discord.js";

export function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);

  const hStr = hrs > 0 ? `${hrs}:` : '';
  const mStr = `${hrs > 0 ? mins.toString().padStart(2, '0') : mins}`;
  const sStr = secs.toString().padStart(2, '0');

  return `${hStr}${mStr}:${sStr}`;
}
function getProgressBar(current: number, total: number, barLength = 20): string {
  let sec = Math.floor(current);
  if(sec % 10 === 4 || sec % 10 === 9){
    sec += 1;
  };if(sec % 10 === 1 || sec % 10 === 6){
    sec -= 1;
  };

  const progress = Math.min(sec / total, 1);
  const filled = Math.round(progress * barLength);
  const empty = barLength - filled;
  const bar = `${filled > 0 ? `**${'='.repeat(filled)}**` : ''}${'-'.repeat(empty)}`;

  return `「${formatTime(sec)}」 ${bar} 「${formatTime(total)}」`;
}

// The card image depends only on the track. Render it once per track and upload it only when the
// message does not already carry it: re-uploading the same file on every progress update made
// Discord show "image failed to load" while the new upload was still in flight.
const cardCache = new Map<string, { key: string; buffer: Buffer }>();
const sentCard = new Map<string, string>();

function cardKey(track: Track | undefined) {
  if (!track) return 'none';
  const req = track.requester as User | undefined;
  return `${track.identifier}|${track.uri}|${req?.id ?? ''}`;
}

// `files` for a message edit: the card when the message shows another track (or is unknown), else nothing.
export function cardFiles(messageId: string | undefined, n: { buffer: Buffer; cardKey: string }) {
  if (messageId && sentCard.get(messageId) === n.cardKey) return {};
  return { files: [{ attachment: n.buffer, name: 'nowplaying.png' }] };
}

export function markCardSent(messageId: string | undefined, key: string) {
  if (!messageId) return;
  sentCard.set(messageId, key);
  if (sentCard.size > 500) sentCard.delete(sentCard.keys().next().value!);
}

export const playerStatus_component = async(player: Player, client: Client, locale: Locale = 'en-US')=>{
  const iE = new InteractionElements;
  const now   = player.queue?.current || undefined;
  const prev  = player.queue?.previous || undefined;
  const queue = player.queue?.slice((player.queue.indexOf(player.queue.current!) || 0) + 1) || undefined;
  // console.log(' \\_ .playing.', player.playing);
  // console.log(player);
  // console.log(prev?.map(p=>p.title) || undefined);
  locale = client.guilds.cache.get(player.guildId)?.preferredLocale || 'en-US';

  const [repeatId, repeatEmoji, repeatLabel] = [
    ['music_repeat_off', emoji.arrow_r, iE.actions[locale].noRepeat],
    ['music_repeat_queue', emoji.m_loop, iE.actions[locale].repeatQueue],
    ['music_repeat_track', emoji.m_loop_one, iE.actions[locale].repeatSong]
  ][['none', 'queue', 'track'].indexOf(player.loop)] as [string, APIMessageComponentEmoji | string, string];
  // const allQ = [...(player.queue.previous || []), ...(player.queue.current ? [player.queue.current] : []), ...(player.queue || [])].reverse().filter((t, i, a) => a.findIndex(x => x.identifier === t.identifier) === i).reverse();
  const allQ = [...(player.queue.previous || []), ...(player.queue.current ? [player.queue.current] : []), ...(player.queue || [])];
  // console.log([...allQ.map(q=>q.info.title)],': ',{...player.queue.previous.map(p=>p.info.title)},player.queue.current?.info.title,{...player.queue.tracks.map(p=>p.info.title)});

  player.queue.all = allQ;

  const key = cardKey(now);
  let card = cardCache.get(player.guildId);
  if (card?.key !== key) {
    card = { key, buffer: await createMusicCard({ track: now, duration: formatTime((now?.length || 0) / 1000) }) };
    cardCache.set(player.guildId, card);
  }
  const buffer = card.buffer;

  const playlist_components = (new ContainerBuilder().setId(1)
    // .setAccentColor(0xBC8FD0)
    .addTextDisplayComponents(t=>t.setContent(`### ${iE.music_message[locale].playlist}`))
    .addSeparatorComponents(s=>s.setSpacing(SeparatorSpacingSize.Small))
    // .addSectionComponents(allQ.map((q,i)=>new SectionBuilder()
    //   .addTextDisplayComponents(t=>t.setContent(`${q == player.queue.current ? '** ->' : `[${i}]`} ${q?.info.title || 'null'}${q == player.queue.current ? '**' : ''}`))
    //   .setButtonAccessory(b=>b.setCustomId(`${i}_setting`).setEmoji(emoji.menu).setStyle(ButtonStyle.Secondary))
    // ))
    .addTextDisplayComponents(t=>t.setContent(`-# (${allQ.length}/100)`))
    .addActionRowComponents(a=>a.addComponents(
      new ButtonBuilder().setCustomId('music_backup').setEmoji(emoji.upload).setLabel(iE.actions[locale].save).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('music_load').setEmoji(emoji.download).setLabel(iE.actions[locale].load).setStyle(ButtonStyle.Secondary).setDisabled(true)
    ))
  );

  playlist_components.spliceComponents(3, 0, (new TextDisplayBuilder().setContent(`${allQ.length > 0 ? allQ.map((q,i)=>q ? `${q == player.queue.current ? '** ->' : `[${i}]`} ${q?.title || ''}${q == player.queue.current ? '**' : ''}` : iE.music_message[locale].notFoundName).join('\n') : iE.music_message[locale].noSongInQueue}`)));

  const m = [
    (new ContainerBuilder() // now
      // .setAccentColor(!now && !queue ? 0xff0000 : player.playing ? 0x00ff00 : 0xffff00)
      // .setAccentColor(0x1f1f1f)
      .addTextDisplayComponents(t=>t.setContent(`${
        (!now && (!queue || queue.length == 0))
          ? `### ${emojiToString(emoji.night_sleep)}  ${iE.music_message[locale].noSongInQueue}`
          : (player.playing && !player.paused)
              ? `### ${emojiToString(emoji.cd)}  ${iE.music_message[locale].playingSong}`
              : `### ${emojiToString(emoji.m_pause)}  ${iE.music_message[locale].pauseSong}`
      }`))
      .addSeparatorComponents(s=>s.setDivider(false).setSpacing(SeparatorSpacingSize.Large))

      .addActionRowComponents(a=>a
        .addComponents(
          new ButtonBuilder().setCustomId(false ? 'music_undo_destroy' : 'music_destroy').setEmoji(false ? emoji.undo : emoji.m_stop).setStyle(ButtonStyle.Secondary).setDisabled(false),
          new ButtonBuilder().setCustomId('music_prev').setEmoji(emoji.m_next_l).setStyle(ButtonStyle.Secondary).setDisabled(false),
          new ButtonBuilder().setCustomId(player.playing ? 'music_pause' : 'music_play').setEmoji(player.playing ? emoji.m_pause : emoji.m_play).setStyle(ButtonStyle.Secondary).setDisabled(false),
          new ButtonBuilder().setCustomId('music_next').setEmoji(emoji.m_next_r).setStyle(ButtonStyle.Secondary).setDisabled(false),
          new ButtonBuilder().setCustomId(repeatId).setEmoji(repeatEmoji).setStyle(ButtonStyle.Secondary).setDisabled(false)
        )
      ).addActionRowComponents(a=>a.addComponents(
          new ButtonBuilder().setCustomId('music_queue').setEmoji(emoji.playlist).setStyle(ButtonStyle.Secondary).setDisabled(false),
          new ButtonBuilder().setCustomId('music_shuffle').setEmoji(emoji.m_shuffle).setStyle(ButtonStyle.Secondary).setDisabled(false),
          new ButtonBuilder().setCustomId('music_favorite').setEmoji(emoji.heart).setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId('music_volume').setEmoji(player.volume > 0 ? emoji.m_volume : emoji.m_mute).setStyle(ButtonStyle.Secondary).setDisabled(false),
          new ButtonBuilder().setCustomId('music_info').setEmoji(emoji.menu).setStyle(ButtonStyle.Secondary).setDisabled(false)
        )
      )
    ),
    // (new ActionRowBuilder<ButtonBuilder>()
    //   .addComponents(
    //     new ButtonBuilder().setCustomId(false ? 'music_undo_destroy' : 'music_destroy').setEmoji(false ? emoji.undo : emoji.m_stop).setStyle(ButtonStyle.Danger).setDisabled(false),
    //     new ButtonBuilder().setCustomId('music_prev').setEmoji(emoji.m_next_l).setStyle(ButtonStyle.Primary).setDisabled(false),
    //     new ButtonBuilder().setCustomId(player.playing ? 'music_pause' : 'music_play').setEmoji(player.playing ? emoji.m_pause : emoji.m_play).setStyle(ButtonStyle.Primary).setDisabled(false),
    //     new ButtonBuilder().setCustomId('music_next').setEmoji(emoji.m_next_r).setStyle(ButtonStyle.Primary).setDisabled(false),
    //     new ButtonBuilder().setCustomId('music_queue').setEmoji(emoji.playlist).setStyle(player.showPlaylist ? ButtonStyle.Success : ButtonStyle.Danger).setDisabled(false)
    //   )
    // ),
    // (new ActionRowBuilder<ButtonBuilder>()
    //   .addComponents(
    //     new ButtonBuilder().setCustomId(repeatId).setEmoji(repeatEmoji).setLabel(repeatLabel).setStyle(ButtonStyle.Primary).setDisabled(false),
    //     new ButtonBuilder().setCustomId('music_shuffle').setEmoji(emoji.m_shuffle).setLabel(iE.actions[locale].shuffle).setStyle(ButtonStyle.Primary).setDisabled(false),
    //     new ButtonBuilder().setCustomId('music_volume').setEmoji(player.volume > 0 ? emoji.m_volume : emoji.m_mute).setLabel(`${player.volume}%`).setStyle(ButtonStyle.Primary).setDisabled(false),
    //     new ButtonBuilder().setCustomId('music_refresh').setEmoji(emoji.reload).setLabel(iE.actions[locale].refresh).setStyle(ButtonStyle.Primary).setDisabled(false)
    //   )
    // )
  ];
  if(now){
    (m[0] as ContainerBuilder).spliceComponents(1, 0, (player.showInfo
      ? new SectionBuilder()
        // .setContent(`## [${now.title}](${now.uri})${now.author ? '\n'+iE.by_label[locale]('__**', now.author, '**__') : ''}\n${getProgressBar(player.position / 1000, (now.length || 0) / 1000, 25)}`)
        .addTextDisplayComponents(t=>t.setContent(`## [${now.title}](${now.uri})${now.author ? '\n'+iE.by_label[locale]('__**', now.author, '**__') : ''}\n${getProgressBar(player.position / 1000, (now.length || 0) / 1000, 25)}`))
        .setThumbnailAccessory(s=>s.setURL(`${now.thumbnail || imageNone}`))
      : new TextDisplayBuilder()
        .setContent(`# [${now.title}](${now.uri})\n${getProgressBar(player.position / 1000, (now.length || 0) / 1000, 25)}`)
      ),(new MediaGalleryBuilder().addItems(i=>i.setURL('attachment://nowplaying.png')))
    );
  };if(!now){
    (m[0] as ContainerBuilder).components.forEach(c=>{if(!('components' in c))return;(c as ActionRowBuilder<ButtonBuilder>).components.forEach(b=>{
      if(['music_prev', 'music_next', 'music_pause', 'music_play'].some(id=>id == (b.data as APIMessageButtonInteractionData).custom_id)){
        b.setDisabled(true);
      };
    })});
  };if(queue.length > 0){
    player.showInfo ?? (m[0] as ContainerBuilder).addTextDisplayComponents(t=>t.setContent(`-# ${iE.music_message[locale].nextSong}: **${queue[0]?.title}**`));
    (m[0] as ContainerBuilder).components.forEach(c=>{if(!('components' in c))return;(c as ActionRowBuilder<ButtonBuilder>).components.forEach(b=>{
      if(['music_next'].some(id=>id == (b.data as APIMessageButtonInteractionData).custom_id)){
        b.setDisabled(false);
      };
    })});
    // m.splice(1, 0, (new ContainerBuilder()
    //   .addTextDisplayComponents(t=>t.setContent(`## คิวต่อไป`)) // lang
    //   .addTextDisplayComponents(t=>t.setContent(`${queue.map((q, i)=>`> [${i}] **${q.title.length > 30 ? q.title.slice(0, 30) + '...' : q.title}**`).join('\n')}`))
    // ));
  };if(!queue){
    (m[0] as ContainerBuilder).components.forEach(c=>{if(!('components' in c))return;(c as ActionRowBuilder<ButtonBuilder>).components.forEach(b=>{
      if(['music_next'].some(id=>id == (b.data as APIMessageButtonInteractionData).custom_id)){
        b.setDisabled(true);
      };
    })});
  };if(!prev){
    (m[0] as ContainerBuilder).components.forEach(c=>{if(!('components' in c))return;(c as ActionRowBuilder<ButtonBuilder>).components.forEach(b=>{
      if(['music_prev'].some(id=>id == (b.data as APIMessageButtonInteractionData).custom_id)){
        b.setDisabled(true);
      };
    })});
  };if(player.showPlaylist){
    m.splice(1, 0, playlist_components);
  };
  (m[0] as ContainerBuilder).addTextDisplayComponents(t=>t.setContent(`-# ${iE.music_message[locale].node} \`${player.shoukaku.node.name.replace(/\x1b\[[0-9;]*m/g, "")}\``));
  return {message: m, buffer, cardKey: key};
};

// One message edit per guild at a time. playerStart, playerUpdate and button handlers fire close
// together; parallel edits that each upload the card replace each other's attachment, and the
// edit that lands last can point at an attachment that no longer exists.
const editQueue = new Map<string, { running: Promise<void>; again: boolean }>();

export function sendPStatus(client: Client, kazagumo: Kazagumo, player: Player, data?: { locale?: Locale, from?: string }): Promise<void> {
  const q = editQueue.get(player.guildId);
  // Busy: the running loop picks this up. Do not hand back the loop's promise: with updates every
  // 2s it can keep looping, and callers that await it (then save players) would never continue.
  if (q) { q.again = true; return Promise.resolve(); }
  const entry = { running: Promise.resolve(), again: false };
  // The caller waits for its own edit only. Later requests that arrived meanwhile are edited in the
  // background; waiting for those too can last forever while players update every 2 s.
  let firstDone!: () => void;
  const first = new Promise<void>(r => { firstDone = r; });
  entry.running = (async () => {
    try {
      do {
        entry.again = false;
        await sendPStatusNow(client, kazagumo, player, data).catch(e => console.error(e));
        firstDone();
      } while (entry.again);
    } finally {
      firstDone();
      editQueue.delete(player.guildId);
    }
  })();
  editQueue.set(player.guildId, entry);
  return first;
}

async function sendPStatusNow(client: Client, kazagumo: Kazagumo, player: Player, data?: { locale?: Locale, from?: string }) {
  kazagumo.emit('messageUpdate', player);
  // console.debug('mDebug', player.messageId);
  const channel = player.textId ? client.channels.cache.get(player.textId || player.voiceId || '') : undefined;
  if(channel && channel.isSendable()){
    // console.log(player.messageId);
    const message = player.messageId && await channel.messages.fetch(player.messageId);
    const nMessage = await playerStatus_component(player, client, data?.locale);
    // const uM = [chalk.bold.yellowBright('[Camming DEBUG]'), 'Message update successful.'].join(' ');
    const uM = `Message update successful. ${data?.from ? chalk.dim(` from ${data?.from}`) : ''}`;
    if(message){
      await message.edit({ components: nMessage.message, ...cardFiles(message.id, nMessage) })
      .then(m=>{
        markCardSent(m.id, nMessage.cardKey);
        // console.log(uM);
        kazagumo.emit('debug', uM);
      }).catch(e=>{
        console.error(e);
      });
    };
    // else{
    //   const m = await channel.send({ components: nMessage, flags: MessageFlags.IsComponentsV2 });
    //   nPlayer.messageId = m.id;
    // };
  }
};

export async function editPStatus(interaction: Interaction<CacheType>, kazagumo: Kazagumo, player: Player, data?: { locale?: Locale, from?: string }) {
  kazagumo.emit('messageUpdate', player);
  const nMessage = await playerStatus_component(player, interaction.client, data?.locale);
  // const uM = [chalk.bold.yellowBright('[Camming DEBUG]'), 'Message update successful.'].join(' ');
  const uM = `Message update successful. ${data?.from ? chalk.dim(` from ${data?.from}`) : ''}`;
  
  if(interaction.isButton()){
    const update = () => interaction.update({ components: nMessage.message, ...cardFiles(interaction.message.id, nMessage) });
    return await update()
    .then(m=>{
      markCardSent(interaction.message.id, nMessage.cardKey);
      // console.log(uM);
      kazagumo.emit('debug', uM);
      return m;
    }).catch(async()=>{
      await interaction.fetchReply();
      return await update()
        .then(m=>{
          // console.log(uM);
          return m;
      kazagumo.emit('debug', uM);
        }).catch(e=>{
          console.error(e);
          return undefined;
        });
    });
  };
  if(interaction.isChatInputCommand()){
    // Slash command replies are new messages, so they always carry the card.
    const update = () => interaction.editReply({ components: nMessage.message, files: [{ attachment: nMessage.buffer, name: 'nowplaying.png' }] });
    return await update()
    .then(m=>{
      markCardSent(m.id, nMessage.cardKey);
      // console.log(uM);
      kazagumo.emit('debug', uM);
      return m;
    }).catch(async()=>{
      await interaction.fetchReply();
      return await update()
        .then(m=>{
          // console.log(uM);
          return m;
      kazagumo.emit('debug', uM);
        }).catch(e=>{
          console.error(e);
          return undefined;
        });
    });
  };
};

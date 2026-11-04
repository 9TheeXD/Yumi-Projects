import { COLOR, NOTICE, card, friendlyError, pick } from "../utils/friendly.js";
import { CacheType, ChatInputCommandInteraction, Client, CommandInteraction, DiscordAPIError, Interaction, MessageFlags, TextDisplayBuilder, underline } from "discord.js";
import chalk from "chalk";
import { editPStatus, playerStatus_component, sendPStatus } from "../utils/messages.js";
import { Kazagumo, KazagumoTrack } from "kazagumo";
import { setTimeout as wait } from "timers/promises";
import Env from "../utils/env.js";
import { clockToMs } from "global/common-functions";
import { InteractionElements } from "../utils/interactionElements.js";
import { musicSearch, noticeText, queueResult } from "../music/resolver.js";
type Locale = 'id' | 'da' | 'de' | 'en-GB' | 'en-US' | 'es-ES' | 'es-419' | 'fr' | 'hr' | 'it' | 'lt' | 'hu' | 'nl' | 'no' | 'pl' | 'pt-BR' | 'ro' | 'fi' | 'sv-SE' | 'vi' | 'tr' | 'cs' | 'el' | 'bg' | 'ru' | 'uk' | 'hi' | 'th' | 'zh-CN' | 'ja' | 'zh-TW' | 'ko';

export class SlashCommands {
slashCommands(interaction: ChatInputCommandInteraction<CacheType>, client: Client, kazagumo: Kazagumo) {
// async function cooldown(interaction: CommandInteraction) {
//   const userId = interaction.user.id;
//   const commandName = interaction.commandName;
//   const cooldownKey = `${userId}-${commandName}`;
//   const currentTimestamp = Date.now();
//   if (client.cooldowns.has(cooldownKey)) {
//     const expirationTime = client.cooldowns.get(cooldownKey)!;
//     if (currentTimestamp < expirationTime) {
//       const timeLeft = (expirationTime - currentTimestamp) / 1000;
//       await interaction.reply({
//         content: interaction.guild?.preferredLocale === 'th'
//           ? `กรุณารออีก ${timeLeft.toFixed(1)} วินาทีก่อนจะใช้คำสั่งนี้อีกครั้ง`
//           : `Please wait another ${timeLeft.toFixed(1)} seconds before using this command again.`,
//         ephemeral: true
//       });
//       return true;
//     };
//   };
//   client.cooldowns.set(cooldownKey, currentTimestamp + 2000);
//   return false;
// };
// const lavalinkManager = new LavalinkManager(client);
(async () => {
try{
const modeM = Env('MODE') === "music";
const iE = new InteractionElements;

if(interaction.guild){
  // if(await cooldown(interaction))return;
  if(modeM ? true : interaction.commandName === 'music'){
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = interaction.guild.members.cache.get(interaction.member?.user.id || '');
    const sub = modeM ? interaction.commandName : (interaction.options.getSubcommandGroup() || interaction.options.getSubcommand());
    console.debug(chalk.yellowBright.bold('[Yumi SC]'), `Command ${chalk.bold(interaction.options.getSubcommandGroup() ? `${interaction.options.getSubcommandGroup()} ${interaction.options.getSubcommand()}` : sub)} was interacted by ${interaction.user.id} in ${interaction.guildId}`);
    if(!member)return;
    if(sub === 'play'){
      const query = interaction.options.getString('search', true);
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      try{
        const player = kazagumo.getPlayer(interaction.guild.id) || await kazagumo.createPlayer({
          guildId: interaction.guild!.id,
          voiceId: member.voice.channel.id,
          textId: interaction.channel?.id,
        });

        const result = await musicSearch(kazagumo, query, { requester: member.user, userId: member.id, nodeName: player.shoukaku.node.name });
        const notice = noticeText(result.notice, interaction.locale);
        if (!result.tracks.length) {
          return interaction.editReply({ content: notice || iE.song_not_found_message[interaction.locale] });
        }

        console.debug({playing: player.playing, paused: player.paused});

        // Playlist / album link: queue every track (capped), otherwise the best match only.
        const added = queueResult(player, result);
        if(!player.paused)player.play();
        const text = `Loading Now Playing...`;  /// lang
        if(!interaction.channel || !interaction.channel.isSendable())return;

        const oldC = player.textId ? await interaction.guild.channels.fetch(player.textId).catch(e=>{return null}) : null;
        const oldM = oldC?.isSendable() && player.messageId ? await oldC.messages.fetch(player.messageId).catch(e=>{return null}) : null

        const m = oldM
          ? await oldM.edit({ components: [new TextDisplayBuilder().setContent(text)], flags: MessageFlags.IsComponentsV2 })
          : await interaction.channel.send({ components: [new TextDisplayBuilder().setContent(text)], flags: MessageFlags.IsComponentsV2 });
        // const m = await interaction.reply({ components: [new TextDisplayBuilder().setContent(text)], flags: MessageFlags.IsComponentsV2 });
        player.messageId = m?.id;
        interaction.editReply({ content: [notice, iE.song_added_message[interaction.locale](added, m.url)].filter(Boolean).join('\n') });

        await wait(300);
        await sendPStatus(client, kazagumo, player);
      }catch(e: any){
        console.error(e);
        await interaction.editReply({ content: friendlyError(e, interaction.locale) });  /// lang
      }
    }if(sub === 'pause'){
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      try{
        const player = kazagumo.getPlayer(interaction.guild.id) || await kazagumo.createPlayer({
          guildId: interaction.guild!.id,
          voiceId: member.voice.channel.id,
          textId: interaction.channelId,
        });
        if(!player.voiceId)player.voiceId = member.voice.channelId;
        if(player.voiceId != member.voice.channelId){
          return interaction.editReply({ content: iE.must_in_same_vc[interaction.locale] });
        };
        if(!player.paused)player.pause(true);

        await wait(300);
        await sendPStatus(client, kazagumo, player);
        await interaction.deleteReply();
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    }if(sub === 'skip'){
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      try{
        const player = kazagumo.getPlayer(interaction.guild.id) || await kazagumo.createPlayer({
          guildId: interaction.guild!.id,
          voiceId: member.voice.channel.id,
          textId: interaction.channelId,
        });
        if(!player.voiceId)player.voiceId = member.voice.channelId;
        if(player.voiceId != member.voice.channelId){
          return interaction.editReply({ content: iE.must_in_same_vc[interaction.locale] });
        };
        player.skip();

        await wait(300);
        await sendPStatus(client, kazagumo, player);
        await interaction.deleteReply();
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    }if(sub === 'stop'){
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      try{
        const player = kazagumo.getPlayer(interaction.guild.id) || await kazagumo.createPlayer({
          guildId: interaction.guild!.id,
          voiceId: member.voice.channel.id,
          textId: interaction.channelId,
        });
        if(!player.voiceId)player.voiceId = member.voice.channelId;
        if(player.voiceId != member.voice.channelId){
          return interaction.editReply({ content: iE.must_in_same_vc[interaction.locale] });
        };
        // player.requestedBy = interaction.user.id;
        player.queue.previous.length = 0;
        player.queue.current = null;
        player.queue.length = 0;
        player.showPlaylist = false;
        player.playing = false;
        player.paused = true;
        await player.destroy();

        await wait(300);
        await sendPStatus(client, kazagumo, player);
        await interaction.deleteReply();
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    }if(sub === 'resume'){
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      try{
        const player = kazagumo.getPlayer(interaction.guild.id) || await kazagumo.createPlayer({
          guildId: interaction.guild!.id,
          voiceId: member.voice.channel.id,
          textId: interaction.channelId,
        });
        if(!player.voiceId)player.voiceId = member.voice.channelId;
        if(player.voiceId != member.voice.channelId){
          return interaction.editReply({ content: iE.must_in_same_vc[interaction.locale] });
        };
        if(player.paused)player.pause(false);

        await wait(300);
        await sendPStatus(client, kazagumo, player);
        await interaction.deleteReply();
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    }if(sub === 'volume'){
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      const volume = interaction.options.getNumber('volume', false);
      try{
        const player = kazagumo.getPlayer(interaction.guild.id) || await kazagumo.createPlayer({
          guildId: interaction.guild!.id,
          voiceId: member.voice.channel.id,
          textId: interaction.channelId,
        });
        if(!player.voiceId)player.voiceId = member.voice.channelId;
        if(player.voiceId != member.voice.channelId){
          return interaction.editReply({ content: iE.must_in_same_vc[interaction.locale] });
        };
        if(volume != null && volume >= 0 && volume <= 200){
          player.setVolume(volume);
          await interaction.deleteReply();
        };

        await wait(300);
        await sendPStatus(client, kazagumo, player);
        if(volume == null){
          await interaction.editReply({ content: iE.current_volume_message[interaction.locale](String(player.volume)) });
        };
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    }if(sub === 'connect'){
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      try{
        const player = kazagumo.getPlayer(interaction.guild.id) || await kazagumo.createPlayer({
          guildId: interaction.guild!.id,
          voiceId: member.voice.channel.id,
          textId: interaction.channelId,
        });
        player.setVoiceChannel(member.voice.channel.id);
        // player.connect();

        const text = `Loading Now Playing...`;  /// lang
        if(interaction.channel && interaction.channel.isSendable()){
          const m = await interaction.channel.send({ components: [new TextDisplayBuilder().setContent(text)], flags: MessageFlags.IsComponentsV2 });
          if(m){
            player.messageId = m.id;
            player.setTextChannel(m.channelId);
          };
        };


        await wait(300);
        await sendPStatus(client, kazagumo, player);
        await interaction.deleteReply();
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    }if(sub === 'loop'){
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      const mode = interaction.options.getString('mode', false) as 'none' | 'queue' | 'track' | null;
      try{
        const player = kazagumo.getPlayer(interaction.guild.id) || await kazagumo.createPlayer({
          guildId: interaction.guild!.id,
          voiceId: member.voice.channel.id,
          textId: interaction.channelId,
        });
        if(!player.voiceId)player.voiceId = member.voice.channelId;
        if(player.voiceId != member.voice.channelId){
          return interaction.editReply({ content: iE.must_in_same_vc[interaction.locale] });
        };
        if(mode != null){
          player.setLoop(mode);
          await interaction.deleteReply();
        };

        await wait(300);
        await sendPStatus(client, kazagumo, player);
        if(mode == null){
          await interaction.editReply({ content: iE.current_loop_mode_message[interaction.locale](player.loop) });
        };
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    }if(sub === 'now'){
      try{
        let player = kazagumo.getPlayer(interaction.guild.id);
        if(!player){
          player = member.voice.channel ? await kazagumo.createPlayer({
            guildId: interaction.guild!.id,
            voiceId: member.voice.channel.id,
            textId: interaction.channel?.id,
          }) : undefined;

          if(!player)return await interaction.deleteReply();
        };

        const text = `Loading Now Playing...`;  /// lang
        if(interaction.channel && interaction.channel.isSendable()){
          const m = await interaction.channel.send({ components: [new TextDisplayBuilder().setContent(text)], flags: MessageFlags.IsComponentsV2 });
          if(m){
            player.messageId = m.id;
            player.setTextChannel(m.channelId);
          };
        };

        await wait(300);
        await sendPStatus(client, kazagumo, player);
        await interaction.deleteReply();
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    }if(sub === 'shuffle'){
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      try{
        const player = kazagumo.getPlayer(interaction.guild.id) || await kazagumo.createPlayer({
          guildId: interaction.guild!.id,
          voiceId: member.voice.channel.id,
          textId: interaction.channelId,
        });
        if(!player.voiceId)player.voiceId = member.voice.channelId;
        if(player.voiceId != member.voice.channelId){
          return interaction.editReply({ content: iE.must_in_same_vc[interaction.locale] });
        };
        player.queue.shuffle();

        await wait(300);
        await sendPStatus(client, kazagumo, player);
        await interaction.deleteReply();
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    }if(sub === 'seek'){
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      const seek = clockToMs(interaction.options.getString('timestamp', true));
      try{
        const player = kazagumo.getPlayer(interaction.guild.id) || await kazagumo.createPlayer({
          guildId: interaction.guild!.id,
          voiceId: member.voice.channel.id,
          textId: interaction.channelId,
        });
        if(!player.voiceId)player.voiceId = member.voice.channelId;
        if(player.voiceId != member.voice.channelId){
          return interaction.editReply({ content: iE.must_in_same_vc[interaction.locale] });
        };
        await player.seek(seek);

        await wait(300);
        await sendPStatus(client, kazagumo, player);
        await interaction.deleteReply();
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    }if(sub === 'queue'){
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      try{
        const player = kazagumo.getPlayer(interaction.guild.id);
        if(!player)return await interaction.deleteReply();
        if(!player.voiceId)player.voiceId = member.voice.channelId;
        if(player.voiceId != member.voice.channelId){
          return interaction.editReply({ content: iE.must_in_same_vc[interaction.locale] });
        };
        
        const sub = interaction.options.getSubcommand();
        if(sub === 'clear'){
          player.queue.clear();
        }if(sub === 'add'){
          return interaction.editReply({ content: iE.premium_tier_required_message[interaction.locale]('1', `https://camming.xyz/dashboard/?to=user/premium/music`) });
        }if(sub === 'remove'){
          return interaction.editReply({ content: iE.premium_tier_required_message[interaction.locale]('1', `https://camming.xyz/dashboard/?to=user/premium/music`) });
        }if(sub === 'move'){
          return interaction.editReply({ content: iE.premium_tier_required_message[interaction.locale]('1', `https://camming.xyz/dashboard/?to=user/premium/music`) });
        }if(sub === 'list'){
          return interaction.editReply({ content: iE.premium_tier_required_message[interaction.locale]('1', `https://camming.xyz/dashboard/?to=user/premium/music`) });
        };

        await wait(300);
        await sendPStatus(client, kazagumo, player);
        await interaction.deleteReply();
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    }if(sub === '247'){
      const locale = interaction.locale;
      const show = (text: string, color: number) => interaction.editReply({ components: [card(text, color)], flags: MessageFlags.IsComponentsV2 });
      const enable = interaction.options.getBoolean('enable');
      // No option: only show the current state. It needs no voice channel and changes nothing.
      if(enable === null){
        const on = kazagumo.getPlayer(interaction.guild.id)?.[247] === true;
        return show(pick(NOTICE.status247(on), locale), on ? COLOR.ok : COLOR.info);
      };
      if(!member.voice.channel){
        return interaction.editReply({ content: iE.join_vc_first_message[interaction.locale] });
      };
      try{
        const player = kazagumo.getPlayer(interaction.guild.id) || await kazagumo.createPlayer({
          guildId: interaction.guild!.id,
          voiceId: member.voice.channel.id,
          textId: interaction.channelId,
        });
        if(!player.voiceId)player.voiceId = member.voice.channelId;
        if(player.voiceId != member.voice.channelId){
          return interaction.editReply({ content: iE.must_in_same_vc[interaction.locale] });
        };
        player[247] = enable;

        await wait(300);
        await sendPStatus(client, kazagumo, player);
        kazagumo.emit('playerUpdate', player);
        await show(pick(NOTICE.set247(enable), locale), enable ? COLOR.ok : COLOR.info);
      }catch(e: any){
        console.error(e);
        await interaction.editReply(friendlyError(e, interaction.locale));  /// lang
      }
      return;
    };
  }
}

}catch(error){
  if(error instanceof DiscordAPIError){
    if(String(error.code).startsWith('10')){
        return;
    };
    return console.warn(chalk.red('[Camming SC]'), chalk.yellow(error));
  }else{
    // return console.error(error);
    return console.warn(chalk.red('[Camming SC]'), chalk.yellow(error));
  };
}
})();
}
}
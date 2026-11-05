import { COLOR, NOTICE, card, friendlyError, pick } from "../utils/friendly.js";
import chalk from 'chalk';
import { Client, CacheType, Interaction, DiscordAPIError, MessageFlags, ButtonInteraction, ModalBuilder, TextInputBuilder, ActionRowBuilder, TextInputStyle } from 'discord.js';
import { editPStatus, playerStatus_component, sendPStatus } from '../utils/messages.js';
import { resumeFailedTrack } from '../utils/function.js';
import { Kazagumo } from 'kazagumo';
import Env from '../utils/env.js';
import { InteractionElements } from '../utils/interactionElements.js';
type Locale = 'id' | 'da' | 'de' | 'en-GB' | 'en-US' | 'es-ES' | 'es-419' | 'fr' | 'hr' | 'it' | 'lt' | 'hu' | 'nl' | 'no' | 'pl' | 'pt-BR' | 'ro' | 'fi' | 'sv-SE' | 'vi' | 'tr' | 'cs' | 'el' | 'bg' | 'ru' | 'uk' | 'hi' | 'th' | 'zh-CN' | 'ja' | 'zh-TW' | 'ko';


export class Buttons {
buttons(interaction: ButtonInteraction<CacheType>, client: Client, kazagumo: Kazagumo) {
(async () => {
try{
const modeM = Env('MODE') === "music";
const iE = new InteractionElements;

async function expired(interaction: ButtonInteraction<CacheType>) {
  await interaction.reply({ content: 'This player has expired.', flags: MessageFlags.Ephemeral });
  interaction.message.deletable && await interaction.message.delete();
};

if(interaction.guild && interaction.customId.startsWith('music')){
  console.debug(chalk.yellowBright.bold('[Yumi SC]'), `Button ${chalk.bold(interaction.customId)} was clicked by ${interaction.user.id} in ${interaction.guildId}`);
	const player = kazagumo.players.get(interaction.guild.id);
  if(player && !player.textId)interaction.channelId && player.setTextChannel(interaction.channelId);
  if(player && !player.messageId)player.messageId = interaction.message.id || undefined;
  if(player && player.state == 1 && player.voiceId != interaction.guild.members.cache.get(interaction.member?.user.id || '')?.voice.channelId){
    return interaction.reply({ content: iE.must_in_same_vc[interaction.guildLocale || interaction.locale] });
  };
	if(interaction.customId === 'music_resume_failed'){
    const locale = interaction.guildLocale || interaction.locale;
    const say = (text: string, color: number) => interaction.update({ components: [card(text, color)], flags: MessageFlags.IsComponentsV2 });
    if(!player)return say(pick(NOTICE.resumeNoPlayer(), locale), COLOR.bad);
    // Already resumed (or playing something): nothing left to play again.
    if(!player.failedTrack)return say(pick(NOTICE.nothingToResume(), locale), COLOR.warn);
    try{
      const track = await resumeFailedTrack(kazagumo, player);
      return await say(pick(NOTICE.resuming((track?.title ?? '').replace(/[*_`~|]/g, '').slice(0, 80)), locale), COLOR.ok);
    }catch(err){
      console.error(err);
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_destroy'){
    if(!player)return expired(interaction);
    try{
      // player.requestedBy = interaction.user.id;
      player.queue.previous.length = 0;
      player.queue.current = null;
      player.queue.length = 0;
      player.showPlaylist = false;
      player.playing = false;
      player.paused = true;
      await player.destroy();
      return await editPStatus(interaction, kazagumo, player);
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
	};if(interaction.customId === 'music_play'){
    if(!player)return expired(interaction);
    try{
      // The player card shows Resume while a song cannot be played: play that song again.
      if(player.failedTrack){
        await resumeFailedTrack(kazagumo, player);
        return await editPStatus(interaction, kazagumo, player);
      };
      if(!player.paused && player.playing){
        await interaction.reply({ content: iE.is_now_playing_message[interaction.guildLocale || interaction.locale], flags: MessageFlags.Ephemeral });
      };
      player.pause(false);
      // await player.play({ clientTrack: cacheP.queue?.[cacheP.currentIndex || 0], position: cacheP.position || 0 });
      if(!player.playing)await player.play();
      // return await sendPStatus(client, player);
      return await editPStatus(interaction, kazagumo, player);
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_pause'){
    if(!player)return expired(interaction);
    try{
      if(!player.playing){
        return await interaction.reply({ content: iE.is_now_paused_message[interaction.guildLocale || interaction.locale], flags: MessageFlags.Ephemeral });
      };
      player.pause(true);
      // if(!player.paused)return await interaction.reply({ content: `Error`, flags: MessageFlags.Ephemeral }); /// lang;
      // return await sendPStatus(client, player);
      return await editPStatus(interaction, kazagumo, player);
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_volume'){
    if(!player)return expired(interaction);
    try{
      const modal = (new ModalBuilder()
        .setCustomId('music_volume')
        .setTitle('Volume')
        .addComponents(new ActionRowBuilder<TextInputBuilder>()
          .addComponents(
            new TextInputBuilder().setCustomId('volume').setLabel('Volume').setMinLength(1).setMaxLength(3).setRequired(true).setStyle(TextInputStyle.Short).setValue(String(player.volume || '0')).setPlaceholder('0 - 100')
          )
        )
      );
      await interaction.showModal(modal);
      // return await sendPStatus(client, player);
      return;
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_shuffle'){
    if(!player)return expired(interaction);
    try{
      player.queue.shuffle();
      
      // return await sendPStatus(client, player);
      return await editPStatus(interaction, kazagumo, player);
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_refresh'){
    if(!player)return expired(interaction);
    try{
      // return await sendPStatus(client, player);
      const m = await editPStatus(interaction, kazagumo, player, { from: 'button' });
      // console.log(player.messageId);
      if(m){
        const message = await m.fetch();
        player.setTextChannel(message.channelId);
        player.messageId = message.id;
      };
      // console.log(player.messageId);
      return;
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_next'){
    if(!player){
      return;
    }try{
      // The user moves on from a song that could not be played.
      player.failedTrack = undefined;
      player.skip();

      // return await sendPStatus(client, player);
      return await editPStatus(interaction, kazagumo, player);
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_prev'){
    if(!player){
      return;
    }try{
      // const prev = await player.queue.shiftPrevious()
      const prev = player.getPrevious();
      if(prev)await player.play(prev);

      // return await sendPStatus(client, player);
      return await editPStatus(interaction, kazagumo, player);
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_repeat_off'){
    if(!player){
      return;
    }try{
      player.setLoop('queue');

      // return await sendPStatus(client, player);
      return await editPStatus(interaction, kazagumo, player);
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_repeat_queue'){
    if(!player)return expired(interaction);
    try{
      player.setLoop('track');

      // return await sendPStatus(client, player);
      return await editPStatus(interaction, kazagumo, player);
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_repeat_track'){
    if(!player)return expired(interaction);
    try{
      await player.setLoop('none');

      // return await sendPStatus(client, player);
      return await editPStatus(interaction, kazagumo, player);
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_queue'){
    if(!player)return expired(interaction);
    try{
      player.showPlaylist = !player.showPlaylist;
      // await interaction.deferUpdate();

      return await editPStatus(interaction, kazagumo, player);
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };if(interaction.customId === 'music_info'){
    if(!player)return expired(interaction);
    try{
      player.showInfo = !player.showInfo;
      return await editPStatus(interaction, kazagumo, player);
    }catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral });
    };
  };
	
};

}catch(error){
  if(error instanceof DiscordAPIError){
    if(String(error.code).startsWith('10')){
        return;
    };
    return console.warn(chalk.red.bold('[Yumi SC]'), chalk.yellow(error));
  }else{
    // return console.error(error);
    return console.warn(chalk.red.bold('[Yumi SC]'), chalk.yellow(error));
  };
}
})();
}
}

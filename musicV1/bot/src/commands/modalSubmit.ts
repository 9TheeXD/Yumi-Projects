import { friendlyError } from "../utils/friendly.js";
import { ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, CacheType, Interaction, ChannelSelectMenuBuilder, ColorResolvable, DiscordAPIError, Client, MessageFlags, ModalSubmitInteraction } from "discord.js";
import chalk from 'chalk';
import { setTimeout as wait } from 'node:timers/promises';
import { editPStatus, playerStatus_component, sendPStatus } from "../utils/messages.js";
import { Kazagumo } from "kazagumo";
import { InteractionElements } from "../utils/interactionElements.js";
import Env from "../utils/env.js";
// const { ActionRowBuilder, EmbedBuilder } = require('discord.js');

export class Modals {
modals(interaction: ModalSubmitInteraction<CacheType>, client: Client, kazagumo: Kazagumo) {
(async () => {
try{
const modeM = Env('MODE') === "music";
const iE = new InteractionElements;

async function notPlayer(interaction: ModalSubmitInteraction<CacheType>) {
	if(!interaction.guild)return;
	const player = await kazagumo.createPlayer({
		guildId: interaction.guild.id,
		voiceId: interaction.guild.members.cache.get(interaction.member?.user.id || '')?.voice.channelId || '',
		textId: interaction.channelId || undefined,
	});
	player.messageId = interaction.message?.id;
	try{await interaction.editReply({ components: (await playerStatus_component(player, client)).message, files: [{ attachment: (await playerStatus_component(player, client)).buffer, name: 'nowplaying.png' }] })}
	catch(err){await sendPStatus(client, kazagumo, player)}
	return;
};

const isUrl = (url: string) => { 
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    } catch {
        return false;
    }
};
const isImageUrl = async (url: string): Promise<boolean> => {
    try {
        const response = await fetch(url, { method: 'HEAD' });
        const contentType = response.headers.get('content-type');
        return !!(contentType && contentType.startsWith('image/'));
    } catch {
        return false;
    }
};

//  =======================  [ ModalSubmit ]  =======================  \\


// Music Command \\
if(interaction.guild && interaction.customId.startsWith('music')){
	const player = kazagumo.players.get(interaction.guild.id);
	if(interaction.customId === 'music_volume'){
		if(!player){
      return await notPlayer(interaction);
    }try{
			const textI = Number(interaction.fields.getTextInputValue('volume') || 20);
			const volume = isNaN(textI) ? 20 : Math.min(200, Math.max(0, textI));
			await player.setVolume(volume);
			await interaction.reply({
					content: iE.set_volume_success_message[interaction.guildLocale || interaction.locale](String(volume)),
					flags: MessageFlags.Ephemeral
			});
      return await sendPStatus(client, kazagumo, player);
		}catch(err){
      return await interaction.reply({ content: friendlyError(err, interaction.locale), flags: MessageFlags.Ephemeral }); /// lang
    };
	};
}


}catch(error){
    if(error instanceof DiscordAPIError){
        if(String(error.code).startsWith('10')){
            return;
        };
    }else{ console.warn(chalk.red('[Yumi MS]'), chalk.yellow(error)); };
}
})();
}
}
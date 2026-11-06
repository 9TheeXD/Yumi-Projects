import { MessageFlags, TextDisplayBuilder, TextDisplayComponent } from "discord.js";
import { Client, Message } from "discord.js";
import { waitForDebugger } from "inspector";
import { Kazagumo, KazagumoTrack } from "kazagumo";
import { setTimeout as wait } from "timers/promises";
import { sendPStatus } from "../utils/messages.js";
import { musicSearch, noticeText, queueResult } from "../music/resolver.js";
import { tx } from "../utils/i18n/index.js";

export default class Messages {

  async message(client: Client, kazagumo: Kazagumo, message: Message) {
    // ให้ทำงานเฉพาะ channelId นี้
    // if (message.channelId !== "1377871442196299927") return;
    if (message.content.startsWith(`<@${client.user?.id}>`)) {
      message.content = message.content.slice(`<@${client.user?.id}>`.length).trim();
    };
    console.debug(message.content);

    // ต้องขึ้นต้นด้วย !music
    if (!message.content.startsWith("!play")) return;

    const query = message.content.slice("!play ".length).trim();
    if (!query) return message.reply("⚠️ ใส่ชื่อเพลงด้วย!");

    const member = message.member;
    const locale = message.guild?.preferredLocale;
    if (!member?.voice.channel) {
      return message.reply(tx('needVoice', locale));
    }

    // สร้าง player
    const player = await kazagumo.createPlayer({
      guildId: message.guild!.id,
      voiceId: member.voice.channel.id,
      textId: message.channel.id,
    });

    // หาเพลง
    const result = await musicSearch(kazagumo, query, { requester: message.author, userId: message.author.id, nodeName: player.shoukaku.node.name });
    if (!result.tracks.length) {
      return message.reply(noticeText(result.notice, locale) || tx('noResult', locale));
    }

    // เพิ่มเพลงเข้า queue
    const added = queueResult(player, result);
    if(!player.playing && !player.paused)player.play();
    const text = `Loading Now Playing...`;

    const m = await message.reply({ components: [new TextDisplayBuilder().setContent(text)], flags: MessageFlags.IsComponentsV2 });
    // const c = message.channel;
    // const m = c.isSendable() ? await c.send({ components: [new TextDisplayBuilder().setContent('Loading Message...')], flags: MessageFlags.IsComponentsV2 }) : undefined;
    player.messageId = m?.id;
    // player.showPlaylist = true;

    await wait(300);
    await sendPStatus(client, kazagumo, player);
    // await sendPStatus(client, kazagumo, player);
  }
}
import chalk from "chalk";
import { Client, MessageFlags, TextDisplayBuilder } from "discord.js";

// Messages for users. Never show raw error text or codes: say what happened and what to do.
type Text = { th: string; en: string };
const pick = (t: Text, locale?: string | null) => (locale === 'th' ? t.th : t.en);

const REPLY: [RegExp, Text][] = [
  [/voice connection is not established|missing session id|missing connection endpoint/i, {
    th: 'เข้าห้องเสียงไม่ได้ตอนนี้ ระบบเสียงของ Discord อาจมีปัญหาชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่',
    en: "Couldn't join the voice channel. Discord voice may be having a short outage, please try again in a moment.",
  }],
  [/no node|any nodes|not available/i, {
    th: 'ระบบเล่นเพลงยังไม่พร้อม ลองใหม่อีกครั้งในอีกสักครู่',
    en: 'The music system is not ready yet, please try again in a moment.',
  }],
  [/missing permissions|missing access/i, {
    th: 'บอทไม่มีสิทธิ์เข้าหรือพูดในห้องเสียงนี้ ให้แอดมินเช็คสิทธิ์ของบอท',
    en: "The bot doesn't have permission to join or speak in this voice channel.",
  }],
  [/timeout|timed out|fetch failed|ECONN|socket|aborted/i, {
    th: 'ระบบเล่นเพลงตอบช้ากว่าปกติ ลองใหม่อีกครั้งในอีกสักครู่',
    en: 'The music system is slow right now, please try again in a moment.',
  }],
];
const GENERIC: Text = {
  th: 'มีบางอย่างผิดพลาด ลองใหม่อีกครั้งในอีกสักครู่',
  en: 'Something went wrong, please try again in a moment.',
};

/** Reply text for a failed command. The real error stays in the log. */
export function friendlyError(err: unknown, locale?: string | null): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  for (const [re, text] of REPLY) if (re.test(msg)) return pick(text, locale);
  return pick(GENERIC, locale);
}

const t = (s: string) => s.replace(/[*_`~|]/g, '').slice(0, 80);

export const NOTICE = {
  trackSkipped: (title: string): Text => ({
    th: `เพลง **${t(title)}** เล่นไม่ได้ตอนนี้ เลยข้ามไปเพลงถัดไปให้`,
    en: `**${t(title)}** can't be played right now, skipped to the next song.`,
  }),
  trackFailedEnd: (title: string): Text => ({
    th: `เพลง **${t(title)}** เล่นไม่ได้ตอนนี้ และไม่มีเพลงอื่นในคิวแล้ว ใช้ /play เพื่อเปิดเพลงใหม่`,
    en: `**${t(title)}** can't be played right now and the queue is empty. Use /play to pick another song.`,
  }),
  trackRetry: (title: string): Text => ({
    th: `เพลง **${t(title)}** สะดุด บอทจะลองเล่นต่อให้อัตโนมัติในอีกไม่กี่วินาที`,
    en: `**${t(title)}** stopped unexpectedly. The bot will try to play it again in a few seconds.`,
  }),
  trackGaveUp: (title: string): Text => ({
    th: `ลองเล่นเพลง **${t(title)}** ใหม่หลายครั้งแล้วยังไม่ได้ เลยหยุดไว้ก่อน ลองเปิดใหม่ด้วย /play หรือเลือกเพลงอื่น`,
    en: `Tried to play **${t(title)}** several times without luck, so playback is paused. Try /play again or pick another song.`,
  }),
  voiceTrouble: (): Text => ({
    th: 'ระบบเสียงของ Discord มีปัญหาชั่วคราว บอทกำลังต่อใหม่และจะเล่นเพลงต่อให้เอง',
    en: 'Discord voice is having a short problem. The bot is reconnecting and will continue the song.',
  }),
  rejoined: (): Text => ({
    th: 'บอทหลุดออกจากห้องเสียง เลยกลับเข้ามาเล่นต่อให้แล้ว (ถ้าต้องการให้หยุด กดปุ่มหยุดเล่น)',
    en: 'The bot dropped out of the voice channel and came back to continue. Use the stop button if you want it to stop.',
  }),
  left: (): Text => ({
    th: 'บอทถูกนำออกจากห้องเสียง เลยหยุดเล่นเพลง ใช้ /play เพื่อเปิดใหม่',
    en: 'The bot was removed from the voice channel, so playback stopped. Use /play to start again.',
  }),
  restoreFailed: (): Text => ({
    th: 'บอทเพิ่งรีสตาร์ทและกลับเข้าห้องเสียงไม่ได้ ใช้ /play เพื่อเปิดเพลงต่อ',
    en: "The bot restarted and couldn't rejoin the voice channel. Use /play to continue.",
  }),
  idleLeft: (): Text => ({
    th: 'ไม่มีเพลงเล่นมาสักพักแล้ว บอทเลยออกจากห้องเสียง ใช้ /play เพื่อเปิดใหม่',
    en: 'Nothing has played for a while, so the bot left the voice channel. Use /play to start again.',
  }),
};

// One notice of each kind per guild per minute: a burst of failures must not flood the channel.
const lastSent = new Map<string, number>();

/** Posts a notice in the player's text channel, in the server's language (Thai or English). */
export async function notify(client: Client, guildId: string, textId: string | undefined | null, kind: string, text: Text) {
  if (!textId) return;
  const key = `${guildId}:${kind}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < 60_000) return;
  lastSent.set(key, now);
  try {
    const channel = await client.channels.fetch(textId);
    if (!channel?.isSendable()) return;
    const locale = client.guilds.cache.get(guildId)?.preferredLocale;
    await channel.send({ components: [new TextDisplayBuilder().setContent(pick(text, locale))], flags: MessageFlags.IsComponentsV2 });
  } catch (e) {
    console.error(chalk.bold('[Notice]'), `Could not post notice in ${guildId}:`, (e as Error).message);
  }
}

import chalk from "chalk";
import { tx, type Key } from "./i18n/index.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, ContainerBuilder, MessageFlags } from "discord.js";

// Messages for users. Never show raw error text or codes: say what happened and what to do.
// Text is a key plus values; pick() renders it in the Discord locale (see i18n/).
export type Text = { key: Key; vars?: Record<string, string> };
export const pick = (t: Text, locale?: string | null) => tx(t.key, locale, t.vars);

export const COLOR = { info: 0x5865f2, ok: 0x57f287, warn: 0xfee75c, bad: 0xed4245 } as const;

/** A Components V2 card for a short message: accent bar, text and an optional button. */
export function card(text: string, color: number = COLOR.info, button?: ButtonBuilder) {
  const c = new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(t => t.setContent(text));
  if (button) c.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(button));
  return c;
}

const REPLY: [RegExp, Key][] = [
  [/voice connection is not established|missing session id|missing connection endpoint/i, 'errVoice'],
  [/no node|any nodes|not available/i, 'errNode'],
  [/missing permissions|missing access/i, 'errPerm'],
  [/timeout|timed out|fetch failed|ECONN|socket|aborted/i, 'errSlow'],
];

/** Reply text for a failed command. The real error stays in the log. */
export function friendlyError(err: unknown, locale?: string | null): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  for (const [re, key] of REPLY) if (re.test(msg)) return tx(key, locale);
  return tx('errGeneric', locale);
}

const t = (s: string) => s.replace(/[*_`~|]/g, '').slice(0, 80);

export const NOTICE = {
  trackSkipped: (title: string): Text => ({ key: 'trackSkipped', vars: { title: t(title) } }),
  trackFailedEnd: (title: string): Text => ({ key: 'trackFailedEnd', vars: { title: t(title) } }),
  trackRetry: (title: string): Text => ({ key: 'trackRetry', vars: { title: t(title) } }),
  trackGaveUp: (title: string): Text => ({ key: 'trackGaveUp', vars: { title: t(title) } }),
  playerFailed: (): Text => ({ key: 'playerFailed' }),
  cardFailed: (): Text => ({ key: 'cardFailed' }),
  resumeButton: (): Text => ({ key: 'resumeButton' }),
  resuming: (title: string): Text => ({ key: 'resuming', vars: { title: t(title) } }),
  nothingToResume: (): Text => ({ key: 'nothingToResume' }),
  resumeNoPlayer: (): Text => ({ key: 'resumeNoPlayer' }),
  status247: (on: boolean): Text => ({ key: on ? 'status247On' : 'status247Off' }),
  set247: (on: boolean): Text => ({ key: on ? 'set247On' : 'set247Off' }),
  voiceTrouble: (): Text => ({ key: 'voiceTrouble' }),
  rejoined: (): Text => ({ key: 'rejoined' }),
  left: (): Text => ({ key: 'left' }),
  restoreFailed: (): Text => ({ key: 'restoreFailed' }),
  idleLeft: (): Text => ({ key: 'idleLeft' }),
};

// One notice of each kind per guild per minute: a burst of failures must not flood the channel.
const lastSent = new Map<string, number>();

/** Posts a notice in the player's text channel, in the server's language. */
export async function notify(client: Client, guildId: string, textId: string | undefined | null, kind: string, text: Text, opts: { color?: number; resume?: boolean } = {}) {
  if (!textId) return;
  const key = `${guildId}:${kind}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < 60_000) return;
  lastSent.set(key, now);
  try {
    const channel = await client.channels.fetch(textId);
    if (!channel?.isSendable()) return;
    const locale = client.guilds.cache.get(guildId)?.preferredLocale;
    const button = opts.resume ? new ButtonBuilder().setCustomId('music_resume_failed').setEmoji('▶️').setLabel(pick(NOTICE.resumeButton(), locale)).setStyle(ButtonStyle.Success) : undefined;
    await channel.send({ components: [card(pick(text, locale), opts.color ?? COLOR.warn, button)], flags: MessageFlags.IsComponentsV2 });
  } catch (e) {
    console.error(chalk.bold('[Notice]'), `Could not post notice in ${guildId}:`, (e as Error).message);
  }
}

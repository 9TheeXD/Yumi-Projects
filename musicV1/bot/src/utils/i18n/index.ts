import type { Key, Lang, Strings } from "./core.js";
import { en } from "./en.js";
import { th } from "./th.js";
import { id, da, de, esES, fr, hr, it, lt, hu, nl } from "./europe1.js";
import { no, pl, ptBR, ro, fi, svSE, vi, tr, cs, el } from "./europe2.js";
import { bg, ru, uk, hi, zhCN, ja, zhTW, ko } from "./asia.js";

export type { Key, Strings, Lang };

// Every locale Discord supports (guild.preferredLocale / interaction.locale). Regional variants share a base.
const TABLE: Record<Lang, Strings> = {
  en, 'en-US': en, 'en-GB': en,
  th, id, da, de, 'es-ES': esES, 'es-419': esES, fr, hr, it, lt, hu, nl, no, pl, 'pt-BR': ptBR, ro, fi, 'sv-SE': svSE,
  vi, tr, cs, el, bg, ru, uk, hi, 'zh-CN': zhCN, ja, 'zh-TW': zhTW, ko,
};

const BY_LANGUAGE = new Map<string, Strings>();
for (const [loc, strings] of Object.entries(TABLE)) if (!BY_LANGUAGE.has(loc.split('-')[0])) BY_LANGUAGE.set(loc.split('-')[0], strings);

/** Text for a key in the given Discord locale. A missing locale, language or sentence falls back to English, never undefined. */
export function tx(key: Key, locale?: string | null, vars?: Record<string, string>): string {
  const own = locale ? (TABLE as Record<string, Strings | undefined>)[locale] ?? BY_LANGUAGE.get(locale.split('-')[0]) : undefined;
  const s = own?.[key] || en[key] || '';
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m) : s;
}

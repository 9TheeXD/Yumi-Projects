import type { Locale } from "../interactionElements.js";

// Every user-facing notice, in every language Discord supports. `{title}` is replaced by the song title.
export const KEYS = [
  'errVoice', 'errNode', 'errPerm', 'errSlow', 'errGeneric',
  'trackSkipped', 'trackFailedEnd', 'trackRetry', 'trackGaveUp',
  'playerFailed', 'cardFailed', 'resumeButton', 'resuming', 'nothingToResume', 'resumeNoPlayer',
  'status247On', 'status247Off', 'set247On', 'set247Off',
  'voiceTrouble', 'rejoined', 'left', 'restoreFailed', 'idleLeft',
] as const;
export type Key = typeof KEYS[number];
export type Strings = Record<Key, string>;
export type Lang = Locale | 'en';

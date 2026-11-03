import fs from "fs";
import path from "path";
import Env from "../utils/env.js";

// Music node registry. One list for the bot, the sidecar and the login flow.
//
//   MUSIC_NODES = NODELINK,NODELINK2,LAVALINK,LAVALINK2
//   NODELINK2_HOST = 127.0.0.1:3002
//   NODELINK2_PASS = ...
//   NODELINK2_SECURE = false            (optional)
//   NODELINK2_KIND = nodelink           (optional, default from the name)
//   NODELINK2_STACK = /home/yumi/nodelink   docker compose dir (for login / restart)
//   NODELINK2_SERVICE = nodelink2           compose service name
//   NODELINK2_TOKEN_VAR = YT_REFRESH_TOKENS_2   variable in <STACK>/.env that holds the burner token
//
// Without MUSIC_NODES the bot uses NODELINK (if set) and LAVALINK, like before.
export type NodeKind = 'nodelink' | 'lavalink';
export type MusicNode = {
  name: string;
  url: string;
  auth: string;
  secure: boolean;
  kind: NodeKind;
  stack?: string;
  service?: string;
  tokenVar?: string;
};

export function musicNodes(): MusicNode[] {
  const names = (Env('MUSIC_NODES') || 'NODELINK,LAVALINK').split(',').map(s => s.trim()).filter(Boolean);
  return names.flatMap(name => {
    const url = Env(`${name}_HOST`);
    if (!url) return [];
    const kind = (Env(`${name}_KIND`) || (name.includes('NODELINK') ? 'nodelink' : 'lavalink')) as NodeKind;
    return [{
      name,
      url,
      auth: Env(`${name}_PASS`) || 'youshallnotpass',
      secure: Env(`${name}_SECURE`)?.toLowerCase() == 'true',
      kind,
      stack: Env(`${name}_STACK`),
      service: Env(`${name}_SERVICE`),
      tokenVar: Env(`${name}_TOKEN_VAR`),
    }];
  });
}

// Priority tiers: "NODELINK,NODELINK2|LAVALINK,LAVALINK2" = balance inside the first tier that has a
// usable node, the next tier only when the whole first tier is down. Without "|" every name is its
// own tier (old behavior: strict order).
export function nodeTiers(): string[][] {
  const raw = Env('MUSIC_NODE_PRIORITY') || 'NODELINK,LAVALINK';
  return raw.includes('|')
    ? raw.split('|').map(t => t.split(',').map(s => s.trim()).filter(Boolean))
    : raw.split(',').map(s => [s.trim()]).filter(t => t[0]);
}

// Per-node YouTube health from the sidecar (sidecar/sidecar-state.json). A node whose YouTube is
// failing still plays other sources, so it is only avoided while a healthy node exists.
const HEALTH_FILE = path.resolve(Env('MUSIC_NODE_HEALTH_FILE') || path.join(process.cwd(), '../sidecar/sidecar-state.json'));
let health: { at: number; youtubeDown: Set<string> } = { at: 0, youtubeDown: new Set() };

export function youtubeDownNodes(): Set<string> {
  if (Date.now() - health.at < 30_000) return health.youtubeDown;
  const down = new Set<string>();
  try {
    const state = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    // Ignore a stale file (sidecar stopped): better to use every node than to trust old data.
    if (Date.now() - Date.parse(state.at) < 20 * 60_000) {
      for (const [name, n] of Object.entries<any>(state.nodes || {})) {
        if (n?.up && n.sources?.youtube && n.sources.youtube.ok === false) down.add(name);
      }
    }
  } catch {}
  health = { at: Date.now(), youtubeDown: down };
  return down;
}

import path from 'path';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import Env, { isDev, isM } from './utils/env.js';
import { Client, GatewayIntentBits } from 'discord.js';
import { NodeOption, Shoukaku } from 'shoukaku';
import chalk from 'chalk';
// import ShoukakuManager from './shoukakuManager';
import { Kazagumo, KazagumoPlayer, KazagumoTrack } from 'kazagumo';
import KazagumoManager from './kazagumoManager.js';
import Messages from './commands/messages.js';
import { DiscordAPIError } from 'discord.js';
import dayjs from 'dayjs';
import { setTimeout as wait } from 'timers/promises';
import { Buttons } from './commands/buttons.js';
import { nodeLoginButton } from './commands/nodeLogin.js';
import { Modals } from './commands/modalSubmit.js';
import { SlashCommands } from './commands/slashCommands.js';
import { Autocomplete } from './commands/autocomplete.js';
import { APIServer } from './apiServer.js';
import { autoDisconnect, restorePlayers } from './utils/function.js';
import { PlayerServer } from './playerServer.js';

const savedPlayers: any = [];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.resolve(__dirname, "../../.env") });
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const originalDebug = console.debug;
console.log = (...args) => {
  (process as NodeJS.EventEmitter).emit('consoleEvent', { type: 'log', args })
  // customLogger('log', ...args);
};console.warn = (...args) => {
  (process as NodeJS.EventEmitter).emit('consoleEvent', { type: 'warn', args })
  // customLogger('warn', ...args);
};console.error = (...args) => {
  (process as NodeJS.EventEmitter).emit('consoleEvent', { type: 'error', args })
  // customLogger('error', ...args);
};console.debug = (...args) => {
  (process as NodeJS.EventEmitter).emit('consoleEvent', { type: 'debug', args })
  // customLogger('error', ...args);
};function customLogger(type: string, ...args: any[]) {
  (process as NodeJS.EventEmitter).emit('consoleEvent', { type, args });
};
process.on('consoleEvent', ({ type, args }: { type: 'log' | 'warn' | 'error' | 'debug'; args: any[] }) => {
  function isEmpty(arg: any) {
    return arg === '' || arg === ' ';
  };
  // if(!(args as string[]).some(a=>a.startsWith('[EDIT]')))return;
  if(args.some(isEmpty) && !args.some(arg=>!isEmpty(arg))){
    // return sendLog(...args);
    if(type == 'log')originalLog(...args);
    if(type == 'warn')originalWarn(...args);
    if(type == 'error')originalError(...args);
    if(type == 'debug')originalDebug(...args);
  }else{
    // const time = chalk.cyan(dayjs().format('DD/MM/YY HH:mm:ss.SSS'));
    const time = chalk.cyan(dayjs().format('DD/MM/YY HH:mm:ss'));
    // return sendLog(time, ...args);
    if(type == 'log')originalLog(time, ...args);
    if(type == 'warn')originalWarn(time, ...args);
    if(type == 'error')originalError(time, ...args);
    if(type == 'debug')originalDebug(time, ...args);
  };
});process.on('unhandledRejection', (reason) => {
  if(reason instanceof DiscordAPIError){
    if(String(reason.code).startsWith('10')){
      return;
    };
  }
  console.warn(chalk.red('[Yumi ERROR] Unhandled Rejection'), chalk.yellow(reason), chalk.gray(((reason as any)?.stack as string)?.split((reason as any) || undefined).slice(1).join('\n') || ''));
});process.on('uncaughtException', (err) => {
  console.error(err);
  console.error(chalk.red('[Yumi ERROR] Uncaught Exception'), chalk.yellow(err), chalk.gray(((err as any)?.stack as string)?.split('\n').slice(1).join('\n') || ''));
  process.exit(1);
});
declare module 'discord.js' {
  interface Client {
    // shoukaku: Shoukaku,
    // kazagumo: Kazagumo
  }
};declare module 'kazagumo' {
  interface KazagumoPlayer {
    messageId?: string;
    showPlaylist: boolean;
    latestUpdate: number;
    showInfo: boolean;
    247: boolean;
    recovering?: boolean;
    restoring?: boolean;
    // Since when nothing has been playing (autoDisconnect leaves after a few minutes).
    idleSince?: number;
    // Recent unrecoverable failures, and the last automatic rejoin after the bot was dropped.
    failTimes?: number[];
    rejoinedAt?: number;
    // Voice failures in a row since the last successful start, and when the first one happened.
    voiceFails?: number;
    voiceFailSince?: number;
    // The song that could not be played when every retry was used up; the Resume button and a bot restart play it again.
    failedTrack?: KazagumoTrack;
    // Times the song did not start within 15 s, within the retry window.
    startTimeouts?: number[];
    // Songs that failed since something last played for 10 s (see MAX_FAILED_SONGS).
    failedSongs?: Set<string>;
    lastTrack?: KazagumoTrack;
  }
  interface KazagumoEvents {
    debug: [message: string];
  }
  interface KazagumoQueue {
    all?: KazagumoTrack[]
  }
  interface Kazagumo {
    nodes: NodeOption[]
  }
};
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    // GatewayIntentBits.MessageContent
  ]
});
const kazagumo = new KazagumoManager(client) as Kazagumo;
(async()=>{
  // new ShoukakuManager(client);

  const commands = {
    message: new Messages(),
    slashCommands: new SlashCommands(),
    buttons: new Buttons(),
    modals: new Modals(),
    autocomplete: new Autocomplete(),
    // selectMenu: new selectMenu()
  };

  async function leaveAllVC() {
    client.guilds.cache.forEach(async(g)=>{
      await g.members.cache.get(client.user?.id || '')?.voice.disconnect();
    });
  };

  client.on('messageCreate', m=>{
    commands.message.message(client, kazagumo, m);
  });
  client.on('interactionCreate', i=>{
    // SlashCommand
    if(i.isChatInputCommand()){ commands.slashCommands.slashCommands(i, client, kazagumo); };
    // // Button
    if(i.isButton() && i.customId.startsWith('ytlogin:')){ nodeLoginButton(i).catch(e=>console.error('[NodeLogin]', e)); return; };
    if(i.isButton()){ commands.buttons.buttons(i, client, kazagumo); };
    // // ModalSubmit
    if(i.isModalSubmit()){ commands.modals.modals(i, client, kazagumo); };
    // // AutoComplete
    if(i.isAutocomplete()){ commands.autocomplete.autocomplete(i, client, kazagumo); };
    // // SelectMenu
    // if(interaction.isAnySelectMenu() ||
    //       interaction.isRoleSelectMenu() ||
    //       interaction.isUserSelectMenu() ||
    //       interaction.isStringSelectMenu() ||
    //       interaction.isChannelSelectMenu() ||
    //       interaction.isMentionableSelectMenu()){ commands.selectMenu.selectMenu(interaction, client) };
  });

  client.on('clientReady', async()=>{
    console.log(chalk.blueBright.bold('[Discord]'), 'Logged in as', chalk.greenBright.bold(client.user?.displayName), 'is Ready!');

    // await leaveAllVC();
    new APIServer(kazagumo, client, isDev ? 32162 : isM ? 32063 : 32062);
    await (new PlayerServer(kazagumo, client)).init();

    await new Promise(r => setTimeout(r, 1_000));
    await restorePlayers(client, kazagumo);
    autoDisconnect(client, kazagumo);
  });

  await client.login(Env('BOT_TOKEN'));
})();

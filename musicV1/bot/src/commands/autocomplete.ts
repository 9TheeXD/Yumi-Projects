import { ApplicationCommandOptionChoiceData, AutocompleteInteraction, CacheType, Client, CommandInteraction, DiscordAPIError, Interaction } from "discord.js";
import chalk from "chalk";
import { formatTime } from "../utils/messages.js";
import { Kazagumo } from "kazagumo";
import Env from "../utils/env.js";
import { InteractionElements } from "../utils/interactionElements.js";
import { choiceValue, musicSearch } from "../music/resolver.js";
type Locale = 'id' | 'da' | 'de' | 'en-GB' | 'en-US' | 'es-ES' | 'es-419' | 'fr' | 'hr' | 'it' | 'lt' | 'hu' | 'nl' | 'no' | 'pl' | 'pt-BR' | 'ro' | 'fi' | 'sv-SE' | 'vi' | 'tr' | 'cs' | 'el' | 'bg' | 'ru' | 'uk' | 'hi' | 'th' | 'zh-CN' | 'ja' | 'zh-TW' | 'ko';

export class Autocomplete {
autocomplete(interaction: AutocompleteInteraction<CacheType>, client: Client, kazagumo: Kazagumo) {
(async () => {
try{
const modeM = Env('MODE') === "music";
const iE = new InteractionElements;

function shortSourceName(source?: string) {
  const map: Record<string, string> = {
    youtube: "yt",
    soundcloud: "sc",
  };

  return source ? map[source] ?? source : source;
};

if(interaction.guild){
  if(modeM ? true : interaction.commandName === 'music'){
    const member = interaction.guild.members.cache.get(interaction.member?.user.id || '');
    const sub = modeM ? interaction.commandName : (interaction.options.getSubcommandGroup() || interaction.options.getSubcommand());
    if(!member)return;
    if(sub === 'play'){
      try{
        // const player = kazagumo.getPlayer(interaction.guild.id) || await createPlayer(client, interaction, interaction.guild, member);
        const query = interaction.options.getFocused();
        const source = interaction.options.get('source', false);
        if (!query) return interaction.respond([]);

        const res = await musicSearch(kazagumo, query, { requester: member, userId: member.id, kind: 'autocomplete' });
        const Yresults = res.tracks;
        // Playlist / album link: offer the whole list first (value = the link, queued in full by /play).
        const listChoice: ApplicationCommandOptionChoiceData[] = res.type === 'PLAYLIST' && query.trim().length <= 100
          ? [{ name: `📃 ${res.playlistName || 'Playlist'} (${res.tracks.length})`.slice(0, 100), value: query.trim() }] : [];
        // const Sresults = (await kazagumo.search(query, { requester: member })).tracks.filter(t=>t.sourceName == 'spotify');
        // const tracks = [...Yresults.slice(0, 10), ...Sresults.slice(0, 10)];
        const tracks = Yresults.slice(0, 10);

        if (!tracks || tracks.length === 0) {
          return interaction.respond([]);
        }

        const choices: ApplicationCommandOptionChoiceData[] = [...listChoice, ...tracks.slice(0, 24).map((track,i) => ({
          name: `${track.sourceName || 'unknown'}・${track.title.slice(0, 80)} 「${formatTime((track.length || 0) / 1000)}」`.slice(0, 100),
          value: choiceValue(track, i),
        }))];

        return interaction.respond(choices);
      }catch(e: any){
        return;
      };
    }if(sub === 'queue'){
      try{
        const top: ApplicationCommandOptionChoiceData<number> = { name: iE.top_of_queue_message[interaction.locale], value: -1 };
        
        const sub = interaction.options.getSubcommand();
        console.debug(interaction.options.getFocused());
        if(sub === 'add'){
          const focus = interaction.options.getFocused(true);
          if(focus.name == 'search'){
            if(!focus.value)return interaction.respond([]);

            const Yresults = (await musicSearch(kazagumo, focus.value.toString(), { requester: member, userId: member.id, kind: 'autocomplete' })).tracks;
            // const Sresults = (await kazagumo.search(query, { requester: member })).tracks.filter(t=>t.sourceName == 'spotify');
            // const tracks = [...Yresults.slice(0, 10), ...Sresults.slice(0, 10)];
            const tracks = Yresults.slice(0, 10);

            if (!tracks || tracks.length === 0) {
              return interaction.respond([]);
            }

            const choices: ApplicationCommandOptionChoiceData[] = tracks.slice(0, 25).map((track,i) => ({
              name: `${track.sourceName || 'unknown'}・${track.title.slice(0, 80)} 「${formatTime((track.length || 0) / 1000)}」`.slice(0, 100),
              value: choiceValue(track, i),
            }));

            return interaction.respond(choices);
          }if(focus.name == 'position'){
            const player = kazagumo.getPlayer(interaction.guild.id);
            if(!player || !player.queue?.all)return interaction.respond([top]);
            const found: ApplicationCommandOptionChoiceData<number>[] = player.queue?.all
              .map((v,i)=>{return { name: `[${i}] ${v?.title || ''}`, value: i }})
              .filter(vt => !focus.value || vt.name.toLowerCase().includes(String(focus.value).toLowerCase()));
            if(!focus.value)found.unshift(top);
            if(found.length === 0)found.push(top);
            return interaction.respond(found.slice(0, 25));
          };
        }if(sub === 'remove'){
          const song = interaction.options.getFocused();
          const player = kazagumo.getPlayer(interaction.guild.id);
          if(!player || !player.queue?.all)return interaction.respond([]);
          const found: ApplicationCommandOptionChoiceData<number>[] = player.queue?.all
            .map((v,i)=>{return { name: `[${i}] ${v?.title || ''}`, value: i }})
            .filter(vt=>!song || vt.name.toLowerCase().includes(String(song).toLowerCase()));
          return interaction.respond(found.slice(0, 25));
        }if(sub === 'move'){
          const focus = interaction.options.getFocused(true);
          const player = kazagumo.getPlayer(interaction.guild.id);
          if(focus.name == 'song'){
            if(!player || !player.queue?.all)return interaction.respond([]);
            const found: ApplicationCommandOptionChoiceData<number>[] = player.queue?.all
              .map((v,i)=>{return { name: `[${i}] ${v?.title || ''}`, value: i }})
              .filter(vt => !focus.value || vt.name.toLowerCase().includes(String(focus.value).toLowerCase()));
            return interaction.respond(found.slice(0, 25));
          }if(focus.name == 'position'){
            if(!player || !player.queue?.all)return interaction.respond([top]);
            const found: ApplicationCommandOptionChoiceData<number>[] = player.queue?.all
              .map((v,i)=>{return { name: `[${i}] ${v?.title || ''}`, value: i }})
              .filter(vt => !focus.value || vt.name.toLowerCase().includes(String(focus.value).toLowerCase()));
            if(!focus.value)found.unshift(top);
            if(found.length === 0)found.push(top);
            return interaction.respond(found.slice(0, 25));
          };
        };
      }catch(e: any){
        return;
      };
    };
  }
}

}catch(error){
  if(error instanceof DiscordAPIError){
    if(String(error.code).startsWith('10')){
        return;
    };
    return console.warn(chalk.red('[Camming AT]'), chalk.yellow(error));
  }else{
    // return console.error(error);
    return console.warn(chalk.red('[Camming AT]'), chalk.yellow(error));
  };
}
})();
}
}
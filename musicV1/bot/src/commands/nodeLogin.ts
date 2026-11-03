import chalk from 'chalk';
import { ButtonBuilder, ButtonInteraction, ButtonStyle, CacheType, ContainerBuilder, MessageFlags, PermissionFlagsBits, SeparatorSpacingSize } from 'discord.js';
import Env from '../utils/env.js';
import { musicNodes } from '../music/nodes.js';
import { LoginResult, startLogin } from '../music/login.js';

// Button "ytlogin:<NODE>" on sidecar alerts (sent by sidecar.mjs with this bot's token).
// Starts a Google device login for that node's burner account and applies the token when done.
export async function nodeLoginButton(interaction: ButtonInteraction<CacheType>) {
  const name = interaction.customId.slice('ytlogin:'.length);
  const admins = (Env('MUSIC_ADMIN_IDS') || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowed = admins.includes(interaction.user.id) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const ephemeral = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;
  if (!allowed) {
    return interaction.reply({ flags: ephemeral, components: [card(0xed4245, '🔒 ใช้ปุ่มนี้ไม่ได้', ['ต้องมีสิทธิ์ Manage Server หรืออยู่ใน `MUSIC_ADMIN_IDS`'])] });
  }
  const node = musicNodes().find(n => n.name === name);
  if (!node) {
    return interaction.reply({ flags: ephemeral, components: [card(0xed4245, `ไม่รู้จัก node ${name}`, ['ดู `MUSIC_NODES` ใน .env'])] });
  }

  // Defer as a plain ephemeral reply; the Components V2 flag goes on each edit.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const v2 = MessageFlags.IsComponentsV2;
  let start;
  try {
    start = await startLogin(node);
  } catch (e) {
    return interaction.editReply({ flags: v2, components: [card(0xed4245, 'สร้างรหัสไม่ได้', [(e as Error).message])] });
  }
  console.log(chalk.magentaBright.bold('[NodeLogin]'), `${interaction.user.tag} started login for ${node.name}`);
  const minutes = Math.round((start.expiresAt - Date.now()) / 60000);
  const steps = new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(t => t.setContent(`### 🔑 login บัญชี burner ให้ ${node.name}`))
    .addTextDisplayComponents(t => t.setContent([
      `1. เปิดลิงก์ด้านล่าง (login **บัญชี burner** ไว้ในเบราว์เซอร์ก่อน)`,
      `2. ใส่รหัส \`${start.userCode}\``,
      `3. กดอนุญาต แล้วรอที่นี่ ระบบจะใส่ token ให้ ${node.name} เอง`,
      '',
      `⚠️ **ห้ามใช้บัญชีหลัก** และใช้คนละบัญชีกับ node อื่น`,
      `-# รหัสหมดอายุในประมาณ ${minutes} นาที`,
    ].join('\n')))
    .addActionRowComponents(a => a.setComponents(
      // Link button: no interaction, just opens the page.
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('เปิดหน้า login ของ Google').setURL(start.url),
    ));
  try {
    await interaction.editReply({ flags: v2, components: [steps] });
  } catch (e) {
    // Never leave the user on "thinking…": show the code as plain text at least.
    console.error(chalk.magentaBright.bold('[NodeLogin]'), 'reply failed:', (e as Error).message, JSON.stringify((e as { rawError?: unknown }).rawError ?? '').slice(0, 500));
    await interaction.followUp({ flags: MessageFlags.Ephemeral, content: `login ${node.name}: เปิด ${start.url} แล้วใส่รหัส \`${start.userCode}\`` }).catch(() => {});
  }

  const result: LoginResult = await start.done;
  console.log(chalk.magentaBright.bold('[NodeLogin]'), `${node.name}: ${result.message}`);
  const done = card(result.ok ? 0x57f287 : 0xed4245, result.ok ? `🟢 ${result.message}` : '🔴 login ไม่สำเร็จ', result.ok ? [] : [result.message]);
  // The interaction token lives 15 minutes; a slow login falls back to a channel message.
  await interaction.editReply({ flags: v2, components: [done] }).catch(async () => {
    if (interaction.channel?.isSendable()) await interaction.channel.send({ flags: MessageFlags.IsComponentsV2, components: [done] }).catch(() => {});
  });
}

function card(color: number, title: string, lines: string[]) {
  const c = new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(t => t.setContent(`### ${title}`));
  if (lines.length) {
    c.addSeparatorComponents(s => s.setDivider(false).setSpacing(SeparatorSpacingSize.Small));
    c.addTextDisplayComponents(t => t.setContent(lines.join('\n')));
  }
  return c;
}

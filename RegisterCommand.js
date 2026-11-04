import dotenv from 'dotenv';
import { REST, Routes, SlashCommandBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import chalk from "chalk";
dotenv.config();

const musicC = [
    (new SlashCommandBuilder().setName('help')
        .setDescription('More information and description')
        .setDescriptionLocalization('th', 'ข้อมูลและคำอธิบายเพิ่มเติม')
        .setContexts([0])
    ),(new SlashCommandBuilder().setName('ping')
        .setDescription('Bot response time')
        .setDescriptionLocalization('th', 'เวลาตอบสนองของบอท')
        .setContexts([0])
    ),(new SlashCommandBuilder().setName('status')
        .setDescription('Server status')
        .setDescriptionLocalization('th', 'สถานะเซิร์ฟเวอร์')
    ),(new SlashCommandBuilder().setName('play')
        .setDescription('Play a song')
        .setDescriptionLocalization('th', 'เล่นเพลง')
        .setContexts([0])
        .addStringOption(o=>o.setName('search')
            .setDescription('The song link or name')
            .setDescriptionLocalization('th', 'ลิงก์หรือชื่อเพลง')
            .setAutocomplete(true)
            .setRequired(true)
        )
    ),(new SlashCommandBuilder().setName('pause')
        .setDescription('Pause the current song')
        .setDescriptionLocalization('th', 'หยุดเพลงชั่วคราว')
        .setContexts([0])
    ),(new SlashCommandBuilder().setName('skip')
        .setDescription('Skip to the next song')
        .setDescriptionLocalization('th', 'ข้ามไปเพลงถัดไป')
        .setContexts([0])
    ),(new SlashCommandBuilder().setName('stop')
        .setDescription('Stop the music and clear the queue')
        .setDescriptionLocalization('th', 'หยุดเพลงและล้างคิวทั้งหมด')
        .setContexts([0])
    ),(new SlashCommandBuilder().setName('resume')
        .setDescription('Continue playing the song')
        .setDescriptionLocalization('th', 'เล่นเพลงต่อ')
        .setContexts([0])
    ),(new SlashCommandBuilder().setName('volume')
        .setDescription('Adjust volume')
        .setDescriptionLocalization('th', 'ปรับระดับเสียง')
        .addNumberOption(o=>o.setName('volume')
            .setDescription('Sound level')
            .setDescriptionLocalization('th', 'ระดับเสียง')
            .setMinValue(0)
            .setMaxValue(200)
            .setRequired(false)
        )
        .setContexts([0])
    ),(new SlashCommandBuilder().setName('connect')
        .setDescription('Connect the bot to your voice channel')
        .setDescriptionLocalization('th', 'เชื่อมต่อบอทเข้าห้องเสียงของคุณ')
        .setContexts([0])
    ),(new SlashCommandBuilder().setName('loop')
        .setDescription('Set the loop mode')
        .setDescriptionLocalization('th', 'ตั้งค่าการเล่นซ้ำ')
        .setContexts([0])
        .addStringOption(o=>o.setName('mode')
            .setDescription('Loop mode')
            .setDescriptionLocalization('th', 'โหมดการเล่นซ้ำ')
            .setRequired(false)
            .addChoices(
                { name: 'off', value: 'none' },
                { name: 'queue', value: 'queue' },
                { name: 'track', value: 'track' }
            )
        )
    ),(new SlashCommandBuilder().setName('now')
        .setDescription('Show the currently playing song')
        .setDescriptionLocalization('th', 'แสดงเพลงที่กำลังเล่นอยู่')
        .setContexts([0])
    ),(new SlashCommandBuilder().setName('shuffle')
        .setDescription('Shuffle the queue')
        .setDescriptionLocalization('th', 'สลับลำดับเพลงในคิวแบบสุ่ม')
        .setContexts([0])
    ),(new SlashCommandBuilder().setName('seek')
        .setDescription('Seek to a specific time in the song')
        .setDescriptionLocalization('th', 'ข้ามไปยังช่วงเวลาที่ต้องการของเพลง')
        .setContexts([0])
        .addStringOption(o=>o.setName('timestamp')
            .setDescription('HH:MM:SS, MM:SS or seconds')
            .setDescriptionLocalization('th', 'รูปแบบเวลา เช่น HH:MM:SS, MM:SS หรือ วินาที')
            .setRequired(true)
        )
    ),(new SlashCommandBuilder().setName('queue')
        .setDescription('Manage the song queue')
        .setDescriptionLocalization('th', 'จัดการคิวเพลง')
        .setContexts([0])
        .addSubcommand(s=>s.setName('clear')
            .setDescription('Clear all songs in the queue')
            .setDescriptionLocalization('th', 'ล้างเพลงทั้งหมดในคิว')
        ).addSubcommand(s=>s.setName('add')
            .setDescription('Add a song to the queue')
            .setDescriptionLocalization('th', 'เพิ่มเพลงเข้าในคิว')
            .addStringOption(o=>o.setName('search')
                .setDescription('The song link or name')
                .setDescriptionLocalization('th', 'ลิงก์หรือชื่อเพลง')
                .setAutocomplete(true)
                .setRequired(true)
            ).addNumberOption(o=>o.setName('position')
                .setNameLocalization('th', 'ตำแหน่ง')
                .setDescription('The song will be added after this song')
                .setDescriptionLocalization('th', 'เพลงจะถูกเพิ่มหลังเพลงนี้')
                .setAutocomplete(true)
                .setRequired(false)
            )
        ).addSubcommand(s=>s.setName('remove')
            .setDescription('Remove a song from the queue')
            .setDescriptionLocalization('th', 'ลบเพลงออกจากคิว')
            .addNumberOption(o=>o.setName('song')
                .setNameLocalization('th', 'เพลง')
                .setDescription('The song index or name')
                .setDescriptionLocalization('th', 'ค้นหาด้วย index หรือ ชื่อเพลง')
                .setAutocomplete(true)
                .setRequired(true)
            )
        ).addSubcommand(s=>s.setName('move')
            .setDescription('Move a song to a new position in the queue')
            .setDescriptionLocalization('th', 'ย้ายตำแหน่งเพลงในคิว')
            .addNumberOption(o=>o.setName('song')
                .setNameLocalization('th', 'เพลง')
                .setDescription('The song index to move')
                .setDescriptionLocalization('th', 'ค้นหาด้วย index หรือ ชื่อเพลง')
                .setAutocomplete(true)
                .setRequired(true)
            )
            .addNumberOption(o=>o.setName('position')
                .setNameLocalization('th', 'ตำแหน่ง')
                .setDescription('The new position index')
                .setDescriptionLocalization('th', 'ตำแหน่งใหม่ในคิว')
                .setAutocomplete(true)
                .setRequired(true)
            )
        ).addSubcommand(s=>s.setName('list')
            .setDescription('Show all queue lists')
            .setDescriptionLocalization('th', 'แสดงคิวทั้งหมด')
        )
    ),(new SlashCommandBuilder().setName('247')
        .setDescription('Show or set 24/7 mode')
        .setDescriptionLocalization('th', 'ดูหรือตั้งค่าโหมด 24/7')
        .setContexts([0])
        .addBooleanOption(o=>o.setName('enable')
            .setDescription('On or off. Leave empty to see the current state')
            .setDescriptionLocalization('th', 'เปิดหรือปิด ไม่ใส่เพื่อดูสถานะปัจจุบัน')
            .setRequired(false)
        )
    )
];

const commands = [
    (new SlashCommandBuilder().setName('prefix')
        .setDescription('Get or set the command prefix.')
        .setDescriptionLocalization('th', 'เช็คหรือตั้งค่าcommand prefix')
        .addStringOption(option => {
            return option
            .setName('prefix')
            .setDescription('Set the command prefix. example: !')
            .setDescriptionLocalization('th', 'ตั้งค่าcommand prefix (ตัวอย่าง: !)')
            .setMaxLength(1)
            .setMinLength(1)
            .setRequired(false)
        })
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('ping')
        .setDescription('Pong! See the latency of the bot.')
        .setDescriptionLocalization('th', 'Pong! ดูเวลาแฝงของบอท')
    ),
    (new SlashCommandBuilder().setName('help')
        .setDescription('Bot info & Commands.')
        .setDescriptionLocalization('th', 'ข้อมูลบอทและรายการคำสั่ง')
    ),
    (new SlashCommandBuilder().setName('ban')
        .setDescription('Ban user')
        .setDescriptionLocalization('th', 'แบนสมาชิก')
        .addUserOption(option => {
            return option
            .setName('user')
            .setDescription('Search and choose users or enter the ID user that you want to ban.')
            .setDescriptionLocalization('th', 'ค้นหาและเลือกผู้ใช้หรือป้อนIDผู้ใช้ที่คุณต้องการแบน')
            .setRequired(true)
        })
        .addStringOption(option => {
            return option
            .setName('reason')
            .setDescription('The reason for banning')
            .setDescriptionLocalization('th', 'เหตุผลในการแบน')
        })
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('unban')
        .setDescription('Unban user')
        .setDescriptionLocalization('th', 'ปลดแบนสมาชิก')
        .addUserOption(option => {
            return option
            .setName('user')
            .setDescription('Search and choose users or enter the ID user that you want to unban.')
            .setDescriptionLocalization('th', 'ค้นหาและเลือกผู้ใช้หรือป้อนIDผู้ใช้ที่คุณต้องการปลดแบน')
            .setRequired(true)
        })
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('banlist')
        .setDescription('Show a list of banned users')
        .setDescriptionLocalization('th', 'แสดงรายการผู้ใช้ที่ถูกแบน')
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('kick')
        .setDescription('Kick user')
        .setDescriptionLocalization('th', 'เตะสมาชิก')
        .addUserOption(option => {
            return option
            .setName('user')
            .setDescription('Search and choose users or enter the ID user that you want to kick.')
            .setDescriptionLocalization('th', 'ค้นหาและเลือกผู้ใช้หรือป้อนIDผู้ใช้ที่คุณต้องการเตะ')
            .setRequired(true)
        })
        .addStringOption(option => {
            return option
            .setName('reason')
            .setDescription('The reason for kicking')
            .setDescriptionLocalization('th', 'เหตุผลในการเตะ')
        })
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('avatar')
        .setDescription('View user avatar image')
        .setDescriptionLocalization('th', 'ดูภาพโปรไฟล์ของผู้ใช้')
        .addUserOption(option => {
            return option
            .setName('user')
            .setDescription('The user to get avatar for.')
            .setDescriptionLocalization('th', 'ผู้ใช้ที่จะได้รับโปรไฟล์')
            .setRequired(false)
        })
    ),
    (new SlashCommandBuilder().setName('banner')
        .setDescription('View user banner image')
        .setDescriptionLocalization('th', 'ดูภาพแบนเนอร์ของผู้ใช้')
        .addUserOption(option => {
            return option
            .setName('user')
            .setDescription('The user to get banner for.')
            .setDescriptionLocalization('th', 'ผู้ใช้ที่จะได้รับแบนเนอร์')
            .setRequired(false)
        })
    ),
    (new SlashCommandBuilder().setName('send')
        .setDescription('Send a message or embed it in a specified channel.')
        .setDescriptionLocalization('th', 'ส่งข้อความหรือEmbedไปที่ช่องที่กำหนด')
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('clear')
        .setDescription('Delete message')
        .setDescriptionLocalization('th', 'ลบข้อความ')
        .addIntegerOption(option =>
            option
                .setName('number')
                .setDescription('Number of messages to delete')
                .setDescriptionLocalization('th', 'จำนวนข้อความที่จะลบ')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)
        )
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('Delete user messages')
                .setDescriptionLocalization('th', 'ลบข้อความของผู้ใช้')
                .setRequired(false)
        )
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('audit_log')
        .setDescription('Set channels for sending audit logs.')
        .setDescriptionLocalization('th', 'ตั้งค่าช่องสำหรับส่งบันทึกการตรวจสอบ')
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('role')
        .setDescription('Set roles on the server')
        .setDescriptionLocalization('th', 'ตั้งค่าบทบาทในเซิร์ฟเวอร์')
        .addSubcommand(sub => sub.setName('add')
            .setDescription('Add roles to users')
            .setDescriptionLocalization('th', 'เพิ่มบทบาทให้ผู้ใช้')
            .addUserOption(option => option
                .setName('user')
                .setNameLocalization('th', 'ผู้ใช้')
                .setDescription('Users who want to add roles')
                .setDescriptionLocalization('th', 'ผู้ใช้ที่ต้องการเพิ่มบทบาท')
                .setRequired(true)
            )
            .addRoleOption(option => option
                .setName('role')
                .setNameLocalization('th', 'บทบาท')
                .setDescription('Roles to add to users')
                .setDescriptionLocalization('th', 'บทบาทที่ต้องการเพิ่มให้ผู้ใช้')
                .setRequired(true)
            )
        )
        .addSubcommand(sub => sub.setName('remove')
            .setDescription('Remove roles from users')
            .setDescriptionLocalization('th', 'ลบบทบาทออกจากผู้ใช้')
            .addUserOption(option => option
                .setName('user')
                .setNameLocalization('th', 'ผู้ใช้')
                .setDescription('Users who want to remove roles')
                .setDescriptionLocalization('th', 'ผู้ใช้ที่ต้องการลบบทบาท')
                .setRequired(true)
            )
            .addRoleOption(option => option
                .setName('role')
                .setNameLocalization('th', 'บทบาท')
                .setDescription('Roles to add to users')
                .setDescriptionLocalization('th', 'บทบาทที่ต้องการลบออกจากผู้ใช้')
                .setRequired(true)
            )
        )
        .addSubcommand(sub => sub.setName('multiple')
            .setDescription('Add/remove roles from multiple users')
            .setDescriptionLocalization('th', 'เพิ่ม/ลบ บทบาทจากผู้ใช้หลายราย')
            .addStringOption(option => option
                .setName('add_or_remove')
                .setNameLocalization('th', 'เพิ่มหรือลบ')
                .setDescription('Add or remove roles')
                .setDescriptionLocalization('th', 'เพิ่มหรือลบบทบาท')
                .addChoices(
                    { name: 'add', name_localizations: {th: 'เพิ่ม'}, value: 'add' },
                    { name: 'remove', name_localizations: {th: 'ลบ'}, value: 'remove' }
                )
                .setRequired(true)
            )
            .addRoleOption(option => option
                .setName('role')
                .setNameLocalization('th', 'บทบาท')
                .setDescription('Roles to add/remove from users')
                .setDescriptionLocalization('th', 'บทบาทที่ต้องการเพิ่ม/ลบออกจากผู้ใช้')
                .setRequired(true)
            )
            .addStringOption(option => option
                .setName('pick_type')
                .setNameLocalization('th', 'เลือกประเภท')
                .setDescription('Pick type')
                .setDescriptionLocalization('th', 'เลือกประเภท')
                .addChoices(
                    { name: 'all', name_localizations: {th: 'ทั้งหมด'}, value: 'all' },
                    { name: 'humans', name_localizations: {th: 'ผู้ใช้ทั้งหมด'}, value: 'humans' },
                    { name: 'bots', name_localizations: {th: 'บอททั้งหมด'}, value: 'bots' },
                    { name: 'all that a role', name_localizations: {th: 'ทั้งหมดที่มีบทบาท'}, value: 'all_that_a_role' }
                )
                .setRequired(true)
            )
            .addRoleOption(option => option
                .setName('all_that_a_role')
                .setNameLocalization('th', 'ทั้งหมดที่มีบทบาท')
                .setDescription('Add/Remove roles from all that have the specified roles (For type *all that a role* only).')
                .setDescriptionLocalization('th', 'เพิ่ม/ลบ บทบาทจากทั้งหมดที่มีบทบาทที่กำหนด (สำหรับประเภท *ทั้งหมดที่มีบทบาท* เท่านั้น)')
                .setRequired(false)
            )
        )
        // .addSubcommand(sub => sub.setName('create')
        //     .setDescription('Create a role')
        //     .setDescriptionLocalization('th', 'สร้างบทบาท')
        //     .addStringOption(option => option
        //         .setName('name').setNameLocalization('th', 'ชื่อ')
        //         .setDescription('Role Name').setDescriptionLocalization('th', 'ชื่อบทบาท')
        //         .setRequired(true)
        //     )
        //     .addStringOption(option => option
        //         .setName('color').setNameLocalization('th', 'สี')
        //         .setDescription('Role Color (#ffffff | Default | Green)').setDescriptionLocalization('th', 'สีบทบาท (#ffffff | Default | Green)')
        //         .setRequired(false)
        //     )
        // )
        // .addSubcommand(sub => sub.setName('delete')
        //     .setDescription('Delete a role')
        //     .setDescriptionLocalization('th', 'ลบบทบาท')
        //     .addRoleOption(option => option
        //         .setName('role').setNameLocalization('th', 'บทบาท')
        //         .setDescription('Select the role to delete').setDescriptionLocalization('th', 'เลือกบทบาทที่จะลบ')
        //         .setRequired(true)
        //     )
        // )
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('user')
        .setDescription('Manage users on the server')
        .setDescriptionLocalization('th', 'จัดการผู้ใช้บนเซิร์ฟเวอร์')
        .addUserOption(option => {
            return option
            .setName('user')
            .setDescription('Select a user')
            .setDescriptionLocalization('th', 'เลือกผู้ใช้')
            .setRequired(false)
        })
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('timeout')
        .setDescription('Timeout a user from sending messages or joining voice channels')
        .setDescriptionLocalization('th', 'หมดเวลาผู้ใช้จากการส่งข้อความหรือเข้าร่วมช่องเสียง')
        .addUserOption(option => {
            return option
            .setName('user')
            .setDescription('Select a user')
            .setDescriptionLocalization('th', 'เลือกผู้ใช้')
            .setRequired(true)
        })
        .addNumberOption(option => {
            return option
            .setName('duration')
            .setDescription('The duration of timeout')
            .setDescriptionLocalization('th', 'ระยะเวลาของการหมดเวลา')
            .addChoices(
                { name: '1 minute', name_localizations: { th: '1 นาที' }, value: 1 * 60 * 1000 },
                { name: '2 minutes', name_localizations: { th: '2 นาที' }, value: 2 * 60 * 1000 },
                { name: '5 minutes', name_localizations: { th: '5 นาที' }, value: 5 * 60 * 1000 },
                { name: '10 minutes', name_localizations: { th: '10 นาที' }, value: 10 * 60 * 1000 },
                { name: '15 minutes', name_localizations: { th: '15 นาที' }, value: 15 * 60 * 1000 },
                { name: '30 minutes', name_localizations: { th: '30 นาที' }, value: 30 * 60 * 1000 },
                { name: '1 hour', name_localizations: { th: '1 ชั่วโมง' }, value: 1 * 60 * 60 * 1000 },
                { name: '2 hours', name_localizations: { th: '2 ชั่วโมง' }, value: 2 * 60 * 60 * 1000 },
                { name: '3 hours', name_localizations: { th: '3 ชั่วโมง' }, value: 3 * 60 * 60 * 1000 },
                { name: '6 hours', name_localizations: { th: '6 ชั่วโมง' }, value: 6 * 60 * 60 * 1000 },
                { name: '12 hours', name_localizations: { th: '12 ชั่วโมง' }, value: 12 * 60 * 60 * 1000 },
                { name: '1 day', name_localizations: { th: '1 วัน' }, value: 1 * 24 * 60 * 60 * 1000 },
                { name: '2 days', name_localizations: { th: '2 วัน' }, value: 2 * 24 * 60 * 60 * 1000 },
                { name: '3 days', name_localizations: { th: '3 วัน' }, value: 3 * 24 * 60 * 60 * 1000 },
                { name: '5 days', name_localizations: { th: '5 วัน' }, value: 5 * 24 * 60 * 60 * 1000 },
                { name: '1 week', name_localizations: { th: '1 อาทิตย์' }, value: 7 * 24 * 60 * 60 * 1000 },
                { name: '2 weeks', name_localizations: { th: '2 อาทิตย์' }, value: 14 * 24 * 60 * 60 * 1000 },
                { name: '3 weeks', name_localizations: { th: '3 อาทิตย์' }, value: 21 * 24 * 60 * 60 * 1000 },
                { name: '4 weeks', name_localizations: { th: '4 อาทิตย์' }, value: 28 * 24 * 60 * 60 * 1000 },
            )
            .setRequired(true)
        })
        .addStringOption(option => {
            return option
            .setName('reason')
            .setDescription('The reason of timeout')
            .setDescriptionLocalization('th', 'เหตุผลที่ต้องหมดเวลา')
        })
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('untimeout')
        .setDescription('Remove timeout from a user')
        .setDescriptionLocalization('th', 'ลบการหมดเวลาออกจากผู้ใช้')
        .addUserOption(option => {
            return option
            .setName('user')
            .setDescription('Select a user')
            .setDescriptionLocalization('th', 'เลือกผู้ใช้')
            .setRequired(true)
        })
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('welcome')
        .setDescription('Set up a welcome message for new members')
        .setDescriptionLocalization('th', 'ตั้งค่าการส่งข้อความต้อนรับสมาชิกใหม่')
        .setContexts([0])
    ),
    (new SlashCommandBuilder().setName('goodbye')
        .setDescription('Set up a goodbye message for members who leave')
        .setDescriptionLocalization('th', 'ตั้งค่าการส่งข้อความอำลาสมาชิกที่ออกจากเซิร์ฟเวอร์')
        .setContexts([0])
    ),
	(new SlashCommandBuilder().setName('music')
		.setDescription('Music controls and playback commands')
		.setContexts([0])
		.addSubcommand(s=>s.setName('help')
            .setDescription('More information and description')
            .setDescriptionLocalization('th', 'ข้อมูลและคำอธิบายเพิ่มเติม')
        ).addSubcommand(s=>s.setName('ping')
            .setDescription('Bot response time')
            .setDescriptionLocalization('th', 'เวลาตอบสนองของบอท')
        ).addSubcommand(s=>s.setName('status')
            .setDescription('Server status')
            .setDescriptionLocalization('th', 'สถานะเซิร์ฟเวอร์')
        ).addSubcommand(s=>s.setName('play')
            .setDescription('Play a song')
            .setDescriptionLocalization('th', 'เล่นเพลง')
            .addStringOption(o=>o.setName('search')
                .setDescription('The song link or name')
                .setDescriptionLocalization('th', 'ลิงก์หรือชื่อเพลง')
                .setAutocomplete(true)
                .setRequired(true)
            )
        ).addSubcommand(s=>s.setName('pause')
            .setDescription('Pause the current song')
            .setDescriptionLocalization('th', 'หยุดเพลงชั่วคราว')
        ).addSubcommand(s=>s.setName('skip')
            .setDescription('Skip to the next song')
            .setDescriptionLocalization('th', 'ข้ามไปเพลงถัดไป')
        ).addSubcommand(s=>s.setName('stop')
            .setDescription('Stop the music and clear the queue')
            .setDescriptionLocalization('th', 'หยุดเพลงและล้างคิวทั้งหมด')
        ).addSubcommand(s=>s.setName('resume')
            .setDescription('Continue playing the song')
            .setDescriptionLocalization('th', 'เล่นเพลงต่อ')
        ).addSubcommand(s=>s.setName('volume')
            .setDescription('Adjust volume')
            .setDescriptionLocalization('th', 'ปรับระดับเสียง')
            .addNumberOption(o=>o.setName('volume')
                .setDescription('Sound level')
                .setDescriptionLocalization('th', 'ระดับเสียง')
                .setMinValue(0)
                .setMaxValue(200)
                .setRequired(false)
            )
        ).addSubcommand(s=>s.setName('connect')
            .setDescription('Connect the bot to your voice channel')
            .setDescriptionLocalization('th', 'เชื่อมต่อบอทเข้าห้องเสียงของคุณ')
        ).addSubcommand(s=>s.setName('loop')
            .setDescription('Set the loop mode')
            .setDescriptionLocalization('th', 'ตั้งค่าการเล่นซ้ำ')
            .addStringOption(o=>o.setName('mode')
                .setDescription('Loop mode')
                .setDescriptionLocalization('th', 'โหมดการเล่นซ้ำ')
                .setRequired(false)
                .addChoices(
                    { name: 'off', value: 'none' },
                    { name: 'queue', value: 'queue' },
                    { name: 'track', value: 'track' }
                )
            )
        ).addSubcommand(s=>s.setName('now')
            .setDescription('Show the currently playing song')
            .setDescriptionLocalization('th', 'แสดงเพลงที่กำลังเล่นอยู่')
        ).addSubcommand(s=>s.setName('shuffle')
            .setDescription('Shuffle the queue')
            .setDescriptionLocalization('th', 'สลับลำดับเพลงในคิวแบบสุ่ม')
        ).addSubcommand(s=>s.setName('seek')
            .setDescription('Seek to a specific time in the song')
            .setDescriptionLocalization('th', 'ข้ามไปยังช่วงเวลาที่ต้องการของเพลง')
            .addStringOption(o=>o.setName('timestamp')
                .setDescription('HH:MM:SS, MM:SS or seconds')
                .setDescriptionLocalization('th', 'รูปแบบเวลา เช่น ชม:น:ว, น:ว หรือ วินาที')
                .setRequired(true)
            )
        ).addSubcommandGroup(s=>s.setName('queue')
            .setDescription('Manage the song queue')
            .setDescriptionLocalization('th', 'จัดการคิวเพลง')
            .addSubcommand(s=>s.setName('clear')
                .setDescription('Clear all songs in the queue')
                .setDescriptionLocalization('th', 'ล้างเพลงทั้งหมดในคิว')
            ).addSubcommand(s=>s.setName('add')
                .setDescription('Add a song to the queue')
                .setDescriptionLocalization('th', 'เพิ่มเพลงเข้าในคิว')
                .addStringOption(o=>o.setName('search')
                    .setDescription('The song link or name')
                    .setDescriptionLocalization('th', 'ลิงก์หรือชื่อเพลง')
                    .setAutocomplete(true)
                    .setRequired(true)
                ).addNumberOption(o=>o.setName('position')
                    .setNameLocalization('th', 'ตำแหน่ง')
                    .setDescription('The song will be added after this song')
                    .setDescriptionLocalization('th', 'เพลงจะถูกเพิ่มหลังเพลงนี้')
                    .setAutocomplete(true)
                    .setRequired(false)
                )
            ).addSubcommand(s=>s.setName('remove')
                .setDescription('Remove a song from the queue')
                .setDescriptionLocalization('th', 'ลบเพลงออกจากคิว')
                .addNumberOption(o=>o.setName('song')
                    .setNameLocalization('th', 'เพลง')
                    .setDescription('The song index or name')
                    .setDescriptionLocalization('th', 'ค้นหาด้วย index หรือ ชื่อเพลง')
                    .setAutocomplete(true)
                    .setRequired(true)
                )
            ).addSubcommand(s=>s.setName('move')
                .setDescription('Move a song to a new position in the queue')
                .setDescriptionLocalization('th', 'ย้ายตำแหน่งเพลงในคิว')
                .addNumberOption(o=>o.setName('song')
                    .setNameLocalization('th', 'เพลง')
                    .setDescription('The song index to move')
                    .setDescriptionLocalization('th', 'ค้นหาด้วย index หรือ ชื่อเพลง')
                    .setAutocomplete(true)
                    .setRequired(true)
                )
                .addNumberOption(o=>o.setName('position')
                    .setNameLocalization('th', 'ตำแหน่ง')
                    .setDescription('The new position index')
                    .setDescriptionLocalization('th', 'ตำแหน่งใหม่ในคิว')
                    .setAutocomplete(true)
                    .setRequired(true)
                )
            ).addSubcommand(s=>s.setName('list')
                .setDescription('Show all queue lists')
                .setDescriptionLocalization('th', 'แสดงคิวทั้งหมด')
            )
        ).addSubcommand(s=>s.setName('247')
            .setDescription('Show or set 24/7 mode')
            .setDescriptionLocalization('th', 'ดูหรือตั้งค่าโหมด 24/7')
            .addBooleanOption(o=>o.setName('enable')
                .setDescription('On or off. Leave empty to see the current state')
                .setDescriptionLocalization('th', 'เปิดหรือปิด ไม่ใส่เพื่อดูสถานะปัจจุบัน')
                .setRequired(false)
            )
        )
	),
];
const dev = [
	(new SlashCommandBuilder().setName('bot')
			.setDescription('ตั้งค่าบอท')
			.addSubcommand(s=>s.setName('status')
					.setDescription('ตั้งค่าสถานะบอท')
					.addStringOption(o=>o.setName('status')
							.setDescription('สถานะ')
							.setChoices(
									{ name: 'online', value: 'online' },
									{ name: 'idle', value: 'idle' },
									{ name: 'dnd', value: 'dnd' },
									{ name: 'invisible', value: 'invisible' } 
							)
							.setRequired(true)
					)
			)
			.addSubcommand(s=>s.setName('activity')
					.setDescription('ตั้งค่ากิจกรรมบอท')
					.addStringOption(o=>o.setName('name')
							.setDescription('ชื่อกิจกรรม')
							.setRequired(false)
					)
					.addNumberOption(o=>o.setName('type')
							.setDescription('ประเภทกิจกรรม')
							.setChoices(
									{ name: 'Playing', value: 0 },
									{ name: 'Streaming', value: 1 },
									{ name: 'Listening', value: 2 },
									{ name: 'Watching', value: 3 },
									{ name: 'Custom', value: 4 },
									{ name: 'Competing', value: 5 }
							)
							.setRequired(false)
					)
			)
			.setContexts([0])
			.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
	),
	(new SlashCommandBuilder().setName('test1')
			.setDescription('test1')
	),
	// ...musicC


];
const music_commands = [

];
const music_dev = [
	// (new SlashCommandBuilder().setName('music')
	// 	.setDescription('music command')
	// 	.setContexts([0])
	// 	.addSubcommand(s=>s.setName('play')
	// 		.setDescription('play')
	// 		.addStringOption(o=>o.setName('search')
	// 			.setDescription('The song link or name')
	// 			.setAutocomplete(true)
	// 			.setRequired(true)
	// 		)
	// 	)
	// ),
	...musicC


];
( async () => {
    try {
        const rest = new REST().setToken(process.env.BOT_TOKEN);
        console.log(chalk.yellow(' - Registering SlashCommands...'))
        await rest.put( Routes.applicationCommands(process.env.BOT_CLIENT_ID), { body: commands } );
        console.log(chalk.green(' - SlashCommands registered successfully!'))

        
        console.log(chalk.yellow(' - Registering SlashCommands2...'))
        await rest.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID, '1018508978445099098'), { body: dev } );
        await rest.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID, '1136970225452068864'), { body: dev } );
        await rest.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID, '1399407575212097597'), { body: dev } );
        await rest.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID, '1399407826627199028'), { body: dev } );
        console.log(chalk.green(' - SlashCommands2 registered successfully!'))
    } catch (error) {
        console.error(chalk.red(` - Register error : ${error}`))
    }

    console.log(chalk.yellow(' ------------------ '))

    const rest2 = new REST().setToken(process.env.BOT_TOKEN_DEV);
    try {
        console.log(chalk.yellow(' - Registering2 SlashCommands...'))
        await rest2.put( Routes.applicationCommands(process.env.BOT_CLIENT_ID_DEV), { body: commands } );
        console.log(chalk.green(' - SlashCommands registered2 successfully!'))
    
        
        console.log(chalk.yellow(' - Registering2 SlashCommands2...'))
        await rest2.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID_DEV, '1018508978445099098'), { body: dev } );
        await rest2.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID_DEV, '1136970225452068864'), { body: dev } );
        await rest2.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID_DEV, '1399407575212097597'), { body: dev } );
        await rest2.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID_DEV, '1399407826627199028'), { body: dev } );
        console.log(chalk.green(' - SlashCommands2 registered2 successfully!'))
    } catch (error) {
        console.error(chalk.red(` - Register2 error : ${error}`))
    }

    console.log(chalk.yellow(' ------------------ '))

    const rest3 = new REST().setToken(process.env.BOT_TOKEN_M);
    try {
        console.log(chalk.yellow(' - Registering3 SlashCommands...'))
        await rest3.put( Routes.applicationCommands(process.env.BOT_CLIENT_ID_M), { body: music_commands } );
        console.log(chalk.green(' - SlashCommands registered2 successfully!'))
    
        
        console.log(chalk.yellow(' - Registering3 SlashCommands2...'))
        await rest3.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID_M, '1018508978445099098'), { body: music_dev } );
        await rest3.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID_M, '1136970225452068864'), { body: music_dev } );
        await rest3.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID_M, '1399407575212097597'), { body: music_dev } );
        await rest3.put( Routes.applicationGuildCommands(process.env.BOT_CLIENT_ID_M, '1399407826627199028'), { body: music_dev } );
        console.log(chalk.green(' - SlashCommands3 registered2 successfully!'))
    } catch (error) {
        console.error(chalk.red(` - Register3 error : ${error}`))
    }
})();
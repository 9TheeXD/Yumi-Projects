import chalk from 'chalk';
import { Client } from 'discord.js';
import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session'; // Import session
import { Kazagumo, KazagumoPlayer, KazagumoTrack } from 'kazagumo';
import { getUserChannelId } from './playerServer.js';
import { isDev, isM } from './utils/env.js';
import { musicSearch } from './music/resolver.js';
import { breakerStatus } from './music/breaker.js';

// Extend Session Data Type (Optional but good for TS)
declare module 'express-session' {
    interface SessionData {
        authenticated: boolean;
    }
}

export class APIServer {
    private app: express.Express;
    private kazagumo: Kazagumo;
    private client: Client; 
    private port: number;

    // Config: ตั้งรหัสผ่านและ Secret Key ตรงนี้ (ควรย้ายไป .env ใน Production)
    private readonly API_PASSWORD = process.env.API_PASSWORD; 
    private readonly SESSION_SECRET = process.env.SESSION_SECRET || '';

    // Variables for calculating Process CPU usage
    private lastCpuUsage: NodeJS.CpuUsage | null = null;
    private lastCpuTime: number | null = null;

    constructor(kazagumo: Kazagumo, client: Client, port: number = 3009) {
        this.kazagumo = kazagumo;
        this.client = client;
        this.port = port;
        this.app = express();

        this.initializeMiddleware();
        this.initializeRoutes();
        this.start();
    }

    private initializeMiddleware(): void {
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));

        // --- เพิ่ม Session Middleware ---
        this.app.use(session({
            secret: this.SESSION_SECRET,
            resave: false,
            saveUninitialized: false,
            cookie: { 
                maxAge: 24 * 60 * 60 * 1000, // 1 วัน
                httpOnly: true, // ป้องกัน JavaScript เข้าถึง Cookie (ป้องกัน XSS)
                secure: false   // ถ้าใช้ HTTPS ให้แก้เป็น true
            }
        }));
    }

    // --- Middleware: ตรวจสอบว่า Login หรือยัง ---
    private requireAuth = (req: Request, res: Response, next: NextFunction) => {
        if (req.session && req.session.authenticated) {
            return next();
        }

        const authHeader = req.headers.authorization;

        if (authHeader && authHeader.startsWith('Basic ')) {
            const base64 = authHeader.split(' ')[1];
            const [username, password] = Buffer.from(base64, 'base64')
                .toString()
                .split(':');

            if (
                username === process.env.API_USERNAME &&
                password === process.env.API_PASSWORD
            ) {
                return next();
            }
        }

        // ถ้าเป็นการเรียก API ให้ตอบ 401 Unauthorized
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // ถ้าเข้าหน้าเว็บปกติ ให้เด้งไปหน้า Login
        res.redirect('/login');
    };

    private initializeRoutes(): void {
        // --- Public Routes (เข้าได้ไม่ต้อง Login) ---
        this.app.get('/login', this.handleLoginPage.bind(this));
        this.app.post('/login', this.handleLoginAction.bind(this));
        this.app.get('/logout', this.handleLogout.bind(this));
        this.app.post('/api/player/search', this.handlePlayerSearch.bind(this));

        // --- Protected Routes (ต้อง Login) ---
        // ใช้ requireAuth คั่นไว้ก่อนเข้าฟังก์ชันจริง
        this.app.get('/', this.requireAuth, this.handleDashboard.bind(this));
        this.app.get('/api/data', this.requireAuth, this.handleData.bind(this));
        this.app.post('/api/control', this.requireAuth, this.handleControl.bind(this));
        this.app.get('/api/userChannelId/:userId', this.requireAuth, this.userChannelId.bind(this));
        this.app.get('/api/:guildId/:channelId/data', this.requireAuth, this.playerData.bind(this));
        this.app.get('/api/:guildId/:channelId/hasPlayer', this.requireAuth, this.hasPlayer.bind(this));
        this.app.post('/api/:guildId/:channelId/control', this.requireAuth, this.playerControl.bind(this));
    }

    private start(): void {
        this.app.listen(this.port, () => {
            console.log(`${chalk.bold.redBright('[APIServer]')} Dashboard running on port ${this.port}`);
        });
    }

    // --- Login Handlers ---
    private handleLoginPage(req: Request, res: Response): void {
        if (req.session.authenticated) {
            return res.redirect('/');
        }
        res.send(this.getLoginHtmlTemplate());
    }

    private handleLoginAction(req: Request, res: Response): void {
        const { password } = req.body;
        if (password === this.API_PASSWORD) {
            req.session.authenticated = true;
            return res.redirect('/');
        }
        // กรณีรหัสผิด ส่งกลับไปหน้า Login พร้อม query error
        res.redirect('/login?error=1');
    }

    private handleLogout(req: Request, res: Response): void {
        req.session.destroy(() => {
            res.redirect('/login');
        });
    }

    private async handlePlayerSearch(req: Request, res: Response): Promise<void> {
        const { q, limit } = req.body || {};
        if (!q) {
            res.status(400).json({ message: 'Missing query' });
            return;
        }
        console.log(q);

        try {
            const result = await musicSearch(this.kazagumo, q);
            res.json({
                ...result,
                tracks: result?.tracks?.slice(0, Number(limit) || 20)
            });
        } catch (error) {
            console.error("Lavalink Search Error:", error);
            res.status(500).json({ message: "ไม่สามารถค้นหาเพลงได้ในขณะนี้ กรุณาลองใหม่" });
        }
    }

    // --- Existing Handlers ---

    private handleDashboard(req: Request, res: Response): void {
        const html = this.getHtmlTemplate();
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    }

    private async handleData(req: Request, res: Response): Promise<void> {
        // ... (Logic เดิม ไม่เปลี่ยนแปลง) ...
        const memUsage = process.memoryUsage();
        const memUsageMB = (memUsage.rss / 1024 / 1024).toFixed(2);
        
        const currentCpuUsage = process.cpuUsage();
        const currentTime = Date.now();
        let cpuPercent = '0.00';

        if (this.lastCpuUsage && this.lastCpuTime) {
            const elapsedMS = currentTime - this.lastCpuTime;
            if (elapsedMS > 0) {
                const userDiff = currentCpuUsage.user - this.lastCpuUsage.user;
                const sysDiff = currentCpuUsage.system - this.lastCpuUsage.system;
                const totalDiffMicros = userDiff + sysDiff;
                const percent = ((totalDiffMicros / 1000) / elapsedMS) * 100;
                cpuPercent = percent.toFixed(2);
            }
        }
        this.lastCpuUsage = currentCpuUsage;
        this.lastCpuTime = currentTime;

        const nodes = [];
        for (const list of this.kazagumo.nodes) {
            const node = Array.from(this.kazagumo.shoukaku.nodes.values()).find(n=>n.name == list.name);
            nodes.push({
                name: list.name,
                state: node?.state || 5,
                ram: (node?.stats?.memory?.used ? (node.stats.memory.used / 1024 / 1024).toFixed(0) : '0'),
                cpu: (node?.stats?.cpu?.systemLoad ? (node.stats.cpu.systemLoad * 100).toFixed(2) : '0'),
                uptime: node?.stats?.uptime || 0,
                penalty: node?.penalties || 0
            });
        }

        const players = [];
        for (const player of this.kazagumo.players.values()) {
            let guildName = player.guildId;
            if (this.client.guilds?.cache) {
                const guild = this.client.guilds.cache.get(player.guildId);
                if (guild) guildName = guild.name;
            } else {
                 const guild = await this.client.guilds.fetch(player.guildId);
                 if (guild) guildName = guild.name;
            }

            players.push({
                guildId: player.guildId,
                guildName: guildName,
                trackTitle: player.queue.current ? player.queue.current.title : null,
                paused: player.paused,
                isPlaying: player.playing && !player.paused
            });
        }

        res.json({
            system: { ram: memUsageMB, cpu: cpuPercent },
            nodes,
            players,
            music: breakerStatus()
        });
    }

    private handleControl(req: Request, res: Response): void {
        const { guildId, action } = req.body;
        const player = this.kazagumo.players.get(guildId);

        if (!player) {
            res.status(404).json({ error: 'Player not found' });
            return;
        }

        try {
            switch (action) {
                case 'pause': player.pause(true); break;
                case 'resume': player.pause(false); break;
                case 'skip': player.skip(); break;
                case 'destroy': player.destroy(); break;
                default: res.status(400).json({ error: 'Invalid action' }); return;
            }
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: 'Action failed' });
        }
    }

    private userChannelId(req: Request, res: Response): void {
        const { userId } = req.params;

        if(!userId){
            res.status(400).json({ message: 'Missing userId' });
            return;
        };

        const { guildId, channelId, updatedAt } = getUserChannelId(userId);
        // const hasPlayer = !!(guildId && this.kazagumo.getPlayer(guildId));

        res.json({ userId, guildId, channelId, updatedAt });
    }

    private hasPlayer(req: Request, res: Response): void {
        const { guildId, channelId } = req.params;

        if(!guildId){
            res.status(400).json({ message: 'Missing guildId' });
            return;
        };if(!channelId){
            res.status(400).json({ message: 'Missing channelId' });
            return;
        };

        const player = this.kazagumo.getPlayer(guildId || '');
        res.json({ hasPlayer: player?.voiceId === channelId, id: this.port });
    }

    private async playerControl(req: Request, res: Response): Promise<void> {
        const { guildId, channelId } = req.params;
        const { action, value, requester } = req.body || {};
        console.log({ action, value });
        let player = this.kazagumo.getPlayer(guildId);

        if (!player || player.voiceId !== channelId) {
            res.status(404).json({ error: 'Player not found' });
            return;
        }

        try {
            switch (action) {
                case 'play':
                    if (typeof value !== 'string') {
                        res.status(400).json({ error: 'Invalid index' });
                        return;
                    }
                    const result = await musicSearch(this.kazagumo, value, { requester, nodeName: player.shoukaku.node.name });
                    if (!result.tracks[0]) {
                        res.status(404).json({ error: 'Track not found', notice: result.notice });
                        return;
                    }
                    player.play(result.tracks[0]);
                    break;
                
                case 'pause':
                    player.pause(true);
                    break;
                case 'resume':
                    player.pause(false);
                    break;
                case 'skip':
                    player.skip();
                    break;
                case 'previous':
                    await player.play(player.queue.previous[0]);
                    break;
                case 'stop':
                    await player.destroy();
                    break;
                case 'seek':
                    if (typeof value !== 'number') {
                        res.status(400).json({ error: 'Invalid seek value', value });
                        return;
                    }
                    await player.seek(value); // ms
                    break;
                case 'forward':
                    await player.seek(player.position + (value || 10000)); // default +10s
                    break;
                case 'rewind':
                    await player.seek(Math.max(0, player.position - (value || 10000))); // -10s
                    break;
                case 'volume':
                    if (typeof value !== 'number') {
                        res.status(400).json({ error: 'Invalid volume' });
                        return;
                    }
                    await player.setVolume(value); // 0-100 หรือมากกว่านั้น
                    break;
                case 'loop':
                    // none | track | queue
                    player.setLoop(value); 
                    break;
                case 'shuffle':
                    player.queue.shuffle();
                    break;
                case 'remove':
                    if (typeof value !== 'number') {
                        res.status(400).json({ error: 'Invalid index' });
                        return;
                    }
                    player.queue.remove(value);
                    break;
                case 'jump':
                    if (typeof value !== 'number') {
                        res.status(400).json({ error: 'Invalid index' });
                        return;
                    }
                    await player.play(player.queue[value]);
                    break;
                case 'clear':
                    player.queue.clear();
                    break;
                case '247':
                    if (typeof value !== 'boolean') {
                        res.status(400).json({ error: 'Invalid volume' });
                        return;
                    }
                    player[247] = value;
                    break;
                default:
                    res.status(400).json({ error: 'Invalid action' });
                    return;
            }
            
            player = this.kazagumo.getPlayer(guildId);
            const data = player && this.constPlayer(player);
            res.json({ success: true, player: data });
        } catch (error) {
            res.status(500).json({ error: 'Action failed' });
        }
    }

    private playerData(req: Request, res: Response) {
        const { guildId, channelId } = req.params;

        if(!guildId){
            res.status(400).json({ message: 'Missing guildId' });
            return;
        };if(!channelId){
            res.status(400).json({ message: 'Missing channelId' });
            return;
        };
        const player = this.kazagumo.players.get(guildId || '');

        if (!player || player.voiceId !== channelId) {
            res.status(404).json({ error: 'Player not found' });
            return;
        };

        const data = this.constPlayer(player);

        console.log(data);
        res.json(data);
    }

    private constPlayer(player: KazagumoPlayer) {
        enum PlayerState {
            CONNECTING = 0,
            CONNECTED = 1,
            DISCONNECTING = 2,
            DISCONNECTED = 3,
            DESTROYING = 4,
            DESTROYED = 5
        }
        type Track = {
            requester: unknown | undefined;
            sourceName: string;
            title: string;
            uri?: string;
            author: string | undefined;
            length: number | undefined;
            thumbnail: string | undefined;
        };
        type Data = {
            guildId: string;
            channelId: string | null;
            queue: {
                items: Track[];
                current: Track | undefined | null;
                previous: Track[];
                size: number;
                totalSize: number;
                isEmpty: boolean;
            };
            playing: boolean;
            loop: 'none' | 'queue' | 'track';
            volume: number;
            position: number;
            state: PlayerState;
        };
        const mapTrack = (t: KazagumoTrack): Track => ({
            requester: t.requester,
            sourceName: t.sourceName,
            title: t.title,
            uri: t.uri,
            author: t.author,
            length: t.length,
            thumbnail: t.thumbnail,
        });
        const data: Data = {
            guildId: player.guildId,
            channelId: player.voiceId,
            queue: {
                items: player.queue.map(mapTrack),
                current: player.queue.current && mapTrack(player.queue.current),
                previous: player.queue.previous.map(mapTrack),
                size: player.queue.size,
                totalSize: player.queue.totalSize,
                isEmpty: player.queue.isEmpty,
            },
            playing: player.playing,
            loop: player.loop,
            volume: player.volume,
            position: player.position,
            state: player.state,
        };
        return data;
    }

    // --- HTML Templates ---

    private getLoginHtmlTemplate(): string {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login</title>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet">
    <style>
        body { background-color: #050000; color: #fff; font-family: 'Poppins', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .login-card { background: #140005; border: 1px solid #ff003c; padding: 40px; border-radius: 12px; box-shadow: 0 0 20px rgba(255, 0, 60, 0.2); width: 100%; max-width: 400px; text-align: center; }
        h1 { color: #ff003c; margin-bottom: 30px; letter-spacing: 2px; text-transform: uppercase; }
        input[type="password"] { width: 100%; padding: 15px; margin-bottom: 20px; background: #000; border: 1px solid #555; color: #fff; border-radius: 6px; font-size: 1rem; outline: none; transition: 0.3s; }
        input[type="password"]:focus { border-color: #ff003c; box-shadow: 0 0 10px rgba(255, 0, 60, 0.3); }
        button { width: 100%; padding: 15px; background: #ff003c; color: white; border: none; border-radius: 6px; font-size: 1.1rem; font-weight: bold; cursor: pointer; transition: 0.3s; }
        button:hover { background: #cc0030; }
        .error { color: #ff3333; margin-bottom: 15px; font-size: 0.9rem; }
    </style>
</head>
<body>
    <div class="login-card">
        <h1>แน่จริงก็ใส่ให้ถูก</h1>
        <form action="/login" method="POST" style="display: flex; flex-direction: column; align-items: center;">
            ${/* เช็ค query parameter error เพื่อแสดงข้อความ */ ''}
            <script>if(window.location.search.includes('error=1')) document.write('<div class="error">Access Denied: Invalid Credentials</div>');</script>
            <input type="password" name="password" placeholder="กรอกรหัส..." required autofocus>
            <button type="submit">ไปต่อ</button>
        </form>
    </div>
</body>
</html>
        `;
    }

    private getHtmlTemplate(): string {
        // 
        // เพิ่มปุ่ม Logout ไว้มุมขวาบนใกล้ๆ Theme Switcher
        // ส่วนอื่นๆ ของโค้ด HTML/Alpine ยังคงเหมือนเดิม 100%
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Lavalink Admin</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700&family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
    <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
    
    <style>
        /* Base Reset */
        * { box-sizing: border-box; margin: 0; padding: 0; transition: none !important; }
        [x-cloak] { display: none !important; } 
        
        #theme-switcher-container {
            position: fixed; top: 20px; right: 20px; z-index: 9999;
            background: rgba(0,0,0,0.8); padding: 8px; border-radius: 8px;
            border: 1px solid #444; backdrop-filter: blur(5px);
            display: flex; gap: 10px; align-items: center;
        }
        select#theme-select {
            background: #222; color: #fff; border: 1px solid #555;
            padding: 5px 10px; border-radius: 4px; cursor: pointer;
        }
        .btn-logout {
            background: #440000; color: #ff9999; border: 1px solid #660000;
            padding: 5px 10px; border-radius: 4px; text-decoration: none; font-family: sans-serif; font-size: 0.9rem;
        }
        .btn-logout:hover { background: #660000; color: white; }
        #app-root { min-height: 100vh; }
    </style>

    <style id="dynamic-theme-style"></style>
</head>
<body>

    <div x-data="dashboard()" x-init="init()" id="app-root">

        <div id="theme-switcher-container">
            <select id="theme-select" x-model="theme" @change="updateThemeCSS()">
                <option value="cyberpunk">Theme: Cyberpunk Crimson</option>
                <option value="liquid">Theme: Crimson Liquid</option>
                <option value="command">Theme: Crimson Command</option>
            </select>
            <a href="/logout" class="btn-logout">LOGOUT</a>
        </div>

        <template x-if="theme === 'cyberpunk'">
            <div class="container">
                <div class="header-grid">
                    <div class="tech-panel">
                        <h2>System Core</h2>
                        <div class="stat-display"><span style="color:#a0a0a0">RAM</span> <span style="color:#ff003c; font-weight:bold;" x-text="system.ram + ' MB'"></span></div>
                        <div class="stat-display"><span style="color:#a0a0a0">CPU</span> <span style="color:#ff003c; font-weight:bold;" x-text="system.cpu + ' %'"></span></div>
                    </div>
                    <div class="tech-panel">
                        <h2>Node Uplink</h2>
                        <div class="node-grid">
                            <template x-for="n in nodes" :key="n.name">
                                <div class="node-card">
                                    <div style="border-bottom:1px solid #300; margin-bottom:5px;">
                                        <b x-text="n.name"></b> 
                                        <span style="float:right;" :style="{color: n.state===2 ? 'var(--primary-red)' : '#555'}" x-text="n.state===2 ? 'ONLINE' : 'OFFLINE'"></span>
                                    </div>
                                    <div style="font-size:0.8rem; color:#a0a0a0">
                                        RAM: <span x-text="n.ram"></span>MB | CPU: <span x-text="n.cpu"></span>%
                                    </div>
                                </div>
                            </template>
                        </div>
                    </div>
                </div>
                
                <div class="tech-panel controls-bar" style="padding:10px;">
                    <input type="text" x-model="filterText" placeholder="SEARCH GUILD...">
                    <button class="btn-filter" :class="filterStatus==='all' && 'active'" @click="filterStatus='all'">All</button>
                    <button class="btn-filter" :class="filterStatus==='playing' && 'active'" @click="filterStatus='playing'">Play</button>
                    <button class="btn-filter" :class="filterStatus==='paused' && 'active'" @click="filterStatus='paused'">Pause</button>
                    <button class="btn-filter" :class="filterStatus==='idle' && 'active'" @click="filterStatus='idle'">Idle</button>
                </div>

                <div class="players-grid">
                    <template x-for="p in filteredPlayers" :key="p.guildId">
                        <div class="tech-panel player-card">
                            <div class="player-header">
                                <span style="font-weight:bold" x-text="p.guildName"></span>
                                <span class="status-badge" 
                                      :class="{'status-playing': p.isPlaying, 'status-paused': p.paused, 'status-idle': !p.isPlaying && !p.paused}"
                                      x-text="p.paused ? 'PAUSED' : (p.isPlaying ? 'ACTIVE' : 'IDLE')"></span>
                            </div>
                            <div class="track-info" x-text="p.trackTitle || ':: NO SIGNAL ::'"></div>
                            <div class="player-actions">
                                <button class="btn-action" @click="control(p.guildId, 'resume')">▶</button>
                                <button class="btn-action" @click="control(p.guildId, 'pause')">||</button>
                                <button class="btn-action" @click="control(p.guildId, 'skip')">>></button>
                                <button class="btn-action" style="background:#300; border-color:red" @click="control(p.guildId, 'destroy')">X</button>
                            </div>
                        </div>
                    </template>
                    <div x-show="filteredPlayers.length === 0" style="grid-column:1/-1; text-align:center; padding:20px; color:#aaa;">NO TARGETS FOUND</div>
                </div>
            </div>
        </template>

        <template x-if="theme === 'liquid'">
            <div class="container">
                <div class="header-grid">
                    <div class="glass-panel">
                        <h2>System Liquid</h2>
                        <div class="stat-circle-group">
                            <div class="stat-bubble"><span style="font-size:1.2rem; font-weight:700;" x-text="system.ram"></span><span style="font-size:0.7rem; color:#ff003c">RAM (MB)</span></div>
                            <div class="stat-bubble"><span style="font-size:1.2rem; font-weight:700;" x-text="system.cpu"></span><span style="font-size:0.7rem; color:#ff003c">CPU (%)</span></div>
                        </div>
                    </div>
                    <div class="glass-panel">
                        <h2>Nodes Status</h2>
                        <div class="node-row">
                            <template x-for="n in nodes" :key="n.name">
                                <div class="node-pill">
                                    <div><div style="font-weight:500" x-text="n.name"></div><div style="font-size:0.75rem; color:#aaa">RAM: <span x-text="n.ram"></span>MB | CPU: <span x-text="n.cpu"></span>%</div></div>
                                    <div style="width:8px; height:8px; border-radius:50%; box-shadow:0 0 8px currentColor;" :style="{background: n.state===2?'#00ff88':'#ff003c', color: n.state===2?'#00ff88':'#ff003c'}"></div>
                                </div>
                            </template>
                        </div>
                    </div>
                </div>
                <div class="glass-panel controls-bar">
                    <span style="font-size:1.2rem;">🔍</span>
                    <input type="text" class="search-glass" x-model="filterText" placeholder="Search Guilds...">
                    <select class="glass-select" x-model="filterStatus">
                        <option value="all">All States</option>
                        <option value="playing">Playing</option>
                        <option value="paused">Paused</option>
                        <option value="idle">Idle</option>
                    </select>
                </div>
                <div class="players-grid">
                    <template x-for="p in filteredPlayers" :key="p.guildId">
                        <div class="glass-panel player-liquid">
                            <div class="player-top">
                                <span style="font-weight:700" x-text="p.guildName"></span>
                                <span style="font-size:0.8rem; text-transform:uppercase;" 
                                      :style="{color: p.paused?'#ffcc00':(p.isPlaying?'#00ff88':'#666')}"
                                      x-text="p.paused?'Paused':(p.isPlaying?'Playing':'Idle')"></span>
                            </div>
                            <div class="track-liquid" x-text="p.trackTitle || 'Water Still...'"></div>
                            <div class="action-dock">
                                <button class="btn-round" @click="control(p.guildId, 'resume')">▶</button>
                                <button class="btn-round" @click="control(p.guildId, 'pause')">⏸</button>
                                <button class="btn-round" @click="control(p.guildId, 'skip')">⏭</button>
                                <button class="btn-round" style="color:#4a0010" @click="control(p.guildId, 'destroy')">✖</button>
                            </div>
                        </div>
                    </template>
                </div>
            </div>
        </template>

        <template x-if="theme === 'command'">
            <div class="container">
                <div class="tech-panel">
                    <div class="section-title">System Metrics</div>
                    <div class="stats-grid">
                        <div class="stat-box"><span style="color:#a0a0b0; font-size:0.9rem;">Memory</span><span style="font-size:2rem; font-weight:700; color:#ff3355;" x-text="system.ram"></span></div>
                        <div class="stat-box"><span style="color:#a0a0b0; font-size:0.9rem;">CPU Load</span><span style="font-size:2rem; font-weight:700; color:#ff3355;" x-text="system.cpu"></span></div>
                    </div>
                </div>
                <div>
                    <div class="section-title">Lavalink Nodes</div>
                    <div class="nodes-row">
                        <template x-for="n in nodes" :key="n.name">
                            <div class="node-card" :class="n.state===2 ? 'online' : 'offline'">
                                <div style="font-weight:600; margin-bottom:5px;" x-text="n.name"></div>
                                <div style="font-size:0.85rem; color:#a0a0b0;">Status: <span style="color:white" x-text="n.state===2?'Online':'Offline'"></span></div>
                            </div>
                        </template>
                    </div>
                </div>
                <div class="controller-bar">
                    <input type="text" class="search-input" x-model="filterText" placeholder="Search Guild...">
                    <select class="tech-select" x-model="filterStatus">
                        <option value="all">Status: All</option>
                        <option value="playing">Status: Playing</option>
                        <option value="paused">Status: Paused</option>
                        <option value="idle">Status: Idle</option>
                    </select>
                </div>
                <div>
                    <div class="section-title">Active Players</div>
                    <div class="players-grid">
                        <template x-for="p in filteredPlayers" :key="p.guildId">
                            <div class="tech-panel player-card">
                                <div class="p-header-bar">
                                    <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:70%;" x-text="p.guildName"></div>
                                    <div class="status-pill" 
                                         :class="{'pill-play': p.isPlaying, 'pill-pause': p.paused, 'pill-idle': !p.isPlaying && !p.paused}"
                                         x-text="p.paused?'Paused':(p.isPlaying?'Playing':'Idle')"></div>
                                </div>
                                <div class="p-body">
                                    <div style="margin-bottom:15px;">
                                        <span style="font-size:0.8rem; color:#a0a0b0;">Now Playing</span>
                                        <div style="font-weight:500; color:#ff3355; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" x-text="p.trackTitle||'---'"></div>
                                    </div>
                                    <div class="control-dock">
                                        <button class="btn-ctrl" @click="control(p.guildId, 'resume')">▶</button>
                                        <button class="btn-ctrl" @click="control(p.guildId, 'pause')">⏸</button>
                                        <button class="btn-ctrl" @click="control(p.guildId, 'skip')">⏭</button>
                                        <button class="btn-ctrl" style="color:#ff3355; background:rgba(230,0,35,0.1);" @click="control(p.guildId, 'destroy')">■</button>
                                    </div>
                                </div>
                            </div>
                        </template>
                    </div>
                </div>
            </div>
        </template>

    </div>

<script>
    // --- CSS CONSTANTS ---
    const THEME_CSS = {
        cyberpunk: \`
            :root { --bg-deep: #050000; --bg-grid: #1a0000; --primary-red: #ff003c; --dark-red: #590015; --accent-orange: #ff5e00; --text-white: #ffffff; --text-gray: #a0a0a0; }
            body { background-color: var(--bg-deep); color: var(--text-white); padding: 20px; font-family: 'Courier New', monospace; background-image: linear-gradient(rgba(255, 0, 60, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 0, 60, 0.1) 1px, transparent 1px), radial-gradient(circle at center, rgba(89, 0, 21, 0.3) 0%, #000 100%); background-size: 40px 40px, 40px 40px, cover; }
            .container { max-width: 1400px; margin: 0 auto; display: grid; gap: 25px; margin-top: 50px; }
            .tech-panel { background: rgba(20, 0, 5, 0.85); border: 2px solid var(--dark-red); border-left: 5px solid var(--primary-red); padding: 20px; position: relative; box-shadow: 0 0 15px rgba(0,0,0,0.8); }
            .tech-panel::after { content: ''; position: absolute; top: 0; right: 0; width: 20px; height: 20px; background: linear-gradient(45deg, transparent 50%, var(--primary-red) 50%); }
            h2 { color: var(--primary-red); font-size: 1.4rem; text-transform: uppercase; border-bottom: 2px solid var(--dark-red); padding-bottom: 10px; margin-bottom: 15px; text-shadow: 0 0 10px var(--primary-red); }
            .header-grid { display: grid; grid-template-columns: 1fr 2fr; gap: 25px; }
            .stat-display { display: flex; justify-content: space-between; align-items: center; background: #000; border: 1px solid var(--primary-red); padding: 10px 15px; margin-bottom: 10px; }
            .node-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 15px; }
            .node-card { background: var(--bg-grid); border: 1px solid var(--primary-red); padding: 15px; }
            .controls-bar { display: flex; gap: 15px; flex-wrap: wrap; background: var(--dark-red); border: 1px solid var(--primary-red); }
            input[type="text"] { background: #000; border: 1px solid var(--primary-red); color: var(--primary-red); padding: 12px; flex: 1; outline: none; text-transform: uppercase; }
            .btn-filter { background: #200005; border: 1px solid var(--primary-red); color: var(--text-gray); padding: 10px 20px; cursor: pointer; text-transform: uppercase; font-weight: bold; }
            .btn-filter.active { background: var(--primary-red); color: #000; box-shadow: 0 0 15px var(--primary-red); }
            .players-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }
            .player-card { background: linear-gradient(180deg, rgba(20,0,0,0.9) 0%, rgba(40,0,0,0.9) 100%); border: 1px solid var(--dark-red); border-top: 3px solid var(--primary-red); }
            .player-header { display: flex; justify-content: space-between; border-bottom: 1px solid var(--dark-red); padding-bottom: 10px; }
            .status-badge { font-size: 0.7rem; padding: 3px 8px; border: 1px solid; text-transform: uppercase; }
            .status-playing { background: var(--primary-red); color: #000; box-shadow: 0 0 10px var(--primary-red); }
            .status-paused { color: var(--accent-orange); border-color: var(--accent-orange); }
            .status-idle { color: #555; border-color: #555; }
            .track-info { background: #000; margin: 10px 0; padding: 12px; border-left: 3px solid var(--primary-red); color: var(--accent-orange); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .player-actions { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 4px; }
            .btn-action { background: #111; border: 1px solid var(--dark-red); color: var(--primary-red); padding: 10px; cursor: pointer; }
            .btn-action:hover { background: var(--dark-red); color: white; }
            @media (max-width: 800px) { .header-grid { grid-template-columns: 1fr; } }
        \`,
        liquid: \`
            :root { --bg-deep: #0a0202; --glass-bg: rgba(255, 255, 255, 0.03); --glass-border: rgba(255, 255, 255, 0.08); --red-accent: #ff003c; }
            body { background-color: var(--bg-deep); color: #fff; padding: 30px; font-family: 'Outfit', sans-serif; background-image: radial-gradient(circle at 10% 10%, rgba(255, 0, 60, 0.15), transparent 40%), radial-gradient(circle at 90% 90%, rgba(100, 0, 20, 0.2), transparent 40%); background-attachment: fixed; }
            .container { max-width: 1300px; margin: 0 auto; display: grid; gap: 30px; margin-top: 40px; }
            .glass-panel { background: linear-gradient(135deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.01)); backdrop-filter: blur(20px); border-radius: 24px; border: 1px solid var(--glass-border); border-top: 1px solid rgba(255,255,255,0.2); box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.5); padding: 25px; position: relative; overflow: hidden; }
            .glass-panel::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 50%; background: linear-gradient(to bottom, rgba(255,255,255,0.03), transparent); pointer-events: none; }
            h2 { font-weight: 300; letter-spacing: 1px; color: rgba(255, 255, 255, 0.7); margin-bottom: 20px; text-transform: uppercase; font-size: 0.9rem; }
            .header-grid { display: grid; grid-template-columns: 1fr 2fr; gap: 20px; }
            .stat-circle-group { display: flex; justify-content: space-around; align-items: center; height: 100%; }
            .stat-bubble { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100px; height: 100px; border-radius: 50%; background: rgba(0,0,0,0.2); border: 1px solid rgba(255, 0, 60, 0.6); box-shadow: 0 0 15px rgba(255, 0, 60, 0.2); }
            .node-row { display: flex; gap: 15px; flex-wrap: wrap; }
            .node-pill { flex: 1; min-width: 200px; background: rgba(0,0,0,0.3); border-radius: 16px; padding: 15px; border: 1px solid var(--glass-border); display: flex; justify-content: space-between; align-items: center; }
            .controls-bar { padding: 15px 25px; display: flex; gap: 20px; align-items: center; border-radius: 50px; }
            .search-glass { flex: 1; background: transparent; border: none; color: white; font-size: 1.1rem; outline: none; padding: 5px; }
            .glass-select { background: rgba(0,0,0,0.4); color: var(--red-accent); border: 1px solid var(--glass-border); border-radius: 30px; padding: 10px 25px; cursor: pointer; outline: none; }
            .glass-select option { background: #1a0505; }
            .players-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 25px; }
            .player-liquid { display: flex; flex-direction: column; gap: 15px; }
            .player-top { display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 10px; }
            .track-liquid { background: rgba(0,0,0,0.2); padding: 15px; border-radius: 12px; color: var(--red-accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .action-dock { display: flex; justify-content: space-between; background: rgba(255,255,255,0.03); border-radius: 50px; padding: 5px; margin-top: auto; }
            .btn-round { width: 40px; height: 40px; border-radius: 50%; border: none; background: transparent; color: white; font-size: 1rem; cursor: pointer; display: flex; align-items: center; justify-content: center; }
            .btn-round:hover { background: rgba(255,255,255,0.1); color: var(--red-accent); }
            @media (max-width: 768px) { .header-grid { grid-template-columns: 1fr; } .controls-bar { flex-direction: column; border-radius: 24px; } }
        \`,
        command: \`
            :root { --primary-red: #e60023; --bg-dark: #0a0a0f; --panel-bg: #14141a; --text-light: #ffffff; --text-dim: #a0a0b0; }
            body { background-color: var(--bg-dark); color: var(--text-light); padding: 30px; font-family: 'Poppins', sans-serif; background-image: linear-gradient(to bottom, rgba(10,10,15,0.9), rgba(10,10,15,1)), url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23330000' fill-opacity='0.15'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E"); }
            .container { max-width: 1300px; margin: 0 auto; display: grid; gap: 30px; margin-top: 40px; }
            .tech-panel { background: var(--panel-bg); border-radius: 16px; padding: 25px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid rgba(230, 0, 35, 0.2); position: relative; overflow: hidden; }
            .tech-panel::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, var(--primary-red), transparent); }
            .section-title { font-weight: 700; font-size: 1.1rem; color: var(--text-dim); text-transform: uppercase; margin-bottom: 20px; display: flex; align-items: center; }
            .section-title::before { content: ''; display: inline-block; width: 8px; height: 8px; background: var(--primary-red); border-radius: 50%; margin-right: 10px; box-shadow: 0 0 10px var(--primary-red); }
            .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .stat-box { background: rgba(255,255,255,0.03); padding: 20px; border-radius: 12px; display: flex; flex-direction: column; }
            .nodes-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 20px; }
            .node-card { background: rgba(0,0,0,0.2); border-radius: 12px; padding: 15px; border-left: 4px solid var(--text-dim); }
            .node-card.online { border-left-color: #00d26a; } .node-card.offline { border-left-color: var(--primary-red); }
            .controller-bar { display: flex; gap: 20px; align-items: center; background: var(--panel-bg); padding: 20px; border-radius: 16px; border: 1px solid rgba(230, 0, 35, 0.3); }
            .search-input { flex: 1; background: rgba(0,0,0,0.3); border: 1px solid #333; padding: 12px 20px; border-radius: 8px; color: white; outline: none; }
            .tech-select { background: var(--primary-red); color: white; border: none; padding: 12px 25px; border-radius: 8px; font-weight: 600; cursor: pointer; outline: none; }
            .players-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 25px; }
            .player-card { display: flex; flex-direction: column; padding: 0 !important; }
            .p-header-bar { padding: 20px; background: linear-gradient(to right, rgba(230, 0, 35, 0.1), transparent); border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between; align-items: center; }
            .status-pill { font-size: 0.75rem; padding: 4px 12px; border-radius: 20px; font-weight: 600; text-transform: uppercase; }
            .pill-play { background: rgba(0, 210, 106, 0.15); color: #00d26a; } .pill-pause { background: rgba(255, 170, 0, 0.15); color: #ffaa00; }
            .pill-idle { background: rgba(255,255,255,0.1); color: var(--text-dim); }
            .p-body { padding: 20px; }
            .control-dock { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 12px; }
            .btn-ctrl { background: rgba(255,255,255,0.05); border: none; color: white; padding: 10px; border-radius: 8px; cursor: pointer; }
            .btn-ctrl:hover { background: rgba(255,255,255,0.15); }
            @media (max-width: 768px) { .stats-grid { grid-template-columns: 1fr; } .controller-bar { flex-direction: column; align-items: stretch; } }
        \`
    };

    // --- ALPINE.JS APP LOGIC ---
    function dashboard() {
        return {
            theme: localStorage.getItem('admin_theme') || 'cyberpunk',
            system: { ram: 0, cpu: 0 },
            nodes: [],
            players: [],
            filterText: '',
            filterStatus: 'all',

            init() {
                this.updateThemeCSS();
                this.fetchData();
                setInterval(() => this.fetchData(), 2000);
            },

            get filteredPlayers() {
                if (!this.players) return [];
                return this.players.filter(p => {
                    const nameMatch = p.guildName.toLowerCase().includes(this.filterText.toLowerCase());
                    let statusMatch = true;
                    if (this.filterStatus === 'playing') statusMatch = p.isPlaying;
                    else if (this.filterStatus === 'paused') statusMatch = p.paused;
                    else if (this.filterStatus === 'idle') statusMatch = !p.isPlaying && !p.paused && !p.trackTitle;
                    return nameMatch && statusMatch;
                });
            },

            updateThemeCSS() {
                localStorage.setItem('admin_theme', this.theme);
                document.getElementById('dynamic-theme-style').innerHTML = THEME_CSS[this.theme];
            },

            async fetchData() {
                try {
                    const res = await fetch('/api/data');
                    if (res.status === 401 || res.redirected) {
                         window.location.reload(); // Reload to force login page if session lost
                         return;
                    }
                    const data = await res.json();
                    this.system = data.system;
                    this.nodes = data.nodes;
                    this.players = data.players;
                } catch (e) {
                    console.error("Fetch failed", e);
                }
            },

            async control(guildId, action) {
                try {
                    const res = await fetch('/api/control', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ guildId, action })
                    });
                    if (res.status === 401) {
                        alert("Session expired. Please login again.");
                        window.location.reload();
                    } else {
                        this.fetchData(); 
                    }
                } catch (e) { console.error(e); }
            }
        }
    }
</script>
</body>
</html>
        `;
    }
}
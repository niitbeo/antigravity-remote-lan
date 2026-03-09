import { createServer, IncomingMessage, ServerResponse } from 'http';
import { networkInterfaces } from 'os';
import { URL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

export interface RemoteSession {
    id: string;
    title: string;
    stepCount: number;
    lastModifiedTime?: string;
}

export interface RemoteActivity {
    at: string;
    level: 'info' | 'warn' | 'error';
    message: string;
}

export interface RemoteMessage {
    role: 'user' | 'assistant' | 'system' | 'unknown';
    text: string;
    at?: string;
}

export interface RemoteFileChange {
    path: string;
    status: string;
    added?: number;
    removed?: number;
}

export interface RemoteWorkCard {
    title: string;
    summary: string;
    updates: string[];
    updatedAt: string;
    source: 'trace' | 'derived';
}

export interface RemoteModelOption {
    id: string;
    name: string;
    active?: boolean;
}

export interface RemoteState {
    status: 'starting' | 'ready' | 'error';
    activeSessionId: string;
    activeSessionTitle: string;
    processing: boolean;
    sessions: RemoteSession[];
    messages: RemoteMessage[];
    changedFiles: RemoteFileChange[];
    workCards: RemoteWorkCard[];
    lastEvent: string;
    activityLog: RemoteActivity[];
    modelOptions: RemoteModelOption[];
    selectedModel?: string;
    selectedPlanner?: 'normal' | 'conversational';
    autoApproveStep?: boolean;
    autoApproveTerminal?: boolean;
    updatedAt: string;
    lastError?: string;
}

export interface RelayHandlers {
    onSendPrompt: (text: string, model?: string) => Promise<void>;
    onAcceptStep: () => Promise<void>;
    onRejectStep: () => Promise<void>;
    onAcceptTerminal: () => Promise<void>;
    onRejectTerminal: () => Promise<void>;
    onFocusSession: (sessionId: string) => Promise<void>;
    onSetModel: (model: string) => Promise<void>;
    onSetPlanner: (planner: 'normal' | 'conversational') => Promise<void>;
    onSetAutoApproveStep: (enabled: boolean) => Promise<void>;
    onSetAutoApproveTerminal: (enabled: boolean) => Promise<void>;
    onStop: () => Promise<void>;
}

export class RelayServer {
    private static readonly MAX_ACTIVITY_LOG = 80;
    private readonly httpServer;
    private readonly wsServer;
    private readonly clients = new Set<WebSocket>();
    private state: RemoteState;

    constructor(
        private readonly host: string,
        private readonly port: number,
        private readonly token: string,
        private readonly handlers: RelayHandlers,
    ) {
        this.state = {
            status: 'starting',
            activeSessionId: '',
            activeSessionTitle: '',
            processing: false,
            sessions: [],
            messages: [],
            changedFiles: [],
            workCards: [],
            lastEvent: 'boot',
            activityLog: [],
            modelOptions: [],
            selectedPlanner: 'normal',
            autoApproveStep: false,
            autoApproveTerminal: false,
            updatedAt: new Date().toISOString(),
        };

        this.httpServer = createServer((req, res) => {
            this.routeHttp(req, res).catch((err: unknown) => {
                this.sendJson(res, 500, { error: String(err) });
            });
        });

        this.wsServer = new WebSocketServer({ noServer: true });
        this.wsServer.on('connection', (socket) => {
            this.clients.add(socket);
            socket.send(JSON.stringify({ type: 'state', payload: this.state }));
            socket.on('close', () => this.clients.delete(socket));
        });

        this.httpServer.on('upgrade', (req, socket, head) => {
            const parsed = this.parseUrl(req);
            const isWsRoute = parsed?.pathname === '/ws';
            const isAuthorized = parsed?.searchParams.get('token') === this.token;
            if (!isWsRoute || !isAuthorized) {
                socket.destroy();
                return;
            }
            this.wsServer.handleUpgrade(req, socket, head, (ws) => {
                this.wsServer.emit('connection', ws, req);
            });
        });
    }

    async start(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.httpServer.listen(this.port, this.host, () => resolve());
            this.httpServer.once('error', reject);
        });
    }

    stop(): void {
        for (const client of this.clients) {
            client.close();
        }
        this.wsServer.close();
        this.httpServer.close();
    }

    updateState(patch: Partial<RemoteState>): void {
        this.state = {
            ...this.state,
            ...patch,
            updatedAt: new Date().toISOString(),
        };
        this.broadcast({ type: 'state', payload: this.state });
    }

    addActivity(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
        const next: RemoteActivity = {
            at: new Date().toISOString(),
            level,
            message,
        };

        const activityLog = [next, ...this.state.activityLog].slice(0, RelayServer.MAX_ACTIVITY_LOG);
        this.updateState({ activityLog });
    }

    getConnectUrls(): string[] {
        const ips = this.getLocalIps();
        return ips.map((ip) => `http://${ip}:${this.port}/?token=${this.token}`);
    }

    private async routeHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const parsed = this.parseUrl(req);
        const pathname = parsed?.pathname ?? '/';
        this.applyCors(res);

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method === 'GET' && pathname === '/health') {
            this.sendJson(res, 200, { ok: true, status: this.state.status });
            return;
        }

        if (pathname.startsWith('/api/')) {
            await this.routeApi(req, res, pathname, parsed);
            return;
        }

        if (req.method === 'GET' && pathname === '/state') {
            if (!this.isHttpAuthorized(req, parsed)) {
                this.sendJson(res, 401, { error: 'unauthorized' });
                return;
            }
            this.sendJson(res, 200, this.state);
            return;
        }

        if (req.method === 'POST' && pathname === '/command') {
            if (!this.isHttpAuthorized(req, parsed)) {
                this.sendJson(res, 401, { error: 'unauthorized' });
                return;
            }
            const body = await this.readBody(req);
            const payload = JSON.parse(body || '{}') as { type?: string; text?: string; sessionId?: string; actor?: string; model?: string; planner?: string };
            await this.handleCommand(payload);
            this.sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'GET' && pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.renderMobilePage());
            return;
        }

        this.sendJson(res, 404, { error: 'not_found' });
    }

    private async routeApi(req: IncomingMessage, res: ServerResponse, pathname: string, parsed: URL | null): Promise<void> {
        if (!this.isHttpAuthorized(req, parsed)) {
            this.sendJson(res, 401, { error: 'unauthorized' });
            return;
        }

        if (req.method === 'GET' && pathname === '/api/status') {
            this.sendJson(res, 200, {
                connected: this.state.status === 'ready',
                activeSessionId: this.state.activeSessionId || null,
                activeSessionName: this.state.activeSessionTitle || null,
                bridgeState: this.state.lastError || (this.state.processing ? 'Processing' : 'Ready'),
                lastEvent: this.state.lastEvent || null,
                updatedAt: this.state.updatedAt,
            });
            return;
        }

        if (req.method === 'GET' && pathname === '/api/sessions') {
            const mapped = this.state.sessions.map((s) => ({
                id: s.id,
                name: s.title,
                steps: s.stepCount,
                updatedAt: s.lastModifiedTime || this.state.updatedAt,
                status: this.sessionStatusFor(s.id),
            }));
            this.sendJson(res, 200, mapped);
            return;
        }

        if (req.method === 'POST' && pathname.startsWith('/api/sessions/') && pathname.endsWith('/open')) {
            const match = pathname.match(/^\/api\/sessions\/([^/]+)\/open$/);
            const sessionId = match ? decodeURIComponent(match[1]) : '';
            if (!sessionId) {
                this.sendJson(res, 400, { error: 'invalid session id' });
                return;
            }
            await this.handleCommand({ type: 'focusSession', sessionId });
            this.sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/prompt') {
            const body = await this.readBody(req);
            const payload = JSON.parse(body || '{}') as { sessionId?: string; prompt?: string; actor?: string; model?: string; planner?: string };
            if (payload.sessionId) {
                await this.handleCommand({ type: 'focusSession', sessionId: payload.sessionId });
            }
            await this.handleCommand({ type: 'sendPrompt', text: payload.prompt || '', actor: payload.actor, model: payload.model, planner: payload.planner });
            this.sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/approval/step') {
            const body = await this.readBody(req);
            const payload = JSON.parse(body || '{}') as { approved?: boolean; actor?: string };
            await this.handleCommand({ type: payload.approved ? 'acceptStep' : 'rejectStep', actor: payload.actor });
            this.sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && pathname === '/api/approval/terminal') {
            const body = await this.readBody(req);
            const payload = JSON.parse(body || '{}') as { approved?: boolean; actor?: string };
            await this.handleCommand({ type: payload.approved ? 'acceptTerminal' : 'rejectTerminal', actor: payload.actor });
            this.sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === 'GET' && pathname === '/api/feed/live') {
            const mapped = this.state.activityLog.map((item, index) => ({
                id: `${item.at}-${index}`,
                time: this.hhmmss(item.at),
                level: this.feedLevel(item.level),
                text: item.message,
            }));
            this.sendJson(res, 200, mapped);
            return;
        }

        if (req.method === 'GET' && pathname === '/api/files/changed') {
            const mapped = this.state.changedFiles.map((f) => ({
                path: f.path,
                status: this.fileStatus(f.status),
            }));
            this.sendJson(res, 200, mapped);
            return;
        }

        this.sendJson(res, 404, { error: 'not_found' });
    }

    private async handleCommand(payload: { type?: string; text?: string; sessionId?: string; actor?: string; model?: string; planner?: string; enabled?: boolean }): Promise<void> {
        const command = payload.type;
        if (!command) throw new Error('missing command type');
        const actor = payload.actor?.trim() ? payload.actor.trim().slice(0, 48) : 'mobile';
        const model = payload.model?.trim() ? payload.model.trim() : '';
        const planner = payload.planner === 'conversational' ? 'conversational' : 'normal';
        const enabled = Boolean(payload.enabled);

        switch (command) {
            case 'sendPrompt':
                if (!payload.text?.trim()) throw new Error('prompt text is required');
                await this.handlers.onSetPlanner(planner);
                await this.handlers.onSendPrompt(payload.text.trim(), model || undefined);
                this.addActivity(`Prompt sent by ${actor}${model ? ` [${model}]` : ''}: ${payload.text.trim().slice(0, 120)}`);
                this.updateState({ lastEvent: `sendPrompt:${actor}`, processing: true });
                break;
            case 'acceptStep':
                await this.handlers.onAcceptStep();
                this.addActivity(`Approved code/file step by ${actor}`);
                this.updateState({ lastEvent: `acceptStep:${actor}` });
                break;
            case 'rejectStep':
                await this.handlers.onRejectStep();
                this.addActivity(`Rejected code/file step by ${actor}`, 'warn');
                this.updateState({ lastEvent: `rejectStep:${actor}` });
                break;
            case 'acceptTerminal':
                await this.handlers.onAcceptTerminal();
                this.addActivity(`Approved terminal command by ${actor}`);
                this.updateState({ lastEvent: `acceptTerminal:${actor}` });
                break;
            case 'rejectTerminal':
                await this.handlers.onRejectTerminal();
                this.addActivity(`Rejected terminal command by ${actor}`, 'warn');
                this.updateState({ lastEvent: `rejectTerminal:${actor}` });
                break;
            case 'focusSession':
                if (!payload.sessionId) throw new Error('sessionId is required');
                await this.handlers.onFocusSession(payload.sessionId);
                this.addActivity(`Switched session: ${payload.sessionId}`);
                this.updateState({ activeSessionId: payload.sessionId, lastEvent: 'focusSession' });
                break;
            case 'setModel':
                if (!model) throw new Error('model is required');
                await this.handlers.onSetModel(model);
                this.addActivity(`Model set by ${actor}: ${model}`);
                this.updateState({ selectedModel: model, lastEvent: `setModel:${model}` });
                break;
            case 'setPlanner':
                await this.handlers.onSetPlanner(planner);
                this.addActivity(`Planner set by ${actor}: ${planner}`);
                this.updateState({ selectedPlanner: planner, lastEvent: `setPlanner:${planner}` });
                break;
            case 'setAutoApproveStep':
                await this.handlers.onSetAutoApproveStep(enabled);
                this.addActivity(`Auto-approve step ${enabled ? 'enabled' : 'disabled'} by ${actor}`);
                this.updateState({ autoApproveStep: enabled, lastEvent: `autoStep:${enabled ? 'on' : 'off'}` });
                break;
            case 'setAutoApproveTerminal':
                await this.handlers.onSetAutoApproveTerminal(enabled);
                this.addActivity(`Auto-approve terminal ${enabled ? 'enabled' : 'disabled'} by ${actor}`);
                this.updateState({ autoApproveTerminal: enabled, lastEvent: `autoTerminal:${enabled ? 'on' : 'off'}` });
                break;
            case 'stop':
                await this.handlers.onStop();
                this.addActivity(`Stop requested by ${actor}`, 'warn');
                this.updateState({ processing: false, lastEvent: `stop:${actor}` });
                break;
            default:
                throw new Error(`unsupported command: ${command}`);
        }
    }

    private broadcast(message: unknown): void {
        const data = JSON.stringify(message);
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        }
    }

    private parseUrl(req: IncomingMessage): URL | null {
        if (!req.url) return null;
        return new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    }

    private isHttpAuthorized(req: IncomingMessage, parsed: URL | null): boolean {
        const queryToken = parsed?.searchParams.get('token');
        const headerToken = req.headers['x-remote-token'];
        const authHeader = req.headers.authorization;
        const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
            ? authHeader.slice('Bearer '.length)
            : '';
        return queryToken === this.token || headerToken === this.token || bearer === this.token;
    }

    private sendJson(res: ServerResponse, status: number, payload: unknown): void {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
    }

    private applyCors(res: ServerResponse): void {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Remote-Token');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }

    private hhmmss(iso: string): string {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleTimeString('vi-VN');
    }

    private sessionStatusFor(sessionId: string): 'idle' | 'live' | 'waiting' | 'error' {
        if (this.state.status === 'error') return 'error';
        if (sessionId === this.state.activeSessionId) return this.state.processing ? 'live' : 'waiting';
        return 'idle';
    }

    private feedLevel(level: 'info' | 'warn' | 'error'): 'info' | 'success' | 'warning' | 'error' {
        if (level === 'warn') return 'warning';
        if (level === 'error') return 'error';
        // map informative progress logs to success when they look like completion/approval
        return 'info';
    }

    private fileStatus(status: string): 'modified' | 'added' | 'deleted' {
        const upper = (status || '').toUpperCase();
        if (upper.includes('A')) return 'added';
        if (upper.includes('D')) return 'deleted';
        return 'modified';
    }

    private readBody(req: IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let raw = '';
            req.on('data', (chunk) => {
                raw += chunk;
                if (raw.length > 1024 * 1024) {
                    reject(new Error('body too large'));
                }
            });
            req.on('end', () => resolve(raw));
            req.on('error', reject);
        });
    }

    private getLocalIps(): string[] {
        const nets = networkInterfaces();
        const ips: string[] = [];

        for (const values of Object.values(nets)) {
            for (const detail of values ?? []) {
                if (detail.family === 'IPv4' && !detail.internal) {
                    ips.push(detail.address);
                }
            }
        }

        if (!ips.length) {
            ips.push('127.0.0.1');
        }
        return ips;
    }

    private renderMobilePage(): string {
        return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Antigravity Remote</title>
  <style>
    :root {
      color-scheme: dark;
      --bg-a: #050914;
      --bg-b: #0c1831;
      --card: rgba(11, 20, 42, 0.72);
      --card-border: #203766;
      --text: #eaf1ff;
      --muted: #90a3c9;
      --accent: #5cc8ff;
      --ok: #2fb884;
      --warn: #f0b429;
      --danger: #f16f7f;
      --soft-shadow: 0 12px 30px rgba(3, 8, 24, 0.5);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "SF Mono", "Roboto Mono", Menlo, Consolas, Monaco, monospace;
      background:
        radial-gradient(circle at 16% -10%, #163163 0%, rgba(22,49,99,0) 42%),
        radial-gradient(circle at 88% -20%, #114f5b 0%, rgba(17,79,91,0) 38%),
        linear-gradient(165deg, var(--bg-b), var(--bg-a) 55%);
      min-height: 100vh;
      line-height: 1.4;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      padding: 14px 14px 12px;
      border-bottom: 1px solid #1a2d58;
      background: rgba(5, 10, 24, 0.82);
      backdrop-filter: blur(10px);
    }
    .titleRow { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .title { font-size: 18px; font-weight: 700; letter-spacing: 0.2px; }
    .statusMeta { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      border: 1px solid transparent;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .ok { background: rgba(47, 184, 132, 0.14); color: #8df2c6; border-color: rgba(47,184,132,0.3); }
    .busy { background: rgba(240, 180, 41, 0.15); color: #f9d989; border-color: rgba(240,180,41,0.35); }
    .wrap {
      max-width: 860px;
      margin: 0 auto;
      padding: 14px;
      padding-bottom: 20px;
      display: block;
    }
    .tabs {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin: 0 0 12px;
      padding: 6px;
      border: 1px solid #254275;
      border-radius: 14px;
      background: rgba(9, 18, 38, 0.74);
    }
    .tabBtn {
      border: 1px solid transparent;
      background: rgba(30, 56, 95, 0.3);
      color: #bcd4ff;
      border-radius: 10px;
      padding: 8px 6px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.2px;
      text-transform: uppercase;
    }
    .tabBtn.active {
      background: linear-gradient(135deg, #1778da, #2f90ff);
      color: #fff;
      border-color: rgba(123, 196, 255, 0.55);
    }
    .panel { display: none; gap: 12px; }
    .panel.active { display: grid; }
    .cfgInput {
      width: 100%;
      border: 1px solid #2c4b81;
      border-radius: 10px;
      background: rgba(7, 14, 30, 0.92);
      color: #eff6ff;
      padding: 9px;
      margin-top: 4px;
      margin-bottom: 10px;
      font-size: 13px;
    }
    .cfgInput:focus { border-color: #5cc8ff; outline: none; }
    .card {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 12px;
      box-shadow: var(--soft-shadow);
    }
    .cardTitle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
      font-size: 13px;
      color: #b3c4e5;
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .small { color: var(--muted); font-size: 12px; }
    .activeTitle {
      font-size: 16px;
      font-weight: 700;
      margin: 4px 0 8px;
      color: #f2f6ff;
      word-break: break-word;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .stat {
      border: 1px solid #284172;
      border-radius: 12px;
      background: rgba(10, 20, 44, 0.8);
      padding: 8px;
    }
    .stat b { color: #dff0ff; display: block; margin-top: 2px; font-size: 13px; }
    textarea {
      width: 100%;
      min-height: 122px;
      resize: vertical;
      border-radius: 12px;
      border: 1px solid #2c4b81;
      background: rgba(6, 14, 31, 0.95);
      color: #fff;
      padding: 11px;
      outline: none;
      font-size: 14px;
    }
    textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(92,200,255,0.16); }
    button {
      border: 0;
      border-radius: 11px;
      padding: 10px 12px;
      color: #fff;
      font-weight: 600;
      background: linear-gradient(135deg, #157ad8, #2e8eff);
    }
    button.alt {
      background: #2c3f68;
      color: #d6e7ff;
    }
    button:hover { filter: brightness(1.05); }
    .grid4 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 8px;
    }
    .session {
      border: 1px solid #284172;
      background: rgba(8, 16, 35, 0.84);
      border-radius: 12px;
      padding: 10px;
    }
    .session.active { border-color: #4ca9ff; background: rgba(13, 31, 62, 0.9); }
    .rowBetween { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .sessionTitle { font-weight: 700; color: #e8f1ff; font-size: 14px; word-break: break-word; }
    .sessionMeta { margin-top: 3px; font-size: 12px; color: var(--muted); }
    .openBtn { margin-top: 8px; padding: 6px 9px; font-size: 12px; border-radius: 9px; }
    .workCard {
      border: 1px solid #2d4f89;
      border-radius: 13px;
      background: rgba(10, 22, 48, 0.9);
      padding: 10px;
      margin-bottom: 8px;
    }
    .workTitle { font-size: 14px; font-weight: 700; color: #e7f4ff; }
    .mutedLabel { color: #9fb3da; font-size: 11px; }
    .workSummary { margin-top: 6px; color: #d0dcf1; font-size: 13px; white-space: pre-wrap; }
    .workUpdates { margin: 8px 0 0; padding-left: 16px; color: #d0dcf1; }
    .workUpdates li { margin-bottom: 5px; }
    .messages, .activity { max-height: 320px; overflow: auto; padding-right: 2px; }
    .msg {
      border: 1px solid #34558e;
      border-radius: 12px;
      background: rgba(8, 17, 37, 0.9);
      padding: 9px 10px;
      margin-bottom: 8px;
    }
    .msg.user { border-color: #3f6eb9; background: rgba(18, 34, 62, 0.9); }
    .msg.assistant { border-color: #2e7f68; background: rgba(11, 36, 35, 0.85); }
    .msg.system { border-color: #7f6f33; background: rgba(36, 32, 13, 0.85); }
    .msgRole { font-size: 11px; color: #9db2d8; margin-bottom: 4px; }
    .msgText { white-space: pre-wrap; word-break: break-word; color: #e8f0ff; font-size: 13px; }
    .fileRow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border: 1px solid #274373;
      background: rgba(7, 14, 29, 0.85);
      border-radius: 11px;
      padding: 8px 10px;
      margin-bottom: 7px;
    }
    .filePath { flex: 1; min-width: 0; word-break: break-word; font-size: 13px; color: #dbe8ff; }
    .badge {
      border-radius: 999px;
      font-size: 11px;
      padding: 3px 8px;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .badge.added { background: rgba(47,184,132,.15); border-color: rgba(47,184,132,.35); color: #97f1c8; }
    .badge.modified { background: rgba(92,200,255,.14); border-color: rgba(92,200,255,.35); color: #b8e8ff; }
    .badge.deleted { background: rgba(241,111,127,.15); border-color: rgba(241,111,127,.35); color: #ffc3cb; }
    .logItem {
      border: 1px solid #24406d;
      border-radius: 11px;
      background: rgba(8, 14, 31, 0.85);
      padding: 8px 10px;
      margin-bottom: 7px;
    }
    .logItem.error { border-color: rgba(241,111,127,.6); background: rgba(60, 18, 30, 0.5); color: #ffd1d6; }
    .logMeta { font-size: 11px; color: #9ab0d9; margin-bottom: 4px; }
    .logText { font-size: 13px; color: #e5efff; white-space: pre-wrap; word-break: break-word; }
    .miniList { display: grid; gap: 7px; }
    .miniItem {
      border: 1px solid #2a4677;
      border-radius: 10px;
      background: rgba(8, 14, 30, 0.82);
      padding: 8px 9px;
    }
    .miniMeta { font-size: 11px; color: #9cb0d5; margin-bottom: 3px; }
    .miniText { font-size: 13px; color: #e8f0ff; white-space: pre-wrap; word-break: break-word; }
    .miniItem.warn { border-color: rgba(240,180,41,.55); background: rgba(66, 50, 12, 0.45); }
    .miniItem.ok { border-color: rgba(47,184,132,.5); background: rgba(13, 44, 35, 0.45); }
    .error {
      margin-top: 8px;
      color: #ffc1ca;
      font-size: 12px;
      border: 1px solid rgba(241,111,127,.45);
      border-radius: 10px;
      background: rgba(64, 17, 29, 0.45);
      padding: 7px 9px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .empty {
      border: 1px dashed #355285;
      border-radius: 11px;
      color: #9eb2d8;
      text-align: center;
      padding: 12px;
      font-size: 12px;
      background: rgba(9, 18, 39, 0.6);
    }
    .chatShell { display: grid; gap: 10px; }
    .chatTop {
      border: 1px solid #2f4a7d;
      border-radius: 12px;
      padding: 10px;
      background: rgba(10, 20, 44, 0.75);
      display: grid;
      gap: 8px;
    }
    .topLine {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .chatToolbar {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 8px;
    }
    .chatComposerActions {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .composerMeta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      color: #aac0e6;
    }
    .composerInput {
      width: 100%;
      min-height: 76px;
      max-height: 136px;
      resize: vertical;
      border-radius: 14px;
      border: 1px solid #2c4b81;
      background: rgba(10, 18, 36, 0.95);
      color: #fff;
      padding: 11px;
      outline: none;
      font-size: 14px;
    }
    .composerSend {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
    }
    .composerDock {
      border-top: 1px solid #24406d;
      background: linear-gradient(180deg, rgba(8, 16, 34, 0.75), rgba(6, 12, 26, 0.94));
      border-radius: 0 0 14px 14px;
      padding-top: 10px;
    }
    .compactBtn { padding: 9px 10px; }
    .dangerBtn {
      background: linear-gradient(135deg, #9a2f45, #be3d57);
    }
    .hidden { display: none !important; }
    #panel-control .chatShell {
      display: flex;
      flex-direction: column;
      gap: 10px;
      height: calc(100vh - 180px);
      min-height: 520px;
    }
    #panel-control #chatMessages {
      flex: 1;
      min-height: 0;
      height: auto;
      max-height: none;
      overflow: auto;
    }
    @media (min-width: 760px) {
      .panel.active { grid-template-columns: 1.15fr 1fr; }
      .panel.active .span2 { grid-column: 1 / -1; }
      .messages, .activity { max-height: 520px; }
      .chatToolbar { grid-template-columns: 220px 1fr auto; }
      #panel-control .chatShell {
        height: calc(100vh - 170px);
        min-height: 560px;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="titleRow">
      <div>
        <div class="title">Antigravity Remote</div>
        <div id="status" class="statusMeta">Connecting...</div>
      </div>
      <span id="procPill" class="pill ok">idle</span>
    </div>
  </header>
  <div class="wrap">
    <nav class="tabs">
      <button class="tabBtn active" data-tab="control">Chat</button>
      <button class="tabBtn" data-tab="sessions">Sessions</button>
      <button class="tabBtn" data-tab="config">Config</button>
      <button class="tabBtn" data-tab="intro">Giới thiệu</button>
    </nav>

    <section class="panel" id="panel-intro">
    <section class="card span2">
      <div class="cardTitle"><span>Giới thiệu</span></div>
      <div class="workSummary"><b>Antigravity Remote</b> giúp điều khiển và theo dõi Antigravity realtime từ mobile/LAN.</div>
      <div class="workSummary"><b>Tác giả:</b> Nguyễn Lê Trường</div>
      <ul class="workUpdates">
        <li>Mở tab <b>Chat</b> để xem stream realtime và gửi prompt.</li>
        <li>Chọn <b>Planning</b> + <b>Model</b> rồi bấm <b>Send Prompt</b>.</li>
        <li>Bấm <b>Stop</b> để dừng phiên chạy hiện tại bất cứ lúc nào.</li>
        <li>Theo dõi activity feed và file thay đổi ở phần theo dõi realtime.</li>
      </ul>
    </section>
    </section>

    <section class="panel active" id="panel-control">
    <section class="card span2 chatShell">
      <div class="chatTop">
        <div class="topLine">
          <div id="activeTitle" class="activeTitle" style="margin:0;">-</div>
          <span id="procPillInline" class="pill ok">idle</span>
        </div>
        <div class="chatToolbar">
          <select id="planningSelect" class="cfgInput" style="margin:0;">
            <option value="normal">Normal</option>
            <option value="conversational">Planning</option>
          </select>
          <select id="modelSelect" class="cfgInput" style="margin:0;">
            <option value="">Default model</option>
          </select>
          <button id="stopRun" class="compactBtn dangerBtn" style="min-width:110px;">Stop</button>
        </div>
      </div>

      <div class="cardTitle"><span>Chat Stream (Realtime)</span><span id="chatCount" class="small">0</span></div>
      <div id="chatMessages" class="messages"></div>

      <section id="approvalCard" class="hidden">
        <div class="cardTitle"><span>Approvals</span></div>
        <div class="grid4">
          <button id="accept">Accept Step</button>
          <button id="reject" class="alt">Reject Step</button>
          <button id="acceptTerm">Accept Terminal</button>
          <button id="rejectTerm" class="alt">Reject Terminal</button>
        </div>
      </section>

      <div class="composerDock">
        <div class="composerMeta">
          <span id="activeSessionBottom" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">-</span>
          <span id="composerRealtime" class="small">realtime</span>
        </div>
        <textarea id="prompt" class="composerInput" placeholder="Ask anything, @ to mention, / for workflows"></textarea>
        <div class="composerSend">
          <button id="send" class="compactBtn">Send Prompt</button>
          <button id="openControl" class="compactBtn alt">Chat</button>
        </div>
      </div>

      <div id="lastError" class="error" style="display:none;"></div>
    </section>
    </section>

    <section class="panel" id="panel-sessions">
    <section class="card">
      <div class="cardTitle"><span>Sessions</span><span id="sessionsCount" class="small">0</span></div>
      <ul id="sessions" class="list"></ul>
    </section>

    <section class="card">
      <div class="cardTitle"><span>Work Cards</span><span class="small">live</span></div>
      <div id="workCards"></div>
    </section>
    </section>

    <section class="panel" id="panel-live">
    <section class="card span2">
      <div class="cardTitle"><span>Giới thiệu nhanh</span></div>
      <div class="workSummary"><b>Tác giả:</b> Nguyễn Lê Trường</div>
      <div class="workSummary">Realtime hiển thị hoạt động bot theo thời gian thực, phục vụ giám sát và điều khiển từ xa.</div>
    </section>

    <section class="card">
      <div class="cardTitle"><span>Changed Files</span><span id="changesCount" class="small">0</span></div>
      <div id="changes"></div>
    </section>

    <section class="card span2">
      <div class="cardTitle"><span>Raw Activity Feed</span><span id="activityCount" class="small">0</span></div>
      <div id="activity" class="activity"></div>
    </section>
    </section>

    <section class="panel" id="panel-config">
      <section class="card span2">
        <div class="cardTitle"><span>Mobile Config</span></div>
        <div class="small" style="margin-bottom:8px;">Server: <b id="cfgServer" style="color:#dff0ff;"></b></div>
        <div class="small" style="margin-bottom:8px;">Token: <b id="cfgToken" style="color:#dff0ff;"></b></div>
        <label class="small" for="cfgActor">Actor Name (who sends/accepts)</label>
        <input id="cfgActor" class="cfgInput" placeholder="e.g. iPhone-Truong" />
        <div class="small" style="margin-bottom:8px;">Tu dong phe duyet:</div>
        <div class="grid4" style="margin-bottom:10px;">
          <button id="toggleAutoStep" class="alt">Auto Accept Step: OFF</button>
          <button id="toggleAutoTerminal" class="alt">Auto Accept Terminal: OFF</button>
        </div>
        <div class="small" style="margin-bottom:10px;">Auto refresh: <b style="color:#dff0ff;">WebSocket live stream</b></div>
        <div class="grid4">
          <button id="refreshNow">Refresh Now</button>
          <button id="copyLink" class="alt">Copy Pair Link</button>
          <button id="resetPrompt" class="alt">Clear Prompt Box</button>
          <button id="gotoControl" class="alt">Back To Control</button>
        </div>
      </section>
    </section>
  </div>

<script>
const q = new URLSearchParams(location.search);
const token = q.get('token') || '';
const statusEl = document.getElementById('status');
const procPillEl = document.getElementById('procPill');
const procPillInlineEl = document.getElementById('procPillInline');
const sessionsEl = document.getElementById('sessions');
const activeTitleEl = document.getElementById('activeTitle');
const lastErrorEl = document.getElementById('lastError');
const activityEl = document.getElementById('activity');
const chatMessagesEl = document.getElementById('chatMessages');
const changesEl = document.getElementById('changes');
const workCardsEl = document.getElementById('workCards');
const sessionsCountEl = document.getElementById('sessionsCount');
const chatCountEl = document.getElementById('chatCount');
const changesCountEl = document.getElementById('changesCount');
const activityCountEl = document.getElementById('activityCount');
const activeSessionBottomEl = document.getElementById('activeSessionBottom');
const approvalCardEl = document.getElementById('approvalCard');
const cfgServerEl = document.getElementById('cfgServer');
const cfgTokenEl = document.getElementById('cfgToken');
const cfgActorEl = document.getElementById('cfgActor');
const promptEl = document.getElementById('prompt');
const modelSelectEl = document.getElementById('modelSelect');
const planningSelectEl = document.getElementById('planningSelect');
const composerRealtimeEl = document.getElementById('composerRealtime');
const toggleAutoStepEl = document.getElementById('toggleAutoStep');
const toggleAutoTerminalEl = document.getElementById('toggleAutoTerminal');
const tabButtons = Array.from(document.querySelectorAll('.tabBtn'));
const tabPanels = {
  intro: document.getElementById('panel-intro'),
  control: document.getElementById('panel-control'),
  sessions: document.getElementById('panel-sessions'),
  live: document.getElementById('panel-live'),
  config: document.getElementById('panel-config')
};

function escapeHtml(input) {
  return String(input ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function roleClass(role) {
  const value = String(role || '').toLowerCase();
  if (value === 'user') return 'user';
  if (value === 'assistant') return 'assistant';
  if (value === 'system') return 'system';
  return '';
}

function statusClass(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'ADD' || value === 'ADDED') return 'added';
  if (value === 'DEL' || value === 'DELETE' || value === 'DELETED' || value === 'REMOVE' || value === 'REMOVED') return 'deleted';
  return 'modified';
}

function setEmpty(container, text) {
  container.innerHTML = '<div class="empty">' + escapeHtml(text) + '</div>';
}

function formatActor(raw) {
  const value = String(raw || '').trim();
  return value ? value.slice(0, 48) : 'mobile';
}

function loadActor() {
  try {
    return formatActor(localStorage.getItem('ag_remote_actor'));
  } catch (_) {
    return 'mobile';
  }
}

function saveActor(value) {
  try {
    localStorage.setItem('ag_remote_actor', formatActor(value));
  } catch (_) {}
}

function approvalPendingItems(state) {
  const entries = [];
  for (const card of (state.workCards || [])) {
    const updates = Array.isArray(card.updates) ? card.updates : [];
    for (const update of updates) {
      const text = String(update || '').trim();
      const low = text.toLowerCase();
      if ((low.includes('wait') || low.includes('approval') || low.includes('confirm') || low.includes('terminal')) &&
          !low.includes('approved') && !low.includes('rejected')) {
        entries.push({ at: card.updatedAt || state.updatedAt, text });
      }
    }
  }

  for (const item of (state.activityLog || [])) {
    const text = String(item.message || '').trim();
    const low = text.toLowerCase();
    if ((low.includes('waiting') || low.includes('approval') || low.includes('pending')) &&
        !low.includes('approved') && !low.includes('rejected')) {
      entries.push({ at: item.at, text });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const item of entries) {
    const key = item.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.slice(0, 8);
}

function recentActionItems(state) {
  const list = [];
  for (const item of (state.activityLog || [])) {
    const text = String(item.message || '');
    const low = text.toLowerCase();
    if (
      low.includes('prompt sent') ||
      low.includes('approved') ||
      low.includes('rejected') ||
      low.includes('switched session') ||
      low.includes('compatibility action succeeded')
    ) {
      list.push({
        at: item.at,
        text,
        level: item.level === 'error' ? 'warn' : (low.includes('approved') ? 'ok' : ''),
      });
    }
  }
  return list.slice(0, 10);
}

function shouldShowActivityInChat(text) {
  const low = String(text || '').toLowerCase();
  if (!low) return false;
  if (low.includes('ls token') || low.includes('csrf') || low.includes('bridge') || low.includes('404')) return false;
  if (low.includes('prompt sent') || low.includes('approved') || low.includes('rejected')) return true;
  if (low.includes('step:+') || low.includes('list directory') || low.includes('switched session')) return true;
  if (low.includes('terminal') || low.includes('waiting') || low.includes('pending')) return true;
  return false;
}

function buildChatItems(state) {
  const items = [];
  const hasAssistantMessage = (state.messages || []).some((m) => roleClass(m.role || 'unknown') === 'assistant');
  for (const m of (state.messages || [])) {
    const role = roleClass(m.role || 'unknown') || 'system';
    items.push({
      role,
      at: m.at || state.updatedAt,
      text: String(m.text || ''),
      source: 'message'
    });
  }
  for (const a of (state.activityLog || [])) {
    if (!shouldShowActivityInChat(a.message)) continue;
    if (hasAssistantMessage && /\bstep\(s\)\b|\bstep:\+\d+/.test(String(a.message || '').toLowerCase())) continue;
    items.push({
      role: 'system',
      at: a.at || state.updatedAt,
      text: String(a.message || ''),
      source: 'activity'
    });
  }
  items.sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.role + ':' + item.text;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.slice(-80);
}

function setActiveTab(tab) {
  for (const btn of tabButtons) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  for (const key of Object.keys(tabPanels)) {
    const panel = tabPanels[key];
    if (!panel) continue;
    panel.classList.toggle('active', key === tab);
  }
}

async function sendCommand(type, extra = {}) {
  const actor = formatActor(cfgActorEl && cfgActorEl.value ? cfgActorEl.value : loadActor());
  const res = await fetch('/command?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, actor, ...extra })
  });
  if (!res.ok) {
    const msg = await res.text();
    alert('Command failed: ' + msg);
  }
}

document.getElementById('send').onclick = async () => {
  const text = promptEl.value.trim();
  if (!text) return;
  const model = String(modelSelectEl.value || '').trim();
  const planner = String(planningSelectEl && planningSelectEl.value ? planningSelectEl.value : 'normal');
  await sendCommand('sendPrompt', { text, model, planner });
  promptEl.value = '';
};
document.getElementById('accept').onclick = () => sendCommand('acceptStep');
document.getElementById('reject').onclick = () => sendCommand('rejectStep');
document.getElementById('acceptTerm').onclick = () => sendCommand('acceptTerminal');
document.getElementById('rejectTerm').onclick = () => sendCommand('rejectTerminal');
document.getElementById('stopRun').onclick = () => sendCommand('stop');
document.getElementById('refreshNow').onclick = () => location.reload();
document.getElementById('resetPrompt').onclick = () => { promptEl.value = ''; };
document.getElementById('gotoControl').onclick = () => setActiveTab('control');
document.getElementById('openControl').onclick = () => setActiveTab('control');
document.getElementById('copyLink').onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    alert('Copied pair link');
  } catch (_) {
    alert('Copy failed');
  }
};
if (toggleAutoStepEl) {
  toggleAutoStepEl.onclick = async () => {
    const enabled = !/ON$/i.test(String(toggleAutoStepEl.textContent || ''));
    await sendCommand('setAutoApproveStep', { enabled });
  };
}
if (toggleAutoTerminalEl) {
  toggleAutoTerminalEl.onclick = async () => {
    const enabled = !/ON$/i.test(String(toggleAutoTerminalEl.textContent || ''));
    await sendCommand('setAutoApproveTerminal', { enabled });
  };
}
for (const btn of tabButtons) {
  btn.onclick = () => setActiveTab(btn.dataset.tab || 'control');
}
cfgActorEl.value = loadActor();
cfgActorEl.addEventListener('change', () => {
  cfgActorEl.value = formatActor(cfgActorEl.value);
  saveActor(cfgActorEl.value);
});
promptEl.addEventListener('keydown', async (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    await document.getElementById('send').onclick();
  }
});
modelSelectEl.addEventListener('change', async () => {
  const model = String(modelSelectEl.value || '').trim();
  if (!model) return;
  await sendCommand('setModel', { model });
});
if (planningSelectEl) {
  planningSelectEl.addEventListener('change', async () => {
    const planner = planningSelectEl.value === 'conversational' ? 'conversational' : 'normal';
    await sendCommand('setPlanner', { planner });
  });
}
cfgServerEl.textContent = location.origin;
cfgTokenEl.textContent = token ? (token.slice(0, 6) + '...' + token.slice(-4)) : '(none)';

function render(state) {
  statusEl.textContent = state.status + ' | active: ' + (state.activeSessionId || '-');
  procPillEl.textContent = state.processing ? 'running' : 'idle';
  procPillEl.className = 'pill ' + (state.processing ? 'busy' : 'ok');
  if (procPillInlineEl) {
    procPillInlineEl.textContent = state.processing ? 'running' : 'idle';
    procPillInlineEl.className = 'pill ' + (state.processing ? 'busy' : 'ok');
  }
  if (composerRealtimeEl) {
    composerRealtimeEl.textContent = state.processing ? 'realtime: running' : 'realtime: idle';
  }
  if (toggleAutoStepEl) {
    const on = Boolean(state.autoApproveStep);
    toggleAutoStepEl.textContent = 'Auto Accept Step: ' + (on ? 'ON' : 'OFF');
    toggleAutoStepEl.className = on ? '' : 'alt';
  }
  if (toggleAutoTerminalEl) {
    const on = Boolean(state.autoApproveTerminal);
    toggleAutoTerminalEl.textContent = 'Auto Accept Terminal: ' + (on ? 'ON' : 'OFF');
    toggleAutoTerminalEl.className = on ? '' : 'alt';
  }
  const activeTitle = state.activeSessionTitle || '(none)';
  activeTitleEl.textContent = activeTitle;
  activeSessionBottomEl.textContent = activeTitle;
  if (state.lastError) {
    lastErrorEl.style.display = 'block';
    lastErrorEl.textContent = 'Error: ' + state.lastError;
  } else {
    lastErrorEl.style.display = 'none';
    lastErrorEl.textContent = '';
  }

  sessionsEl.innerHTML = '';
  const sessions = state.sessions || [];
  sessionsCountEl.textContent = String(sessions.length);
  if (!sessions.length) {
    setEmpty(sessionsEl, 'No sessions detected yet.');
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'session' + (s.id === state.activeSessionId ? ' active' : '');

    const when = s.lastModifiedTime ? new Date(s.lastModifiedTime).toLocaleTimeString() : '-';
    li.innerHTML =
      '<div class="rowBetween">' +
        '<div>' +
          '<div class="sessionTitle">' + escapeHtml(s.title || 'Untitled conversation') + '</div>' +
          '<div class="sessionMeta">#' + escapeHtml(s.stepCount ?? 0) + ' step(s) • updated ' + escapeHtml(when) + '</div>' +
        '</div>' +
      '</div>';

    const btn = document.createElement('button');
    btn.textContent = s.id === state.activeSessionId ? 'Opened' : 'Open';
    btn.onclick = () => sendCommand('focusSession', { sessionId: s.id });
    btn.className = 'alt openBtn';
    li.appendChild(btn);
    sessionsEl.appendChild(li);
  }

  const pending = approvalPendingItems(state);
  if (approvalCardEl) {
    approvalCardEl.classList.toggle('hidden', pending.length === 0);
  }

  const modelOptions = Array.isArray(state.modelOptions) ? state.modelOptions : [];
  const selectedModel = String(state.selectedModel || '').trim();
  if (modelSelectEl) {
    const previous = modelSelectEl.value;
    modelSelectEl.innerHTML = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default model';
    modelSelectEl.appendChild(defaultOption);
    for (const m of modelOptions) {
      const option = document.createElement('option');
      option.value = String(m.id || '');
      option.textContent = String(m.name || m.id || '');
      modelSelectEl.appendChild(option);
    }
    modelSelectEl.value = selectedModel || previous || '';
  }

  if (planningSelectEl) {
    const planner = state.selectedPlanner === 'conversational' ? 'conversational' : 'normal';
    planningSelectEl.value = planner;
  }

  chatMessagesEl.innerHTML = '';
  const chatItems = buildChatItems(state);
  chatCountEl.textContent = String(chatItems.length);
  if (!chatItems.length) {
    setEmpty(chatMessagesEl, 'No chat yet. Send prompt to start realtime conversation.');
  }
  for (const m of chatItems) {
    const box = document.createElement('div');
    const role = (m.role || 'system');
    box.className = 'msg ' + role;
    const at = m.at ? new Date(m.at).toLocaleTimeString() : '';
    box.innerHTML =
      '<div class="msgRole">' + escapeHtml(String(role).toUpperCase()) + (at ? ' • ' + escapeHtml(at) : '') + '</div>' +
      '<div class="msgText">' + escapeHtml(m.text || '') + '</div>';
    chatMessagesEl.appendChild(box);
  }
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  workCardsEl.innerHTML = '';
  const workCards = state.workCards || [];
  if (!workCards.length) {
    setEmpty(workCardsEl, 'No work cards available.');
  }
  for (const c of workCards) {
    const box = document.createElement('div');
    box.className = 'workCard';
    const at = c.updatedAt ? new Date(c.updatedAt).toLocaleTimeString() : '-';
    const updates = (c.updates || []).slice(0, 6).map(u => '<li>' + escapeHtml(u) + '</li>').join('');
    box.innerHTML =
      '<div class="workTitle">' + escapeHtml(c.title || 'Work Card') + '</div>' +
      '<div class="mutedLabel">' + escapeHtml(c.source || 'derived') + ' • ' + escapeHtml(at) + '</div>' +
      (c.summary ? '<div class="workSummary">' + escapeHtml(c.summary) + '</div>' : '') +
      (updates ? '<ul class="workUpdates">' + updates + '</ul>' : '');
    workCardsEl.appendChild(box);
  }

  changesEl.innerHTML = '';
  const changedFiles = state.changedFiles || [];
  changesCountEl.textContent = String(changedFiles.length);
  if (!changedFiles.length) {
    setEmpty(changesEl, 'No changed files reported.');
  }
  for (const f of changedFiles) {
    const row = document.createElement('div');
    const cls = statusClass(f.status);
    const churn = (Number.isFinite(f.added) || Number.isFinite(f.removed))
      ? (' (+' + (f.added ?? 0) + ' / -' + (f.removed ?? 0) + ')')
      : '';
    row.className = 'fileRow';
    row.innerHTML =
      '<div class="filePath">' + escapeHtml(f.path || '') + '<span class="small">' + escapeHtml(churn) + '</span></div>' +
      '<span class="badge ' + cls + '">' + escapeHtml(f.status || '?') + '</span>';
    changesEl.appendChild(row);
  }

  activityEl.innerHTML = '';
  const activity = state.activityLog || [];
  activityCountEl.textContent = String(activity.length);
  if (!activity.length) {
    setEmpty(activityEl, 'No activity yet.');
  }
  for (const item of activity) {
    const li = document.createElement('div');
    const at = new Date(item.at).toLocaleTimeString();
    li.className = 'logItem';
    li.innerHTML =
      '<div class="logMeta">[' + escapeHtml(at) + '] ' + escapeHtml(item.level || 'info').toUpperCase() + '</div>' +
      '<div class="logText">' + escapeHtml(item.message || '') + '</div>';
    if (item.level === 'error') li.classList.add('error');
    activityEl.appendChild(li);
  }

}

const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(wsProto + '://' + location.host + '/ws?token=' + encodeURIComponent(token));
ws.onopen = () => { statusEl.textContent = 'connected'; };
ws.onclose = () => { statusEl.textContent = 'disconnected'; };
ws.onmessage = (evt) => {
  const msg = JSON.parse(evt.data);
  if (msg.type === 'state') render(msg.payload);
};
</script>
</body>
</html>`;
    }
}

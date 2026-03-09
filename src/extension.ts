import * as crypto from 'crypto';
import { exec as execCb } from 'child_process';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import QRCode from 'qrcode';
import WebSocket from 'ws';
import { AntigravitySDK, ITrajectoryEntry } from 'antigravity-sdk';
import { RelayServer, RemoteFileChange, RemoteMessage, RemoteModelOption, RemoteSession, RemoteWorkCard } from './relayServer';

const execAsync = promisify(execCb);

let controller: RemoteController | null = null;

class RemoteController implements vscode.Disposable {
    private relay: RelayServer | null = null;
    private sdkReady = false;
    private lastProgressAt = 0;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly pollIntervals: NodeJS.Timeout[] = [];
    private readonly output = vscode.window.createOutputChannel('Antigravity Remote');
    private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    private currentActiveSessionId = '';
    private currentActiveSessionTitle = '';
    private csrfFailureCount = 0;
    private lastLsRestartAt = 0;
    private lsConversationUnsupported = false;
    private lsTrajectoryApiDetected = false;
    private cdpConversationDetected = false;
    private cdpConnection: {
        ws: WebSocket;
        call: (method: string, params?: unknown) => Promise<unknown>;
        contexts: Array<{ id: number }>;
    } | null = null;
    private lastConversationErrorLogAt = 0;
    private lastPartialTranscriptWarnAt = 0;
    private recentStepUpdates: string[] = [];
    private selectedModel = '';
    private selectedPlanner: 'normal' | 'conversational' = 'normal';
    private autoApproveStepEnabled = false;
    private autoApproveTerminalEnabled = false;
    private lastAutoApproveStepAt = 0;
    private lastAutoApproveTerminalAt = 0;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly sdk: AntigravitySDK,
    ) {
        this.statusBar.command = 'antigravityRemote.showConnectInfo';
        this.statusBar.text = '$(radio-tower) AG Remote: off';
        this.statusBar.tooltip = 'Antigravity Remote relay is stopped';
        this.statusBar.show();
    }

    async start(): Promise<void> {
        if (this.relay) {
            return;
        }

        await this.ensureSdkInitialized();

        const cfg = vscode.workspace.getConfiguration('antigravityRemote');
        const host = cfg.get<string>('host', '0.0.0.0');
        const preferredPort = cfg.get<number>('port', 4317);
        const token = await this.getOrCreateToken();
        const candidatePorts = [preferredPort, preferredPort + 1, preferredPort + 2, preferredPort + 3, preferredPort + 4];
        let lastError: unknown = null;

        for (const port of candidatePorts) {
            const candidate = this.createRelay(host, port, token);
            candidate.updateState({ status: 'starting', lastEvent: 'relay_booting' });
            try {
                await candidate.start();
                this.relay = candidate;
                break;
            } catch (error) {
                lastError = error;
                candidate.stop();
                this.output.appendLine(`Relay start failed on ${host}:${port} -> ${String(error)}`);
            }
        }

        if (!this.relay) {
            this.updateStatusBar('error');
            throw new Error(`Unable to start relay on ports ${candidatePorts.join(', ')}. Last error: ${String(lastError)}`);
        }

        this.relay.updateState({ status: 'ready', lastEvent: 'relay_started' });
        this.relay.addActivity('Relay started and connected to Antigravity');
        this.bindSdkEvents();
        await this.refreshSessions();
        await this.refreshConversationAndDiff();
        this.updateStatusBar('ready');

        const primaryUrl = this.relay.getConnectUrls()[0] ?? '(no url)';
        this.output.appendLine(`Relay started at ${primaryUrl}`);
        vscode.window.showInformationMessage(`Antigravity Remote relay started: ${primaryUrl}`);
    }

    stop(): void {
        for (const timer of this.pollIntervals) {
            clearInterval(timer);
        }
        this.pollIntervals.length = 0;

        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }

        try {
            this.cdpConnection?.ws.close();
        } catch {
            // ignore close errors
        }
        this.cdpConnection = null;

        this.relay?.stop();
        this.relay = null;
        this.updateStatusBar('off');
    }

    async showConnectInfo(): Promise<void> {
        if (!this.relay) {
            vscode.window.showWarningMessage('Relay is not running. Start it first.');
            return;
        }

        const urls = this.relay.getConnectUrls();
        const pick = await vscode.window.showQuickPick(urls, {
            title: 'Antigravity Remote URLs (same Wi-Fi)',
            placeHolder: 'Choose a URL to copy',
        });

        if (pick) {
            await vscode.env.clipboard.writeText(pick);
            vscode.window.showInformationMessage('Remote URL copied to clipboard.');
        }
    }

    async showPairingQr(): Promise<void> {
        if (!this.relay) {
            vscode.window.showWarningMessage('Relay is not running. Start it first.');
            return;
        }

        const url = this.relay.getConnectUrls()[0];
        if (!url) {
            vscode.window.showErrorMessage('No relay URL available.');
            return;
        }

        const qrDataUrl = await QRCode.toDataURL(url, { width: 360, margin: 1 });
        const panel = vscode.window.createWebviewPanel(
            'antigravityRemotePairQr',
            'Antigravity Remote Pairing QR',
            vscode.ViewColumn.One,
            { enableScripts: false },
        );

        panel.webview.html = `<!doctype html>
<html>
  <body style="font-family: sans-serif; padding: 16px;">
    <h2>Pair phone on same Wi-Fi</h2>
    <p>Open camera app and scan this QR.</p>
    <img src="${qrDataUrl}" alt="Pairing QR" style="width: 280px; height: 280px;" />
    <p><code>${url}</code></p>
  </body>
</html>`;
    }

    async resetToken(): Promise<void> {
        const answer = await vscode.window.showWarningMessage(
            'Reset token? Existing paired URLs will stop working.',
            { modal: true },
            'Reset',
        );

        if (answer !== 'Reset') {
            return;
        }

        const token = crypto.randomBytes(16).toString('hex');
        await this.context.globalState.update('antigravityRemote.token', token);

        const wasRunning = Boolean(this.relay);
        if (wasRunning) {
            this.stop();
            await this.start();
        }

        vscode.window.showInformationMessage('Pairing token reset complete.');
    }

    dispose(): void {
        this.stop();
        this.statusBar.dispose();
        this.output.dispose();
    }

    private updateStatusBar(state: 'off' | 'ready' | 'error'): void {
        if (state === 'ready') {
            this.statusBar.text = '$(radio-tower) AG Remote: on';
            this.statusBar.backgroundColor = undefined;
            this.statusBar.tooltip = 'Antigravity Remote relay is running';
            return;
        }

        if (state === 'error') {
            this.statusBar.text = '$(warning) AG Remote: error';
            this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            this.statusBar.tooltip = 'Antigravity Remote relay encountered an error';
            return;
        }

        this.statusBar.text = '$(radio-tower) AG Remote: off';
        this.statusBar.backgroundColor = undefined;
        this.statusBar.tooltip = 'Antigravity Remote relay is stopped';
    }

    private bindSdkEvents(): void {
        const onStep = this.sdk.monitor.onStepCountChanged((event) => {
            this.lastProgressAt = Date.now();
            const updateLine = `${event.title}: +${event.delta} step(s)`;
            this.recentStepUpdates = [updateLine, ...this.recentStepUpdates].slice(0, 20);
            this.relay?.updateState({
                activeSessionId: event.sessionId,
                lastEvent: `step:+${event.delta}`,
                processing: true,
            });
            this.relay?.addActivity(updateLine);
            this.currentActiveSessionId = event.sessionId;
            void this.refreshConversationAndDiff();
            void this.refreshSessions();
        });

        const onActive = this.sdk.monitor.onActiveSessionChanged((event) => {
            this.relay?.updateState({
                activeSessionId: event.sessionId,
                lastEvent: `active:${event.title}`,
            });
            this.relay?.addActivity(`Active session: ${event.title}`);
            this.currentActiveSessionId = event.sessionId;
            this.currentActiveSessionTitle = event.title;
            void this.refreshConversationAndDiff();
        });

        const onNewConversation = this.sdk.monitor.onNewConversation(() => {
            this.relay?.updateState({ lastEvent: 'new_conversation' });
            this.relay?.addActivity('New conversation detected');
            void this.refreshSessions();
        });

        const onState = this.sdk.monitor.onStateChanged((event) => {
            this.relay?.addActivity(`State updated: ${event.key} (${event.previousSize} -> ${event.newSize})`);
        });

        this.disposables.push({ dispose: () => onStep.dispose() });
        this.disposables.push({ dispose: () => onActive.dispose() });
        this.disposables.push({ dispose: () => onNewConversation.dispose() });
        this.disposables.push({ dispose: () => onState.dispose() });

        this.sdk.monitor.start(1200, 1500);
        this.disposables.push({ dispose: () => this.sdk.monitor.stop() });

        const poll = setInterval(() => {
            void this.refreshSessions();
        }, 2500);
        this.pollIntervals.push(poll);

        const dataPoll = setInterval(() => {
            void this.refreshConversationAndDiff();
        }, 1200);
        this.pollIntervals.push(dataPoll);

        const processingGuard = setInterval(() => {
            if (!this.relay) {
                return;
            }
            const idleTooLong = Date.now() - this.lastProgressAt > 20000;
            if (idleTooLong) {
                this.relay.updateState({ processing: false });
            }
        }, 4000);
        this.pollIntervals.push(processingGuard);
    }

    private async ensureSdkInitialized(): Promise<void> {
        if (this.sdkReady) {
            return;
        }

        await this.sdk.initialize();
        this.sdkReady = true;
        if (!this.sdk.ls.isReady) {
            this.lsConversationUnsupported = true;
            this.relay?.addActivity('LS bridge unavailable on this setup, using diagnostics transcript fallback', 'warn');
        }
    }

    private createRelay(host: string, port: number, token: string): RelayServer {
        return new RelayServer(host, port, token, {
            onSendPrompt: async (text, model) => this.sendPromptCompat(text, model),
            onAcceptStep: async () => this.acceptStepCompat(),
            onRejectStep: async () => this.rejectStepCompat(),
            onAcceptTerminal: async () => this.acceptTerminalCompat(),
            onRejectTerminal: async () => this.rejectTerminalCompat(),
            onFocusSession: async (sessionId) => this.sdk.cascade.focusSession(sessionId),
            onSetModel: async (model) => this.setModelCompat(model),
            onSetPlanner: async (planner) => this.setPlannerCompat(planner),
            onSetAutoApproveStep: async (enabled) => this.setAutoApproveStepCompat(enabled),
            onSetAutoApproveTerminal: async (enabled) => this.setAutoApproveTerminalCompat(enabled),
            onStop: async () => this.stopActiveCompat(),
        });
    }

    private async sendPromptCompat(text: string, model?: string): Promise<void> {
        const preferredModel = (model ?? this.selectedModel).trim();
        if (preferredModel && this.currentActiveSessionId && this.sdk.ls.isReady) {
            const parsed = this.parseModelValue(preferredModel);
            try {
                await this.sdk.ls.sendMessage({
                    cascadeId: this.currentActiveSessionId,
                    text,
                    ...(parsed !== undefined ? { model: parsed } : {}),
                });
                this.selectedModel = preferredModel;
                this.relay?.updateState({ selectedModel: preferredModel });
                return;
            } catch (error) {
                this.output.appendLine(`ls.sendMessage with model failed, fallback to cascade.sendPrompt: ${String(error)}`);
            }
        }

        await this.sdk.cascade.sendPrompt(text);
    }

    private parseModelValue(raw: string): number | undefined {
        const value = raw.trim();
        if (!value) return undefined;
        const numeric = Number(value);
        if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
            return numeric;
        }
        return undefined;
    }

    private async setModelCompat(model: string): Promise<void> {
        const value = model.trim();
        if (!value) {
            return;
        }
        this.selectedModel = value;
        this.relay?.updateState({ selectedModel: value });
    }

    private async setPlannerCompat(planner: 'normal' | 'conversational'): Promise<void> {
        this.selectedPlanner = planner === 'conversational' ? 'conversational' : 'normal';
        this.relay?.updateState({ selectedPlanner: this.selectedPlanner });
    }

    private async setAutoApproveStepCompat(enabled: boolean): Promise<void> {
        this.autoApproveStepEnabled = enabled;
        this.relay?.updateState({ autoApproveStep: enabled });
    }

    private async setAutoApproveTerminalCompat(enabled: boolean): Promise<void> {
        this.autoApproveTerminalEnabled = enabled;
        this.relay?.updateState({ autoApproveTerminal: enabled });
    }

    private async stopActiveCompat(): Promise<void> {
        const errors: string[] = [];
        const tryStep = async (label: string, action: () => Promise<void>): Promise<boolean> => {
            try {
                await action();
                this.relay?.addActivity(`Stop action succeeded: ${label}`);
                return true;
            } catch (error) {
                const text = `${label}: ${String(error)}`;
                errors.push(text);
                this.output.appendLine(`Stop action ${text}`);
                return false;
            }
        };

        if (this.currentActiveSessionId && this.sdk.ls.isReady) {
            const ok = await tryStep('cancelCascade', () => this.sdk.ls.cancelCascade(this.currentActiveSessionId));
            if (ok) {
                return;
            }
        }

        const commandCandidates = [
            'antigravity.command.reject',
            'antigravity.terminalCommand.reject',
            'antigravity.agent.rejectAgentStep',
        ];
        for (const cmd of commandCandidates) {
            const ok = await tryStep(cmd, () => this.sdk.commands.execute(cmd));
            if (ok) {
                return;
            }
        }

        throw new Error(`Unable to stop current run: ${errors.join(' | ')}`);
    }

    private async acceptStepCompat(): Promise<void> {
        // Different Antigravity builds expose either "agent step" or generic "command" approvals.
        await this.runCompatChain('accept-step', [
            ['acceptStep', () => this.sdk.cascade.acceptStep()],
            ['acceptCommand', () => this.sdk.cascade.acceptCommand()],
        ]);
    }

    private async rejectStepCompat(): Promise<void> {
        await this.runCompatChain('reject-step', [
            ['rejectStep', () => this.sdk.cascade.rejectStep()],
            ['rejectCommand', () => this.sdk.cascade.rejectCommand()],
        ]);
    }

    private async acceptTerminalCompat(): Promise<void> {
        await this.runCompatChain('accept-terminal', [
            ['acceptTerminalCommand', () => this.sdk.cascade.acceptTerminalCommand()],
            ['runTerminalCommand', () => this.sdk.cascade.runTerminalCommand()],
            ['acceptCommand', () => this.sdk.cascade.acceptCommand()],
        ]);
    }

    private async rejectTerminalCompat(): Promise<void> {
        await this.runCompatChain('reject-terminal', [
            ['rejectTerminalCommand', () => this.sdk.cascade.rejectTerminalCommand()],
            ['rejectCommand', () => this.sdk.cascade.rejectCommand()],
        ]);
    }

    private async runCompatChain(
        label: string,
        steps: Array<[name: string, action: () => Promise<void>]>,
    ): Promise<void> {
        const errors: string[] = [];
        for (const [name, action] of steps) {
            try {
                await action();
                this.relay?.addActivity(`Compatibility action succeeded: ${name}`);
                return;
            } catch (error) {
                const text = `${name}: ${String(error)}`;
                errors.push(text);
                this.output.appendLine(`Cascade action ${text}`);
                this.relay?.addActivity(`Cascade ${text}`, 'warn');
            }
        }

        throw new Error(`No compatible command worked for ${label}. ${errors.join(' | ')}`);
    }

    private async refreshSessions(): Promise<void> {
        try {
            const [sessions, modelOptions] = await Promise.all([
                this.fetchSessionsWithDiagnosticsPriority(),
                this.fetchModelOptions(),
            ]);
            const normalized = sessions.map((s) => this.toRemoteSession(s));
            const active = this.sdk.monitor.activeSessionId || sessions[0]?.id || '';
            this.currentActiveSessionId = active;
            this.currentActiveSessionTitle = normalized.find((s) => s.id === active)?.title ?? '';
            const selectedModel = this.selectedModel
                || modelOptions.find((item) => item.active)?.id
                || modelOptions[0]?.id
                || '';
            this.selectedModel = selectedModel;
            this.relay?.updateState({
                status: 'ready',
                sessions: normalized,
                activeSessionId: active,
                activeSessionTitle: this.currentActiveSessionTitle,
                modelOptions,
                selectedModel,
                selectedPlanner: this.selectedPlanner,
                autoApproveStep: this.autoApproveStepEnabled,
                autoApproveTerminal: this.autoApproveTerminalEnabled,
            });
            this.updateStatusBar('ready');
        } catch (error) {
            this.relay?.updateState({
                status: 'error',
                lastError: String(error),
                lastEvent: 'refresh_failed',
                processing: false,
            });
            this.relay?.addActivity(`refreshSessions failed: ${String(error)}`, 'error');
            this.output.appendLine(`refreshSessions error: ${String(error)}`);
            this.updateStatusBar('error');
        }
    }

    private async fetchSessionsWithDiagnosticsPriority(): Promise<ITrajectoryEntry[]> {
        try {
            const diag = await this.sdk.cascade.getDiagnostics();
            const recent = (diag.raw as Record<string, unknown>).recentTrajectories;
            if (Array.isArray(recent) && recent.length > 0) {
                const mapped = recent.map((entry) => {
                    const obj = (entry ?? {}) as Record<string, unknown>;
                    return {
                        id: String(obj.googleAgentId ?? ''),
                        title: String(obj.summary ?? 'Untitled'),
                        stepCount: Number(obj.lastStepIndex ?? 0),
                        workspaceUri: '',
                        lastModifiedTime: String(obj.lastModifiedTime ?? ''),
                        trajectoryId: String(obj.trajectoryId ?? ''),
                    } as ITrajectoryEntry;
                }).filter((item) => item.id);
                if (mapped.length > 0) {
                    return mapped;
                }
            }
        } catch {
            // fall through to sdk.cascade.getSessions()
        }

        return this.sdk.cascade.getSessions();
    }

    private async fetchModelOptions(): Promise<RemoteModelOption[]> {
        try {
            const status = await this.sdk.ls.getUserStatus() as Record<string, unknown>;
            const listCandidates = [
                status.models,
                status.availableModels,
                status.allowedModels,
                status.modelConfigs,
            ];
            const rawList = listCandidates.find(Array.isArray) as unknown[] | undefined;
            if (!rawList || rawList.length === 0) {
                return this.fallbackModelOptions();
            }

            const activeModelRaw = status.currentModel ?? status.model ?? status.activeModel;
            const activeModel = typeof activeModelRaw === 'string' ? activeModelRaw : String(activeModelRaw ?? '');
            const out: RemoteModelOption[] = [];
            const seen = new Set<string>();
            for (const item of rawList) {
                if (!item || typeof item !== 'object') continue;
                const obj = item as Record<string, unknown>;
                const idRaw = obj.id ?? obj.modelId ?? obj.value ?? obj.name;
                const id = String(idRaw ?? '').trim();
                if (!id || seen.has(id)) continue;
                seen.add(id);
                const nameRaw = obj.name ?? obj.displayName ?? obj.label ?? id;
                const name = String(nameRaw ?? id).trim();
                const active = Boolean(obj.isActive)
                    || (activeModel.length > 0 && (activeModel === id || activeModel === name));
                out.push({ id, name, active });
            }
            if (out.length > 0) {
                return out.slice(0, 20);
            }
        } catch {
            // use fallback
        }

        return this.fallbackModelOptions();
    }

    private fallbackModelOptions(): RemoteModelOption[] {
        return [
            { id: '1018', name: 'Gemini Flash', active: this.selectedModel === '1018' },
            { id: '1020', name: 'Gemini Pro', active: this.selectedModel === '1020' },
            { id: '1021', name: 'Gemini Pro High', active: this.selectedModel === '1021' },
        ];
    }

    private async refreshConversationAndDiff(): Promise<void> {
        if (!this.relay) {
            return;
        }

        const [messages, changedFiles, workCards] = await Promise.all([
            this.fetchConversationMessages().catch((err) => {
                this.output.appendLine(`fetchConversationMessages error: ${String(err)}`);
                return [] as RemoteMessage[];
            }),
            this.fetchChangedFiles().catch((err) => {
                this.output.appendLine(`fetchChangedFiles error: ${String(err)}`);
                return [] as RemoteFileChange[];
            }),
            this.fetchWorkCards().catch((err) => {
                this.output.appendLine(`fetchWorkCards error: ${String(err)}`);
                return [] as RemoteWorkCard[];
            }),
        ]);

        this.relay.updateState({
            messages,
            changedFiles,
            workCards,
        });

        await this.runAutoApprovePass(messages, workCards);
    }

    private async runAutoApprovePass(messages: RemoteMessage[], workCards: RemoteWorkCard[]): Promise<void> {
        if (!this.autoApproveStepEnabled && !this.autoApproveTerminalEnabled) {
            return;
        }

        const textPool: string[] = [];
        for (const msg of messages) {
            if (!msg?.text) continue;
            textPool.push(msg.text);
        }
        for (const card of workCards) {
            if (card.summary) textPool.push(card.summary);
            for (const update of card.updates || []) {
                if (update) textPool.push(update);
            }
        }

        const blob = textPool.join('\n').toLowerCase();
        if (!blob) {
            return;
        }

        const hasPending =
            /(waiting|pending|approval|approve|confirm|human-in-the-loop|human in the loop|accept|reject)/.test(blob);
        if (!hasPending) {
            return;
        }

        const looksTerminal =
            /(terminal|shell|run command|terminal command|bash|zsh|command execution)/.test(blob);
        const now = Date.now();
        const cooldownMs = 1800;

        if (this.autoApproveTerminalEnabled && looksTerminal && now - this.lastAutoApproveTerminalAt > cooldownMs) {
            this.lastAutoApproveTerminalAt = now;
            try {
                await this.acceptTerminalCompat();
                this.relay?.addActivity('Auto accepted terminal command');
            } catch (error) {
                this.output.appendLine(`auto-accept terminal failed: ${String(error)}`);
            }
            return;
        }

        if (this.autoApproveStepEnabled && now - this.lastAutoApproveStepAt > cooldownMs) {
            this.lastAutoApproveStepAt = now;
            try {
                await this.acceptStepCompat();
                this.relay?.addActivity('Auto accepted step approval');
            } catch (error) {
                this.output.appendLine(`auto-accept step failed: ${String(error)}`);
            }
        }
    }

    private async fetchConversationMessages(): Promise<RemoteMessage[]> {
        if (!this.currentActiveSessionId) {
            return [];
        }

        if (!this.sdk.ls.isReady) {
            try {
                const ok = await this.sdk.ls.initialize();
                if (!ok || !this.sdk.ls.isReady) {
                    this.lsConversationUnsupported = true;
                    this.logConversationErrorOnce('LSBridge not initialized, switching to diagnostics fallback');
                    const fromDiag = await this.fetchMessagesFromDiagnostics();
                    if (fromDiag.length > 0) {
                        return fromDiag;
                    }
                    const fromTrace = await this.fetchMessagesFromTrace();
                    if (fromTrace.length > 0) {
                        return fromTrace;
                    }
                    return this.fetchExecutionTranscriptFallback();
                }
            } catch {
                this.lsConversationUnsupported = true;
                this.logConversationErrorOnce('LSBridge init failed, switching to diagnostics fallback');
                const fromDiag = await this.fetchMessagesFromDiagnostics();
                if (fromDiag.length > 0) {
                    return fromDiag;
                }
                const fromTrace = await this.fetchMessagesFromTrace();
                if (fromTrace.length > 0) {
                    return fromTrace;
                }
                return this.fetchExecutionTranscriptFallback();
            }
        }

        const fromTrajectoryApi = await this.fetchMessagesFromLsTrajectory();
        const trajectoryHasAssistant = fromTrajectoryApi.some((item) => item.role === 'assistant');

        const fromCdp = await this.fetchMessagesFromCdp();
        const cdpHasAssistant = fromCdp.some((item) => item.role === 'assistant');

        if (fromTrajectoryApi.length > 0 || fromCdp.length > 0) {
            const merged = this.mergeConversationSources(fromTrajectoryApi, fromCdp);
            if (merged.length > 0) {
                if (trajectoryHasAssistant || cdpHasAssistant) {
                    return merged;
                }
                // keep old behavior safety: only fallback further when both sources still miss assistant text
                const now = Date.now();
                if (now - this.lastPartialTranscriptWarnAt > 12_000) {
                    this.lastPartialTranscriptWarnAt = now;
                    this.relay?.addActivity(
                        `Transcript partial (no assistant yet): trajectory=${fromTrajectoryApi.length}, cdp=${fromCdp.length}. Trying fallback...`,
                        'warn',
                    );
                }
            }
        }

        if (this.lsConversationUnsupported) {
            const fromDiag = await this.fetchMessagesFromDiagnostics();
            if (fromDiag.length > 0) {
                return fromDiag;
            }
            const fromTrace = await this.fetchMessagesFromTrace();
            if (fromTrace.length > 0) {
                return fromTrace;
            }
            return this.fetchExecutionTranscriptFallback();
        }

        try {
            const raw = await this.sdk.ls.getConversation(this.currentActiveSessionId);
            const fromLs = this.extractMessages(raw);
            if (fromLs.length > 0) {
                return fromLs;
            }
            const fromDiag = await this.fetchMessagesFromDiagnostics();
            if (fromDiag.length > 0) {
                return fromDiag;
            }
            const fromTrace = await this.fetchMessagesFromTrace();
            if (fromTrace.length > 0) {
                return fromTrace;
            }
            return this.fetchExecutionTranscriptFallback();
        } catch (error) {
            const errorText = String(error);
            const text = errorText.toLowerCase();
            const is404 = text.includes('404') || text.includes('page not found');
            const notInitialized = text.includes('lsbridge not initialized');
            const isCsrfError = text.includes('csrf') || text.includes('401') || text.includes('unauthorized');
            if (is404) {
                this.lsConversationUnsupported = true;
                this.logConversationErrorOnce(`LS GetConversation unsupported (404), switching to diagnostics fallback: ${errorText}`);
                this.relay?.addActivity('Conversation API unavailable on this Antigravity version, using log-based transcript fallback', 'warn');
                const fromDiag = await this.fetchMessagesFromDiagnostics();
                if (fromDiag.length > 0) {
                    return fromDiag;
                }
                const fromTrace = await this.fetchMessagesFromTrace();
                if (fromTrace.length > 0) {
                    return fromTrace;
                }
                return this.fetchExecutionTranscriptFallback();
            }
            if (notInitialized) {
                this.lsConversationUnsupported = true;
                this.logConversationErrorOnce(`LS bridge unavailable, switching to diagnostics fallback: ${errorText}`);
                const fromDiag = await this.fetchMessagesFromDiagnostics();
                if (fromDiag.length > 0) {
                    return fromDiag;
                }
                const fromTrace = await this.fetchMessagesFromTrace();
                if (fromTrace.length > 0) {
                    return fromTrace;
                }
                return this.fetchExecutionTranscriptFallback();
            }
            if (isCsrfError) {
                this.csrfFailureCount += 1;
                this.relay?.addActivity('LS token expired, refreshing bridge...', 'warn');
                try {
                    const recovered = await this.recoverLsConnection(this.currentActiveSessionId);
                    if (!recovered) {
                        await this.sdk.ls.initialize();
                    }
                    const retried = await this.sdk.ls.getConversation(this.currentActiveSessionId);
                    this.relay?.addActivity('LS bridge refreshed successfully');
                    this.csrfFailureCount = 0;
                    return this.extractMessages(retried);
                } catch (retryError) {
                    if (this.shouldRestartLanguageServer()) {
                        await this.restartLanguageServerAndReconnect();
                        try {
                            const secondRetry = await this.sdk.ls.getConversation(this.currentActiveSessionId);
                            this.relay?.addActivity('Conversation fetch recovered after LS restart');
                            this.csrfFailureCount = 0;
                            return this.extractMessages(secondRetry);
                        } catch (secondRetryError) {
                            this.relay?.addActivity(`Conversation fetch still failing after LS restart: ${String(secondRetryError)}`, 'error');
                        }
                    }
                    this.relay?.addActivity(`Conversation fetch failed after refresh: ${String(retryError)}`, 'error');
                    const fromDiag = await this.fetchMessagesFromDiagnostics();
                    if (fromDiag.length > 0) {
                        return fromDiag;
                    }
                    const fromTrace = await this.fetchMessagesFromTrace();
                    if (fromTrace.length > 0) {
                        return fromTrace;
                    }
                    return this.fetchExecutionTranscriptFallback();
                }
            }

            this.logConversationErrorOnce(`Conversation fetch failed: ${errorText}`);
            this.relay?.addActivity(`Conversation fetch failed: ${errorText}`, 'warn');
            const fromDiag = await this.fetchMessagesFromDiagnostics();
            if (fromDiag.length > 0) {
                return fromDiag;
            }
            const fromTrace = await this.fetchMessagesFromTrace();
            if (fromTrace.length > 0) {
                return fromTrace;
            }
            return this.fetchExecutionTranscriptFallback();
        }
    }

    private async fetchMessagesFromLsTrajectory(): Promise<RemoteMessage[]> {
        if (!this.sdk.ls.isReady || !this.currentActiveSessionId) {
            return [];
        }

        const extractFromSteps = (steps: unknown[]): RemoteMessage[] => {
            const out: RemoteMessage[] = [];
            const seen = new Set<string>();
            const push = (role: RemoteMessage['role'], text: string, at?: string): void => {
                const cleaned = this.cleanLogText(text);
                if (!cleaned || cleaned.length < 2) return;
                const key = `${role}:${cleaned}`;
                if (seen.has(key)) return;
                seen.add(key);
                out.push({ role, text: cleaned.slice(0, 8000), at });
            };

            for (const stepNode of steps) {
                if (!stepNode || typeof stepNode !== 'object') continue;
                const step = stepNode as Record<string, unknown>;
                const metadata = (step.metadata && typeof step.metadata === 'object')
                    ? step.metadata as Record<string, unknown>
                    : {};
                const at = this.pickFirstString(metadata, ['createdAt', 'viewableAt', 'completedAt', 'timestamp']);
                const userInput = (step.userInput && typeof step.userInput === 'object')
                    ? step.userInput as Record<string, unknown>
                    : undefined;
                if (userInput) {
                    const userResponse = this.pickFirstString(userInput, ['userResponse', 'text', 'prompt', 'content']);
                    if (userResponse) {
                        push('user', userResponse, at);
                    }
                    const items = Array.isArray(userInput.items) ? userInput.items : [];
                    for (const item of items) {
                        if (!item || typeof item !== 'object') continue;
                        const text = this.pickFirstString(item as Record<string, unknown>, ['text', 'content', 'message', 'value']);
                        if (text) {
                            push('user', text, at);
                        }
                    }
                }

                const notifyUser = (step.notifyUser && typeof step.notifyUser === 'object')
                    ? step.notifyUser as Record<string, unknown>
                    : undefined;
                if (notifyUser) {
                    const content = this.pickFirstString(notifyUser, ['notificationContent', 'message', 'content', 'text']);
                    if (content) {
                        push('assistant', content, at);
                    }
                }

                const systemMessage = (step.systemMessage && typeof step.systemMessage === 'object')
                    ? step.systemMessage as Record<string, unknown>
                    : undefined;
                if (systemMessage) {
                    const content = this.pickFirstString(systemMessage, ['message', 'content', 'text']);
                    if (content) {
                        push('system', content, at);
                    }
                }

                const roleAware = this.extractRoleAwareTexts(step);
                for (const item of roleAware) {
                    push(item.role, item.text, at);
                }
            }

            return this.dedupeAndRankMessages(out);
        };

        try {
            const raw = await this.sdk.ls.rawRPC('GetCascadeTrajectory', { cascadeId: this.currentActiveSessionId });
            const trajectory = (raw && typeof raw === 'object' && (raw as Record<string, unknown>).trajectory && typeof (raw as Record<string, unknown>).trajectory === 'object')
                ? (raw as Record<string, unknown>).trajectory as Record<string, unknown>
                : undefined;
            const steps = trajectory && Array.isArray(trajectory.steps) ? trajectory.steps : [];
            const fromTrajectory = extractFromSteps(steps);
            if (fromTrajectory.length > 0) {
                if (!this.lsTrajectoryApiDetected) {
                    this.lsTrajectoryApiDetected = true;
                    this.relay?.addActivity('Using LS trajectory API for full conversation stream');
                }
                return fromTrajectory.slice(-80);
            }
        } catch {
            // try steps endpoint below
        }

        try {
            const raw = await this.sdk.ls.rawRPC('GetCascadeTrajectorySteps', { cascadeId: this.currentActiveSessionId });
            const steps = (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).steps))
                ? (raw as Record<string, unknown>).steps as unknown[]
                : [];
            const fromSteps = extractFromSteps(steps);
            if (fromSteps.length > 0) {
                if (!this.lsTrajectoryApiDetected) {
                    this.lsTrajectoryApiDetected = true;
                    this.relay?.addActivity('Using LS trajectory steps API for full conversation stream');
                }
                return fromSteps.slice(-80);
            }
        } catch {
            return [];
        }

        return [];
    }

    private async fetchMessagesFromCdp(): Promise<RemoteMessage[]> {
        try {
            const cdp = await this.ensureCdpConnection();
            if (!cdp || cdp.contexts.length === 0) {
                return [];
            }

            const expression = `(() => {
                const root =
                    document.getElementById('conversation') ||
                    document.querySelector('[data-testid*="conversation"]') ||
                    document.querySelector('[aria-label*="conversation" i]') ||
                    document.querySelector('[aria-label*="chat" i]') ||
                    document.querySelector('.conversation') ||
                    document.getElementById('chat') ||
                    document.getElementById('cascade') ||
                    document.body;
                if (!root) return [];

                const roleFromElement = (el) => {
                    const cls = ((el.className || '') + ' ' + (el.parentElement?.className || '') + ' ' + (el.closest('[class]')?.className || '')).toLowerCase();
                    const txt = String(el.innerText || '').trim();
                    if (cls.includes('justify-end') || cls.includes('self-end') || cls.includes('user')) return 'user';
                    if (cls.includes('assistant') || cls.includes('bot') || cls.includes('model')) return 'assistant';
                    if (/^you[:\\s]/i.test(txt)) return 'user';
                    if (/^(assistant|model|ai)[:\\s]/i.test(txt)) return 'assistant';
                    if (el.closest('[data-author="user"], [data-role="user"]')) return 'user';
                    if (el.closest('[data-author="assistant"], [data-role="assistant"], [data-author="model"]')) return 'assistant';
                    return 'assistant';
                };

                const rows = [];
                const seen = new Set();
                const turnCandidates = Array.from(root.querySelectorAll('.gap-y-3 > *, [data-message-id], [data-testid*="message"], [data-role], [data-author], .markdown, .prose, .rounded-lg'));
                const genericCandidates = Array.from(root.querySelectorAll('article, section, div'));
                const blocks = (turnCandidates.length >= 2 ? turnCandidates : genericCandidates).slice(-120);

                for (const el of blocks) {
                    const text = String(el.innerText || '').trim();
                    if (!text || text.length < 2) continue;
                    if (/^(Good|Bad)$/i.test(text)) continue;
                    if (text.includes('Ask anything') || text.includes('Planning')) continue;
                    const role = roleFromElement(el);
                    const normalized = text.replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
                    const key = role + ':' + normalized;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    rows.push({ role, text: normalized });
                }

                return rows.slice(-60);
            })()`;

            for (const ctx of cdp.contexts) {
                try {
                    const raw = await cdp.call('Runtime.evaluate', {
                        expression,
                        returnByValue: true,
                        awaitPromise: true,
                        contextId: ctx.id,
                    }) as Record<string, unknown>;

                    const result = raw?.result as Record<string, unknown> | undefined;
                    const value = result?.value;
                    if (!Array.isArray(value) || value.length === 0) {
                        continue;
                    }

                    const out: RemoteMessage[] = [];
                    const seen = new Set<string>();
                    for (const item of value) {
                        if (!item || typeof item !== 'object') continue;
                        const obj = item as Record<string, unknown>;
                        const role = this.normalizeRole(typeof obj.role === 'string' ? obj.role : undefined);
                        const text = this.cleanLogText(typeof obj.text === 'string' ? obj.text : '');
                        if (!text || text.length < 2) continue;
                        const key = `${role}:${text}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        out.push({ role, text: text.slice(0, 8000) });
                    }

                    if (out.length > 0) {
                        if (!this.cdpConversationDetected) {
                            this.cdpConversationDetected = true;
                            this.relay?.addActivity('Using CDP live chat capture fallback for full messages');
                        }
                        return out.slice(-60);
                    }
                } catch {
                    // try next context
                }
            }

            return [];
        } catch {
            return [];
        }
    }

    private async ensureCdpConnection(): Promise<{
        ws: WebSocket;
        call: (method: string, params?: unknown) => Promise<unknown>;
        contexts: Array<{ id: number }>;
    } | null> {
        if (this.cdpConnection && this.cdpConnection.ws.readyState === WebSocket.OPEN) {
            return this.cdpConnection;
        }

        const target = await this.discoverCdpTarget();
        if (!target) {
            return null;
        }

        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve());
            ws.once('error', (err) => reject(err));
        });

        const contexts: Array<{ id: number }> = [];
        let idCounter = 1;
        const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timeout: NodeJS.Timeout }>();

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(String(raw)) as Record<string, unknown>;
                if (typeof msg.id === 'number' && pending.has(msg.id)) {
                    const item = pending.get(msg.id)!;
                    clearTimeout(item.timeout);
                    pending.delete(msg.id);
                    if (msg.error) {
                        item.reject(msg.error);
                    } else {
                        item.resolve(msg.result ?? {});
                    }
                    return;
                }

                if (msg.method === 'Runtime.executionContextCreated') {
                    const params = msg.params as Record<string, unknown> | undefined;
                    const ctx = params?.context as Record<string, unknown> | undefined;
                    const id = typeof ctx?.id === 'number' ? ctx.id : undefined;
                    if (id && !contexts.some((c) => c.id === id)) {
                        contexts.push({ id });
                    }
                    return;
                }

                if (msg.method === 'Runtime.executionContextsCleared') {
                    contexts.length = 0;
                    return;
                }

                if (msg.method === 'Runtime.executionContextDestroyed') {
                    const params = msg.params as Record<string, unknown> | undefined;
                    const id = typeof params?.executionContextId === 'number' ? params.executionContextId : undefined;
                    if (!id) return;
                    const idx = contexts.findIndex((c) => c.id === id);
                    if (idx >= 0) contexts.splice(idx, 1);
                }
            } catch {
                // ignore malformed messages
            }
        });

        const call = (method: string, params?: unknown): Promise<unknown> => {
            return new Promise((resolve, reject) => {
                const id = idCounter++;
                const timeout = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`CDP ${method} timeout`));
                }, 12000);
                pending.set(id, { resolve, reject, timeout });
                ws.send(JSON.stringify({ id, method, params: params ?? {} }));
            });
        };

        await call('Runtime.enable', {});
        await new Promise((resolve) => setTimeout(resolve, 500));

        this.cdpConnection = { ws, call, contexts };
        return this.cdpConnection;
    }

    private async discoverCdpTarget(): Promise<{ webSocketDebuggerUrl: string } | null> {
        const ports = [9000, 9001, 9002, 9003];
        for (const port of ports) {
            try {
                const targets = await this.httpJsonGet(`http://127.0.0.1:${port}/json/list`) as Array<Record<string, unknown>>;
                if (!Array.isArray(targets)) {
                    continue;
                }

                const workbench = targets.find((t) => {
                    const url = typeof t.url === 'string' ? t.url.toLowerCase() : '';
                    const title = typeof t.title === 'string' ? t.title.toLowerCase() : '';
                    return url.includes('workbench.html') || title.includes('workbench') || title.includes('antigravity');
                });
                const chosen = workbench ?? targets.find((t) => typeof t.webSocketDebuggerUrl === 'string');
                if (chosen && typeof chosen.webSocketDebuggerUrl === 'string') {
                    return { webSocketDebuggerUrl: chosen.webSocketDebuggerUrl };
                }
            } catch {
                // try next port
            }
        }

        return null;
    }

    private httpJsonGet(url: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            http.get(url, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += String(chunk); });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (error) {
                        reject(error);
                    }
                });
            }).on('error', reject);
        });
    }

    private extractMessages(payload: unknown): RemoteMessage[] {
        const out: RemoteMessage[] = [];
        const seen = new Set<string>();

        const visit = (node: unknown): void => {
            if (!node) {
                return;
            }
            if (Array.isArray(node)) {
                for (const item of node) {
                    visit(item);
                }
                return;
            }
            if (typeof node !== 'object') {
                return;
            }

            const obj = node as Record<string, unknown>;
            const roleRaw = this.pickFirstString(obj, ['role', 'author', 'sender', 'speaker']);
            const texts = this.extractTextCandidatesFromNode(obj);
            const timestamp = this.pickFirstString(obj, ['timestamp', 'createdAt', 'time']);

            for (const textRaw of texts) {
                if (!textRaw || textRaw.trim().length < 2) {
                    continue;
                }
                const normalizedText = textRaw.trim();
                const normalizedRole = this.normalizeRole(roleRaw);
                const key = `${normalizedRole}:${normalizedText}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push({
                        role: normalizedRole,
                        text: normalizedText.slice(0, 8000),
                        at: timestamp,
                    });
                }
            }

            for (const value of Object.values(obj)) {
                visit(value);
            }
        };

        visit(payload);

        return out.slice(-40);
    }

    private mergeConversationSources(primary: RemoteMessage[], secondary: RemoteMessage[]): RemoteMessage[] {
        const seen = new Set<string>();
        const out: RemoteMessage[] = [];
        const push = (msg: RemoteMessage): void => {
            const cleaned = this.cleanLogText(msg.text || '');
            if (!cleaned || cleaned.length < 2) return;
            const key = `${msg.role}:${cleaned}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({ ...msg, text: cleaned.slice(0, 8000) });
        };

        for (const msg of [...primary, ...secondary]) {
            push(msg);
        }

        const ranked = this.dedupeAndRankMessages(out);
        return ranked.slice(-120);
    }

    private extractRoleAwareTexts(step: Record<string, unknown>): RemoteMessage[] {
        const out: RemoteMessage[] = [];
        const seen = new Set<string>();

        const inferRoleFromPath = (path: string): RemoteMessage['role'] => {
            const p = path.toLowerCase();
            if (/(^|\.)(user|human|prompt|query|userinput|instruction)/.test(p)) return 'user';
            if (/(^|\.)(assistant|model|answer|response|completion|notifyuser|final|result|output)/.test(p)) return 'assistant';
            if (/(^|\.)(system|metadata|trace|event)/.test(p)) return 'system';
            return 'unknown';
        };

        const push = (role: RemoteMessage['role'], text: string): void => {
            const cleaned = this.cleanLogText(text);
            if (!cleaned || cleaned.length < 2) return;
            const key = `${role}:${cleaned}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({ role, text: cleaned.slice(0, 8000) });
        };

        const visit = (node: unknown, path: string): void => {
            if (!node) return;
            if (typeof node === 'string') {
                const role = inferRoleFromPath(path);
                if (role !== 'unknown' && this.isLikelyConversationText(node, role)) {
                    push(role, node);
                }
                return;
            }
            if (Array.isArray(node)) {
                node.forEach((item, idx) => visit(item, `${path}[${idx}]`));
                return;
            }
            if (typeof node !== 'object') return;

            const obj = node as Record<string, unknown>;

            const msgRole = this.normalizeRole(this.pickFirstString(obj, ['role', 'author', 'sender']));
            const msgText = this.pickFirstString(obj, ['text', 'content', 'message', 'value', 'response', 'output', 'result', 'notificationContent']);
            if (msgText && msgRole !== 'unknown' && this.isLikelyConversationText(msgText, msgRole)) {
                push(msgRole, msgText);
            }

            for (const [key, value] of Object.entries(obj)) {
                visit(value, path ? `${path}.${key}` : key);
            }
        };

        visit(step, 'step');
        return out;
    }

    private extractTextCandidatesFromNode(node: unknown): string[] {
        const out: string[] = [];
        const seen = new Set<string>();
        const push = (value: string): void => {
            const cleaned = this.cleanLogText(value);
            if (!cleaned || cleaned.length < 2) {
                return;
            }
            if (seen.has(cleaned)) {
                return;
            }
            seen.add(cleaned);
            out.push(cleaned);
        };

        const visit = (value: unknown): void => {
            if (!value) return;
            if (typeof value === 'string') {
                push(value);
                return;
            }
            if (Array.isArray(value)) {
                for (const item of value) {
                    visit(item);
                }
                return;
            }
            if (typeof value !== 'object') return;
            const obj = value as Record<string, unknown>;
            const directKeys = [
                'text',
                'message',
                'summary',
                'response',
                'output',
                'result',
                'finalResponse',
                'assistantResponse',
                'prompt',
                'input',
                'value',
            ];
            for (const key of directKeys) {
                const maybe = obj[key];
                if (typeof maybe === 'string') {
                    push(maybe);
                }
            }
            if (Array.isArray(obj.parts)) {
                for (const part of obj.parts) {
                    if (typeof part === 'string') {
                        push(part);
                        continue;
                    }
                    if (!part || typeof part !== 'object') continue;
                    const partObj = part as Record<string, unknown>;
                    if (typeof partObj.text === 'string') {
                        push(partObj.text);
                    }
                    if (typeof partObj.content === 'string') {
                        push(partObj.content);
                    }
                }
            }
            if (obj.content && typeof obj.content === 'object') {
                visit(obj.content);
            }
            if (Array.isArray(obj.candidates)) {
                visit(obj.candidates);
            }
            if (Array.isArray(obj.messages)) {
                visit(obj.messages);
            }
        };
        visit(node);
        return out;
    }

    private async recoverLsConnection(sessionId: string): Promise<boolean> {
        if (!sessionId) {
            return false;
        }

        const candidates = await this.discoverLsCandidates();
        for (const candidate of candidates) {
            const okTls = await this.probeConversationEndpoint(candidate.port, sessionId, candidate.csrfToken, true);
            if (okTls) {
                this.sdk.ls.setConnection(candidate.port, candidate.csrfToken, true);
                this.relay?.addActivity(`Recovered LS bridge on port ${candidate.port} (tls)`);
                return true;
            }

            const okHttp = await this.probeConversationEndpoint(candidate.port, sessionId, candidate.csrfToken, false);
            if (okHttp) {
                this.sdk.ls.setConnection(candidate.port, candidate.csrfToken, false);
                this.relay?.addActivity(`Recovered LS bridge on port ${candidate.port} (http)`);
                return true;
            }
        }

        this.relay?.addActivity('Unable to recover LS token/port automatically', 'warn');
        return false;
    }

    private async discoverLsCandidates(): Promise<Array<{ port: number; csrfToken: string }>> {
        const rootHint = (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '').toLowerCase();
        let output = '';
        try {
            const res = await execAsync('ps -eo pid,args 2>/dev/null | grep language_server | grep csrf_token | grep -v grep');
            output = res.stdout ?? '';
        } catch {
            return [];
        }

        const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
        const ranked = lines
            .map((line) => ({ line, score: rootHint && line.toLowerCase().includes(rootHint) ? 2 : 1 }))
            .sort((a, b) => b.score - a.score)
            .map((item) => item.line);

        const out: Array<{ port: number; csrfToken: string }> = [];
        const seen = new Set<string>();

        for (const line of ranked) {
            const pidMatch = line.match(/^(\d+)\s+/);
            const tokenMatch = line.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);
            if (!pidMatch || !tokenMatch) {
                continue;
            }
            const pid = Number(pidMatch[1]);
            const csrfToken = tokenMatch[1];
            if (!pid || !csrfToken) {
                continue;
            }

            const ports = await this.getPidPorts(pid);
            for (const port of ports) {
                const key = `${port}:${csrfToken}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                out.push({ port, csrfToken });
            }
        }

        return out;
    }

    private async getPidPorts(pid: number): Promise<number[]> {
        try {
            const res = await execAsync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${pid}`);
            const lines = (res.stdout ?? '').split('\n');
            const ports: number[] = [];
            for (const line of lines) {
                const match = line.match(/127\.0\.0\.1:(\d+)/);
                if (!match) {
                    continue;
                }
                const port = Number(match[1]);
                if (port && !ports.includes(port)) {
                    ports.push(port);
                }
            }
            return ports;
        } catch {
            return [];
        }
    }

    private probeConversationEndpoint(port: number, sessionId: string, csrfToken: string, useTls: boolean): Promise<boolean> {
        const mod = useTls ? https : http;
        const proto = useTls ? 'https' : 'http';
        return new Promise((resolve) => {
            const req = mod.request(`${proto}://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetConversation`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-codeium-csrf-token': csrfToken,
                },
                rejectUnauthorized: false,
                timeout: 1800,
            }, (res) => {
                // If token is valid, server usually won't return auth errors (401/403).
                const status = res.statusCode ?? 0;
                resolve(status > 0 && status !== 401 && status !== 403);
            });

            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.write(JSON.stringify({ cascadeId: sessionId }));
            req.end();
        });
    }

    private shouldRestartLanguageServer(): boolean {
        const now = Date.now();
        const cooldownMs = 60_000;
        const passedCooldown = now - this.lastLsRestartAt > cooldownMs;
        return this.csrfFailureCount >= 2 && passedCooldown;
    }

    private async restartLanguageServerAndReconnect(): Promise<void> {
        this.lastLsRestartAt = Date.now();
        this.relay?.addActivity('Restarting Antigravity Language Server to recover CSRF...', 'warn');
        await this.sdk.commands.execute('antigravity.restartLanguageServer');
        await new Promise((resolve) => setTimeout(resolve, 3500));
        await this.sdk.ls.initialize();
        this.relay?.addActivity('Language Server restarted and LS bridge reinitialized');
    }

    private pickFirstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
        for (const key of keys) {
            const value = obj[key];
            if (typeof value === 'string' && value.trim()) {
                return value;
            }
        }
        return undefined;
    }

    private normalizeRole(input?: string): RemoteMessage['role'] {
        const value = (input ?? '').toLowerCase();
        if (value.includes('assistant') || value.includes('ai') || value.includes('bot') || value === 'model') {
            return 'assistant';
        }
        if (value.includes('user') || value.includes('human')) {
            return 'user';
        }
        if (value.includes('system')) {
            return 'system';
        }
        return 'unknown';
    }

    private async fetchMessagesFromDiagnostics(): Promise<RemoteMessage[]> {
        try {
            const diag = await this.sdk.cascade.getDiagnostics();
            const raw = diag.raw as Record<string, unknown>;
            const sources: string[] = [];
            const objects: unknown[] = [];

            const pushText = (value: unknown): void => {
                if (!value) return;
                if (typeof value === 'string') {
                    sources.push(value);
                    return;
                }
                if (Array.isArray(value)) {
                    for (const item of value) {
                        if (typeof item === 'string') {
                            sources.push(item);
                        } else if (item && typeof item === 'object') {
                            const obj = item as Record<string, unknown>;
                            objects.push(obj);
                            for (const key of ['message', 'text', 'content', 'line']) {
                                const candidate = obj[key];
                                if (typeof candidate === 'string') {
                                    sources.push(candidate);
                                }
                            }
                        }
                    }
                }
            };

            pushText(raw.languageServerLogs);
            pushText(raw.extensionLogs);
            pushText(raw.mainThreadLogs);
            pushText(raw.rendererLogs);
            pushText(raw.agentWindowConsoleLogs);
            objects.push(raw.languageServerLogs, raw.extensionLogs, raw.mainThreadLogs, raw.rendererLogs, raw.agentWindowConsoleLogs);

            const combined = sources.join('\n');
            const structured = this.extractMessages(objects);
            const unstructured = combined.trim() ? this.extractMessagesFromTextBlob(combined) : [];
            const merged = [...structured, ...unstructured];
            const deduped = this.dedupeAndRankMessages(merged);
            return deduped.slice(-80);
        } catch (error) {
            this.logConversationErrorOnce(`Diagnostics transcript fallback failed: ${String(error)}`);
            return [];
        }
    }

    private async fetchMessagesFromTrace(): Promise<RemoteMessage[]> {
        try {
            const [managerTrace, workbenchTrace] = await Promise.all([
                this.sdk.commands.execute<unknown>('antigravity.getManagerTrace').catch(() => ''),
                this.sdk.commands.execute<unknown>('antigravity.getWorkbenchTrace').catch(() => ''),
            ]);

            const chunks = [managerTrace, workbenchTrace]
                .map((item) => (typeof item === 'string' ? item : JSON.stringify(item ?? '')))
                .filter((item) => item.trim().length > 0);
            if (chunks.length === 0) {
                return [];
            }

            const blob = chunks.join('\n\n');
            const fromBlob = this.extractMessagesFromTextBlob(blob);
            const fromStructured = this.extractMessages([managerTrace, workbenchTrace]);
            const merged = this.dedupeAndRankMessages([...fromStructured, ...fromBlob]);
            return merged.slice(-80);
        } catch {
            return [];
        }
    }

    private extractMessagesFromTextBlob(text: string): RemoteMessage[] {
        const messages: RemoteMessage[] = [];
        const seen = new Set<string>();

        const add = (role: RemoteMessage['role'], content: string): void => {
            const cleaned = this.cleanLogText(content);
            if (!cleaned || cleaned.length < 3) return;
            const key = `${role}:${cleaned}`;
            if (seen.has(key)) return;
            seen.add(key);
            messages.push({ role, text: cleaned.slice(0, 8000) });
        };

        // JSON-like snippets: "role":"assistant","content":"..."
        const roleJson = /"role"\s*:\s*"(user|assistant|system)".{0,4000}?"(?:content|text|message|value|response|output)"\s*:\s*"((?:\\.|[^"\\]){3,8000})"/gis;
        let match: RegExpExecArray | null;
        while ((match = roleJson.exec(text)) !== null) {
            add(this.normalizeRole(match[1]), match[2]);
        }

        const assistantBlocks = /(?:assistant|model|bot)\s*[:>\]-]\s*([\s\S]{12,5000}?)(?=\n(?:user|human|assistant|model|ai|bot|system)\s*[:>\]-]|\n\[\d{2}:\d{2}:\d{2}\]|$)/gim;
        while ((match = assistantBlocks.exec(text)) !== null) {
            add('assistant', match[1]);
        }

        const userBlocks = /(?:user|human)\s*[:>\]-]\s*([\s\S]{3,3000}?)(?=\n(?:assistant|model|ai|bot|system)\s*[:>\]-]|\n\[\d{2}:\d{2}:\d{2}\]|$)/gim;
        while ((match = userBlocks.exec(text)) !== null) {
            add('user', match[1]);
        }

        // Plain log lines: user: ..., assistant: ...
        const lines = text.split('\n').slice(-600);
        for (const line of lines) {
            const plain = line.trim();
            if (!plain) continue;
            const userMatch = plain.match(/^(?:user|human)\s*[:>-]\s*(.+)$/i);
            if (userMatch?.[1]) {
                add('user', userMatch[1]);
                continue;
            }
            const assistantMatch = plain.match(/^(?:assistant|model|ai|bot)\s*[:>-]\s*(.+)$/i);
            if (assistantMatch?.[1]) {
                add('assistant', assistantMatch[1]);
            }
        }

        return messages;
    }

    private dedupeAndRankMessages(messages: RemoteMessage[]): RemoteMessage[] {
        const seen = new Set<string>();
        const out: RemoteMessage[] = [];
        for (const msg of messages) {
            const text = this.cleanLogText(msg.text || '');
            if (!text) continue;
            if (!this.isLikelyConversationText(text, msg.role)) continue;
            const key = `${msg.role}:${text}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ ...msg, text });
        }
        return out;
    }

    private isLikelyConversationText(text: string, role: RemoteMessage['role']): boolean {
        const low = text.toLowerCase();
        if (text.length < 4) return false;
        if (low.includes('getconversation') || low.includes('csrf') || low.includes('lsbridge')) return false;
        if (low.includes('http://') || low.includes('https://') || low.includes('vscode-file://')) return text.length > 80;
        if (role === 'assistant' || role === 'user') return true;
        if (text.length > 80 && /[.!?]/.test(text)) return true;
        return false;
    }

    private cleanLogText(input: string): string {
        const normalized = input
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\t/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        return normalized;
    }

    private logConversationErrorOnce(message: string): void {
        const now = Date.now();
        if (now - this.lastConversationErrorLogAt < 20_000) {
            return;
        }
        this.lastConversationErrorLogAt = now;
        this.output.appendLine(message);
    }

    private async fetchChangedFiles(): Promise<RemoteFileChange[]> {
        const fromBrain = await this.fetchChangedFilesFromBrain();
        if (fromBrain.length > 0) {
            return fromBrain;
        }

        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            return [];
        }

        try {
            const { stdout: statusOut } = await execAsync(`git -C ${this.shellEscape(root)} status --porcelain`);
            const statusMap = new Map<string, string>();
            const lines = statusOut.split('\n').map((line) => line.trimEnd()).filter(Boolean);
            for (const line of lines) {
                const code = line.slice(0, 2).trim() || '?';
                const path = line.slice(3).trim();
                if (!path) {
                    continue;
                }
                statusMap.set(path, code);
            }

            const { stdout: numstatOut } = await execAsync(`git -C ${this.shellEscape(root)} diff --numstat`);
            const churnMap = new Map<string, { added?: number; removed?: number }>();
            const nsLines = numstatOut.split('\n').map((line) => line.trim()).filter(Boolean);
            for (const line of nsLines) {
                const [addedRaw, removedRaw, ...pathParts] = line.split(/\s+/);
                const path = pathParts.join(' ');
                if (!path) {
                    continue;
                }
                const added = Number.isNaN(Number(addedRaw)) ? undefined : Number(addedRaw);
                const removed = Number.isNaN(Number(removedRaw)) ? undefined : Number(removedRaw);
                churnMap.set(path, { added, removed });
            }

            const allPaths = new Set<string>([...statusMap.keys(), ...churnMap.keys()]);
            return [...allPaths].slice(0, 60).map((path) => ({
                path,
                status: statusMap.get(path) ?? 'M',
                added: churnMap.get(path)?.added,
                removed: churnMap.get(path)?.removed,
            }));
        } catch {
            return [];
        }
    }

    private shellEscape(value: string): string {
        return `'${value.replace(/'/g, `'\"'\"'`)}'`;
    }

    private async fetchWorkCards(): Promise<RemoteWorkCard[]> {
        const fromBrain = await this.fetchWorkCardsFromBrain();
        if (fromBrain.length > 0) {
            return fromBrain;
        }

        const traced = await this.fetchWorkCardsFromTrace();
        if (traced.length > 0) {
            return traced;
        }

        const activeSession = this.currentActiveSessionTitle;
        const summary = this.recentStepUpdates.length > 0
            ? 'Derived from live step stream because Antigravity trace API is limited on this version.'
            : 'Waiting for new steps...';

        return [{
            title: (activeSession && typeof activeSession === 'string') ? activeSession : 'Current Task',
            summary,
            updates: this.recentStepUpdates.slice(0, 8),
            updatedAt: new Date().toISOString(),
            source: 'derived',
        }];
    }

    private async fetchWorkCardsFromTrace(): Promise<RemoteWorkCard[]> {
        try {
            const traceRaw = await this.sdk.commands.execute<unknown>('antigravity.getManagerTrace');
            if (!traceRaw) {
                return [];
            }
            const text = typeof traceRaw === 'string' ? traceRaw : JSON.stringify(traceRaw);
            if (!text || text.length < 20) {
                return [];
            }

            const cards: RemoteWorkCard[] = [];
            const blockPattern = /(Exploring [^\n]+|Greeting [^\n]+|Implementing [^\n]+|Refactoring [^\n]+)([\s\S]{0,1200}?)(?=\n[A-Z][^\n]{6,80}\n|$)/g;
            let match: RegExpExecArray | null;
            while ((match = blockPattern.exec(text)) !== null) {
                const title = this.cleanLogText(match[1]);
                const body = this.cleanLogText(match[2] || '');
                const updates = body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
                cards.push({
                    title,
                    summary: body.slice(0, 280),
                    updates,
                    updatedAt: new Date().toISOString(),
                    source: 'trace',
                });
            }

            return cards.slice(-4);
        } catch {
            return [];
        }
    }

    private async resolveBrainDirForActiveSession(): Promise<string | null> {
        const brainRoot = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        const activeId = this.currentActiveSessionId;

        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(activeId);
        if (isUuid) {
            const direct = path.join(brainRoot, activeId);
            try {
                const st = await fs.stat(direct);
                if (st.isDirectory()) {
                    return direct;
                }
            } catch {
                // fallback below
            }
        }

        try {
            const entries = await fs.readdir(brainRoot, { withFileTypes: true });
            const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
            const candidates: Array<{ dir: string; score: number }> = [];
            for (const d of dirs) {
                const full = path.join(brainRoot, d);
                try {
                    const taskPath = path.join(full, 'task.md');
                    const st = await fs.stat(taskPath);
                    candidates.push({ dir: full, score: st.mtimeMs });
                } catch {
                    // ignore dirs without task.md
                }
            }
            candidates.sort((a, b) => b.score - a.score);
            return candidates[0]?.dir ?? null;
        } catch {
            return null;
        }
    }

    private async readBrainMarkdown(brainDir: string, baseName: 'task.md' | 'walkthrough.md' | 'implementation_plan.md'): Promise<string> {
        const direct = path.join(brainDir, baseName);
        try {
            return await fs.readFile(direct, 'utf8');
        } catch {
            // fallback to latest resolved version
        }

        try {
            const files = await fs.readdir(brainDir);
            const resolved = files
                .filter((f) => f.startsWith(`${baseName}.resolved`))
                .map((name) => ({ name, num: Number(name.split('.resolved.')[1] ?? '-1') }))
                .sort((a, b) => b.num - a.num);
            const target = resolved[0]?.name ?? `${baseName}.resolved`;
            return await fs.readFile(path.join(brainDir, target), 'utf8');
        } catch {
            return '';
        }
    }

    private async fetchWorkCardsFromBrain(): Promise<RemoteWorkCard[]> {
        const brainDir = await this.resolveBrainDirForActiveSession();
        if (!brainDir) return [];

        const task = await this.readBrainMarkdown(brainDir, 'task.md');
        const walkthrough = await this.readBrainMarkdown(brainDir, 'walkthrough.md');
        const plan = await this.readBrainMarkdown(brainDir, 'implementation_plan.md');
        if (!task && !walkthrough && !plan) {
            return [];
        }

        const title = this.extractFirstHeading(task) || this.extractFirstHeading(walkthrough) || this.currentActiveSessionTitle || 'Current Task';
        const summary = this.extractFirstParagraph(walkthrough) || this.extractFirstParagraph(plan) || this.extractFirstParagraph(task) || 'Task in progress.';
        const updates = [
            ...this.extractChecklistLines(task),
            ...this.extractBulletLines(walkthrough),
            ...this.extractBulletLines(plan),
        ].slice(0, 8);

        return [{
            title,
            summary,
            updates,
            updatedAt: new Date().toISOString(),
            source: 'trace',
        }];
    }

    private async fetchMessagesFromBrain(): Promise<RemoteMessage[]> {
        const brainDir = await this.resolveBrainDirForActiveSession();
        if (!brainDir) return [];

        const walkthrough = await this.readBrainMarkdown(brainDir, 'walkthrough.md');
        const plan = await this.readBrainMarkdown(brainDir, 'implementation_plan.md');
        const task = await this.readBrainMarkdown(brainDir, 'task.md');
        const body = [walkthrough, plan, task].filter(Boolean).join('\n\n');
        if (!body) return [];

        const out: RemoteMessage[] = [];
        const lines = body
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 1200);

        // Only accept explicit role-like lines from markdown exports.
        for (const line of lines) {
            const userMatch = line.match(/^(?:user|human)\s*[:>-]\s*(.+)$/i);
            if (userMatch?.[1]) {
                out.push({ role: 'user', text: this.cleanLogText(userMatch[1]).slice(0, 1200) });
                continue;
            }
            const assistantMatch = line.match(/^(?:assistant|model|ai|bot)\s*[:>-]\s*(.+)$/i);
            if (assistantMatch?.[1]) {
                out.push({ role: 'assistant', text: this.cleanLogText(assistantMatch[1]).slice(0, 1200) });
            }
        }
        return out.slice(-40);
    }

    private async fetchExecutionTranscriptFallback(): Promise<RemoteMessage[]> {
        const out: RemoteMessage[] = [];
        const seen = new Set<string>();
        const add = (role: RemoteMessage['role'], text: string): void => {
            const cleaned = this.cleanLogText(text);
            if (!cleaned || cleaned.length < 3) return;
            const key = `${role}:${cleaned}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({ role, text: cleaned.slice(0, 1200) });
        };

        for (const line of this.recentStepUpdates.slice(0, 20)) {
            add('system', line);
        }

        const fromBrain = await this.fetchMessagesFromBrain();
        for (const msg of fromBrain) {
            add(msg.role, msg.text);
        }

        return out.slice(0, 40);
    }

    private async fetchChangedFilesFromBrain(): Promise<RemoteFileChange[]> {
        const brainDir = await this.resolveBrainDirForActiveSession();
        if (!brainDir) return [];

        const plan = await this.readBrainMarkdown(brainDir, 'implementation_plan.md');
        const walkthrough = await this.readBrainMarkdown(brainDir, 'walkthrough.md');
        const text = `${plan}\n${walkthrough}`;
        if (!text.trim()) return [];

        const files: RemoteFileChange[] = [];
        const seen = new Set<string>();
        const regex = /\[(MODIFY|ADD|DELETE|UPDATE)\]\s*\[([^\]]+)\]\(file:\/\/([^)]+)\)/gi;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const status = match[1].toUpperCase();
            const p = decodeURIComponent(match[3]).replace(/^\/+/, '/');
            if (seen.has(p)) continue;
            seen.add(p);
            files.push({ path: p, status });
        }

        return files.slice(0, 40);
    }

    private extractFirstHeading(md: string): string {
        const m = md.match(/^#\s+(.+)$/m);
        return m?.[1]?.trim() ?? '';
    }

    private extractFirstParagraph(md: string): string {
        return md
            .split(/\n{2,}/)
            .map((p) => p.replace(/^#+\s*/g, '').trim())
            .find((p) => p.length > 40 && !p.startsWith('- ') && !p.startsWith('```')) ?? '';
    }

    private extractChecklistLines(md: string): string[] {
        return md
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => /^- \[[ xX]\]\s+/.test(line))
            .map((line) => line.replace(/^- \[[ xX]\]\s+/, '').replace(/\s*<!--.*$/, ''))
            .slice(0, 10);
    }

    private extractBulletLines(md: string): string[] {
        return md
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('- ') || line.startsWith('* '))
            .map((line) => line.replace(/^[-*]\s+/, ''))
            .filter((line) => line.length > 8)
            .slice(0, 10);
    }

    private toRemoteSession(session: ITrajectoryEntry): RemoteSession {
        return {
            id: session.id,
            title: session.title,
            stepCount: session.stepCount,
            lastModifiedTime: session.lastModifiedTime,
        };
    }

    private async getOrCreateToken(): Promise<string> {
        const existing = this.context.globalState.get<string>('antigravityRemote.token');
        if (existing) {
            return existing;
        }
        const token = crypto.randomBytes(16).toString('hex');
        await this.context.globalState.update('antigravityRemote.token', token);
        return token;
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const sdk = new AntigravitySDK(context);

    controller = new RemoteController(context, sdk);
    context.subscriptions.push(controller);

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityRemote.startRelay', async () => {
            if (!controller) {
                return;
            }
            try {
                await controller.start();
            } catch (error) {
                vscode.window.showErrorMessage(`Start Relay failed: ${String(error)}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityRemote.stopRelay', () => {
            controller?.stop();
            vscode.window.showInformationMessage('Antigravity Remote relay stopped.');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityRemote.showConnectInfo', async () => {
            await controller?.showConnectInfo();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityRemote.showPairingQr', async () => {
            await controller?.showPairingQr();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityRemote.resetToken', async () => {
            await controller?.resetToken();
        }),
    );

    const autoStart = vscode.workspace.getConfiguration('antigravityRemote').get<boolean>('autoStart', true);
    if (autoStart) {
        try {
            await controller.start();
        } catch (error) {
            vscode.window.showErrorMessage(`Auto start failed: ${String(error)}`);
        }
    }
}

export function deactivate(): void {
    controller?.dispose();
    controller = null;
}

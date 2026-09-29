/**
 * The desktop app, assembled.
 *
 * Everything with a decision in it lives in a module of its own with tests
 * around it; this file is the wiring that holds those modules together and
 * owns the things Electron insists on owning — windows, the tray, the session,
 * the lifecycle. It is meant to be readable top to bottom rather than clever.
 */

import { BrowserWindow, Menu, app, dialog, globalShortcut, nativeTheme, net, safeStorage, screen, session, shell } from 'electron';
import { watch } from 'chokidar';
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';

import type { AppCommand, UpdateState } from '../shared/ipc.ts';
import { EVENT } from '../shared/ipc.ts';
import type { DesktopSettings, NextcloudStatus, Platform, ServerProbeResult, WatchedFileEvent } from '../shared/types.ts';
import { SecretStore } from './config/secrets.ts';
import { SettingsStore } from './config/store.ts';
import { confirmationPrompt, parseDeepLink } from './deepLink.ts';
import { Logger } from './logging.ts';
import { buildMenu } from './menu.ts';
import { NextcloudBridge } from './nextcloud/bridge.ts';
import { isInside } from './nextcloud/paths.ts';
import { nextcloudSummary } from './nextcloud/summary.ts';
import { chromiumFetch } from './server/chromiumFetch.ts';
import { secureContextOrigin } from './server/secureOrigin.ts';
import { adoptsRedirect, probeServer, type ProbeOptions } from './server/probe.ts';
import { hostKind, normaliseServerUrl, originOf, serverUrl as joinServerUrl } from './server/url.ts';
import { permissionDecision, senderTrust, type PolicyContext } from './security/policy.ts';
import { settingsForServerPage } from './config/schema.ts';
import { AppTray } from './tray.ts';
import { Updater } from './updater.ts';
import { buildInfoFrom, detectPackaging, updateCapability, type BuildInfo, type Packaging } from './updatePolicy.ts';
import { Notifier } from './notifications.ts';
import { applyNavigationPolicy, createMainWindow, hardenedWebPreferences, unreachableUrl } from './windows/mainWindow.ts';
import { QuickAskWindow } from './windows/quickAsk.ts';
import { shellDirectory, shellPageUrl } from './windows/shellPages.ts';
import { normaliseWindowState, restoreBounds, type WindowState } from './windows/windowState.ts';

export class DesktopApp {
    readonly log: Logger;
    readonly settings: SettingsStore;
    readonly secrets: SecretStore;
    readonly packaging: Packaging;
    readonly build: BuildInfo;

    private nextcloud!: NextcloudBridge;
    private updater!: Updater;
    private notifier!: Notifier;
    private tray!: AppTray;
    private quickAsk!: QuickAskWindow;

    private mainWindow: BrowserWindow | null = null;
    private settingsWindow: BrowserWindow | null = null;
    private nextcloudStatus: NextcloudStatus = { installed: false, running: false, accounts: [] };
    private quitting = false;
    /** One quiet reload when a load fails but the server answers the probe. */
    private retriedAfterGoodProbe = false;
    /** The bridge check runs once, on the first page of ours. */
    private bridgeChecked = false;
    /** Main-frame navigations started in the workspace window, for spotting stale verdicts. */
    private mainNavigations = 0;
    /** Where the current main-frame navigation began, before any redirect. */
    private mainNavigationStart = '';

    /** The origin started with the secure-context switch, if any (see server/secureOrigin.ts). */
    private readonly secureOrigin: string | null;

    constructor(options: { secureOrigin?: string | null } = {}) {
        this.secureOrigin = options.secureOrigin ?? null;
        this.log = new Logger({
            directory: app.getPath('logs'),
            level: app.isPackaged ? 'info' : 'debug',
            console: !app.isPackaged,
        });
        this.settings = new SettingsStore({
            file: path.join(app.getPath('userData'), 'settings.json'),
            onWarning: this.log.warnFor('Settings'),
        });
        this.secrets = new SecretStore({
            file: path.join(app.getPath('userData'), 'credentials.json'),
            safeStorage,
            onWarning: this.log.warnFor('Secrets'),
        });
        this.build = readBuildInfo();
        this.packaging = detectPackaging({
            platform: process.platform,
            execPath: process.execPath,
            env: process.env,
            packaged: app.isPackaged,
            windowsStore: process.windowsStore,
        });
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    async boot(): Promise<void> {
        await this.settings.load();
        await this.secrets.load();
        this.log.info('App', `starting ${app.getVersion()} (${this.packaging}) on ${process.platform}`);
        if (app.commandLine.hasSwitch('no-sandbox')) {
            this.log.warn('App', "Chromium's sandbox is OFF for this run (--no-sandbox). Settings → About says why and how to turn it on.");
        }

        this.applyTheme();
        this.installSessionHeaders();
        this.installPermissionHandlers();
        this.watchRenderers();
        if (this.secureOrigin) {
            this.log.info('Server', `${this.secureOrigin} is plain http on a private address; treated as a secure context`);
            // A service worker registered by that origin would outlive the
            // network it was registered on, and on another network the same
            // address can be someone else. Start from none, every launch.
            await session.defaultSession
                .clearStorageData({ origin: this.secureOrigin, storages: ['serviceworkers'] })
                .catch((error: unknown) => this.log.warn('Server', `could not clear service workers: ${String(error)}`));
        }

        this.nextcloud = new NextcloudBridge({
            settings: () => this.settings.get(),
            createWatcher: (watchPath, options) => watch(watchPath, options),
            onStatusChanged: (status) => this.onNextcloudStatus(status),
            onWatchedFile: (event) => this.onWatchedFile(event),
            onWarning: this.log.warnFor('Nextcloud'),
        });

        this.notifier = new Notifier({
            settings: () => this.settings.get(),
            isFocused: () => this.mainWindow?.isFocused() ?? false,
            onActivate: (deepLink) => {
                this.showMain();
                if (deepLink) this.handleDeepLink(deepLink);
            },
        });

        this.updater = new Updater({
            packaging: this.packaging,
            build: this.build,
            settings: () => this.settings.get(),
            log: this.log,
            onState: (state) => this.broadcast(EVENT.updateState, state),
        });

        this.quickAsk = new QuickAskWindow({
            onSubmit: (text) => {
                this.showMain();
                this.sendCommand({ kind: 'quick-ask', text });
            },
        });

        this.tray = new AppTray({
            actions: {
                open: () => this.showMain(),
                newChat: () => {
                    this.showMain();
                    this.sendCommand({ kind: 'new-chat' });
                },
                quickAsk: () => this.quickAsk.toggle(),
                openSettings: () => this.showSettings(),
                refreshNextcloud: () => void this.refreshNextcloud(),
                openNextcloudFolder: () => void this.openNextcloudFolder(),
                quit: () => this.quit(),
            },
            nextcloud: () => this.nextcloudStatus,
            serverUrl: () => this.settings.get().server.url,
        });

        Menu.setApplicationMenu(buildMenu(this.menuActions()));
        this.tray.create();
        this.registerShortcuts();

        // Everything that must work whatever the server does is wired BEFORE
        // the first load. The load used to come first, and a server that was
        // down at launch aborted boot() right here — no updater, and settings
        // changes that were saved but never applied.
        this.updater.start();
        this.settings.onChange((settings) => this.onSettingsChanged(settings));

        await this.refreshNextcloud();
        await this.openMainWindow();
    }

    async shutdown(): Promise<void> {
        this.quitting = true;
        // Any of these may be missing when boot() stopped partway; the settings
        // flush below is the part that must happen regardless.
        this.updater?.stop();
        globalShortcut.unregisterAll();
        this.quickAsk?.destroy();
        this.tray?.destroy();
        await this.nextcloud?.dispose().catch((error: unknown) => this.log.warn('Nextcloud', `dispose failed: ${String(error)}`));
        await this.settings.flush();
        this.log.close();
    }

    quit(): void {
        this.quitting = true;
        app.quit();
    }

    get isQuitting(): boolean {
        return this.quitting;
    }

    // ── Windows ──────────────────────────────────────────────────────────────

    /** Bring the workspace to the front, opening it if it was closed to the tray. */
    showMain(): void {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            if (this.mainWindow.isMinimized()) this.mainWindow.restore();
            this.mainWindow.show();
            this.mainWindow.focus();
            return;
        }
        void this.openMainWindow();
    }

    private async openMainWindow(): Promise<void> {
        const settings = this.settings.get();
        const saved = await this.readWindowState();
        const bounds = restoreBounds(saved, screen.getAllDisplays(), screen.getPrimaryDisplay());

        const window = createMainWindow({
            bounds,
            maximised: saved.maximised === true,
            autoHideMenuBar: settings.appearance.autoHideMenuBar,
        });
        this.mainWindow = window;

        window.once('ready-to-show', () => {
            if (!settings.launch.startMinimised) window.show();
        });
        window.on('close', (event) => {
            if (this.quitting || !this.settings.get().launch.closeToTray) return;
            // Closing the last window on Windows and Linux hides to the tray;
            // this is the setting that makes the difference, and it is the one
            // people look for first when the app "will not quit".
            event.preventDefault();
            window.hide();
        });
        window.on('closed', () => {
            this.mainWindow = null;
        });
        const remember = () => void this.saveWindowState();
        window.on('resize', remember);
        window.on('move', remember);
        window.on('maximize', remember);
        window.on('unmaximize', remember);
        window.webContents.on('did-finish-load', () => {
            const loaded = window.webContents.getURL();
            if (this.isServerNavigation(loaded)) this.retriedAfterGoodProbe = false;
            void this.checkBridge(window, loaded);
        });
        window.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
            if (!isMainFrame) return;
            // -3 is ERR_ABORTED: a navigation replaced by another one, or one
            // that turned into a download. Nothing is wrong, and the page that
            // replaced it is already loading.
            if (code === -3) return;
            this.log.warn('Window', `could not load ${failedUrl}: ${description} (${code})`);
            // Only the server not answering is "unreachable". A failed hop to
            // somewhere else (an identity provider mid-sign-in, say) is that
            // page's problem, and the probe below would test the wrong host.
            if (!this.isServerNavigation(failedUrl)) return;
            void this.showUnreachable(description);
        });
        window.webContents.setZoomLevel(settings.appearance.zoomLevel);
        // Plain http to another machine works, and says so where it cannot be
        // missed: the page sets the title, this appends to it.
        // What the window shows is said where it cannot be missed: plain http
        // to another machine, and any page that is not the workspace (a
        // sign-in provider, mid-sign-in) by its host — the window has no
        // address bar, and a page borrowing the workspace's frame should not
        // be mistaken for it.
        window.on('page-title-updated', (event, title) => {
            const suffix = this.titleSuffix(window.webContents.getURL());
            if (!suffix) return;
            event.preventDefault();
            window.setTitle(`${title} — ${suffix}`);
        });
        window.webContents.on('did-start-navigation', (details) => {
            if (!details.isMainFrame || details.isSameDocument) return;
            // Fired once per navigation; its redirects arrive as will-redirect.
            this.mainNavigations += 1;
            this.mainNavigationStart = details.url;
        });

        await this.loadWorkspace(window);
    }

    /** Point the main window at the server, or at the first-run picker. */
    private async loadWorkspace(window: BrowserWindow): Promise<void> {
        const url = this.settings.get().server.url;
        this.load(window, url || shellPageUrl('welcome'));
    }

    /**
     * Load a URL into a window without letting the outcome steer control flow.
     *
     * `loadURL` rejects when the load fails, and also when another navigation
     * replaces it. Awaited, that rejection aborted whatever was waiting on it —
     * at launch, the rest of boot(). A failure is did-fail-load's to handle, so
     * the promise is only logged here.
     */
    private load(window: BrowserWindow | null, url: string): void {
        if (!window || window.isDestroyed()) return;
        window.loadURL(url).catch((error: unknown) => this.log.debug('Window', `load of ${url} ended: ${String(error)}`));
    }

    /**
     * Say in the log whether the first page of ours actually got
     * `window.beeflow`. When it did not, every button on the page was dead and
     * the log said nothing; this line is what the CI launch checks look for.
     */
    private async checkBridge(window: BrowserWindow, url: string): Promise<void> {
        if (this.bridgeChecked || !url.startsWith('file:') || window.isDestroyed()) return;
        this.bridgeChecked = true;
        try {
            const kind = String(await window.webContents.executeJavaScript('typeof window.beeflow', true));
            if (kind === 'object') this.log.info('App', 'bridge ready');
            else this.log.error('App', `the page has no window.beeflow (${kind}); its controls will not work`);
        } catch (error) {
            this.log.warn('App', `could not check the bridge: ${String(error)}`);
        }
    }

    private isServerNavigation(url: string): boolean {
        const server = originOf(this.settings.get().server.url);
        return Boolean(server && originOf(url) === server);
    }

    private unreachableInFlight: Promise<void> | null = null;

    private showUnreachable(reason: string): Promise<void> {
        // One at a time: two failures close together would otherwise race to
        // put different pages on screen.
        this.unreachableInFlight ??= this.explainUnreachable(reason).finally(() => {
            this.unreachableInFlight = null;
        });
        return this.unreachableInFlight;
    }

    private async explainUnreachable(reason: string): Promise<void> {
        const url = this.settings.get().server.url;
        if (!url || !this.mainWindow || this.mainWindow.isDestroyed()) return;
        // A failure to load the error page would otherwise put this straight
        // back on screen, forever. One attempt is the whole budget.
        if (this.mainWindow.webContents.getURL().startsWith('file://')) return;
        // Probe rather than repeat Chromium's message: the probe distinguishes
        // "certificate expired" from "nothing listening" from "not Bee Flow",
        // and those have three different fixes.
        const before = this.mainNavigations;
        const probe = await this.probe(url);
        // The probe can take a while. If the window has moved on meanwhile —
        // the user reloaded, or navigated somewhere that worked — this verdict
        // is about a page nobody is looking at any more.
        if (this.mainNavigations !== before || !this.mainWindow || this.mainWindow.isDestroyed()) return;
        if (probe.ok && !this.retriedAfterGoodProbe) {
            // The server answers the probe, so this was a blip (a restart, a
            // network change mid-load). One quiet retry beats an error page
            // with a green "the server answered" on it.
            this.retriedAfterGoodProbe = true;
            this.load(this.mainWindow, url);
            return;
        }
        this.retriedAfterGoodProbe = false;
        this.load(this.mainWindow, unreachableUrl(url, probe.error ?? reason, probe.code ?? 'unknown', probe.redirectTarget));
    }

    /**
     * The saved server answered its own address with a redirect somewhere the
     * window may not follow — it moved, or someone moved it. Refusing and
     * handing the target to the browser left the window blank, with a new
     * browser tab on every launch and nothing in the log. Instead: a move
     * that is strictly the same server (http becoming https, another port on
     * the same host) is adopted through setServer, which checks it; anything
     * else goes to the unreachable page, which names the new address and lets
     * the person choose it.
     */
    private onServerRedirectRefused(target: string): boolean {
        const server = this.settings.get().server.url;
        if (!server || !this.mainWindow || this.mainWindow.isDestroyed()) return false;
        if (!this.isServerNavigation(this.mainNavigationStart)) return false;
        this.log.warn('Server', `${server} now redirects to ${target}`);
        const moved = normaliseServerUrl(target);
        if (moved.ok && adoptsRedirect(server, moved.url)) {
            void this.setServer(moved.url);
            return true;
        }
        this.load(this.mainWindow, unreachableUrl(server, `Your server now sends you to ${target}.`, 'redirected', target));
        return true;
    }

    private titleSuffix(url: string): string {
        if (!url || url.startsWith('file:')) return '';
        if (this.isServerNavigation(url)) return this.isUnencrypted(url) ? 'not encrypted' : '';
        try {
            return new URL(url).host;
        } catch {
            return '';
        }
    }

    showSettings(): void {
        if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
            this.settingsWindow.show();
            this.settingsWindow.focus();
            return;
        }
        const window = new BrowserWindow({
            width: 860,
            height: 720,
            minWidth: 520,
            minHeight: 480,
            title: 'Bee Flow Settings',
            backgroundColor: '#0f0f13',
            autoHideMenuBar: true,
            ...(this.mainWindow ? { parent: this.mainWindow } : {}),
            webPreferences: hardenedWebPreferences(),
        });
        this.load(window, shellPageUrl('settings'));
        window.on('closed', () => {
            this.settingsWindow = null;
        });
        this.settingsWindow = window;
    }

    /** The first-run picker, reachable again from the menu. */
    chooseServer(): void {
        this.showMain();
        this.load(this.mainWindow, shellPageUrl('welcome', { change: '1' }));
    }

    // ── Server ───────────────────────────────────────────────────────────────

    private pendingSetServer: Promise<ServerProbeResult> | null = null;

    /** One change of server at a time; a second request while one runs gets its answer. */
    setServer(rawUrl: string): Promise<ServerProbeResult> {
        this.pendingSetServer ??= this.changeServer(rawUrl).finally(() => {
            this.pendingSetServer = null;
        });
        return this.pendingSetServer;
    }

    private async changeServer(rawUrl: string): Promise<ServerProbeResult> {
        const probe = await this.probe(rawUrl);
        if (!probe.ok) return probe;

        const previous = this.settings.get().server;
        const recent = [previous.url, ...previous.recent].filter((value) => value && value !== probe.url);
        await this.settings.patch({ server: { url: probe.url, recent, apiOrigin: probe.apiOrigin ?? '' } });

        this.log.info('Server', `now pointing at ${probe.url}`);
        this.broadcast(EVENT.serverChanged, probe.url);
        this.load(this.mainWindow, probe.url);
        this.tray.refresh();
        this.offerRestartForSecureContext(probe.url);
        return probe;
    }

    /**
     * A new plain-http server on a private address needs the secure-context
     * switch, which only takes effect at startup. The workspace works without
     * it; encrypted sign-in (OPAQUE, PIN unlock) does not. So: ask.
     */
    private restartOffered = false;

    private offerRestartForSecureContext(serverUrl: string): void {
        const wanted = secureContextOrigin(serverUrl);
        if (!wanted || wanted === this.secureOrigin || this.restartOffered) return;
        this.restartOffered = true;
        const options = {
            type: 'info' as const,
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            title: 'Restart to finish connecting',
            message: `Restart Bee Flow to finish connecting to ${wanted}.`,
            detail: 'This server is reached over plain http. Bee Flow can still use encrypted sign-in with it on your own network, but only after a restart.',
        };
        const window = this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null;
        void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).then(({ response }) => {
            this.restartOffered = false;
            if (response === 0) this.relaunch();
        });
    }

    /** Forget a server from the picker's recent list. */
    async forgetServer(url: string): Promise<void> {
        const server = this.settings.get().server;
        await this.settings.patch({ server: { ...server, recent: server.recent.filter((value) => value !== url) } });
    }

    // ── Nextcloud ────────────────────────────────────────────────────────────

    get bridge(): NextcloudBridge {
        return this.nextcloud;
    }

    async refreshNextcloud(): Promise<NextcloudStatus> {
        const status = await this.nextcloud.refresh();
        this.log.info('Nextcloud', nextcloudSummary(status));
        return status;
    }

    private onNextcloudStatus(status: NextcloudStatus): void {
        this.nextcloudStatus = status;
        this.tray.refresh();
        this.broadcast(EVENT.ncStatusChanged, status);
    }

    private onWatchedFile(event: WatchedFileEvent): void {
        this.log.debug('Nextcloud', `watched ${event.kind}: ${event.localPath}`);
        this.broadcast(EVENT.watchedFile, event);
    }

    private async openNextcloudFolder(): Promise<void> {
        const folder = this.nextcloudStatus.accounts[0]?.folders[0]?.localPath;
        if (!folder) {
            dialog.showMessageBox({
                type: 'info',
                title: 'No Nextcloud folder',
                message: 'Bee Flow could not find a Nextcloud sync folder on this computer.',
                detail: nextcloudSummary(this.nextcloudStatus),
            });
            return;
        }
        await shell.openPath(folder);
    }

    /** Run Login Flow v2 and hand the credential to the Bee Flow server. */
    async pairNextcloud(serverUrlHint?: string): Promise<{ ok: true; server: string; loginName: string; storedOnServer: boolean } | { ok: false; error: string }> {
        const target = serverUrlHint || this.nextcloudStatus.accounts[0]?.url || '';
        if (!target) {
            return { ok: false, error: 'Bee Flow does not know which Nextcloud to sign in to. Enter its address in Settings first.' };
        }
        try {
            const credential = await this.nextcloud.login(target, (url) => shell.openExternal(url));
            // The password is held in the OS keyring so the app can re-present
            // it after a server rebuild without another round trip.
            const persisted = await this.secrets.set('nextcloud.appPassword', credential.appPassword);
            if (!persisted) this.log.warn('Nextcloud', 'the app password is held for this session only');

            const storedOnServer = await this.sendAppPasswordToServer(credential);
            this.log.info('Nextcloud', `linked ${credential.loginName} at ${credential.server}`);
            return { ok: true, server: credential.server, loginName: credential.loginName, storedOnServer };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log.warn('Nextcloud', `pairing failed: ${message}`);
            return { ok: false, error: message };
        }
    }

    /**
     * Hand the app password to the user's own Bee Flow server.
     *
     * This is the point of the pairing: the server already knows how to read
     * Nextcloud files (server/integrations/nextcloudFiles/), it just needs a
     * credential. The request rides the main window's session, so it carries
     * the user's existing sign-in and no separate token is needed.
     */
    private async sendAppPasswordToServer(credential: { server: string; loginName: string; appPassword: string }): Promise<boolean> {
        const base = this.settings.get().server.url;
        if (!base || !this.mainWindow || this.mainWindow.isDestroyed()) return false;
        try {
            const response = await this.mainWindow.webContents.session.fetch(joinServerUrl(base, '/auth/save-app-password'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Beeflow-Client': 'desktop' },
                body: JSON.stringify({ username: credential.loginName, password: credential.appPassword, url: credential.server }),
            });
            if (!response.ok) {
                this.log.warn('Nextcloud', `the Bee Flow server refused the app password (HTTP ${response.status})`);
                return false;
            }
            return true;
        } catch (error) {
            this.log.warn('Nextcloud', `could not reach the Bee Flow server to store the app password: ${String(error)}`);
            return false;
        }
    }

    // ── Deep links ───────────────────────────────────────────────────────────

    handleDeepLink(raw: string): void {
        const action = parseDeepLink(raw);
        this.log.info('DeepLink', `${raw} → ${action.kind}`);

        if (action.kind === 'unknown') return;

        if (action.needsConfirmation) {
            const prompt = confirmationPrompt(action);
            const choice = dialog.showMessageBoxSync({
                type: 'question',
                buttons: ['Cancel', 'Continue'],
                defaultId: 0,
                cancelId: 0,
                title: prompt?.title ?? 'Continue?',
                message: prompt?.title ?? 'Continue?',
                detail: prompt?.detail ?? '',
            });
            if (choice !== 1) return;
        }

        switch (action.kind) {
            case 'navigate': {
                this.showMain();
                const base = this.settings.get().server.url;
                if (base) this.load(this.mainWindow, new URL(action.path, base).toString());
                break;
            }
            case 'quick-ask':
                this.quickAsk.toggle(action.text);
                break;
            case 'set-server':
                void this.setServer(action.url);
                break;
            case 'pair-nextcloud':
                void this.pairNextcloud(action.server);
                break;
            case 'open-path':
                // Revealed in its folder, never opened: `openPath` would run an
                // .exe, a script or a .desktop file with its default handler,
                // and a link from any web page could name one.
                this.revealPath(action.path);
                break;
            default:
                break;
        }
        this.broadcast(EVENT.deepLink, raw);
    }

    // ── Shared plumbing ──────────────────────────────────────────────────────

    /** The policy context, rebuilt on each decision so it is never stale. */
    policy(): PolicyContext {
        const { server } = this.settings.get();
        return {
            serverUrl: server.url,
            ...(server.apiOrigin ? { apiOrigin: server.apiOrigin } : {}),
            nextcloudOrigins: this.nextcloudStatus.accounts.map((account) => account.url),
            shellRoot: shellDirectory(),
        };
    }

    /** Is this page the configured server, reached over plain http from another machine? */
    private isUnencrypted(url: string): boolean {
        const server = this.settings.get().server.url;
        if (!server || originOf(url) !== originOf(server)) return false;
        const parsed = new URL(server);
        return parsed.protocol === 'http:' && hostKind(parsed.hostname) !== 'loopback';
    }

    notify(input: { title: string; body: string; silent?: boolean; deepLink?: string }): boolean {
        return this.notifier.show(input);
    }

    updateState(): UpdateState {
        return this.updater.current();
    }

    checkForUpdates(): Promise<UpdateState> {
        return this.updater.check();
    }

    installUpdate(): void {
        this.updater.install();
    }

    setBadge(count: number): void {
        const value = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
        // Linux desktops vary in whether they support this at all; Electron
        // returns false rather than throwing, and a missing badge is not worth
        // a log line on every unread message.
        app.setBadgeCount(value);
    }

    /**
     * A command for the workspace — never for a page that happens to be in
     * its window instead (a sign-in provider mid-sign-in has the bridge too,
     * and no business with the user's quick-ask text or their file paths).
     */
    sendCommand(command: AppCommand): void {
        const contents = this.mainWindow?.webContents;
        if (!contents || contents.isDestroyed()) return;
        if (senderTrust(contents.getURL(), this.policy()) === 'other') {
            this.log.info('App', `not sending ${command.kind} to ${contents.getURL()}: it is not the workspace`);
            return;
        }
        contents.send(EVENT.command, command);
    }

    /**
     * Restart the app, so that it comes back.
     *
     * A bare app.relaunch() re-runs process.execPath. For an AppImage that is
     * inside a mount the runtime tears down as this process exits, and for the
     * Windows portable build it is in a temp folder the wrapper deletes — the
     * relaunch finds nothing, and the app just quits. The wrapper each of them
     * started from is what has to be run. The arguments go too, minus any
     * `beeflow://` link, which would otherwise be replayed after the restart.
     */
    relaunch(): void {
        const wrapper = [process.env.APPIMAGE, process.env.PORTABLE_EXECUTABLE_FILE].find((file) => file && path.isAbsolute(file));
        const args = process.argv.slice(1).filter((argument) => !/^beeflow:/i.test(argument));
        app.relaunch(wrapper ? { execPath: wrapper, args } : { args });
        this.quit();
    }

    /**
     * Send an event to the windows that may hear it: this app's own pages, and
     * the workspace. Never to a popup or an identity provider's page, which
     * have the bridge too (the preload runs everywhere) but no business with
     * what happens in this app. Settings go to the workspace in its redacted
     * form, the same one settings.get gives it.
     */
    broadcast(channel: string, payload: unknown): void {
        const context = this.policy();
        for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed()) continue;
            const trust = senderTrust(window.webContents.getURL(), context);
            if (trust === 'other') continue;
            const forPage = trust === 'server' && channel === EVENT.settingsChanged ? settingsForServerPage(payload as DesktopSettings) : payload;
            window.webContents.send(channel, forPage);
        }
    }

    diagnosticsPaths(): { logPath: string; settingsPath: string } {
        return { logPath: this.log.file, settingsPath: this.settings.file };
    }

    updateCapabilityReason(): string {
        return updateCapability(this.packaging, this.build).reason;
    }

    private menuActions() {
        return {
            newChat: () => {
                this.showMain();
                this.sendCommand({ kind: 'new-chat' });
            },
            quickAsk: () => this.quickAsk.toggle(),
            focusSearch: () => {
                this.showMain();
                this.sendCommand({ kind: 'focus-search' });
            },
            openSettings: () => this.showSettings(),
            chooseServer: () => this.chooseServer(),
            reload: () => this.mainWindow?.webContents.reload(),
            checkForUpdates: () => void this.checkForUpdatesInteractive(),
            openNextcloudFolder: () => void this.openNextcloudFolder(),
            pairNextcloud: () => void this.pairNextcloud(),
            refreshNextcloud: () => void this.refreshNextcloud(),
            attachFromNextcloud: () => void this.attachFromNextcloud(),
            showLogs: () => void shell.showItemInFolder(this.log.file),
            about: () => this.showAbout(),
        };
    }

    /**
     * Pick files from the Nextcloud folder and hand them to the workspace as
     * references.
     *
     * The same journey as a drag-and-drop, started from the menu instead: the
     * native picker opens in the sync folder, the paths are resolved to WebDAV
     * references, and the SPA is told to attach those rather than to upload
     * anything.
     */
    private async attachFromNextcloud(): Promise<void> {
        const accounts = this.nextcloud.accounts();
        const defaultPath = accounts[0]?.folders[0]?.localPath;
        if (!defaultPath) {
            await dialog.showMessageBox({
                type: 'info',
                title: 'No Nextcloud folder',
                message: 'Bee Flow could not find a Nextcloud sync folder on this computer.',
                detail: nextcloudSummary(this.nextcloudStatus),
            });
            return;
        }

        const picked = this.mainWindow
            ? await dialog.showOpenDialog(this.mainWindow, { properties: ['openFile', 'multiSelections'], defaultPath })
            : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], defaultPath });
        if (picked.canceled || picked.filePaths.length === 0) return;

        const files = await this.nextcloud.resolve(picked.filePaths);
        if (files.length === 0) return;
        this.showMain();
        this.sendCommand({ kind: 'attach-files', files });
    }

    private async checkForUpdatesInteractive(): Promise<void> {
        const capability = updateCapability(this.packaging, this.build);
        if (!capability.canSelfUpdate) {
            await dialog.showMessageBox({ type: 'info', title: 'Updates', message: 'Bee Flow does not update itself here.', detail: capability.reason });
            return;
        }
        const state = await this.updater.check();
        if (state.status === 'idle') {
            await dialog.showMessageBox({ type: 'info', title: 'Updates', message: `Bee Flow ${app.getVersion()} is up to date.` });
        }
    }

    private showAbout(): void {
        void dialog.showMessageBox({
            type: 'info',
            title: 'About Bee Flow',
            message: `Bee Flow ${app.getVersion()}`,
            detail: [
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
                `Installed as: ${this.packaging}`,
                `Server: ${this.settings.get().server.url || 'not set'}`,
                `Nextcloud: ${nextcloudSummary(this.nextcloudStatus)}`,
            ].join('\n'),
        });
    }

    // ── Settings reactions ───────────────────────────────────────────────────

    private onSettingsChanged(settings: DesktopSettings): void {
        this.applyTheme();
        this.registerShortcuts();
        this.tray.refresh();
        // `startMinimised` is honoured by the main window's ready-to-show
        // handler rather than by the OS, because only macOS's login-item API
        // understands "open hidden" and the behaviour should not differ.
        app.setLoginItemSettings({ openAtLogin: settings.launch.openAtLogin });
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.setAutoHideMenuBar(settings.appearance.autoHideMenuBar);
            this.mainWindow.webContents.setZoomLevel(settings.appearance.zoomLevel);
        }
        void this.nextcloud.syncWatchers(settings.nextcloud.watchedFolders);
        this.broadcast(EVENT.settingsChanged, settings);
    }

    private applyTheme(): void {
        nativeTheme.themeSource = this.settings.get().appearance.theme;
    }

    private registerShortcuts(): void {
        globalShortcut.unregisterAll();
        const accelerator = this.settings.get().shortcuts.quickAsk;
        if (!accelerator) return;
        try {
            const registered = globalShortcut.register(accelerator, () => this.quickAsk.toggle());
            if (!registered) {
                // Another application already owns it. Worth a log line and
                // nothing more: the app is perfectly usable without it.
                this.log.warn('Shortcuts', `${accelerator} is already taken by another application`);
            }
        } catch (error) {
            this.log.warn('Shortcuts', `could not register ${accelerator}: ${String(error)}`);
        }
    }

    /**
     * Announce this client on every request to the configured server.
     *
     * The server reads `X-Beeflow-Client` (server/core/http/requestClient.js) to
     * tell a browser from the Android app from this one — it is a closed enum
     * on a row that already exists, and the only reason it is set here rather
     * than in the SPA is that the SPA is the same bundle in both cases.
     *
     * The header is scoped to the configured server's origin. Sending it to an
     * identity provider during sign-in would tell a third party something about
     * the user's setup for no benefit at all.
     */
    private installSessionHeaders(): void {
        session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
            const { server } = this.settings.get();
            const requestOrigin = originOf(details.url);
            const ours = [originOf(server.url), server.apiOrigin || null].filter(Boolean);
            if (requestOrigin && ours.includes(requestOrigin)) {
                callback({ requestHeaders: { ...details.requestHeaders, 'X-Beeflow-Client': 'desktop' } });
                return;
            }
            callback({ requestHeaders: details.requestHeaders });
        });
    }

    /**
     * Hear about every renderer this app creates, including popups.
     *
     * A preload that fails to load leaves its page without `window.beeflow`
     * and says so only in that renderer's console, which nobody sees in a
     * packaged app. That exact failure once made the Connect button do nothing,
     * with an empty log. It goes in the log now.
     */
    private watchRenderers(): void {
        app.on('web-contents-created', (_event, contents) => {
            contents.on('preload-error', (_preloadEvent, preloadPath, error) => {
                this.log.error('Preload', `${preloadPath} failed to load in ${contents.getURL() || 'a new window'}: ${error?.stack ?? String(error)}`);
            });
            // Every renderer, including the popups window.open creates, which
            // no code of ours constructs and so none of it could remember to
            // police. A sign-in popup is exactly where a stray link leads.
            applyNavigationPolicy(contents, () => this.policy(), {
                openExternal: (url) => void this.openExternally(url),
                onBlocked: (url) => this.log.warn('Navigation', `blocked ${url} in ${contents.getURL() || 'a new window'}`),
                onRedirectRefused: (url) => contents === this.mainWindow?.webContents && this.onServerRedirectRefused(url),
            });
        });
    }

    /**
     * Ask the OS to open a URL in the user's browser.
     *
     * Not every desktop has an answer: a minimal window manager, or an
     * AppImage on a system without xdg-utils. That used to fail silently —
     * the click did nothing. Now the address is shown so it can be copied.
     */
    async openExternally(url: string): Promise<boolean> {
        this.log.info('Navigation', `opening in the browser: ${url}`);
        try {
            await shell.openExternal(url);
            return true;
        } catch (error) {
            this.log.warn('Navigation', `could not open ${url}: ${String(error)}`);
            void dialog.showMessageBox({
                type: 'info',
                title: 'No web browser could be opened',
                message: 'Bee Flow could not open your web browser.',
                detail: `Open this address in a browser yourself:\n\n${url}`,
            });
            return false;
        }
    }

    /**
     * Show a file in the OS file manager — only somewhere the user already
     * chose to share with this app: a Nextcloud sync folder, or Downloads.
     *
     * "Show me this file" is a reasonable thing for the workspace (or a
     * beeflow:// link) to ask. "Show me /home/tom/.ssh" is not, and neither is
     * a network share: `\\host\share\x.exe` makes Windows reach out to
     * that host just to look.
     */
    revealPath(target: unknown, options: { ownFiles?: boolean } = {}): boolean {
        const candidate = typeof target === 'string' ? target : '';
        if (!candidate || !path.isAbsolute(candidate) || /^(\\\\|\/\/)/.test(candidate)) {
            this.log.warn('IPC', `refused to reveal ${candidate || 'an empty path'}`);
            return false;
        }
        const resolved = path.resolve(candidate);
        const ownFile = options.ownFiles === true && [this.log.file, this.settings.file].some((file) => path.resolve(file) === resolved);
        const allowed = ownFile || this.nextcloud.isInsideAnySyncFolder(resolved) || isInside(app.getPath('downloads'), resolved);
        if (!allowed) {
            this.log.warn('IPC', `refused to reveal ${resolved}`);
            return false;
        }
        shell.showItemInFolder(resolved);
        return true;
    }

    /**
     * Which OS permissions a page gets.
     *
     * Chromium asks this process for every one; without these handlers it
     * grants most by default. `permissionDecision` is the rule. On top of it,
     * a server reached over plain http from another machine is asked about per
     * permission: whoever is on that network path can change the page, and the
     * microphone should not go to them unasked.
     */
    private installPermissionHandlers(): void {
        const asked = new Map<string, boolean>();
        const PER_REQUEST = new Set(['media', 'audioCapture', 'videoCapture', 'display-capture']);

        session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
            const url = details.requestingUrl || contents?.getURL() || '';
            if (!permissionDecision(permission, url, this.policy())) {
                this.log.info('Permissions', `refused ${permission} to ${url || 'an unknown page'}`);
                callback(false);
                return;
            }
            if (!this.isUnencrypted(url) || !PER_REQUEST.has(permission)) {
                callback(true);
                return;
            }
            const key = `${originOf(url)} ${permission}`;
            const previous = asked.get(key);
            if (previous !== undefined) {
                callback(previous);
                return;
            }
            const window = contents ? BrowserWindow.fromWebContents(contents) : null;
            const options = {
                type: 'question' as const,
                buttons: ['Block', 'Allow'],
                defaultId: 0,
                cancelId: 0,
                title: 'Allow access?',
                message: `${originOf(url)} wants to use your ${permission === 'display-capture' ? 'screen' : 'microphone or camera'}.`,
                detail: 'This server is reached without encryption, so anyone on the network in between could change the page that is asking. Allow it only on a network you trust.',
            };
            void (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).then(({ response }) => {
                asked.set(key, response === 1);
                callback(response === 1);
            });
        });

        session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
            if (!permissionDecision(permission, requestingOrigin, this.policy())) return false;
            if (this.isUnencrypted(requestingOrigin) && PER_REQUEST.has(permission)) return asked.get(`${originOf(requestingOrigin)} ${permission}`) === true;
            return true;
        });
    }

    // ── Window state persistence ─────────────────────────────────────────────

    private get windowStateFile(): string {
        return path.join(app.getPath('userData'), 'window-state.json');
    }

    private async readWindowState(): Promise<Partial<WindowState>> {
        try {
            return normaliseWindowState(JSON.parse(await fs.readFile(this.windowStateFile, 'utf8')));
        } catch {
            return {};
        }
    }

    private async saveWindowState(): Promise<void> {
        const window = this.mainWindow;
        if (!window || window.isDestroyed()) return;
        // A maximised window reports the maximised bounds; storing those would
        // mean un-maximising restores to full screen and the user can never get
        // their old size back.
        const bounds = window.isMaximized() || window.isFullScreen() ? window.getNormalBounds() : window.getBounds();
        const state: WindowState = { ...bounds, maximised: window.isMaximized(), fullScreen: window.isFullScreen() };
        try {
            await fs.writeFile(this.windowStateFile, `${JSON.stringify(state, null, 4)}\n`, 'utf8');
        } catch (error) {
            this.log.debug('Window', `could not save the window position: ${String(error)}`);
        }
    }

    /**
     * Probe a server over Chromium's network stack, the one the window uses,
     * so the two agree about proxies, certificates and HSTS. Every outcome is
     * logged: a failed connect used to leave nothing in the log at all.
     */
    async probe(url: string): Promise<ServerProbeResult> {
        const result = await probeServer(url, this.probeOptions());
        if (result.ok) {
            this.log.info('Server', `probe of ${url}: Bee Flow at ${result.url}${result.insecure ? ' (not encrypted)' : ''}${result.apiOrigin ? `, sign-in via ${result.apiOrigin}` : ''}`);
        } else {
            this.log.warn('Server', `probe of ${url}: ${result.code} — ${result.error ?? ''}`);
        }
        for (const warning of result.warnings ?? []) this.log.warn('Server', warning);
        return result;
    }

    private probeOptions(): ProbeOptions {
        return { fetch: chromiumFetch(net), platform: process.platform as Platform };
    }
}

/** The build facts the release workflow stamped into the packaged package.json. */
function readBuildInfo(): BuildInfo {
    try {
        return buildInfoFrom(JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')));
    } catch {
        return {};
    }
}

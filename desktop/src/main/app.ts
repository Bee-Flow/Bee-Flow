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
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import type { AppCommand, UpdateState } from '../shared/ipc.ts';
import { EVENT } from '../shared/ipc.ts';
import type { DesktopSettings, NextcloudStatus, Platform, ServerProbeResult } from '../shared/types.ts';
import { SecretStore } from './config/secrets.ts';
import { SettingsStore } from './config/store.ts';
import { routeDeepLink } from './deepLinkRouter.ts';
import { openExternally, revealPath } from './externalActions.ts';
import { Logger } from './logging.ts';
import { buildMenu } from './menu.ts';
import { NextcloudBridge } from './nextcloud/bridge.ts';
import { NextcloudActions, type NextcloudHost } from './nextcloudActions.ts';
import type { PairingResult } from './nextcloud/pairing.ts';
import { nextcloudSummary } from './nextcloud/summary.ts';
import { noNextcloudFolder } from './dialogs.ts';
import { chromiumFetch } from './server/chromiumFetch.ts';
import { probeServer, type ProbeOptions } from './server/probe.ts';
import { isServerNavigation, isUnencrypted, titleSuffix } from './server/serverPage.ts';
import { workspaceUrl } from './server/url.ts';
import { createPermissionHandlers, type PermissionPrompt } from './security/permissions.ts';
import { permissionDecision, senderTrust, type PolicyContext } from './security/policy.ts';
import { withClientHeader } from './security/sessionHeaders.ts';
import { settingsForServerPage } from './config/schema.ts';
import { AppTray } from './tray.ts';
import { RestartOffer } from './restartOffer.ts';
import { UnreachableFlow } from './unreachableFlow.ts';
import { Updater } from './updater.ts';
import { buildInfoFrom, detectPackaging, updateCapability, type BuildInfo, type Packaging } from './updatePolicy.ts';
import { Notifier } from './notifications.ts';
import { applyNavigationPolicy, createMainWindow, hardenedWebPreferences, unreachableUrl } from './windows/mainWindow.ts';
import { QuickAskWindow } from './windows/quickAsk.ts';
import { shellDirectory, shellPageUrl } from './windows/shellPages.ts';
import { readWindowState, restoreBounds, windowStateOf, writeWindowState } from './windows/windowState.ts';

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
    private nc!: NextcloudActions;
    /** The server-will-not-load flow: its state and its decisions live in unreachableFlow.ts. */
    private readonly unreachable: UnreachableFlow;
    private readonly restartOffer: RestartOffer;
    private quitting = false;
    /** The bridge check runs once, on the first page of ours. */
    private bridgeChecked = false;

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
        this.restartOffer = new RestartOffer({
            secureOrigin: this.secureOrigin,
            ask: async (options) => {
                const window = this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null;
                const { response } = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
                return response;
            },
            relaunch: () => this.relaunch(),
        });
        this.unreachable = new UnreachableFlow({
            serverUrl: () => this.settings.get().server.url,
            mainWindowUrl: () => (this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow.webContents.getURL() : null),
            probe: (url) => this.probe(url),
            load: (url) => this.load(this.mainWindow, url),
            unreachablePage: (server, error, code, redirectTarget) => unreachableUrl(server, error, code, redirectTarget),
            setServer: (url) => this.setServer(url),
            isServerNavigation: (url) => this.isServerNavigation(url),
            warn: (tag, message) => this.log.warn(tag, message),
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
            onStatusChanged: (status) => this.nc.onStatus(status),
            onWatchedFile: (event) => this.nc.onWatchedFile(event),
            onWarning: this.log.warnFor('Nextcloud'),
        });
        this.nc = new NextcloudActions(this.nextcloudHost());

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
                openNextcloudFolder: () => void this.nc.openFolder(),
                quit: () => this.quit(),
            },
            nextcloud: () => this.nc.status,
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
        const saved = await readWindowState(this.windowStateFile);
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
            this.unreachable.loaded(loaded);
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
            void this.unreachable.show(description);
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
            this.unreachable.navigationStarted(details.url);
        });

        await this.loadWorkspace(window);
    }

    /** Point the main window at the server, or at the first-run picker. */
    private async loadWorkspace(window: BrowserWindow): Promise<void> {
        const url = this.settings.get().server.url;
        this.load(window, url ? workspaceUrl(url) : shellPageUrl('welcome'));
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
        return isServerNavigation(url, this.settings.get().server.url);
    }

    private titleSuffix(url: string): string {
        return titleSuffix(url, this.settings.get().server.url);
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
        this.load(this.mainWindow, workspaceUrl(probe.url));
        this.tray.refresh();
        this.restartOffer.offer(probe.url);
        return probe;
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

    refreshNextcloud(): Promise<NextcloudStatus> {
        return this.nc.refresh();
    }

    /** Run Login Flow v2 and hand the credential to the Bee Flow server (see nextcloud/pairing.ts). */
    pairNextcloud(serverUrlHint?: string): Promise<PairingResult> {
        return this.nc.pair(serverUrlHint);
    }

    private nextcloudHost(): NextcloudHost {
        return {
            log: this.log,
            bridge: this.nextcloud,
            storeAppPassword: (appPassword) => this.secrets.set('nextcloud.appPassword', appPassword),
            serverUrl: () => this.settings.get().server.url,
            mainSessionFetch: () => {
                if (!this.mainWindow || this.mainWindow.isDestroyed()) return null;
                const { session: windowSession } = this.mainWindow.webContents;
                return (url, init) => windowSession.fetch(url, init);
            },
            openExternal: (url) => shell.openExternal(url),
            openPath: (folder) => shell.openPath(folder),
            showMessage: (message) => void dialog.showMessageBox(message),
            statusChanged: () => this.tray.refresh(),
            broadcast: (channel, payload) => this.broadcast(channel, payload),
        };
    }

    // ── Deep links ───────────────────────────────────────────────────────────

    handleDeepLink(raw: string): void {
        routeDeepLink(raw, {
            info: (tag, message) => this.log.info(tag, message),
            confirm: (prompt) =>
                dialog.showMessageBoxSync({
                    type: 'question',
                    buttons: ['Cancel', 'Continue'],
                    defaultId: 0,
                    cancelId: 0,
                    title: prompt.title,
                    message: prompt.title,
                    detail: prompt.detail,
                }) === 1,
            showMain: () => this.showMain(),
            serverUrl: () => this.settings.get().server.url,
            loadMain: (url) => this.load(this.mainWindow, url),
            quickAsk: (text) => this.quickAsk.toggle(text),
            setServer: (url) => this.setServer(url),
            pairNextcloud: (server) => this.pairNextcloud(server),
            revealPath: (target) => void this.revealPath(target),
            broadcast: (channel, payload) => this.broadcast(channel, payload),
        });
    }

    // ── Shared plumbing ──────────────────────────────────────────────────────

    /** The policy context, rebuilt on each decision so it is never stale. */
    policy(): PolicyContext {
        const { server } = this.settings.get();
        return {
            serverUrl: server.url,
            ...(server.apiOrigin ? { apiOrigin: server.apiOrigin } : {}),
            nextcloudOrigins: this.nc.status.accounts.map((account) => account.url),
            shellRoot: shellDirectory(),
        };
    }

    /** Is this page the configured server, reached over plain http from another machine? */
    private isUnencrypted(url: string): boolean {
        return isUnencrypted(url, this.settings.get().server.url);
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
            openNextcloudFolder: () => void this.nc.openFolder(),
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
            await dialog.showMessageBox(noNextcloudFolder(this.nc.status));
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
                `Nextcloud: ${nextcloudSummary(this.nc.status)}`,
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

    /** Announce this client on every request to the configured server (see security/sessionHeaders.ts). */
    private installSessionHeaders(): void {
        session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: withClientHeader(details.requestHeaders, details.url, this.settings.get().server) });
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
                onRedirectRefused: (url) => contents === this.mainWindow?.webContents && this.unreachable.redirectRefused(url),
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
    openExternally(url: string): Promise<boolean> {
        return openExternally(url, {
            info: (tag, message) => this.log.info(tag, message),
            warn: (tag, message) => this.log.warn(tag, message),
            openExternal: (target) => shell.openExternal(target),
            showMessage: (message) => void dialog.showMessageBox(message),
        });
    }

    /**
     * Show a file in the OS file manager — only somewhere the user already
     * chose to share with this app (see security/reveal.ts).
     */
    revealPath(target: unknown, options: { ownFiles?: boolean } = {}): boolean {
        return revealPath(target, options, {
            warn: (tag, message) => this.log.warn(tag, message),
            ownFiles: [this.log.file, this.settings.file],
            isInsideSyncFolder: (resolved) => this.nextcloud.isInsideAnySyncFolder(resolved),
            downloads: () => app.getPath('downloads'),
            showItemInFolder: (target2) => shell.showItemInFolder(target2),
        });
    }

    /** Which OS permissions a page gets (see security/permissions.ts). */
    private installPermissionHandlers(): void {
        const handlers = createPermissionHandlers({
            allowed: (permission, url) => permissionDecision(permission, url, this.policy()),
            isUnencrypted: (url) => this.isUnencrypted(url),
            onRefused: (permission, url) => this.log.info('Permissions', `refused ${permission} to ${url || 'an unknown page'}`),
        });

        session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
            const url = details.requestingUrl || contents?.getURL() || '';
            const ask = async (options: PermissionPrompt): Promise<number> => {
                const window = contents ? BrowserWindow.fromWebContents(contents) : null;
                const { response } = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
                return response;
            };
            handlers.request(permission, url, ask, callback);
        });

        session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => handlers.check(permission, requestingOrigin));
    }

    // ── Window state persistence ─────────────────────────────────────────────

    private get windowStateFile(): string {
        return path.join(app.getPath('userData'), 'window-state.json');
    }


    private async saveWindowState(): Promise<void> {
        const window = this.mainWindow;
        if (!window || window.isDestroyed()) return;
        try {
            await writeWindowState(this.windowStateFile, windowStateOf(window));
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

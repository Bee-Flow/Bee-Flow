/**
 * The entry point.
 *
 * Everything here is lifecycle: one instance, the deep-link registration, and
 * handing control to DesktopApp. The ordering is the fiddly part — the single
 * instance lock has to be taken before anything else, and the protocol client
 * has to be registered before the first `open-url` can arrive.
 */

import { BrowserWindow, app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DesktopApp } from './app.ts';
import { DEEP_LINK_SCHEME, extractDeepLink } from './deepLink.ts';
import { registerIpcHandlers } from './ipc/handlers.ts';
import { SYSTEM_ENTRY_PATHS, planAppImageEntry } from './linux/appImageEntry.ts';
import { SECURE_ORIGIN_SWITCH, savedServerUrl, secureContextOrigin } from './server/secureOrigin.ts';

/**
 * A throwaway profile, for the end-to-end tests.
 *
 * Each e2e launch gets its own settings, credentials, cookies and logs, so one
 * test's server choice cannot leak into the next and a developer's real profile
 * is never touched. It has to happen before the single-instance lock, because
 * the lock lives in the profile directory. Anyone who can set this variable can
 * already run the binary however they like, so it grants nothing.
 */
const profileOverride = process.env.BEEFLOW_USER_DATA_DIR;
if (profileOverride) {
    app.setPath('userData', profileOverride);
    app.setAppLogsPath(path.join(profileOverride, 'logs'));
}

/**
 * A plain-http server on a private address gets a secure context — see
 * server/secureOrigin.ts. A Chromium switch, so it is set now, before ready,
 * from what the settings file says; DesktopApp is told which origin it was so
 * it can ask for a restart when a new server needs a different one.
 */
const secureOrigin = secureContextOrigin(savedServerUrl(() => readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')));
if (secureOrigin) app.commandLine.appendSwitch(SECURE_ORIGIN_SWITCH, secureOrigin);

/**
 * One instance, always.
 *
 * Two copies of a workspace client is never what someone meant: the second one
 * fights the first for the tray icon, the global shortcut and the settings
 * file. A second launch — including the one the OS performs to deliver a
 * `beeflow://` link — hands its arguments to the running copy instead.
 */
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    void start();
}

async function start(): Promise<void> {
    // Chromium's shared GPU cache is per-user, not per-app; a distinct name
    // keeps this client's cache away from any other Electron app's.
    app.setAppUserModelId('nl.beeflow.desktop');

    const desktop = new DesktopApp({ secureOrigin });

    // An AppImage or a `npm run dev` session has no installer to have done
    // this, so the app registers itself. On a packaged .deb/.rpm/.msi the
    // installer already did, and this is a no-op. Before any 'open-url' can
    // arrive, which is only after this function yields.
    registerProtocolClient(desktop);

    app.on('second-instance', (_event, argv) => {
        const link = extractDeepLink(argv);
        if (link) desktop.handleDeepLink(link);
        else desktop.showMain();
    });

    // macOS delivers deep links as an event rather than as arguments, and can
    // do so before the app is ready.
    const pendingLinks: string[] = [];
    app.on('open-url', (event, url) => {
        event.preventDefault();
        if (app.isReady()) desktop.handleDeepLink(url);
        else pendingLinks.push(url);
    });

    // Registered before boot(), so they are in place whatever boot() does. They
    // used to come after it, and a boot() that threw (a server down at launch
    // did it) left a half-started app: no quit handling, no settings flush on
    // exit, and its own error unlogged.
    process.on('uncaughtException', (error) => {
        desktop.log.error('Main', `uncaught exception: ${error?.stack ?? String(error)}`);
    });
    process.on('unhandledRejection', (reason) => {
        desktop.log.error('Main', `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
    });

    // On Windows and Linux the app lives in the tray, so the last window
    // closing is not a reason to quit — `closeToTray` decides, and the window's
    // own close handler has already hidden it when it is on. macOS behaves the
    // way macOS apps do regardless.
    app.on('window-all-closed', () => {
        if (process.platform === 'darwin') return;
        if (!desktop.settings.get().launch.closeToTray) app.quit();
    });

    // Quitting waits for shutdown() — settings flushed to disk, watchers
    // closed — with a time limit, then quits again for real. The second
    // app.quit() goes through the normal sequence ('will-quit', 'quit'), which
    // is where the updater installs a downloaded update; app.exit() would skip
    // it.
    let shutDown = false;
    app.on('before-quit', (event) => {
        if (shutDown) return;
        event.preventDefault();
        shutDown = true;
        const limit = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_LIMIT_MS));
        void Promise.race([desktop.shutdown(), limit])
            .catch((error: unknown) => desktop.log.error('Main', `shutdown failed: ${String(error)}`))
            .finally(() => app.quit());
    });

    await app.whenReady();

    registerIpcHandlers(desktop);
    try {
        await desktop.boot();
    } catch (error) {
        desktop.log.error('Main', `start-up did not finish: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }

    for (const link of pendingLinks.splice(0)) desktop.handleDeepLink(link);
    const launchLink = extractDeepLink(process.argv);
    if (launchLink) desktop.handleDeepLink(launchLink);

    // macOS: clicking the Dock icon with no windows open should reopen one.
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) desktop.showMain();
    });
}

/** Long enough to flush settings; short enough that quitting never hangs. */
const SHUTDOWN_LIMIT_MS = 5_000;

function registerProtocolClient(desktop: DesktopApp): void {
    if (process.defaultApp && process.argv.length >= 2) {
        // `electron .` during development: the OS needs the interpreter and the
        // script path, not just the binary.
        app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [process.argv[1] ?? '']);
        return;
    }
    if (process.platform === 'linux') installAppImageEntry(desktop);
    const registered = app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    desktop.log.info('DeepLink', `beeflow:// ${registered ? 'is handled by this copy' : 'could not be registered with the OS'}`);
}

/**
 * An AppImage writes the desktop file its `beeflow://` registration points
 * at, because nothing installed one (see linux/appImageEntry.ts). Best effort:
 * a read-only home or a missing update-desktop-database costs the deep links,
 * not the app.
 */
function installAppImageEntry(desktop: DesktopApp): void {
    const file = path.join(process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share'), 'applications', 'beeflow.desktop');
    let existing: string | null = null;
    try {
        existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
    } catch {
        existing = null;
    }
    const plan = planAppImageEntry({
        appImage: process.env.APPIMAGE,
        appDir: process.env.APPDIR,
        execPath: process.execPath,
        home: os.homedir(),
        xdgDataHome: process.env.XDG_DATA_HOME,
        systemEntryExists: SYSTEM_ENTRY_PATHS.some((entry) => existsSync(entry)),
        existing,
    });
    if (!plan) return;
    try {
        if (plan.action === 'write') {
            mkdirSync(path.dirname(plan.file), { recursive: true });
            writeFileSync(plan.file, plan.content, { encoding: 'utf8', mode: 0o644 });
            desktop.log.info('DeepLink', `registered this AppImage for beeflow:// links (${plan.file})`);
        } else {
            rmSync(plan.file, { force: true });
            desktop.log.info('DeepLink', `removed the AppImage link handler at ${plan.file}; the installed package handles beeflow:// now`);
        }
        execFile('update-desktop-database', [path.dirname(plan.file)], () => undefined);
    } catch (error) {
        desktop.log.warn('DeepLink', `could not update the AppImage link handler: ${String(error)}`);
    }
}

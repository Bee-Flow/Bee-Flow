/**
 * The main window: the Bee Flow workspace itself.
 *
 * It renders the SERVER'S OWN SPA rather than a copy bundled into this app.
 * That is the central architectural decision of this client and it is worth
 * being explicit about, because the obvious alternative — ship `agent-hub`'s
 * build inside the installer — is what most Electron apps do.
 *
 * Bee Flow is self-hosted first. Every customer runs their own server, upgrades
 * it on their own schedule, and some run a version months apart from the
 * newest. A bundled SPA would have to stay compatible with all of them, which
 * means a compatibility matrix, a version-negotiation layer and a class of bug
 * where the UI shows a button the server has never heard of. Loading the
 * server's own bundle makes that class of bug impossible: the UI and the API
 * always ship together, exactly as they do in a browser.
 *
 * What this client adds is everything a browser tab cannot do — the tray, the
 * global shortcut, native notifications, deep links, the Nextcloud bridge, and
 * a preload that hands the SPA a typed `window.beeflow` when it wants them.
 */

import { BrowserWindow, app, type BrowserWindowConstructorOptions, type WebContents } from 'electron';

import { VERSION_ARGUMENT } from '../../shared/ipc.ts';
import { classifyNavigation, classifyWindowOpen, isIdentityProvider, isServerOrigin, type PolicyContext } from '../security/policy.ts';
import { preloadPath, shellPageUrl } from './shellPages.ts';
import type { Bounds } from './windowState.ts';

export interface MainWindowOptions {
    bounds: Bounds;
    maximised?: boolean;
    autoHideMenuBar: boolean;
    backgroundColor?: string;
}

/** What applyNavigationPolicy does with a verdict it does not allow. */
export interface NavigationHooks {
    /** Hand a URL to the system browser (and cope when there is none). */
    openExternal(url: string): void;
    /** A navigation or window was refused outright. */
    onBlocked(url: string): void;
    /**
     * A main-frame redirect was refused. Return true to take it over (the
     * workspace window handles "your server moved" itself) instead of handing
     * the target to the browser.
     */
    onRedirectRefused?(url: string): boolean;
}

/**
 * The window preferences, in one place so every window in this app gets the
 * same ones. A second window created with looser settings is the usual way an
 * Electron app ends up with a renderer that can reach Node.
 */
export function hardenedWebPreferences(): BrowserWindowConstructorOptions['webPreferences'] {
    return {
        preload: preloadPath(),
        // The three that matter, and the reasons they are not defaults worth
        // trusting: a renderer showing a remote origin must not be able to
        // reach Node (nodeIntegration), must not share a JavaScript context
        // with the preload (contextIsolation), and should run in Chromium's own
        // sandbox (sandbox) so a renderer compromise is not a machine
        // compromise.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // No <webview>: nothing here needs one, and it is an easy way to get a
        // window with different preferences than the ones above.
        webviewTag: false,
        // Chromium's own protections, spelled out rather than assumed.
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        spellcheck: true,
        // The sandboxed preload cannot ask the main process anything
        // synchronously, and `window.beeflow.version` is a plain property; the
        // renderer's command line is how it learns the version at load.
        additionalArguments: [`${VERSION_ARGUMENT}${app.getVersion()}`],
    };
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
    const window = new BrowserWindow({
        ...options.bounds,
        minWidth: 420,
        minHeight: 480,
        show: false,
        autoHideMenuBar: options.autoHideMenuBar,
        backgroundColor: options.backgroundColor ?? '#0f0f13',
        title: 'Bee Flow',
        // A workspace looks better without the platform's title bar on top of
        // its own header, but only where hiding it does not also hide the
        // window controls.
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        webPreferences: hardenedWebPreferences(),
    });

    if (options.maximised) window.maximize();
    // The navigation policy is applied to every WebContents the app creates,
    // this one included, from DesktopApp's 'web-contents-created' hook.
    return window;
}

/**
 * Apply the navigation rules to a set of web contents.
 *
 * Every surface needs them: the main window, a sign-in popup, the quick-ask
 * window, the local shell pages. A surface that skips this is a surface where a
 * link in a chat message opens inside the app — so rather than trusting each
 * window to remember, DesktopApp applies it from 'web-contents-created', which
 * also catches the popups that `window.open` creates.
 */
export function applyNavigationPolicy(contents: WebContents, policy: () => PolicyContext, hooks: NavigationHooks): void {
    // Is this window in the middle of a sign-in? Started by arriving on an
    // identity provider (by server redirect, or as a popup opened to one),
    // ended by arriving back on the server. See NavigationSource.
    let signingIn = false;
    const noteArrival = (url: string) => {
        const context = policy();
        if (isServerOrigin(url, context)) signingIn = false;
        else if (isIdentityProvider(url, context)) signingIn = true;
    };
    contents.on('did-navigate', (_event, url) => noteArrival(url));

    contents.setWindowOpenHandler(({ url }) => {
        const verdict = classifyWindowOpen(url, policy());
        if (verdict === 'popup') {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: 620,
                    height: 760,
                    // A sign-in window has to show its address bar's worth of
                    // information somehow; the title is what is left, and
                    // Chromium keeps it in step with the page.
                    autoHideMenuBar: true,
                    webPreferences: hardenedWebPreferences(),
                },
            };
        }
        if (verdict === 'external') hooks.openExternal(url);
        else hooks.onBlocked(url);
        return { action: 'deny' };
    });

    contents.on('will-navigate', (event, url) => {
        const verdict = classifyNavigation(url, policy(), 'navigate', { url: contents.getURL(), signingIn });
        if (verdict === 'allow') return;
        event.preventDefault();
        if (verdict === 'external') hooks.openExternal(url);
        else hooks.onBlocked(url);
    });

    // A server's 3xx does not pass through will-navigate at all, so without
    // this an allowed page could redirect the window anywhere — an open
    // redirect on the server, or an identity provider forwarding to a callback
    // someone else registered, would land a stranger's page in the workspace.
    // Main frame only: a redirect inside an iframe cannot replace the page.
    contents.on('will-redirect', (details) => {
        if (!details.isMainFrame) return;
        const verdict = classifyNavigation(details.url, policy(), 'redirect', { url: contents.getURL(), signingIn });
        if (verdict === 'allow') {
            // A redirect chain can pass through a provider without ever
            // committing a page there; the sign-in has started all the same.
            noteArrival(details.url);
            return;
        }
        details.preventDefault();
        if (hooks.onRedirectRefused?.(details.url)) return;
        if (verdict === 'external') hooks.openExternal(details.url);
        else hooks.onBlocked(details.url);
    });

    // A renderer that tries to attach a <webview> gets one with our own
    // preferences and nothing else, whatever the tag asked for.
    contents.on('will-attach-webview', (event) => {
        event.preventDefault();
    });
}

/** The page shown when the configured server cannot be reached. */
export function unreachableUrl(serverUrl: string, reason: string, code: string, target?: string): string {
    return shellPageUrl('unreachable', { server: serverUrl, reason, code, ...(target ? { target } : {}) });
}

/**
 * What this app is allowed to load, open and ask the operating system for.
 *
 * The main window renders the Bee Flow server's own SPA rather than a bundled
 * copy, which is what keeps the UI and the API it talks to from ever drifting
 * apart. The cost of that choice is that a window in this app is pointed at a
 * remote origin, so every navigation out of it has to be a decision rather
 * than a default — a link in a chat message, a redirect from an identity
 * provider and an `<a href="file:///etc/shadow">` all arrive through the same
 * events.
 *
 * All of it is pure functions over strings. The Electron wiring reads a verdict
 * and obeys it; the rules live here, where they can be tested exhaustively.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { originOf } from '../server/url.ts';

/** What the policy needs to know about the current session. */
export interface PolicyContext {
    /** The configured Bee Flow server, '' when the app is not set up yet. */
    serverUrl: string;
    /**
     * The same server's second origin, where its web app starts single
     * sign-on (SERVER_PUBLIC_HOST). Navigable, so a sign-in finishes in the
     * window; never trusted beyond that — see isServerUrl.
     */
    apiOrigin?: string;
    /** Origins of Nextcloud accounts this machine syncs, for the login flow. */
    nextcloudOrigins?: string[];
    /**
     * The directory this app's own pages are loaded from (dist/ui/shell).
     * Given, a `file://` page counts as ours only when it is directly in it;
     * without it, the path-shape check below is all there is.
     */
    shellRoot?: string;
    /** Whose path rules apply to `shellRoot`; defaults to this machine's. */
    platform?: NodeJS.Platform;
}

/**
 * Who started a navigation.
 *
 * `navigate` is the page itself: a link, `location.href`, a form. `redirect`
 * is a server answering an allowed request with a 3xx. The difference decides
 * identity providers: a sign-in reaches one by redirect, while a page sending
 * the whole workspace window to github.com is a link someone clicked.
 */
export type NavigationKind = 'navigate' | 'redirect';

/**
 * Where a navigation starts from, for the rules that depend on it.
 *
 * `signingIn` is set by the window's own state (see applyNavigationPolicy): a
 * server redirect onto an identity provider starts a sign-in, and arriving
 * back on the server ends it. In between, the provider's pages have to be
 * able to do what sign-in pages do — submit a password form, move to a
 * consent page, hand over to a company's own ADFS or Okta by redirect —
 * without every step being thrown out to the system browser.
 */
export interface NavigationSource {
    /** The page that is navigating, when known. */
    url?: string;
    signingIn?: boolean;
}

export type NavigationVerdict = 'allow' | 'external' | 'block';
export type WindowOpenVerdict = 'popup' | 'external' | 'block';

/**
 * Identity providers a sign-in may legitimately bounce through.
 *
 * RFC 8252 says a native app should do OAuth in the system browser, and that is
 * what `external` does for an ordinary link. But the Bee Flow server's own SSO
 * flow is built around a popup that hands a session token back to the opener
 * (`?popup=1&pickup=`, see server/auth/oauth/loginPickupRoutes.js), and a
 * system browser cannot hand anything back to a window it does not know about.
 * So these origins — and only these — may open in a child window inside the
 * app, with the same hardened preferences as every other window here.
 */
const IDENTITY_PROVIDER_HOSTS = [
    'accounts.google.com',
    'oauth2.googleapis.com',
    'login.microsoftonline.com',
    'login.live.com',
    'login.microsoft.com',
    'github.com',
    'gitlab.com',
    'auth.beeflow.nl',
];

/** Schemes the OS should handle, and that are meaningless inside a window. */
const HANDOFF_SCHEMES = ['mailto:', 'tel:', 'sms:', 'webcal:'];

/** Schemes that are never navigated to, whoever asks. */
const FORBIDDEN_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'blob:', 'about:'];

function schemeOf(url: string): string {
    const match = /^([a-z][a-z0-9+.-]*:)/i.exec(String(url ?? '').trim());
    return match?.[1]?.toLowerCase() ?? '';
}

/**
 * Is this URL the server the app is configured against?
 *
 * The main origin only. This is the test for everything that grants something
 * — the IPC channels meant for the server's pages, OS permissions, the client
 * header — so the single sign-on origin deliberately does not pass it.
 */
export function isServerUrl(url: string, context: PolicyContext): boolean {
    if (!context.serverUrl) return false;
    const target = originOf(url);
    const server = originOf(context.serverUrl);
    return Boolean(target && server && target === server);
}

/** The server's main origin, or its single sign-on origin. For navigation only. */
export function isServerOrigin(url: string, context: PolicyContext): boolean {
    if (isServerUrl(url, context)) return true;
    const target = originOf(url);
    const api = context.apiOrigin ? originOf(context.apiOrigin) : null;
    return Boolean(target && api && target === api);
}

export function isIdentityProvider(url: string, context: PolicyContext): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (IDENTITY_PROVIDER_HOSTS.includes(host)) return true;
    // A user's own Nextcloud is an identity provider for this product, and its
    // host is only knowable at runtime — it comes from the desktop client's
    // config or from what they typed on the pairing screen.
    return (context.nextcloudOrigins ?? []).some((origin) => originOf(origin) === parsed.origin);
}

/**
 * Where a top-level navigation inside an existing window may go.
 *
 * `allow` lets Electron proceed; `external` cancels it and hands the URL to the
 * OS; `block` cancels it and does nothing. The local shell pages are loaded
 * with `file://` and are allowed to navigate among themselves — their URLs are
 * built by this app, never by a page.
 */
export function classifyNavigation(url: string, context: PolicyContext, kind: NavigationKind = 'navigate', from: NavigationSource = {}): NavigationVerdict {
    const scheme = schemeOf(url);
    if (!scheme) return 'block';
    if (FORBIDDEN_SCHEMES.includes(scheme)) return 'block';
    if (HANDOFF_SCHEMES.includes(scheme)) return 'external';
    // The app's own deep-link scheme is handled by the deep-link route, not by
    // navigating a window to it.
    if (scheme === 'beeflow:') return 'block';
    if (scheme === 'file:') {
        // Only the shell UI this app shipped. A `file://` navigation coming out
        // of a remote page is the classic local-file read, and there is no
        // legitimate version of it here.
        return isPackagedShellUrl(url, context.shellRoot, context.platform) ? 'allow' : 'block';
    }
    if (scheme !== 'http:' && scheme !== 'https:') return 'block';
    if (isServerOrigin(url, context)) return 'allow';
    // An identity provider is a hop in a sign-in, which arrives as a redirect
    // from the server. A page navigating there itself is a clicked link, and
    // GitHub or Google in the workspace window is not what anyone meant.
    if (kind === 'redirect' && isIdentityProvider(url, context)) return 'allow';
    if (from.signingIn && scheme === 'https:') {
        // Mid-sign-in. Redirects may go anywhere https (a provider handing
        // over to a company's own federated login). The page itself may
        // submit its forms and move within its own site or to another
        // provider; a link off to anywhere else is still a link.
        if (kind === 'redirect') return 'allow';
        if (isIdentityProvider(url, context)) return 'allow';
        const current = from.url ? originOf(from.url) : null;
        if (current && current === originOf(url)) return 'allow';
    }
    return 'external';
}

/**
 * What to do when a page calls `window.open` or a link targets `_blank`.
 *
 * The difference from a plain navigation is that this one CREATES a window, so
 * the verdict says which kind: a hardened child window for the sign-in popup,
 * the system browser for a link someone clicked in a conversation, or nothing.
 */
export function classifyWindowOpen(url: string, context: PolicyContext): WindowOpenVerdict {
    const scheme = schemeOf(url);
    if (!scheme || FORBIDDEN_SCHEMES.includes(scheme)) return 'block';
    if (HANDOFF_SCHEMES.includes(scheme)) return 'external';
    if (scheme === 'beeflow:') return 'block';
    if (scheme === 'file:') return 'block';
    if (scheme !== 'http:' && scheme !== 'https:') return 'block';
    if (isServerOrigin(url, context) || isIdentityProvider(url, context)) return 'popup';
    return 'external';
}

/**
 * Is this a page this app shipped?
 *
 * With `shellRoot`, the page must be an `.html` file directly inside that
 * directory — the one this app resolved at startup, compared as a real path.
 * Without it (the tests), by path shape. `..` anywhere is refused outright,
 * which is what stops `file:///…/dist/ui/shell/../../../../etc/passwd`. The
 * shape check alone would also accept `…/dist/ui/shell/x.html` planted in any
 * other directory — a synced folder, say — which is why the app passes the
 * root.
 */
export function isPackagedShellUrl(url: string, shellRoot?: string, platform: NodeJS.Platform = process.platform): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'file:') return false;
    const windows = platform === 'win32';
    // A file URL with a host is a network share (\\server\share), which only
    // Windows can run an app from; anywhere else it is not a page of ours.
    if (parsed.host !== '' && (!windows || !shellRoot)) return false;
    const decoded = safeDecode(parsed.pathname);
    if (decoded.includes('..')) return false;
    // Emitted by tsc into dist/ui/shell/, and copied there by copy-assets.mjs.
    if (!/\/dist\/ui\/shell\/[A-Za-z0-9._-]+\.html$/.test(decoded)) return false;
    if (!shellRoot) return true;
    try {
        // Compared as the filesystem compares, not as text. On Windows,
        // Chromium upper-cases the drive letter of a file URL while Node keeps
        // whatever case the app was started with (`c:\…` from many
        // terminals), and path.win32.relative ignores case where Windows does.
        const paths = windows ? path.win32 : path.posix;
        const file = fileURLToPath(parsed, { windows });
        return paths.relative(paths.resolve(shellRoot), paths.dirname(file)) === '';
    } catch {
        return false;
    }
}

/**
 * Who a renderer is, for deciding what it may ask of this process.
 *
 * - `shell`: a page this app shipped. Everything.
 * - `server`: the configured server's own origin — the workspace. What the
 *   integration is for, and nothing that changes which server this is.
 * - `other`: anything else a window can end up showing — an identity provider
 *   mid-sign-in, the single sign-on origin, a popup. Nothing.
 */
export type SenderTrust = 'shell' | 'server' | 'other';

export function senderTrust(url: string, context: PolicyContext): SenderTrust {
    if (isPackagedShellUrl(url, context.shellRoot, context.platform)) return 'shell';
    if (isServerUrl(url, context)) return 'server';
    return 'other';
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * Which OS permissions a page may have.
 *
 * The product genuinely needs the microphone (dictation, meeting capture) and
 * notifications, and it needs them from the server's own pages. Everything else
 * Chromium can ask for — location, serial ports, USB devices, HID, MIDI,
 * Bluetooth — has no feature behind it here, and a privacy product that grants
 * them "just in case" is not one.
 *
 * `clipboard-read` is there for screenshot paste on Linux/Wayland: the paste
 * event carries no image there, so the web app reads the clipboard itself.
 * Chromium still requires a user gesture or focus for it.
 */
export function permissionDecision(permission: string, requestingUrl: string, context: PolicyContext): boolean {
    if (!isServerUrl(requestingUrl, context)) return false;
    switch (permission) {
        case 'media':
        case 'audioCapture':
        case 'videoCapture':
        case 'notifications':
        case 'clipboard-sanitized-write':
        case 'clipboard-read':
        case 'fullscreen':
        case 'display-capture':
            return true;
        default:
            return false;
    }
}

/** The list, exported so the settings/diagnostics page can show it verbatim. */
export const ALLOWED_IDENTITY_PROVIDERS: readonly string[] = IDENTITY_PROVIDER_HOSTS;

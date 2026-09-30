/**
 * Server addresses inside a chat answer: where a tapped link goes, and how a
 * stored image is fetched.
 *
 * Both start from the same fact. The web app is served BY the server, so the
 * server writes paths relative to itself — `/app/studio/webpages/<id>` in a
 * tool result, `/api/storage/…` as a generated image's URL — and a browser
 * resolves them for free. An APK has no such anchor (see core/api/server.ts), so a
 * relative path handed to Linking.openURL simply failed, and an image stored by
 * URL rendered as nothing.
 *
 * Pure on purpose: the server URL and the headers are passed in, so the
 * decisions can be tested without a configured server or a signed-in session.
 */

/** A generated image: inline data, or a URL once the server stored it. */
export interface MarkdownImage {
    data?: string;
    url?: string;
    mimeType: string;
}

/**
 * Maps an `/app/...` web path to this app's screen, or null. The table is the
 * notifications feature's (`translateWebLink`); it reaches here through
 * MarkdownLinkProvider, because shared code may not import a feature.
 * `approximate` marks the nearest screen rather than the thing itself (the
 * Studio hub for a section this build does not know).
 */
export type AppLinkTranslator = (path: string) => { href: string | null; approximate?: boolean } | null;

export type LinkTarget =
    /** A screen in this app — pushed onto the router. */
    | { kind: 'route'; href: string }
    /** An http(s) page — opened in a Custom Tab. */
    | { kind: 'browser'; url: string }
    /** mailto:, tel: and the like — handed to the OS. */
    | { kind: 'system'; url: string };

/**
 * The part of an absolute URL after the configured server, when it points at
 * that server — `https://ai.acme.example/app/cowork/1` → `/app/cowork/1`.
 * Null for any other host: a link to somewhere else is not ours to reroute.
 */
function onServer(url: string, serverUrl: string | null): string | null {
    if (!serverUrl) return null;
    try {
        const link = new URL(url);
        const base = new URL(serverUrl);
        if (`${link.protocol}//${link.host}` !== `${base.protocol}//${base.host}`) return null;
        // A server installed under a path (`https://host/beeflow`) keeps it.
        const prefix = base.pathname.replace(/\/+$/, '');
        if (prefix && link.pathname !== prefix && !link.pathname.startsWith(`${prefix}/`)) return null;
        return `${link.pathname.slice(prefix.length) || '/'}${link.search}`;
    } catch {
        return null;
    }
}

/** A path that starts at the server root: `/x`, but not the protocol-relative `//host/x`. */
function isRootRelative(href: string): boolean {
    return href.startsWith('/') && !href.startsWith('//');
}

// Plain prefix checks rather than regexes: every input here is text from a
// model's answer, and a scanner cannot prove a regex over it linear.
function isHttpUrl(href: string): boolean {
    const head = href.slice(0, 8).toLowerCase();
    return head.startsWith('http://') || head.startsWith('https://');
}

/** `/app`, `/app/…`, `/app?…` or `/app#…` — the web app's own address space. */
function isAppPath(path: string): boolean {
    return path.startsWith('/app') && (path.length === 4 || '/?#'.includes(path.charAt(4)));
}

/**
 * The web pages a phone's browser is actually shown: agent-hub's
 * MOBILE_ALLOWED_PAGES (authedApp/appRoutes.js), each spelled as the addresses
 * its pageFromPath maps onto that page — `/x` is the address itself, `/x/`
 * anything under it. On every other page the web's MobileRouteGuard sends a
 * phone to the Agents chat, and it does so after a sign-in, because a Custom
 * Tab does not share this app's session. So is the web's `/app/*` catch-all,
 * which draws the chat rather than the page a link names: it is not listed.
 * Pinned to the web by links.lockstep.test.ts.
 */
export const PHONE_WEB_PAGES: readonly (readonly [page: string, address: string])[] = [
    ['agents', '/app'],
    ['agents', '/app/a/'],
    ['agents', '/app/agent/'],
    ['agents', '/app/d/'],
    ['settings', '/app/settings'],
    ['settings', '/app/settings/'],
    ['apps', '/app/apps'],
    ['appRun', '/app/apps/'],
    ['forms', '/app/forms'],
    ['formView', '/app/forms/'],
    ['cowork', '/app/cowork'],
    ['cowork', '/app/cowork/'],
    ['cowork', '/app/work'],
    ['cowork', '/app/work/'],
    ['cowork', '/app/studio/cowork'],
    ['cowork', '/app/studio/cowork/'],
    // The one slice of Studio the web draws on a phone (guards.jsx).
    ['approvals', '/app/studio/approvals'],
    ['approvals', '/app/studio/approvals/'],
];

/** `/app/x/?q#h` → `/app/x`: the pathname, without a trailing slash. */
function barepath(path: string): string {
    let end = path.length;
    for (const stop of ['?', '#']) {
        const at = path.indexOf(stop);
        if (at >= 0 && at < end) end = at;
    }
    while (end > 1 && path.charAt(end - 1) === '/') end -= 1;
    return path.slice(0, end);
}

/**
 * Settings sections the web's own settings screen hides on a phone
 * (agent-hub pages/settings/settingsNavItems.jsx SETTINGS_DESKTOP_ONLY_TABS):
 * at phone width AdvancedSettings.jsx swaps them for Preferences. So although
 * 'settings' is an allowed page, a browser handed the Learning Center or
 * Connections shows Preferences after a sign-in — the address itself and
 * anything under it. Pinned to the web by links.lockstep.test.ts.
 */
export const PHONE_WEB_HIDDEN: readonly string[] = ['/app/settings/integrations', '/app/settings/learning'];

/** Does the web draw the page this `/app/...` address names on a phone? */
export function servedOnPhoneWeb(path: string): boolean {
    const bare = barepath(path);
    if (PHONE_WEB_HIDDEN.some((at) => bare === at || bare.startsWith(`${at}/`))) return false;
    return PHONE_WEB_PAGES.some(([, at]) => (at.endsWith('/') ? bare.startsWith(at) && bare.length > at.length : bare === at));
}

const SYSTEM_SCHEMES = new Set(['mailto', 'tel', 'sms', 'geo']);

function hasSystemScheme(href: string): boolean {
    const colon = href.indexOf(':');
    return colon > 0 && SYSTEM_SCHEMES.has(href.slice(0, colon).toLowerCase());
}

/**
 * The `/app/...` path an href names — relative, or an absolute URL on the
 * configured server — or null when it is not an address of the web app.
 */
function appPathOf(raw: string, serverUrl: string | null): string | null {
    const path = isRootRelative(raw) ? raw : isHttpUrl(raw) ? onServer(raw, serverUrl) : null;
    return path && isAppPath(path) ? path : null;
}

/**
 * Is this an address of the web app (`/app/...`, relative or on the configured
 * server)? For a link `linkTarget` answers null to, it tells "a page the phone
 * cannot show" — worth saying so — from "no usable address at all"
 * (`docs/setup`, a scheme we do not trust), which a computer could not open
 * either.
 */
export function isAppLink(href: string, serverUrl: string | null): boolean {
    return appPathOf(href.trim(), serverUrl) !== null;
}

/**
 * An app path: its screen here, or the web page when the web draws it on a
 * phone, or null.
 *
 * The screen wins even when it is only approximate (the Studio hub for a
 * section this build does not know): the web page is no better on a phone —
 * the web sends Studio, the admin pages, notebooks and projects to the Agents
 * chat, after a sign-in. Null for an address neither side can show, so the
 * caller says so instead of spending a sign-in on a page that bounces.
 */
function appTarget(raw: string, path: string, serverUrl: string | null, translate: AppLinkTranslator): LinkTarget | null {
    const native = translate(path);
    if (native?.href) return { kind: 'route', href: native.href };
    if (!servedOnPhoneWeb(path)) return null;
    if (isHttpUrl(raw)) return { kind: 'browser', url: raw };
    return serverUrl ? { kind: 'browser', url: `${serverUrl}${raw}` } : null;
}

/**
 * Where a link in an answer should go.
 *
 * App paths (`/app/...`, relative or on the configured server) go through
 * `translate` — the notification table, the one place that knows which web
 * screen has a native twin — so a link and a notification to the same thing
 * open the same screen (see appTarget for the rest of that address space).
 * Any other http(s) link opens in a Custom Tab, and mailto:, tel: and the
 * like go to the system.
 */
export function linkTarget(
    href: string,
    serverUrl: string | null,
    translate: AppLinkTranslator,
): LinkTarget | null {
    const raw = href.trim();
    if (!raw) return null;

    const path = appPathOf(raw, serverUrl);
    if (path) return appTarget(raw, path, serverUrl, translate);

    if (isHttpUrl(raw)) return { kind: 'browser', url: raw };
    if (isRootRelative(raw)) return serverUrl ? { kind: 'browser', url: `${serverUrl}${raw}` } : null;
    // Named schemes only. An answer can quote a web page, so its links are not
    // ours to trust, and Android resolves `intent:` into launching any app with
    // any extras. Anything else — `#anchor`, `docs/x` — has no base on a phone.
    if (hasSystemScheme(raw)) return { kind: 'system', url: raw };
    return null;
}

/** What expo-image needs to draw one generated image, or null when it cannot. */
export interface ImageSource {
    uri: string;
    headers?: Record<string, string>;
}

/**
 * The expo-image source for a generated image.
 *
 * A stored image is served by the server behind the session, like any other
 * API path, so the request carries the same headers the API client sends —
 * without them an SSO user (no cookie in this app's jar) gets a 401 and a
 * blank tile. Those headers go to the configured server ONLY: an absolute URL
 * on another host (a provider's CDN) is fetched bare, because the session
 * token is not something to hand to a third party.
 */
export function imageSource(
    image: MarkdownImage,
    serverUrl: string | null,
    headers: Record<string, string>,
): ImageSource | null {
    const url = image.url?.trim() ?? '';
    if (url.startsWith('data:')) return { uri: url };
    if (isRootRelative(url) && serverUrl) return { uri: `${serverUrl}${url}`, headers };
    if (isHttpUrl(url)) {
        return onServer(url, serverUrl) !== null ? { uri: url, headers } : { uri: url };
    }
    if (image.data) return { uri: `data:${image.mimeType};base64,${image.data}` };
    return null;
}

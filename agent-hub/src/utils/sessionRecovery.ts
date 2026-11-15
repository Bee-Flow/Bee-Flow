// What authFetch does with a 401: which requests count (decided by the path
// of the request, never by a substring of the whole URL) and whether the
// session is really gone before the page is reloaded.

import { logger } from './logger';

/**
 * API path prefixes whose 401 is an answer rather than an expired session.
 * An entry that ends in a slash is a plain prefix; one without matches the
 * path itself and everything below it.
 */
const NO_RECOVERY_PREFIXES = [
    // Login and setup flow: these handle their own 401. The session check
    // below lives here too, which is what keeps it from recursing.
    '/auth/',
    // Public health check.
    '/api/health',
    // i18n fetches before login: they fall back to the English defaults.
    '/api/languages/',
    // The connector's admin-gated routes: a 401 means "this Nextcloud user is
    // not an admin", which no reload can change.
    '/setup/',
] as const;

/** Nextcloud's two routes to the connector; the app id is the segment after the marker. */
const EMBED_MARKERS = ['/apps/app_api/proxy/', '/exapps/'] as const;

function pathnameOf(url: string): string | null {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    try { return new URL(url, origin || 'http://localhost').pathname; }
    catch (_) { return null; }
}

/**
 * The API path of a request: its pathname without the API base (a host in
 * development, Nextcloud's proxy prefix inside the embed). The query string
 * and the fragment are not part of it. Null when the URL cannot be read.
 */
export function apiPathOf(url: string, apiBase = ''): string | null {
    const pathname = pathnameOf(url);
    if (pathname === null) return null;
    let basePath = apiBase ? pathnameOf(apiBase) ?? '' : '';
    while (basePath.endsWith('/')) basePath = basePath.slice(0, -1);
    if (basePath && pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
    for (const marker of EMBED_MARKERS) {
        const at = pathname.indexOf(marker);
        if (at === -1) continue;
        const afterAppId = pathname.indexOf('/', at + marker.length);
        return afterAppId === -1 ? '/' : pathname.slice(afterAppId);
    }
    return pathname;
}

/** Does a 401 on this request mean "check whether the session expired"? */
export function shouldRecoverFrom401(url: string, apiBase = ''): boolean {
    const path = apiPathOf(url, apiBase);
    if (path === null) return false;
    return !NO_RECOVERY_PREFIXES.some((prefix) => (
        prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`)
    ));
}

// Deploy-spanning by contract, see the key inventory in utils/storageMigrations.ts.
const RELOAD_FLAG = 'bf_auth_reload_at';
const COOLDOWN_MS = 30_000;

function lastReloadAt(): number {
    try { return parseInt(sessionStorage.getItem(RELOAD_FLAG) || '0', 10) || 0; }
    catch (err) { logger.debug('sessionStorage unavailable', err); return 0; }
}

/** The call the app boots on: it answers 200 with `authenticated`, signed in or not. */
const SESSION_CHECK_PATH = '/auth/user';

/** Sends a GET to an API path through the transport that got the 401. */
type ApiGet = (apiPath: string) => Promise<Response>;

/**
 * Is the session gone, going by the answer of the session check? That is the
 * call the app boots on, so this says what a reload would show: the login
 * screen when it answers `authenticated: false` (or 401, from a proxy in front
 * of the server). Anything else, a failed check included, is not a reason to
 * throw away what is on the page.
 */
async function sessionIsGone(get: ApiGet): Promise<boolean> {
    try {
        const res = await get(SESSION_CHECK_PATH);
        if (res.status === 401) return true;
        if (!res.ok) return false;
        const body: unknown = await res.json();
        return typeof body === 'object' && body !== null && (body as { authenticated?: unknown }).authenticated === false;
    } catch (err) {
        logger.debug('session check failed', err);
        return false;
    }
}

/**
 * Build the 401 recovery for a transport. The returned function resolves once
 * it has decided: it reloads the page when the session is gone and otherwise
 * leaves the 401 to the caller, because the session is fine and only that one
 * endpoint refuses.
 *
 * Simultaneous 401s share one session check and at most one reload.
 *
 * Loop breaker: when a 401 caused a reload within the last 30s, the reload did
 * not fix the underlying problem (bad JWT, wrong audience, unprovisioned
 * user). A second one would spin forever and hide the broken endpoint.
 */
export function createSessionRecovery(get: ApiGet): (url: string) => Promise<void> {
    let inFlight: Promise<void> | null = null;

    const recover = async (): Promise<void> => {
        if (!(await sessionIsGone(get))) return;
        try { sessionStorage.setItem(RELOAD_FLAG, String(Date.now())); }
        catch (err) { logger.debug('sessionStorage unavailable', err); }
        window.location.reload();
    };

    return (url: string): Promise<void> => {
        if (Date.now() - lastReloadAt() < COOLDOWN_MS) {
            logger.warn(`[authFetch] 401 on ${url}: suppressing reload (cooldown active)`);
            return Promise.resolve();
        }
        inFlight ??= recover().finally(() => { inFlight = null; });
        return inFlight;
    };
}

// @typecheck strict
/**
 * Request screen for the remote browser (Playwright `context.route`).
 *
 * The browser sidecar resolves names itself, so a literal screen on the URL
 * host (core/http/ssrfGuard.isBlockedHost) only catches addresses spelled out
 * in the URL. This screen resolves the name on the server side as well and
 * refuses when ANY address it resolves to is one the guard forbids — the same
 * answer safeFetch gives at connect time, applied to every request Chromium
 * makes for a page: navigation, redirect hops, subresources, iframes.
 *
 * Answers are cached per screen for a short while (one screen per browser
 * context), so a page with many subresources on one host resolves it once.
 * A resolver error counts as a refusal: the route handler must answer, and
 * "could not resolve" is never a reason to let a request through.
 */

'use strict';

const dns = require('dns');
const { isBlockedHost, normalizeHostname, isForbiddenAddress, makeGuardedLookup } = require('./ssrfGuard');

const DEFAULT_TTL_MS = 60_000;

/**
 * @typedef {import('./ssrfGuard').Resolver} Resolver
 * @typedef {(hostname: string) => Promise<boolean>} HostScreen  true = the host may be dialled
 */

/**
 * Build a screen: `await screen(hostname)` answers whether every address of
 * the host is public. Literal IPs are decided without DNS; names go through
 * the guarded lookup (every record checked) and the verdict is cached.
 *
 * @param {{ lookup?: Resolver, ttlMs?: number, now?: () => number }} [options]
 *   lookup: base resolver (default dns.lookup at call time), injectable for
 *   tests; ttlMs: cache lifetime of a verdict; now: clock, for tests
 * @returns {HostScreen}
 */
function makeResolvedHostScreen({ lookup, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    const guardedLookup = makeGuardedLookup({ lookup: lookup || ((host, opts, cb) => dns.lookup(host, opts, cb)) });
    /** @type {Map<string, { ok: boolean, expiresAt: number }>} */
    const cache = new Map();
    /** @type {Map<string, Promise<boolean>>} */
    const pending = new Map();

    /** @param {string} name @returns {Promise<boolean>} */
    function resolveVerdict(name) {
        return new Promise((resolve) => {
            try {
                guardedLookup(name, { all: true }, (err) => resolve(!err));
            } catch {
                resolve(false);
            }
        });
    }

    return async function screen(hostname) {
        if (isBlockedHost(hostname)) return false;
        const { kind, canonical } = normalizeHostname(hostname);
        if (kind !== 'name') return canonical !== null && !isForbiddenAddress(canonical);
        const hit = cache.get(canonical);
        if (hit && hit.expiresAt > now()) return hit.ok;
        let inFlight = pending.get(canonical);
        if (!inFlight) {
            inFlight = resolveVerdict(canonical).then((ok) => {
                cache.set(canonical, { ok, expiresAt: now() + ttlMs });
                pending.delete(canonical);
                return ok;
            });
            pending.set(canonical, inFlight);
        }
        return inFlight;
    };
}

/**
 * The verdict for one browser request: the scheme must be http(s) and the
 * host must pass `screen`. Shared by every route handler so the rule reads
 * the same everywhere.
 * @param {string} rawUrl
 * @param {HostScreen} screen
 * @returns {Promise<boolean>}
 */
async function requestAllowed(rawUrl, screen) {
    /** @type {URL} */
    let u;
    try { u = new URL(rawUrl); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return screen(u.hostname);
}

/**
 * Route every request of `context` through `screen`: http(s) to a public
 * host continues, anything else is aborted. Page-level routes (a fake preview
 * origin fulfilled in-process) take precedence over this one.
 * @param {import('playwright').BrowserContext} context
 * @param {HostScreen} [screen]
 * @returns {Promise<HostScreen>}
 */
async function guardContextRequests(context, screen = makeResolvedHostScreen()) {
    await context.route('**/*', async (route) => (
        await requestAllowed(route.request().url(), screen) ? route.continue() : route.abort('blockedbyclient')
    ));
    return screen;
}

/**
 * WebSockets are not seen by `context.route`; screen them on their own. A
 * socket to a host `screen` accepts connects, any other is closed.
 * The verdict comes from a server-side resolution of the name; the browser
 * resolves it again when it dials, so a name whose answer changes between the
 * two lookups is not covered here (the sidecar's network isolation is).
 * @param {import('playwright').BrowserContext} context
 * @param {HostScreen} screen
 */
async function guardContextWebSockets(context, screen) {
    await context.routeWebSocket(/.*/, async (ws) => {
        const httpUrl = ws.url().replace(/^ws(s?):/i, 'http$1:');
        if (await requestAllowed(httpUrl, screen)) {
            ws.connectToServer();
            return;
        }
        await ws.close();
    });
}

const OFFLINE_SCHEMES = new Set(['data:', 'about:', 'blob:']);

/**
 * For a render that needs no network at all (PDF of already-inlined HTML):
 * only data:, about: and blob: continue; every other request and every
 * WebSocket is refused.
 * @param {import('playwright').BrowserContext} context
 */
async function blockContextNetwork(context) {
    await context.route('**/*', (route) => {
        const url = route.request().url();
        const protocol = URL.canParse(url) ? new URL(url).protocol : '';
        return OFFLINE_SCHEMES.has(protocol) ? route.continue() : route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, (ws) => ws.close());
}

module.exports = {
    makeResolvedHostScreen, requestAllowed, guardContextRequests, guardContextWebSockets, blockContextNetwork,
    DEFAULT_TTL_MS,
};

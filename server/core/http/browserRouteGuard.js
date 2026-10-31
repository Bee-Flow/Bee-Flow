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

module.exports = { makeResolvedHostScreen, requestAllowed, DEFAULT_TTL_MS };

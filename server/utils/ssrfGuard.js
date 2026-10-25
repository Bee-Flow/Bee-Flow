// @typecheck
/**
 * Shared SSRF guard for user-controlled URLs (the Playwright test runner, the
 * security-scan worker, the code-step sandbox, read_url, KB ingestion, ...).
 *
 * A thin adapter: the address table, the host screen and the guarded
 * dispatcher are the canonical core/http/ssrfGuard.js. What this module adds
 * is its own error vocabulary (EPRIVATEADDRESS, the "Refused: ..." text the
 * callers show and match on) and its safeFetch semantics: http and https,
 * redirects followed, every hop re-validated at socket-connect time.
 *
 * Layers (defence in depth), all from the canonical module:
 *   1. isPrivateHostname(host)  literal screen on the URL host before any
 *      network activity (localhost, metadata hostnames, private IPs in any
 *      numeric spelling).
 *   2. validatingLookup         dns.lookup-compatible; rejects when ANY
 *      resolved address is private. Runs on EVERY connect: the DNS-rebinding
 *      defence, and because redirects open fresh connections it also covers
 *      every redirect hop.
 *   3. The connector re-screens the hostname (net.connect() bypasses the
 *      custom lookup for IP-literal hosts) and checks the connected peer.
 *
 * safeFetch(url, opts) = undici fetch through that Agent. Use it anywhere
 * user-controlled URLs are fetched.
 */

'use strict';

const net = require('net');
const dns = require('dns');
const { fetch: undiciFetch } = require('undici');
const canonical = require('../core/http/ssrfGuard');

const PRIVATE_ADDRESS_ERROR_CODE = 'EPRIVATEADDRESS';
const PRIVATE_ADDRESS_ERROR_MESSAGE = 'Refused: target resolves to a private/internal address.';

// Kept for API compatibility. The decision is made by the canonical table
// (canonical.isBlockedHost), which blocks every host these patterns match.
const PRIVATE_HOST_REGEXES = [
    /^localhost$/i,
    /^127(?:\.\d{1,3}){3}$/,
    /^10(?:\.\d{1,3}){3}$/,
    /^192\.168(?:\.\d{1,3}){2}$/,
    /^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/,
    /^169\.254(?:\.\d{1,3}){2}$/,
    /^::1$/,
    /^fc[0-9a-f]{2}:/i,
    /^fd[0-9a-f]{2}:/i,
    /^fe80:/i,
    /^metadata\.google\.internal$/i,
];

function privateAddressError(host) {
    const err = /** @type {Error & { code?: string, host?: string }} */ (new Error(PRIVATE_ADDRESS_ERROR_MESSAGE));
    err.code = PRIVATE_ADDRESS_ERROR_CODE;
    err.host = host;
    return err;
}

/** An empty DNS answer: an ordinary resolver error, not a refusal. */
function unresolvedError(host) {
    const err = /** @type {Error & { code?: string, hostname?: string }} */ (new Error(`getaddrinfo ENOTFOUND ${host}`));
    err.code = 'ENOTFOUND';
    err.hostname = host;
    return err;
}

/** True when `err` (or anything in its cause chain) is our refusal. */
function isPrivateAddressError(err) {
    for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
        if (e.code === PRIVATE_ADDRESS_ERROR_CODE) return true;
        if (Array.isArray(e.errors) && e.errors.some(inner => isPrivateAddressError(inner))) return true;
    }
    return false;
}

/**
 * True when `ip` is a private / internal / non-routable address. Non-IP
 * input returns false: use isPrivateHostname() for hostnames.
 */
function isPrivateIp(ip) {
    if (typeof ip !== 'string') return false;
    let addr = ip.trim().replace(/^\[/, '').replace(/\]$/, '');
    const zone = addr.indexOf('%');
    if (zone !== -1) addr = addr.slice(0, zone);
    if (net.isIP(addr) === 0) return false;
    return canonical.isForbiddenAddress(addr);
}

/**
 * Literal screen on a URL hostname (no DNS). Empty / non-string hosts are
 * treated as private (refuse). Normalises brackets and the FQDN trailing dot.
 */
function isPrivateHostname(host) {
    return canonical.isBlockedHost(host);
}

/**
 * Build a dns.lookup-compatible function that resolves via `baseLookup`
 * (default: real dns.lookup) and fails with EPRIVATEADDRESS when the name
 * screens private or ANY resolved address is private. Handles both the
 * single-address and `all: true` (Happy Eyeballs) callback shapes.
 *
 * @param {Function} [baseLookup]
 */
function makeValidatingLookup(baseLookup = dns.lookup) {
    return canonical.makeGuardedLookup({ lookup: baseLookup, refuse: privateAddressError, unresolved: unresolvedError });
}

const validatingLookup = makeValidatingLookup();

/**
 * Agent whose connector (a) re-screens the hostname (net.connect() skips
 * custom lookups for IP literals, so redirect hops to e.g. https://10.0.0.5/
 * must be refused there), (b) resolves names through validatingLookup and
 * (c) checks the connected peer. `lookup` is injectable for tests.
 *
 * @param {{ lookup?: typeof import('node:dns').lookup }} [options]
 */
function makeSafeDispatcher({ lookup } = {}) {
    return canonical.createGuardedDispatcher({
        lookup: lookup || dns.lookup,
        refuse: privateAddressError,
        unresolved: unresolvedError,
    });
}

/** @type {ReturnType<typeof makeSafeDispatcher> | null} */
let _defaultDispatcher = null;
function defaultDispatcher() {
    if (!_defaultDispatcher) _defaultDispatcher = makeSafeDispatcher();
    return _defaultDispatcher;
}

/**
 * fetch() that can't reach private/internal addresses: every socket
 * connect (initial request AND each redirect hop) revalidates the target,
 * so DNS rebinding and redirect laundering both fail with an error whose
 * cause chain satisfies isPrivateAddressError(). Throws on refusal; callers
 * that need a structured error catch + translate (see codeSandbox).
 */
async function safeFetch(url, opts = {}) {
    const parsed = new URL(typeof url === 'string' ? url : String(url));
    if (isPrivateHostname(parsed.hostname)) throw privateAddressError(parsed.hostname);
    const { dispatcher, ...init } = opts || {};
    return undiciFetch(url, { ...init, dispatcher: dispatcher || defaultDispatcher() });
}

module.exports = {
    PRIVATE_HOST_REGEXES,
    PRIVATE_ADDRESS_ERROR_CODE,
    PRIVATE_ADDRESS_ERROR_MESSAGE,
    isPrivateIp,
    isPrivateHostname,
    isPrivateAddressError,
    makeValidatingLookup,
    validatingLookup,
    makeSafeDispatcher,
    safeFetch,
};

/** @typedef {{ code?: string, cause?: ErrLike, errors?: ErrLike[] }} ErrLike */

// @typecheck strict
/**
 * The SSRF guard: one address table, one host screen, one guarded dispatcher.
 *
 * Every outbound path that may be pointed at a user-supplied URL decides
 * "is this target internal?" here. The two older entry points are thin
 * adapters over this module and keep their own names, signatures and error
 * texts:
 *   - utils/ssrfGuard.js             (EPRIVATEADDRESS errors, redirects
 *                                     followed, http and https)
 *   - core/customIntegrations/ssrfGuard.js (generic messages, https only,
 *                                     no redirects; a plain re-export)
 *   - utils/isPrivateTarget.js       (sync literal pre-filter on a URL)
 *
 * Layers:
 *   1. isForbiddenAddress(ip)    pure numeric range check (no DNS). THE table.
 *   2. normalizeHostname(host)   pure; canonicalizes every numeric IPv4
 *      spelling (short-form, decimal, hex, octal, mixed: inet_aton semantics)
 *      so nothing numeric-ambiguous ever reaches DNS as a "name".
 *   3. isBlockedHost(host)       pure literal screen on a hostname: the
 *      table above plus the names that always mean "this machine / the cloud
 *      metadata service" (localhost, metadata.google.internal).
 *   4. assertPublicHttpsTarget(url)  async; scheme/userinfo checks plus a
 *      full DNS lookup where EVERY resolved address must be public.
 *   5. createGuardedDispatcher()  undici Agent whose connector re-screens the
 *      host (net.connect skips a custom lookup for IP literals, so a redirect
 *      to https://10.0.0.5/ is refused here), resolves names through a lookup
 *      that rejects when ANY record is forbidden (DNS rebinding, and every
 *      redirect hop, since each hop opens its own connection), and checks the
 *      socket's actual peer address after connect. HTTP/1.1 only
 *      (allowH2: false): undici 8 offers h2 by default.
 *
 * All messages thrown by the https-target guard are intentionally generic:
 * they are shown to org admins building integrations and must never echo
 * internal detail.
 *
 * Not to be confused with core/http/ipClass.js, which classifies an address a
 * socket already reached (for the geo/egress ledger); it does not gate.
 */

'use strict';

const dns = require('dns');
const { parseIPv4Numeric, formatIPv4, looksNumericLabel, parseIPv6, isForbiddenIPv4Int, isForbiddenIPv6Bytes } = require('./ssrfGuardParseIPv6');

// ── IPv4 / IPv6 parsing lives in ./ssrfGuardParseIPv6 ─────────────

// RFC 5952-style text form (lowercase, longest zero run compressed,
// v4-mapped kept in mixed notation).
/**
 * @param {number[]} bytes
 * @returns {string}
 */
function formatIPv6(bytes) {
    /** @type {number[]} */
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0
        && groups[4] === 0 && groups[5] === 0xffff) {
        return `::ffff:${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    }
    let best = -1;
    let bestLen = 0;
    for (let i = 0; i < 8;) {
        if (groups[i] !== 0) { i++; continue; }
        let j = i;
        while (j < 8 && groups[j] === 0) j++;
        if (j - i > bestLen) { bestLen = j - i; best = i; }
        i = j;
    }
    if (bestLen < 2) return groups.map(g => g.toString(16)).join(':');
    const headStr = groups.slice(0, best).map(g => g.toString(16)).join(':');
    const tailStr = groups.slice(best + bestLen).map(g => g.toString(16)).join(':');
    return `${headStr}::${tailStr}`;
}

// ── Forbidden range checks (numeric, never regex-on-strings) ──────
// The tables themselves live in ./ssrfGuardParseIPv6.

/**
 * True when `ip` is loopback, RFC1918, link-local, ULA, CGNAT, 0.0.0.0/8,
 * 192.0.0.0/24, 198.18.0.0/15, multicast, reserved, broadcast, unspecified,
 * site-local, or a wrapped IPv4 form (mapped, compat, NAT64, 6to4) of any of those.
 * Fail-closed: anything that does not parse as an IP is also forbidden —
 * callers only pass literal IPs (resolved addresses / numeric hostnames).
 * @param {unknown} ip
 * @returns {boolean}
 */
function isForbiddenAddress(ip) {
    if (typeof ip !== 'string' || ip.length === 0) return true;
    let h = ip.trim().toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    if (h.includes(':')) {
        const bytes = parseIPv6(h);
        return bytes === null ? true : isForbiddenIPv6Bytes(bytes);
    }
    const n = parseIPv4Numeric(h.split('.'));
    return n === null ? true : isForbiddenIPv4Int(n);
}

/**
 * Classifies a hostname as a literal IP or a DNS name.
 * Returns { kind: 'ip4' | 'ip6' | 'name', canonical }.
 *   - ip4: canonical is the dotted quad, or null when the host LOOKS numeric
 *     but is malformed (e.g. "300.1.2.3") — callers must treat null as
 *     forbidden, never fall through to DNS.
 *   - ip6: canonical is the RFC 5952 text form, or null when malformed.
 *   - name: canonical is lowercased with brackets/trailing dot stripped.
 * @param {unknown} host
 * @returns {HostClass}
 */
function normalizeHostname(host) {
    let h = String(host || '').trim().toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    if (h.includes(':')) {
        const bytes = parseIPv6(h);
        return { kind: 'ip6', canonical: bytes === null ? null : formatIPv6(bytes) };
    }
    if (h.endsWith('.')) h = h.slice(0, -1);
    const parts = h.split('.');
    if (h !== '' && parts.length <= 4 && parts.every(looksNumericLabel)) {
        const n = parseIPv4Numeric(parts);
        return { kind: 'ip4', canonical: n === null ? null : formatIPv4(n) };
    }
    return { kind: 'name', canonical: h };
}

// ── Literal host screen ───────────────────────────────────────────

// Names that always mean "this machine" or "the cloud metadata service",
// whatever DNS says (metadata.google.internal only resolves inside GCP).
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/**
 * True when `host` must never be dialled: empty, a blocked name, or a literal
 * IP (in any spelling) that is forbidden or malformed. A DNS name is NOT
 * blocked here; its addresses are checked at lookup time.
 * Normalises surrounding whitespace, case, brackets and one trailing dot.
 * @param {unknown} host
 * @returns {boolean}
 */
function isBlockedHost(host) {
    if (typeof host !== 'string') return true;
    const h = host.trim().toLowerCase()
        .replace(/^\[/, '').replace(/\]$/, '')
        .replace(/\.$/, '');
    if (!h) return true;
    if (BLOCKED_HOSTNAMES.has(h)) return true;
    const { kind, canonical } = normalizeHostname(h);
    if (kind === 'name') return false;
    return canonical === null || isForbiddenAddress(canonical);
}

// ── Async URL guard ───────────────────────────────────────────────

/**
 * Validates that `rawUrl` is an https (by default) URL whose host — literal
 * or every DNS-resolved address — is public. Throws a generic Error on any
 * violation. Returns { url, addresses } on success.
 *
 * `options.lookup` exists for tests; production callers use dns.promises.
 * @param {unknown} rawUrl
 * @param {{ requireHttps?: boolean, lookup?: typeof dns.promises.lookup }} [options]
 * @returns {Promise<{ url: URL, addresses: string[] }>}
 */
async function assertPublicHttpsTarget(rawUrl, { requireHttps = true, lookup = dns.promises.lookup } = {}) {
    /** @type {URL} */
    let url;
    try {
        url = new URL(String(rawUrl));
    } catch {
        throw new Error('Invalid URL.');
    }
    if (url.protocol !== 'https:' && !(requireHttps === false && url.protocol === 'http:')) {
        throw new Error(requireHttps ? 'Only https:// URLs are allowed.' : 'Only http(s) URLs are allowed.');
    }
    if (url.username || url.password) {
        throw new Error('URLs with embedded credentials are not allowed.');
    }
    if (!url.hostname) {
        throw new Error('Invalid URL.');
    }
    const { kind, canonical } = normalizeHostname(url.hostname);
    if (kind !== 'name') {
        if (canonical === null || isForbiddenAddress(canonical)) {
            throw new Error('Target address is not allowed.');
        }
        return { url, addresses: [canonical] };
    }
    let results;
    try {
        results = await lookup(canonical, { all: true, verbatim: true });
    } catch {
        throw new Error('Target host could not be resolved.');
    }
    if (!Array.isArray(results) || results.length === 0) {
        throw new Error('Target host could not be resolved.');
    }
    for (const r of results) {
        if (!r || typeof r.address !== 'string' || isForbiddenAddress(r.address)) {
            throw new Error('Target address is not allowed.');
        }
    }
    return { url, addresses: results.map(r => r.address) };
}

// ── Guarded lookup + dispatcher (anti-rebinding) ──────────────────

const genericRefusal = () => new Error('Target address is not allowed.');
const genericUnresolved = () => new Error('Target host could not be resolved.');

/**
 * A dns.lookup-compatible function for net.connect that fails with
 * `refuse(hostname)` when the name screens as blocked or ANY resolved record
 * is forbidden. It always resolves with `all: true` internally, so a
 * multi-record answer cannot smuggle a private address past a single-address
 * happy path, and answers in whichever shape the caller asked for.
 *
 * @param {{ lookup?: Resolver, refuse?: (host: string) => Error, unresolved?: (host: string) => Error }} [options]
 *   lookup: base resolver (default: dns.lookup), injectable for tests; refuse: error for a forbidden target;
 *   unresolved: error for an empty answer
 * @returns {GuardedLookup}
 */
function makeGuardedLookup({ lookup, refuse = genericRefusal, unresolved = genericUnresolved } = {}) {
    // Without an injected resolver, dns.lookup is read at call time.
    /** @type {Resolver} */
    const resolve = lookup || ((host, opts, cb) => dns.lookup(host, opts, cb));
    /** @type {GuardedLookup} */
    const guardedLookup = (hostname, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        if (typeof cb !== 'function') throw new TypeError('A lookup callback is required.');
        const opts = typeof options === 'function' ? {} : (options || {});
        // Node's net module ignores the answer when err is set; the placeholder only satisfies the callback type.
        const noAnswer = opts.all ? [] : '';
        if (isBlockedHost(hostname)) {
            process.nextTick(cb, refuse(hostname), noAnswer);
            return;
        }
        resolve(hostname, { ...opts, all: true }, (err, addresses, family) => {
            if (err) return cb(err, noAnswer);
            /** @type {Array<{ address?: unknown, family?: number } | null | undefined>} */
            const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family }])
                .map(e => (typeof e === 'string' ? { address: e, family: e.includes(':') ? 6 : 4 } : e));
            if (list.length === 0) return cb(unresolved(hostname), noAnswer);
            for (const entry of list) {
                if (!entry || typeof entry.address !== 'string' || isForbiddenAddress(entry.address)) {
                    return cb(refuse(hostname), noAnswer);
                }
            }
            /** @type {dns.LookupAddress[]} */
            const answers = [];
            for (const entry of list) {
                if (!entry || typeof entry.address !== 'string') continue; // unreachable: screened above
                answers.push({ address: entry.address, family: entry.family ?? (entry.address.includes(':') ? 6 : 4) });
            }
            if (opts.all) return cb(null, answers);
            cb(null, answers[0].address, answers[0].family);
        });
    };
    return guardedLookup;
}

/**
 * Wrap an undici connector: refuse a blocked host before dialling (IP
 * literals never reach the lookup), and refuse a socket whose actual peer is
 * forbidden (destroying it), whatever resolved it.
 *
 * @param {import("undici").buildConnector.connector} baseConnect                 an undici connector (buildConnector result)
 * @param {(host: string) => Error} refuse
 * @returns {import("undici").buildConnector.connector}
 */
function guardConnector(baseConnect, refuse = genericRefusal) {
    return function guardedConnect(opts, callback) {
        const host = String((opts && opts.hostname) || '').replace(/^\[/, '').replace(/\]$/, '');
        if (isBlockedHost(host)) {
            process.nextTick(callback, refuse(host), null);
            return null;
        }
        return baseConnect(opts, (err, socket) => {
            if (err) return callback(err, null);
            const remote = socket && socket.remoteAddress;
            if (!remote || isForbiddenAddress(remote)) {
                if (socket) socket.destroy();
                return callback(refuse(host), null);
            }
            callback(null, socket);
        });
    };
}

/**
 * THE guarded dispatcher factory: an undici Agent built from guardConnector
 * over a connector that resolves through makeGuardedLookup. HTTP/1.1 only,
 * on the Agent and on the connector (a custom connector keeps the ALPN list
 * it was built with, so both need the flag).
 * undici is required lazily so the pure helpers stay dependency-free.
 *
 * @param {{ lookup?: Resolver, refuse?: (host: string) => Error, unresolved?: (host: string) => Error }} [options]
 */
function createGuardedDispatcher({ lookup, refuse = genericRefusal, unresolved = genericUnresolved } = {}) {
    const { Agent, buildConnector } = require('undici');
    const baseConnect = buildConnector({
        allowH2: false,
        lookup: makeGuardedLookup({ lookup, refuse, unresolved }),
    });
    return new Agent({ allowH2: false, connect: guardConnector(baseConnect, refuse) });
}

/** @type {import('undici').Agent | null} */
let sharedDispatcher = null;

/**
 * Shared guarded Agent with the generic messages of the https-target guard.
 */
function createPinnedDispatcher() {
    if (!sharedDispatcher) sharedDispatcher = createGuardedDispatcher();
    return sharedDispatcher;
}

/**
 * fetch() with the full guard stack: pre-flight DNS validation, no
 * redirects (each hop must be re-validated by the caller), and the pinned
 * dispatcher. Callers supply their own AbortController/timeout via options.
 * @param {string | URL} rawUrl
 * @param {import('undici').RequestInit} [options]
 */
async function safeFetch(rawUrl, options = {}) {
    await assertPublicHttpsTarget(rawUrl);
    // undici's own fetch guarantees dispatcher compatibility regardless of
    // the Node-bundled undici version backing globalThis.fetch.
    const { fetch: undiciFetch } = require('undici');
    return undiciFetch(rawUrl, {
        ...options,
        redirect: 'error',
        dispatcher: createPinnedDispatcher(),
    });
}

module.exports = {
    isForbiddenAddress,
    normalizeHostname,
    isBlockedHost,
    assertPublicHttpsTarget,
    makeGuardedLookup,
    guardConnector,
    createGuardedDispatcher,
    createPinnedDispatcher,
    safeFetch,
};

/**
 * @typedef {(err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void} LookupCallback
 * @typedef {(err: NodeJS.ErrnoException | null, address?: string | Array<string | dns.LookupAddress>, family?: number) => void} ResolverCallback
 * @typedef {(host: string, opts: dns.LookupOptions, cb: ResolverCallback) => void} Resolver
 * @typedef {{ kind: 'name', canonical: string } | { kind: 'ip4' | 'ip6', canonical: string | null }} HostClass  a hostname told apart: a DNS name, or an IP literal (canonical null when malformed)
 * @typedef {(hostname: string, options: dns.LookupOptions | LookupCallback, callback?: LookupCallback) => void} GuardedLookup
 */

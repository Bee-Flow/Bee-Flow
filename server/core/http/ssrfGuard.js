// @typecheck
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

// ── IPv4 parsing (inet_aton semantics) ────────────────────────────

// Parses one dot-separated part in decimal / 0x-hex / 0-octal form.
// Returns null when the part is not a clean numeric token.
function parseIPv4Part(part) {
    if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part.slice(2), 16);
    if (/^0[0-7]*$/.test(part)) return parseInt(part, 8);
    if (/^[1-9][0-9]*$/.test(part)) return parseInt(part, 10);
    return null;
}

// inet_aton: 1 part = 32-bit value, 2 parts = a.b24, 3 parts = a.b.c16,
// 4 parts = dotted quad. Returns the address as an unsigned 32-bit int,
// or null when any part is malformed / out of range.
function parseIPv4Numeric(parts) {
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > 4) return null;
    const nums = [];
    for (const p of parts) {
        const v = parseIPv4Part(p);
        if (v === null || !Number.isFinite(v)) return null;
        nums.push(v);
    }
    // The final part covers all remaining bytes; the leading parts are octets.
    const last = nums[nums.length - 1];
    if (last < 0 || last >= 2 ** (8 * (4 - (nums.length - 1)))) return null;
    let n = last;
    for (let i = 0; i < nums.length - 1; i++) {
        if (nums[i] < 0 || nums[i] > 255) return null;
        n += nums[i] * 2 ** (8 * (3 - i));
    }
    return n >>> 0;
}

function formatIPv4(n) {
    return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

// True when the label could plausibly be a numeric IPv4 part — even an
// invalid one like "08" or "0x". Hosts made entirely of such labels are
// treated as (possibly malformed) IPs, never as DNS names.
function looksNumericLabel(label) {
    return /^0x[0-9a-f]*$/i.test(label) || /^[0-9]+$/.test(label);
}

// ── IPv6 parsing ──────────────────────────────────────────────────

// Returns a 16-entry byte array, or null when malformed. Accepts an
// embedded IPv4 tail ("::ffff:127.0.0.1") and strips %zone identifiers.
function parseIPv6(input) {
    let s = String(input);
    const zone = s.indexOf('%');
    if (zone !== -1) s = s.slice(0, zone);
    if (!s) return null;

    let head = s;
    let tail = null;
    const dc = s.indexOf('::');
    if (dc !== -1) {
        if (s.indexOf('::', dc + 1) !== -1) return null;
        head = s.slice(0, dc);
        tail = s.slice(dc + 2);
    }

    const parseGroups = (part, v4TailAllowed) => {
        if (part === '') return [];
        const segs = part.split(':');
        const out = [];
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            if (v4TailAllowed && i === segs.length - 1 && seg.includes('.')) {
                const v4 = parseIPv4Numeric(seg.split('.'));
                if (v4 === null) return null;
                out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
                continue;
            }
            if (!/^[0-9a-f]{1,4}$/i.test(seg)) return null;
            out.push(parseInt(seg, 16));
        }
        return out;
    };

    const headGroups = parseGroups(head, tail === null);
    if (headGroups === null) return null;
    let groups;
    if (tail === null) {
        if (headGroups.length !== 8) return null;
        groups = headGroups;
    } else {
        const tailGroups = parseGroups(tail, true);
        if (tailGroups === null) return null;
        if (headGroups.length + tailGroups.length > 7) return null;
        const fill = new Array(8 - headGroups.length - tailGroups.length).fill(0);
        groups = [...headGroups, ...fill, ...tailGroups];
    }
    const bytes = [];
    for (const g of groups) {
        bytes.push((g >> 8) & 0xff, g & 0xff);
    }
    return bytes;
}

// RFC 5952-style text form (lowercase, longest zero run compressed,
// v4-mapped kept in mixed notation).
function formatIPv6(bytes) {
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

function isForbiddenIPv4Int(n) {
    const top = n >>> 24;
    if (top === 0) return true;                                   // 0.0.0.0/8
    if (top === 10) return true;                                  // 10.0.0.0/8
    if (top === 127) return true;                                 // 127.0.0.0/8
    if (((n & 0xffc00000) >>> 0) === 0x64400000) return true;     // 100.64.0.0/10 (CGNAT)
    if ((n >>> 16) === 0xa9fe) return true;                       // 169.254.0.0/16
    if (((n & 0xfff00000) >>> 0) === 0xac100000) return true;     // 172.16.0.0/12
    if ((n >>> 16) === 0xc0a8) return true;                       // 192.168.0.0/16
    if (n === 0xffffffff) return true;                            // broadcast
    return false;
}

function isForbiddenIPv6Bytes(bytes) {
    let leadingZeroBytes = 0;
    while (leadingZeroBytes < 16 && bytes[leadingZeroBytes] === 0) leadingZeroBytes++;
    if (leadingZeroBytes === 16) return true;                     // :: unspecified
    if (leadingZeroBytes === 15 && bytes[15] === 1) return true;  // ::1 loopback
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
    if ((bytes[0] & 0xfe) === 0xfc) return true;                  // fc00::/7 ULA
    const v4 = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
    if (leadingZeroBytes >= 10 && bytes[10] === 0xff && bytes[11] === 0xff) {
        return isForbiddenIPv4Int(v4);                            // ::ffff:a.b.c.d mapped
    }
    if (leadingZeroBytes >= 12) {
        return isForbiddenIPv4Int(v4);                            // deprecated ::a.b.c.d compat
    }
    return false;
}

/**
 * True when `ip` is loopback, RFC1918, link-local, ULA, CGNAT, 0.0.0.0/8,
 * broadcast, unspecified, or an IPv4-mapped IPv6 form of any of those.
 * Fail-closed: anything that does not parse as an IP is also forbidden —
 * callers only pass literal IPs (resolved addresses / numeric hostnames).
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
 */
async function assertPublicHttpsTarget(rawUrl, { requireHttps = true, lookup = dns.promises.lookup } = {}) {
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
 * @param {object} [options]
 * @param {Function} [options.lookup]      base resolver (default: dns.lookup); injectable for tests
 * @param {(host: string) => Error} [options.refuse]      error for a forbidden target
 * @param {(host: string) => Error} [options.unresolved]  error for an empty answer
 */
function makeGuardedLookup({ lookup, refuse = genericRefusal, unresolved = genericUnresolved } = {}) {
    // Without an injected resolver, dns.lookup is read at call time.
    const resolve = lookup || ((host, opts, cb) => dns.lookup(host, opts, cb));
    return function guardedLookup(hostname, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        const opts = options || {};
        if (isBlockedHost(hostname)) {
            process.nextTick(callback, refuse(hostname));
            return;
        }
        resolve(hostname, { ...opts, all: true }, (err, addresses, family) => {
            if (err) return callback(err);
            const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family }])
                .map(e => (typeof e === 'string' ? { address: e, family: e.includes(':') ? 6 : 4 } : e));
            if (list.length === 0) return callback(unresolved(hostname));
            for (const entry of list) {
                if (!entry || typeof entry.address !== 'string' || isForbiddenAddress(entry.address)) {
                    return callback(refuse(hostname));
                }
            }
            if (opts.all) return callback(null, list);
            callback(null, list[0].address, list[0].family);
        });
    };
}

/**
 * Wrap an undici connector: refuse a blocked host before dialling (IP
 * literals never reach the lookup), and refuse a socket whose actual peer is
 * forbidden (destroying it), whatever resolved it.
 *
 * @param {Function} baseConnect                 an undici connector (buildConnector result)
 * @param {(host: string) => Error} refuse
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
 * @param {object} [options]
 * @param {Function} [options.lookup]
 * @param {(host: string) => Error} [options.refuse]
 * @param {(host: string) => Error} [options.unresolved]
 */
function createGuardedDispatcher({ lookup, refuse = genericRefusal, unresolved = genericUnresolved } = {}) {
    const { Agent, buildConnector } = require('undici');
    const baseConnect = buildConnector({
        allowH2: false,
        lookup: makeGuardedLookup({ lookup, refuse, unresolved }),
    });
    return new Agent({ allowH2: false, connect: guardConnector(baseConnect, refuse) });
}

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
 * @typedef {(err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void} LookupCallback
 * @typedef {(err: NodeJS.ErrnoException | null, address?: string | Array<string | dns.LookupAddress>, family?: number) => void} ResolverCallback
 * @typedef {(host: string, opts: dns.LookupOptions, cb: ResolverCallback) => void} Resolver
 */

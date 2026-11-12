// @typecheck
/**
 * Nextcloud target validation — the SSRF gate for user-supplied Nextcloud URLs.
 *
 * A user can save their own Nextcloud base URL alongside their app password
 * (Settings → Verbindingen). Every subsequent call attaches their Basic
 * credentials, so an unvalidated URL turns the server into a credential-bearing
 * probe of its own network. A check of "is it http(s)" alone is not enough.
 *
 * Policy:
 *   - Private / loopback / link-local targets are REFUSED by default.
 *   - NEXTCLOUD_ALLOW_PRIVATE_HOSTS re-allows private and loopback targets,
 *     because self-hosted installs legitimately run Nextcloud on a LAN
 *     address. A comma-separated list of host names or IP addresses allows
 *     exactly those hosts (the installer writes the Nextcloud host it asked
 *     for); `1` allows every private host, as before. This is a
 *     deployment-level decision, not a per-user one.
 *   - Cloud metadata endpoints stay blocked in BOTH modes. There is no
 *     legitimate Nextcloud at 169.254.169.254, and that is the one target where
 *     a blind SSRF turns directly into cloud credentials.
 *
 * Enforced twice on purpose: at save time (fast, clear error) and again at use
 * time in nextcloudClient (rows saved before this existed, and DNS that changes
 * after the save). Use-time protection comes from ssrfGuard.safeFetch, which
 * also re-resolves on every connect and redirect hop (DNS-rebinding defence).
 */

const dns = require('dns');
const { isPrivateHostname, safeFetch } = require('../utils/ssrfGuard');
const { bestEffort } = require('./bestEffort');

const MAX_REDIRECTS = 5;

// Refused regardless of NEXTCLOUD_ALLOW_PRIVATE_HOSTS.
const METADATA_HOSTNAMES = new Set([
    'metadata.google.internal',
    'metadata.goog',
    'instance-data',
    'metadata',
]);
const LINK_LOCAL_V4_RE = /^169\.254(?:\.\d{1,3}){2}$/;
// fe80::/10 link-local and the IMDS v6 address.
const LINK_LOCAL_V6_RE = /^\[?(?:fe[89ab][0-9a-f]:|fd00:ec2::254)/i;
// 169.254.0.0/16 written as IPv4-mapped IPv6 (the URL parser turns
// ::ffff:169.254.x.y into ::ffff:a9fe:xxyy).
const LINK_LOCAL_MAPPED_RE = /^\[?::ffff:(?:a9fe:|169\.254\.)/i;

const MAX_URL_LENGTH = 512;

/** A host as compared: lower case, without IPv6 brackets. */
function bareHost(host) {
    const h = String(host || '').trim().toLowerCase();
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/**
 * The private hosts this deployment allows: null = every private host
 * (NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1), otherwise the listed hosts (empty = none).
 * A list entry may carry a port (`nc.lan:8080`); only the host counts.
 * @returns {string[] | null}
 */
function allowedPrivateHosts() {
    const raw = String(process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS || '').trim();
    if (raw === '1') return null;
    if (!raw || raw === '0') return [];
    return raw.split(',').map((entry) => {
        const e = entry.trim();
        if (e.startsWith('[')) return bareHost(e.slice(0, e.indexOf(']') + 1));
        // host:port (one colon); a bare IPv6 address has several.
        return bareHost(e.split(':').length === 2 ? e.split(':')[0] : e);
    }).filter(Boolean);
}

/** True when some private host is allowed (all of them, or a list). */
function allowPrivateHosts() {
    const allowed = allowedPrivateHosts();
    return allowed === null || allowed.length > 0;
}

/** True when this private host may be called. */
function privateHostAllowed(hostname) {
    const allowed = allowedPrivateHosts();
    return allowed === null || allowed.includes(bareHost(hostname));
}

/** Metadata endpoints — never reachable, whatever the deployment allows. */
function isMetadataHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return METADATA_HOSTNAMES.has(host)
        || LINK_LOCAL_V4_RE.test(host)
        || LINK_LOCAL_V6_RE.test(host)
        || LINK_LOCAL_MAPPED_RE.test(host);
}

/**
 * Throws when `rawUrl` is not an acceptable Nextcloud target.
 * The thrown message is user-facing: it names the env flag so a self-hoster
 * knows exactly why their LAN address was refused.
 */
function assertAllowedNextcloudHost(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl));
    } catch (_) {
        throw new Error('Enter a valid Nextcloud URL (e.g. https://cloud.example.com)');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('The Nextcloud URL must start with http:// or https://');
    }
    // Credentials in the URL would be silently carried into every request.
    if (parsed.username || parsed.password) {
        throw new Error('The Nextcloud URL must not contain a username or password');
    }
    if (isMetadataHost(parsed.hostname)) {
        throw new Error('That address is not a valid Nextcloud host.');
    }
    if (isPrivateHostname(parsed.hostname) && !privateHostAllowed(parsed.hostname)) {
        throw new Error(
            'That Nextcloud URL points to a private or local network address. '
            + 'If this is a self-hosted install on your own network, list that host in '
            + 'NEXTCLOUD_ALLOW_PRIVATE_HOSTS on the server (or set NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1) to allow it.'
        );
    }
    return parsed;
}

/** Boolean form for call sites that pick their own error shape. */
function isAllowedNextcloudHost(rawUrl) {
    try {
        assertAllowedNextcloudHost(rawUrl);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * fetch() for every Nextcloud call — validates the target first, then routes:
 *
 *   default            → ssrfGuard.safeFetch (blocks private addresses at
 *                        connect time, so DNS rebinding and redirect hops are
 *                        covered too).
 *   ALLOW_PRIVATE_HOSTS → fetch that allows LAN and loopback targets, because
 *                        the whole point of the flag is that they are
 *                        intended. Link-local and metadata addresses are
 *                        still refused at connect time, and redirects are
 *                        followed by hand (privateHostFetch), so every hop
 *                        passes the metadata check above.
 *
 * Use-time validation matters independently of save-time validation: rows
 * written before this guard existed are already in the database.
 */
async function nextcloudFetch(url, opts = {}) {
    const parsed = assertAllowedNextcloudHost(url);
    // A listed host goes out as a private target; any other host keeps the
    // connect-time screen of safeFetch (a public name that resolves to a
    // private address is refused there).
    const listed = allowedPrivateHosts();
    if (listed === null || listed.includes(bareHost(parsed.hostname))) return privateHostFetch(url, opts);
    return safeFetch(url, opts);
}

/**
 * Private-host mode: the LAN target is intended, so the request goes out as
 * is, but redirects are not left to fetch. GET/HEAD redirects are followed by
 * hand with every hop checked by assertAllowedNextcloudHost (metadata and
 * link-local literals refused); any other redirect is returned as is. A hop
 * to another origin goes out without Authorization and Cookie.
 * Every connect goes through privateModeDispatcher, which refuses a name that
 * resolves to a link-local or metadata address.
 * @param {string | URL} url
 * @param {RequestInit} [opts]
 */
async function privateHostFetch(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const followable = method === 'GET' || method === 'HEAD';
    let target = String(url);
    let init = opts;
    for (let hop = 0; ; hop += 1) {
        const res = await fetch(target, withPrivateModeDispatcher({ ...init, redirect: 'manual' }));
        if (!followable || res.status < 300 || res.status > 399) return res;
        const location = res.headers && res.headers.get('location');
        if (!location) return res;
        await res.body?.cancel().catch((e) => bestEffort('utils/nextcloudTarget:privateHostFetch', e));
        if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects from the Nextcloud server.');
        const next = new URL(location, target);
        // What fetch does on its own when it follows a redirect: the
        // credentials belong to the origin they were sent to, not to wherever
        // that origin points next.
        if (next.origin !== new URL(target).origin) init = withoutCredentials(init);
        target = next.toString();
        assertAllowedNextcloudHost(target);
        // With a host list, a redirect stays on the listed hosts.
        const listed = allowedPrivateHosts();
        if (listed !== null && !listed.includes(bareHost(next.hostname))) throw new Error('That address is not a valid Nextcloud host.');
    }
}

const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];

/**
 * The same init without the headers that carry a credential.
 * @param {RequestInit} init
 * @returns {RequestInit}
 */
function withoutCredentials(init) {
    if (!init.headers) return init;
    const headers = new Headers(init.headers);
    for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    return { ...init, headers };
}

const OAUTH_ENDPOINTS = { authorize: '/apps/oauth2/authorize', token: '/apps/oauth2/api/v1/token' };

/**
 * A Nextcloud OAuth2 endpoint under `baseUrl`. It goes through the front
 * controller (`/index.php/…`): a server without pretty URLs answers 404 on
 * the bare `/apps/oauth2/…` path, while the `index.php` form is served with
 * and without the rewrite (Nextcloud admin manual, "OAuth2").
 * @param {string} baseUrl
 * @param {'authorize' | 'token'} endpoint
 */
function nextcloudOAuthUrl(baseUrl, endpoint) {
    const path = OAUTH_ENDPOINTS[endpoint];
    if (!path) throw new Error(`Unknown Nextcloud OAuth endpoint: ${String(endpoint)}`);
    const base = String(baseUrl || '').replace(/\/+$/, '').replace(/\/index\.php$/i, '');
    return `${base}/index.php${path}`;
}

// ── Private-host mode: connect-time screen ─────────────────────────

/**
 * @typedef {import('../core/http/ssrfGuard').Resolver} LookupFn
 * @typedef {import('../core/http/ssrfGuard').GuardedLookup} GuardedLookup
 * @typedef {import('../core/http/ssrfGuard').LookupCallback} LookupCallback
 */

/** @param {string} host */
function linkLocalRefusal(host) {
    const err = /** @type {Error & { code?: string, host?: string }} */ (new Error('That address is not a valid Nextcloud host.'));
    err.code = 'ENEXTCLOUDLINKLOCAL';
    err.host = host;
    return err;
}

/**
 * dns.lookup-compatible: resolves every record and refuses the name when ANY
 * of them is a link-local or metadata address. RFC1918 and loopback pass, as
 * private-host mode intends.
 * @param {LookupFn} baseLookup
 */
function makeLinkLocalRefusingLookup(baseLookup) {
    /** @type {GuardedLookup} */
    const lookup = (hostname, options, callback) => {
        const cb = /** @type {LookupCallback} */ (typeof options === 'function' ? options : callback);
        const opts = typeof options === 'function' ? {} : (options || {});
        const noAnswer = opts.all ? [] : '';
        baseLookup(hostname, { ...opts, all: true }, (err, addresses) => {
            if (err) return cb(err, noAnswer);
            /** @type {import('dns').LookupAddress[]} */
            const list = (Array.isArray(addresses) ? addresses : [])
                .map((e) => (typeof e === 'string' ? { address: e, family: e.includes(':') ? 6 : 4 } : e))
                .filter((e) => e && typeof e.address === 'string');
            if (list.length === 0) return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), noAnswer);
            if (list.some((e) => isMetadataHost(e.address))) return cb(linkLocalRefusal(hostname), noAnswer);
            if (opts.all) return cb(null, list);
            cb(null, list[0].address, list[0].family);
        });
    };
    return lookup;
}

/**
 * undici Agent for private-host mode: names resolve through the refusing
 * lookup, and the connected peer is checked as well (IP literals skip the
 * lookup). Wrapped for the runtime's bundled fetch when that still speaks the
 * older dispatcher interface. `lookup` is injectable for tests.
 * @param {{ lookup?: LookupFn }} [options]
 */
function makePrivateModeDispatcher({ lookup } = {}) {
    const undici = require('undici');
    const baseConnect = undici.buildConnector({
        allowH2: false,
        lookup: makeLinkLocalRefusingLookup(lookup || ((h, o, cb) => dns.lookup(h, o, cb))),
    });
    /** @type {import('undici').buildConnector.connector} */
    const connect = (opts, callback) => baseConnect(opts, (err, socket) => {
        if (err) return callback(err, null);
        const remote = socket && socket.remoteAddress;
        if (!remote || isMetadataHost(remote)) {
            if (socket) socket.destroy();
            return callback(linkLocalRefusal(String(opts && opts.hostname)), null);
        }
        callback(null, socket);
    });
    const agent = new undici.Agent({ allowH2: false, connect });
    const bundledMajor = Number(String(process.versions.undici || '').split('.')[0]);
    return bundledMajor > 0 && bundledMajor < 7 ? new undici.Dispatcher1Wrapper(agent) : agent;
}

/** @type {ReturnType<typeof makePrivateModeDispatcher> | null} */
let _privateModeDispatcher = null;

/**
 * Adds the connect-time screen to a fetch init. A replaced global fetch (a
 * test stub) ignores the extra key, so the call shape stays the same.
 * @param {RequestInit} init
 */
function withPrivateModeDispatcher(init) {
    if (!_privateModeDispatcher) _privateModeDispatcher = makePrivateModeDispatcher();
    return /** @type {RequestInit} */ ({ ...init, dispatcher: _privateModeDispatcher });
}

module.exports = {
    assertAllowedNextcloudHost,
    isAllowedNextcloudHost,
    isMetadataHost,
    allowPrivateHosts,
    privateHostAllowed,
    nextcloudFetch,
    nextcloudOAuthUrl,
    makePrivateModeDispatcher,
    MAX_URL_LENGTH,
};

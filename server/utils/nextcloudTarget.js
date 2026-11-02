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
 *   - NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1 re-allows RFC1918 + loopback, because
 *     self-hosted installs legitimately run Nextcloud on a LAN address. This is
 *     a deployment-level decision, not a per-user one.
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

function allowPrivateHosts() {
    return process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS === '1';
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
    if (isPrivateHostname(parsed.hostname) && !allowPrivateHosts()) {
        throw new Error(
            'That Nextcloud URL points to a private or local network address. '
            + 'If this is a self-hosted install on your own network, set '
            + 'NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1 on the server to allow it.'
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
    assertAllowedNextcloudHost(url);
    if (allowPrivateHosts()) return privateHostFetch(url, opts);
    return safeFetch(url, opts);
}

/**
 * Private-host mode: the LAN target is intended, so the request goes out as
 * is, but redirects are not left to fetch. GET/HEAD redirects are followed by
 * hand with every hop checked by assertAllowedNextcloudHost (metadata and
 * link-local literals refused); any other redirect is returned as is.
 * Every connect goes through privateModeDispatcher, which refuses a name that
 * resolves to a link-local or metadata address.
 * @param {string | URL} url
 * @param {RequestInit} [opts]
 */
async function privateHostFetch(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const followable = method === 'GET' || method === 'HEAD';
    let target = String(url);
    for (let hop = 0; ; hop += 1) {
        const res = await fetch(target, withPrivateModeDispatcher({ ...opts, redirect: 'manual' }));
        if (!followable || res.status < 300 || res.status > 399) return res;
        const location = res.headers && res.headers.get('location');
        if (!location) return res;
        await res.body?.cancel().catch((e) => bestEffort('utils/nextcloudTarget:privateHostFetch', e));
        if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects from the Nextcloud server.');
        target = new URL(location, target).toString();
        assertAllowedNextcloudHost(target);
    }
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
    nextcloudFetch,
    makePrivateModeDispatcher,
    MAX_URL_LENGTH,
};

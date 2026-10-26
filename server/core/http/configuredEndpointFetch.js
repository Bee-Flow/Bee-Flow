// @typecheck strict
/**
 * fetch() for endpoints an ADMIN configured (LLM providers, the AI gateway):
 * the target may legitimately sit on a private network (Ollama, vLLM, a
 * LiteLLM container), so private and loopback ranges are allowed here, unlike
 * the strict utils/ssrfGuard.safeFetch used for user-controlled URLs.
 *
 * What stays refused, on every connect (so DNS rebinding and redirect hops are
 * covered): the cloud-metadata and link-local ranges (169.254.0.0/16,
 * fe80::/10, fd00:ec2::254), the unspecified address, the metadata host names
 * and every scheme but http(s). Redirects are not followed unless the caller says otherwise
 * (each hop is still re-screened on connect).
 */
'use strict';

const dns = require('dns');
const { fetch: undiciFetch, Agent, buildConnector } = require('undici');
const canonical = require('./ssrfGuard');

const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata.goog', 'instance-data']);

/**
 * True for an address (literal, any spelling) that must never be dialled.
 * @param {string} address
 */
function isMetadataOrLinkLocal(address) {
    const { kind, canonical: c } = canonical.normalizeHostname(address);
    if (kind === 'name') return false;
    if (c === null) return true;
    if (kind === 'ip4') return /^(169\.254\.|0\.)/.test(c) || c === '255.255.255.255';
    const v6 = c.toLowerCase();
    if (v6 === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isMetadataOrLinkLocal(mapped[1]);
    return /^fe[89ab][0-9a-f]:/.test(v6) || v6.startsWith('fd00:ec2:');
}

function refusal() {
    const err = /** @type {Error & { code?: string }} */ (new Error('Refused: target is a metadata or link-local address.'));
    err.code = 'EMETADATAADDRESS';
    return err;
}

/**
 * @param {string} host
 */
function isBlocked(host) {
    const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return !h || METADATA_NAMES.has(h) || isMetadataOrLinkLocal(h);
}

function createDispatcher() {
    const baseConnect = buildConnector({
        allowH2: false,
        lookup: /** @type {any} */ ((/** @type {any} */ hostname, /** @type {any} */ options, /** @type {any} */ callback) => {
            if (typeof options === 'function') { callback = options; options = {}; }
            if (isBlocked(hostname)) return process.nextTick(/** @type {any} */ (callback), refusal());
            /** @type {any} */ (dns.lookup)(hostname, { ...(options || {}), all: true }, (/** @type {any} */ err, /** @type {any} */ list) => {
                if (err) return callback(err);
                if (list.some((/** @type {{ address: string }} */ e) => isMetadataOrLinkLocal(e.address))) return callback(refusal());
                if (options && options.all) return callback(null, list);
                callback(null, list[0].address, list[0].family);
            });
        }),
    });
    return new Agent({
        allowH2: false,
        connect: (opts, cb) => {
            const host = String((opts && opts.hostname) || '');
            if (isBlocked(host)) { process.nextTick(/** @type {any} */ (cb), refusal(), null); return null; }
            return baseConnect(opts, (err, socket) => {
                if (err) return cb(err, null);
                if (socket && socket.remoteAddress && isMetadataOrLinkLocal(socket.remoteAddress)) {
                    socket.destroy();
                    return cb(refusal(), null);
                }
                cb(null, socket);
            });
        },
    });
}

/** @type {ReturnType<typeof createDispatcher> | null} */
let shared = null;

/**
 * @param {string} url
 * @param {RequestInit & { dispatcher?: any }} [opts]
 */
async function fetchConfiguredEndpoint(url, opts = {}) {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed.');
    if (isBlocked(parsed.hostname)) throw refusal();
    if (!shared) shared = createDispatcher();
    const { dispatcher, ...init } = /** @type {any} */ (opts || {});
    return undiciFetch(url, { redirect: 'error', ...init, dispatcher: dispatcher || shared });
}

module.exports = { fetchConfiguredEndpoint, isMetadataOrLinkLocal };

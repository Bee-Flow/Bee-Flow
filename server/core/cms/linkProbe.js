/** @typedef {import('url').URL} URL */
// @typecheck strict
/**
 * Reachability probe for external URLs of a CMS site, used only when an
 * administrator asks for it (never on its own, never from the public site).
 *
 * Outbound HTTP, so it is deliberately narrow: http and https only, standard
 * ports, no credentials in the URL, no cookies, no request body, a short
 * timeout, a cap on the number of URLs per run and a small concurrency. Every
 * request goes through utils/ssrfGuard safeFetch, which refuses private,
 * loopback and link-local targets after DNS resolution and on every redirect
 * hop. HEAD first; a ranged GET when HEAD fails or is refused.
 */

'use strict';

const { safeFetch, isPrivateAddressError } = require('../../utils/ssrfGuard');
const { bestEffort } = require('../../utils/bestEffort');

const MAX_URLS = 50;
const CONCURRENCY = 4;
const TIMEOUT_MS = 5000;
/** Redirect hops followed per request. */
const MAX_HOPS = 5;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username -- a public User-Agent string, not a credential
const USER_AGENT = 'BeeFlow-LinkCheck/1.0';

/**
 * @typedef {{ status: number } | { error: 'invalid' | 'refused' | 'unreachable' }} ProbeResult
 */

/** @param {string} raw @returns {URL | null} a URL we are willing to request, or null */
function requestable(raw) {
    /** @type {URL} */
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (!ALLOWED_PORTS.has(url.port)) return null;
    return url;
}

/**
 * @param {string} raw
 * @param {{ fetchFn: Function, timeoutMs: number }} opts
 * @returns {Promise<ProbeResult>}
 */
async function probeOne(raw, { fetchFn, timeoutMs }) {
    const url = requestable(raw);
    if (!url) return { error: 'invalid' };
    /**
     * One request; redirects are followed here, each hop screened like the first URL.
     * @param {string} method
     */
    const send = async (method) => {
        let current = url;
        for (let hop = 0; hop <= MAX_HOPS; hop++) {
            const res = await fetchFn(current.href, {
                method,
                redirect: 'manual',
                credentials: 'omit',
                headers: { 'user-agent': USER_AGENT, accept: '*/*', ...(method === 'GET' ? { range: 'bytes=0-0' } : {}) },
                signal: AbortSignal.timeout(timeoutMs),
            });
            // Only the status matters: never read a body of a third-party site.
            await res.body?.cancel().catch((/** @type {unknown} */ e) => bestEffort('core/cms/linkProbe:send', e));
            const location = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
            if (!location) return res.status;
            const next = requestable(new URL(location, current).href);
            if (!next) throw Object.assign(new Error('redirect target not allowed'), { code: 'EBADREDIRECT' });
            current = next;
        }
        throw Object.assign(new Error('too many redirects'), { code: 'EBADREDIRECT' });
    };
    try {
        const head = await send('HEAD');
        if (head < 400) return { status: head };
    } catch (e) {
        if (isPrivateAddressError(e)) return { error: 'refused' };
    }
    try {
        return { status: await send('GET') };
    } catch (e) {
        return { error: isPrivateAddressError(e) ? 'refused' : 'unreachable' };
    }
}

/**
 * Probe a list of URLs. Duplicates are asked once; URLs past `max` are not
 * asked at all and counted in `skipped`.
 * @param {string[]} urls
 * @param {{ fetchFn?: Function, max?: number, concurrency?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ results: Map<string, ProbeResult>, skipped: number }>}
 */
async function probeUrls(urls, options = {}) {
    const { fetchFn = safeFetch, max = MAX_URLS, concurrency = CONCURRENCY, timeoutMs = TIMEOUT_MS } = options;
    const unique = [...new Set(urls)];
    const queue = unique.slice(0, max);
    /** @type {Map<string, ProbeResult>} */
    const results = new Map();
    const worker = async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            results.set(next, await probeOne(next, { fetchFn, timeoutMs }));
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return { results, skipped: Math.max(0, unique.length - max) };
}

module.exports = { probeUrls, probeOne, requestable, MAX_URLS, CONCURRENCY, TIMEOUT_MS, MAX_HOPS };

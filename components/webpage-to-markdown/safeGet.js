'use strict';
/**
 * GET a caller-supplied URL without reaching private or internal addresses.
 *
 * Both web-fetching components (webpage-to-markdown, website-sitemap-fetcher)
 * are agentEnabled: the URL comes from a chat user, or from a page the agent
 * read earlier (prompt injection). A plain axios.get with maxRedirects: 5
 * would read guard-service, the cloud metadata endpoint or the server's own
 * API and hand the answer back as Markdown.
 *
 * A component runs from its own directory and cannot require server/, so
 * ssrfGuard.js next to this file is a generated copy of the canonical
 * server/core/http/ssrfGuard.js (npm run gen:shared writes it, npm run
 * lint:shared-mirror checks it). This file is byte-identical in both
 * components for the same reason (scripts/check-duplicated-files.mjs).
 *
 * Layers:
 *   1. Every hop (the first URL and each redirect target) must be http(s) and
 *      pass the literal host screen (localhost, metadata names, private IPs
 *      in any numeric spelling). Redirects are followed here, one at a time
 *      (maxRedirects: 0 towards axios), so a public page cannot redirect the
 *      fetch to an internal one.
 *   2. Direct connections (no proxy configured) resolve through the guarded
 *      lookup: every connect, so every hop, fails when ANY address of the name
 *      is private. That is also the DNS-rebinding defence, since the socket
 *      dials exactly the address that was checked.
 *   3. Behind an HTTP(S)_PROXY the proxy dials, so the lookup cannot guard
 *      the socket. Each hop's name is then resolved here first and refused
 *      when it resolves to a private address; a name the local resolver does
 *      not know is left to the proxy, as before.
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const axios = require('axios');
const guard = require('./ssrfGuard');

const MAX_REDIRECTS = 5;
const PRIVATE_ADDRESS_ERROR_CODE = 'EPRIVATEADDRESS';
const PRIVATE_ADDRESS_ERROR_MESSAGE = 'Refused: target resolves to a private/internal address.';
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

function privateAddressError(host) {
    const err = new Error(PRIVATE_ADDRESS_ERROR_MESSAGE);
    err.code = PRIVATE_ADDRESS_ERROR_CODE;
    err.host = host;
    return err;
}

function usesProxy(env) {
    return PROXY_ENV.some(name => Boolean(env[name]));
}

function makeAgents(lookup) {
    const guardedLookup = guard.makeGuardedLookup({ lookup, refuse: privateAddressError });
    return {
        httpAgent: new http.Agent({ lookup: guardedLookup }),
        httpsAgent: new https.Agent({ lookup: guardedLookup }),
    };
}

let defaultAgents = null;

function resolveAll(lookup, host) {
    return new Promise(resolve => {
        lookup(host, { all: true }, (err, addresses) => resolve(err ? null : addresses));
    });
}

/** Throws when `url` may not be fetched; resolves with the parsed URL. */
async function checkHop(url, viaProxy, lookup) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported protocol ${parsed.protocol}`);
    }
    if (guard.isBlockedHost(parsed.hostname)) throw privateAddressError(parsed.hostname);
    if (viaProxy) {
        const { kind, canonical } = guard.normalizeHostname(parsed.hostname);
        if (kind === 'name') {
            const addresses = await resolveAll(lookup, canonical);
            const list = Array.isArray(addresses) ? addresses : [];
            if (list.some(a => !a || typeof a.address !== 'string' || guard.isForbiddenAddress(a.address))) {
                throw privateAddressError(parsed.hostname);
            }
        }
    }
    return parsed;
}

function defaultValidateStatus(status) {
    return status >= 200 && status < 300;
}

/**
 * Drop-in for axios.get(url, options) on a caller-supplied URL.
 *
 * @param {string} url
 * @param {object} [options]  axios request options; `validateStatus` and
 *   `maxRedirects` keep their axios meaning, the agents and proxy are set here.
 * @param {object} [deps]  for tests: `lookup` (dns.lookup-compatible),
 *   `env` (the proxy variables), `request` (axios.request-compatible).
 * @returns {Promise<{ response: import('axios').AxiosResponse, url: string }>}
 *   the final response and the URL it came from (after redirects).
 */
async function safeGet(url, options = {}, deps = {}) {
    const env = deps.env || process.env;
    const lookup = deps.lookup || dns.lookup;
    const request = deps.request || axios.request;
    const viaProxy = usesProxy(env);
    const {
        validateStatus = defaultValidateStatus,
        maxRedirects = MAX_REDIRECTS,
        ...rest
    } = options;

    let transport = {};
    if (!viaProxy) {
        if (deps.lookup) transport = makeAgents(deps.lookup);
        else transport = defaultAgents || (defaultAgents = makeAgents());
        // Never let axios pick a proxy up from a variable not listed above.
        transport = { ...transport, proxy: false };
    }

    let current = String(url);
    for (let hop = 0; ; hop++) {
        await checkHop(current, viaProxy, lookup);
        const response = await request({
            ...rest,
            ...transport,
            url: current,
            method: 'get',
            maxRedirects: 0,
            validateStatus: () => true,
        });
        const location = response.headers && response.headers.location;
        if (response.status >= 300 && response.status < 400 && location) {
            if (hop >= maxRedirects) throw new Error('Maximum number of redirects exceeded');
            current = new URL(String(location), current).href;
            continue;
        }
        if (!validateStatus(response.status)) {
            throw new axios.AxiosError(
                `Request failed with status code ${response.status}`,
                response.status >= 500 ? axios.AxiosError.ERR_BAD_RESPONSE : axios.AxiosError.ERR_BAD_REQUEST,
                response.config,
                response.request,
                response,
            );
        }
        return { response, url: current };
    }
}

module.exports = {
    safeGet,
    checkHop,
    PRIVATE_ADDRESS_ERROR_CODE,
    PRIVATE_ADDRESS_ERROR_MESSAGE,
};

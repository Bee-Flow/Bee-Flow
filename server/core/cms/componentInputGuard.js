// @typecheck strict
/**
 * Screens the inputs of a component run for http(s) targets on a private or
 * internal address.
 *
 * A component is a child process in the server's network namespace, and its
 * inputs come from the caller of POST /execute. Three bundled components
 * (youtrack-read-items, n8n-webhook-header-auth, afas-customer-data) call the
 * URL they are given and return the answer, so without this check any signed-in
 * user could read an internal service or the cloud metadata endpoint through
 * them. The components that fetch arbitrary pages carry their own guard; this
 * one sits in front of all of them.
 *
 * It is a pre-flight check that gives the caller a clear answer. The connection
 * itself is screened again inside the component's process
 * (componentNetGuard.js), which is what holds against a name that changes its
 * answer between the two lookups and against inputs that are not URLs.
 *
 * COMPONENT_ALLOW_PRIVATE_HOSTS re-allows private targets for an installation
 * whose n8n, YouTrack or mail relay is internal: a comma-separated list of
 * hosts, or `1` for all (the same shape as NEXTCLOUD_ALLOW_PRIVATE_HOSTS).
 */

const { isPrivateHostname, validatingLookup } = require('../../utils/ssrfGuard');

/** @typedef {(host: string, options: { all: boolean }, callback: (err: Error | null) => void) => void} Lookup */

/**
 * @param {string} host
 * @param {Lookup} lookup
 * @returns {Promise<boolean>} true when the name resolves, and only to public addresses
 */
function resolvesPublic(host, lookup) {
    return new Promise((resolve) => {
        lookup(host, { all: true }, (err) => resolve(!err));
    });
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikeHttpUrl(value) {
    if (typeof value !== 'string') return false;
    const start = value.trim().slice(0, 8).toLowerCase();
    return start.startsWith('http://') || start.startsWith('https://');
}

/**
 * The first input that names an http(s) target on a private, internal or
 * unresolvable host. Inputs whose name starts with `_` are set by the server
 * itself (the caller's own Nextcloud), not by the request.
 *
 * @param {Record<string, unknown>} inputs
 * @param {{ lookup?: Lookup, allowed?: string[] }} [options] allowed: hosts that may be private (allowedPrivateHosts)
 * @returns {Promise<string | null>} the input's name, or null when every target is public
 */
async function privateUrlInput(inputs, { lookup = /** @type {Lookup} */ (/** @type {unknown} */ (validatingLookup)), allowed = [] } = {}) {
    if (allowed.includes('*')) return null;
    for (const [name, value] of Object.entries(inputs || {})) {
        if (name.startsWith('_') || !looksLikeHttpUrl(value)) continue;
        const host = hostOf(value);
        if (host === null) return name;
        if (allowed.includes(host)) continue;
        if (isPrivateHostname(host) || !(await resolvesPublic(host, lookup))) return name;
    }
    return null;
}

/**
 * @param {unknown} url
 * @returns {string | null} the URL's host, lower case and without IPv6 brackets; null when it is not a URL
 */
function hostOf(url) {
    let host;
    try { host = new URL(String(url).trim()).hostname.toLowerCase(); } catch (e) { return null; }
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * The hosts a component run may reach although they are private: the
 * operator's list, the caller's own Nextcloud (set by the server, and governed
 * by the Nextcloud host policy) and a configured outbound proxy.
 *
 * @param {Record<string, unknown>} inputs
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]} lower-case hosts, or ['*'] when the operator allows all
 */
function allowedPrivateHosts(inputs, env = process.env) {
    const raw = String(env.COMPONENT_ALLOW_PRIVATE_HOSTS || '').trim().toLowerCase();
    if (raw === '1' || raw === 'true' || raw === '*') return ['*'];
    const hosts = raw.split(',').map((h) => h.trim()).filter(Boolean);
    for (const url of [inputs?._nextcloudUrl, env.HTTP_PROXY, env.HTTPS_PROXY, env.http_proxy, env.https_proxy]) {
        const host = url ? hostOf(url) : null;
        if (host) hosts.push(host);
    }
    return [...new Set(hosts)];
}

/**
 * Refuses a component run whose inputs name a private or internal address.
 * @param {Record<string, unknown>} inputs
 */
async function assertPublicTargets(inputs) {
    const blocked = await privateUrlInput(inputs, { allowed: allowedPrivateHosts(inputs) });
    if (blocked) throw new Error(`Input "${blocked}" points at a private or internal address, which a component may not call.`);
}

module.exports = { privateUrlInput, assertPublicTargets, allowedPrivateHosts };

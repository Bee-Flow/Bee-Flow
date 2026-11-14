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
 * It is a pre-flight check: the component resolves the name again when it
 * connects, so a name that changes its answer between the two lookups is not
 * covered here.
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
 * @param {{ lookup?: Lookup }} [options]
 * @returns {Promise<string | null>} the input's name, or null when every target is public
 */
async function privateUrlInput(inputs, { lookup = /** @type {Lookup} */ (/** @type {unknown} */ (validatingLookup)) } = {}) {
    for (const [name, value] of Object.entries(inputs || {})) {
        if (name.startsWith('_') || !looksLikeHttpUrl(value)) continue;
        let host;
        try { host = new URL(String(value).trim()).hostname; } catch (e) { return name; }
        if (isPrivateHostname(host) || !(await resolvesPublic(host, lookup))) return name;
    }
    return null;
}

/**
 * Refuses a component run whose inputs name a private or internal address.
 * @param {Record<string, unknown>} inputs
 */
async function assertPublicTargets(inputs) {
    const blocked = await privateUrlInput(inputs);
    if (blocked) throw new Error(`Input "${blocked}" points at a private or internal address, which a component may not call.`);
}

module.exports = { privateUrlInput, assertPublicTargets };

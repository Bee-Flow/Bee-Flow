// @typecheck strict
/**
 * Loaded into a component's process before its own code (`node --require`).
 *
 * A component runs in the server's network and connects wherever its inputs
 * say: an http(s) URL, an SMTP host, anything. The server screens URL inputs
 * before the run (componentInputGuard.js), but that check and the component's
 * own connection are two lookups, and inputs that are not URLs are not screened
 * at all. This file closes both at the one place every connection passes:
 * `net.Socket.prototype.connect`, under http, https, tls, fetch and SMTP alike.
 *
 *   - a literal private, loopback, link-local or metadata address is refused;
 *   - a host name is resolved through a lookup that refuses the connection when
 *     any answer is such an address, so the address checked is the one used.
 *
 * BEEFLOW_COMPONENT_ALLOWED_HOSTS (set by the engine: the operator's
 * COMPONENT_ALLOW_PRIVATE_HOSTS, the caller's own Nextcloud, a configured
 * proxy) lists the hosts that may be private; `*` allows all.
 *
 * Plain CommonJS with no dependency outside core/http: it runs in a bare node
 * process, without the server's loaders.
 */

const net = require('net');
const { isForbiddenAddress, isBlockedHost, makeGuardedLookup } = require('../http/ssrfGuard');

const ALLOWED = new Set(String(process.env.BEEFLOW_COMPONENT_ALLOWED_HOSTS || '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
const ALLOW_ALL = ALLOWED.has('*');

/** @param {string} host */
function refusal(host) {
    return Object.assign(new Error(`Refusing to connect to a private or internal address (${host})`), { code: 'EPRIVATEADDRESS' });
}

/**
 * @param {unknown} host
 * @returns {string} lower case, without IPv6 brackets; node's own default when absent
 */
function bareHost(host) {
    const h = String(host || 'localhost').trim().toLowerCase();
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** @typedef {{ host?: string, path?: string, port?: number | string, lookup?: unknown }} ConnectOptions */

const originalConnect = /** @type {(this: import('net').Socket, ...args: unknown[]) => import('net').Socket} */ (
    /** @type {unknown} */ (net.Socket.prototype.connect));

/**
 * @this {import('net').Socket}
 * @param {...unknown} args connect(options[, cb]), connect(port[, host][, cb]), connect(path[, cb]) or node's normalised array
 * @returns {import('net').Socket}
 */
function guardedConnect(...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    /** @type {ConnectOptions} */
    let options;
    if (first !== null && typeof first === 'object') {
        options = /** @type {ConnectOptions} */ (first);
    } else {
        // connect(path): a pipe, not a network address.
        if (typeof first === 'string' && !/^\d+$/.test(first)) return originalConnect.apply(this, args);
        const hasHost = typeof args[1] === 'string';
        options = { port: /** @type {number | string} */ (first), host: hasHost ? /** @type {string} */ (args[1]) : undefined };
        args = [options, ...args.slice(hasHost ? 2 : 1)];
    }
    if (ALLOW_ALL || options.path) return originalConnect.apply(this, args);
    const host = bareHost(options.host);
    if (ALLOWED.has(host)) return originalConnect.apply(this, args);
    const literal = net.isIP(host) !== 0;
    if (literal ? isForbiddenAddress(host) : isBlockedHost(host)) {
        process.nextTick(() => this.destroy(refusal(host)));
        return this;
    }
    if (!literal) {
        const base = typeof options.lookup === 'function' ? /** @type {Parameters<typeof makeGuardedLookup>[0]} */ ({ lookup: options.lookup }) : {};
        options.lookup = makeGuardedLookup({ ...base, refuse: refusal });
    }
    return originalConnect.apply(this, args);
}

/** @type {{ connect: unknown }} */ (net.Socket.prototype).connect = guardedConnect;

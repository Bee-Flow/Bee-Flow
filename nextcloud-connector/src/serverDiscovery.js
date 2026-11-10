/**
 * Is a Bee Flow server running next to this Nextcloud?
 *
 * The setup page asks this once, for an administrator, while no server is
 * chosen. The answer is a suggestion: the administrator still picks the
 * address and connects with a pairing code. Nothing is chosen here.
 *
 * What is asked, and of whom:
 *   - a fixed list of nearby addresses only: the Docker host this container
 *     runs on (its default gateway, and the `host.docker.internal` name) and
 *     the server's container name, each on the port the installer uses. No
 *     address from the request, and never an address on the internet;
 *   - one `GET /api/health` each (serverProbe.js): no header of ours, no body,
 *     nothing about this Nextcloud.
 */

'use strict';

const fs = require('fs');
const net = require('net');
const { probe } = require('./serverProbe');

// The port a self-hosted Bee Flow server listens on unless its administrator
// chose another one (SERVER_PORT in .env.selfhost.example).
const SERVER_PORT = 3001;
const PROBE_TIMEOUT_MS = 1_500;
const NAMED_HOSTS = ['host.docker.internal', 'beeflow-server'];

/**
 * The default gateway from the kernel's route table (`/proc/net/route`): on a
 * Docker network that is the host. Only a private address counts. The gateway column is the address as hex
 * in the machine's byte order (little-endian on every platform we ship for).
 * @param {string} routeTable
 * @returns {string | null}
 */
function gatewayOf(routeTable) {
    for (const line of String(routeTable).split('\n').slice(1)) {
        const [, destination, gateway] = line.trim().split('\t');
        if (destination !== '00000000' || !gateway || gateway.length !== 8 || gateway === '00000000') continue;
        const bytes = [6, 4, 2, 0].map((at) => Number.parseInt(gateway.slice(at, at + 2), 16));
        const address = bytes.join('.');
        if (bytes.every((b) => Number.isInteger(b)) && net.isIPv4(address)) return isPrivate(bytes) ? address : null;
    }
    return null;
}

/**
 * A private network address (10/8, 172.16/12, 192.168/16)? A container's
 * gateway is one. On a machine with a public address the gateway is the
 * provider's router, which is not ours to ask.
 * @param {number[]} bytes
 * @returns {boolean}
 */
function isPrivate([a, b]) {
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** @returns {string} */
function readRouteTable() {
    try { return fs.readFileSync('/proc/net/route', 'utf8'); } catch (_) { return ''; }
}

/**
 * The addresses to ask, in the order they are offered.
 * @param {string} routeTable
 * @returns {string[]}
 */
function candidates(routeTable) {
    const gateway = gatewayOf(routeTable);
    return [...(gateway ? [gateway] : []), ...NAMED_HOSTS].map((host) => `http://${host}:${SERVER_PORT}`);
}

/**
 * @param {{ probeFn?: typeof probe, routeTable?: string }} [deps]
 * @returns {Promise<Array<{ apiBaseUrl: string, version: string }>>}
 */
async function discover({ probeFn = probe, routeTable = readRouteTable() } = {}) {
    const answers = await Promise.all(candidates(routeTable).map(async (apiBaseUrl) => {
        const result = await probeFn(apiBaseUrl, { timeoutMs: PROBE_TIMEOUT_MS });
        // A Bee Flow server names its build in the health answer; any other
        // service that happens to answer 200 on this port is not offered.
        return result.ok && typeof result.version === 'string' && result.version
            ? { apiBaseUrl, version: result.version }
            : null;
    }));
    return answers.flatMap((a) => (a ? [a] : []));
}

module.exports = { discover, candidates, gatewayOf, SERVER_PORT, PROBE_TIMEOUT_MS };

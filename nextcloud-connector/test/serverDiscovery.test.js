// Looking for a Bee Flow server next to this Nextcloud (GET /setup/discover).
//
// The list of addresses is fixed: the Docker host and the server's container
// name, on the installer's port. Only an answer that names a Bee Flow build is
// offered, and the route is declared for administrators.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { discover, candidates, gatewayOf, SERVER_PORT, PROBE_TIMEOUT_MS } = require('../src/serverDiscovery');

// /proc/net/route inside a container on a Docker bridge network (172.18.0.0/16).
const ROUTES = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    '',
].join('\n');

test('the default gateway is read from the route table', () => {
    assert.equal(gatewayOf(ROUTES), '172.18.0.1');
});

test('a route table without a default route, or an unreadable one, names no gateway', () => {
    assert.equal(gatewayOf(ROUTES.split('\n').filter((l) => !l.includes('010012AC')).join('\n')), null);
    assert.equal(gatewayOf(''), null);
    assert.equal(gatewayOf('Iface\tDestination\tGateway\neth0\t00000000\tnot-hex!\n'), null);
});

test('a gateway with a public address is not asked', () => {
    // 203.0.113.1 as the default gateway: a machine on a provider's network
    assert.equal(gatewayOf(ROUTES.replace('010012AC', '017100CB')), null);
});

test('only the Docker host and the server container are asked, on the installer port', () => {
    assert.deepEqual(candidates(ROUTES), [
        `http://172.18.0.1:${SERVER_PORT}`,
        `http://host.docker.internal:${SERVER_PORT}`,
        `http://beeflow-server:${SERVER_PORT}`,
    ]);
    assert.deepEqual(candidates(''), [
        `http://host.docker.internal:${SERVER_PORT}`,
        `http://beeflow-server:${SERVER_PORT}`,
    ]);
});

test('an address is offered only when a Bee Flow server answers there', async () => {
    const asked = [];
    const probeFn = async (url, options) => {
        asked.push({ url, options });
        if (url.startsWith('http://172.18.0.1:')) return { ok: true, status: 200, url, error: null, version: 'abc123' };
        // something else on that port: healthy, but it names no Bee Flow build
        if (url.includes('host.docker.internal')) return { ok: true, status: 200, url, error: null, version: null };
        return { ok: false, status: 0, url, error: 'fetch failed', reason: 'unreachable' };
    };
    const found = await discover({ probeFn, routeTable: ROUTES });
    assert.deepEqual(found, [{ apiBaseUrl: `http://172.18.0.1:${SERVER_PORT}`, version: 'abc123' }]);
    assert.deepEqual(asked.map((a) => a.url), candidates(ROUTES));
    assert.ok(asked.every((a) => a.options.timeoutMs === PROBE_TIMEOUT_MS), 'each address gets the short timeout');
});

test('nothing nearby answers: nothing is offered', async () => {
    const probeFn = async (url) => ({ ok: false, status: 0, url, error: 'fetch failed', reason: 'unreachable' });
    assert.deepEqual(await discover({ probeFn, routeTable: '' }), []);
});

test('the route is declared for administrators', () => {
    const xml = fs.readFileSync(path.join(__dirname, '..', 'appinfo', 'info.xml'), 'utf8');
    const line = xml.split('\n').find((l) => l.includes('|discover|'));
    assert.ok(line, 'setup/discover is in a declared route');
    assert.ok(line.includes('<access_level>ADMIN</access_level>'));
});

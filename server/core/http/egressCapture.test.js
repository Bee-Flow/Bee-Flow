/**
 * Egress capture against real sockets: a local HTTP server on 127.0.0.1, no
 * internet. Each test pins one of the rules in egressCapture.js's header:
 * the address comes off the connection (also a reused one), attribution is
 * fixed when a request is created, a sealed probe hears nothing more, a
 * capture failure never reaches the request, and a model call is nobody's row.
 *
 * Run: cd server && node --test core/http/egressCapture.test.js
 */
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const undici = require('undici');
const capture = require('./egressCapture');
const { runWithProbe, runWithProbeSettled, outsideProbe, markLocal, recordPeer, withPeers } = capture;

const servers = [];

/** A fresh server (a fresh origin, so no pooled connection carries over). */
async function serve(handler = null) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            if (handler && handler(req, res, body) !== false) return;
            res.setHeader('cf-ray', '8c1f2a3b4d5e6f70-AMS');
            res.setHeader('server', 'cloudflare');
            res.end(JSON.stringify({ method: req.method, body }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return { server, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` };
}

before(() => capture.install());
afterEach(() => capture.setFaultHookForTests(null));
after(async () => {
    for (const s of servers) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
    }
});

test('the first and a reused keep-alive connection both record the socket address', async () => {
    const { base, port } = await serve();
    const dispatcher = new undici.Agent({ keepAliveTimeout: 10_000 });
    const call = () => runWithProbe(async () => (await undici.fetch(`${base}/a`, { dispatcher })).text());
    const first = await call();
    // Let the pool take the socket back before the next call asks for one.
    await new Promise((r) => setTimeout(r, 20));
    const second = await call();
    await dispatcher.close();

    for (const { probe } of [first, second]) {
        assert.strictEqual(probe.peers.length, 1);
        assert.strictEqual(probe.peers[0].ip, '127.0.0.1');
        assert.strictEqual(probe.peers[0].port, port);
        assert.strictEqual(probe.peers[0].basis, 'socket');
    }
    assert.strictEqual(first.probe.peers[0].reused, false);
    assert.strictEqual(second.probe.peers[0].reused, true, 'the old probe recorded nothing on a reused connection');
});

test('Node\'s own fetch is captured, and the snapshot is frozen with the legacy fields from the last peer', async () => {
    const { base } = await serve();
    const { result, probe } = await runWithProbe(async () => (await fetch(`${base}/x`, { method: 'POST', body: 'hello' })).json());
    assert.deepStrictEqual(result, { method: 'POST', body: 'hello' });
    assert.ok(Object.isFrozen(probe) && Object.isFrozen(probe.peers) && Object.isFrozen(probe.peers[0]));
    assert.strictEqual(probe.sealed, true);
    const [peer] = probe.peers;
    assert.strictEqual(peer.host, '127.0.0.1');
    assert.strictEqual(peer.family, 4);
    assert.strictEqual(peer.method, 'POST');
    assert.strictEqual(peer.sentBody, true);
    assert.strictEqual(peer.status, 200);
    assert.strictEqual(probe.hostname, '127.0.0.1');
    assert.strictEqual(probe.peer_ip, '127.0.0.1');
    assert.strictEqual(probe.peer_ip_source, 'socket');
    assert.strictEqual(probe.tls_servername, '127.0.0.1');
});

test('edge headers land on the peer, and only the known names', async () => {
    const { base } = await serve((req, res) => {
        res.setHeader('cf-ray', 'a41859ef1d78ae32-AMS');
        res.setHeader('x-served-by', 'cache-ams21080-AMS');
        res.setHeader('x-secret-thing', 'nope');
        res.end('ok');
    });
    const { probe } = await runWithProbe(async () => (await fetch(`${base}/`)).text());
    const { edge } = probe.peers[0];
    assert.strictEqual(edge['cf-ray'], 'a41859ef1d78ae32-AMS');
    assert.strictEqual(edge['x-served-by'], 'cache-ams21080-AMS');
    assert.strictEqual(edge['x-amz-cf-pop'], null);
    assert.ok(!('x-secret-thing' in edge));
    assert.deepStrictEqual(Object.keys(edge).sort(), [...capture.EDGE_HEADERS].sort());
});

test('an npm undici request with its own dispatcher (the safeFetch shape) is captured', async () => {
    const { base } = await serve();
    const dispatcher = new undici.Agent({ connect: { lookup: require('node:dns').lookup } });
    const { probe } = await runWithProbe(async () => (await undici.fetch(`${base}/safe`, { dispatcher })).text());
    await dispatcher.close();
    assert.strictEqual(probe.peers.length, 1);
    assert.strictEqual(probe.peers[0].ip, '127.0.0.1');
});

test('two probes running in parallel each see only their own connection', async () => {
    const a = await serve((req, res) => { setTimeout(() => res.end('a'), 30); });
    const b = await serve((req, res) => { setTimeout(() => res.end('b'), 10); });
    const [pa, pb] = await Promise.all([
        runWithProbe(async () => (await fetch(`${a.base}/`)).text()),
        runWithProbe(async () => (await fetch(`${b.base}/`, { method: 'PUT', body: 'x' })).text()),
    ]);
    assert.deepStrictEqual(pa.probe.peers.map((p) => p.port), [a.port]);
    assert.deepStrictEqual(pb.probe.peers.map((p) => p.port), [b.port]);
    assert.strictEqual(pa.probe.peers[0].sentBody, false);
    assert.strictEqual(pb.probe.peers[0].sentBody, true);
});

test('a request queued behind another probe\'s request is attributed to its own probe', async () => {
    // One connection: B waits until A's response is done, so B's headers are
    // sent from A's context (A has already been sealed by then).
    const { base } = await serve((req, res) => { setTimeout(() => res.end(req.url), req.url === '/slow' ? 60 : 0); });
    const dispatcher = new undici.Agent({ connections: 1, pipelining: 1 });
    const [pa, pb] = await Promise.all([
        runWithProbe(async () => (await undici.fetch(`${base}/slow`, { dispatcher })).text()),
        new Promise((r) => setTimeout(r, 5)).then(() => runWithProbe(async () => (
            await undici.fetch(`${base}/fast`, { dispatcher, method: 'POST', body: 'from-b' })).text())),
    ]);
    await dispatcher.close();
    assert.strictEqual(pa.probe.peers.length, 1);
    assert.strictEqual(pa.probe.peers[0].method, 'GET');
    assert.strictEqual(pa.probe.peers[0].sentBody, false, 'B\'s POST must not be merged into A');
    assert.strictEqual(pb.probe.peers.length, 1, 'B must keep its own peer');
    assert.strictEqual(pb.probe.peers[0].method, 'POST');
    assert.strictEqual(pb.probe.peers[0].reused, true);
});

test('a fetch redirect stays with the probe that made the call', async () => {
    const target = await serve();
    const { base } = await serve((req, res) => {
        res.writeHead(302, { location: `http://localhost:${target.port}/landed` });
        res.end();
    });
    const other = await serve((req, res) => { setTimeout(() => res.end('other'), 20); });
    const [redirected, bystander] = await Promise.all([
        runWithProbe(async () => (await fetch(`${base}/go`)).text()),
        runWithProbe(async () => (await fetch(`${other.base}/`)).text()),
    ]);
    assert.deepStrictEqual(redirected.probe.peers.map((p) => p.host), ['127.0.0.1', 'localhost']);
    // Happy Eyeballs may try ::1 first; the peer is the address that connected.
    assert.ok(['127.0.0.1', '::1'].includes(redirected.probe.peers[1].ip));
    assert.strictEqual(redirected.probe.peers[1].port, target.port);
    assert.deepStrictEqual(bystander.probe.peers.map((p) => p.port), [other.port]);
});

test('node:http with a keep-alive agent: the address on the first and on the reused socket', async () => {
    const { port } = await serve();
    const agent = new http.Agent({ keepAlive: true });
    const get = () => runWithProbe(() => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/n', agent }, (res) => { res.resume(); res.on('end', resolve); })
            .on('error', reject);
    }));
    const first = await get();
    const second = await get();
    agent.destroy();
    for (const { probe } of [first, second]) {
        assert.strictEqual(probe.peers.length, 1);
        assert.strictEqual(probe.peers[0].ip, '127.0.0.1');
        assert.strictEqual(probe.peers[0].status, 200);
        assert.strictEqual(probe.peers[0].edge['cf-ray'], '8c1f2a3b4d5e6f70-AMS');
    }
    assert.strictEqual(first.probe.peers[0].reused, false);
    assert.strictEqual(second.probe.peers[0].reused, true);
});

test('node:http: a request whose response never finishes is still read at seal time', async () => {
    const { port } = await serve((req, res) => { res.writeHead(200); res.write('partial'); });
    const { probe } = await runWithProbe(() => new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/hang' }, () => {
            resolve();
            req.destroy();
        });
        req.on('error', () => {});
    }));
    assert.strictEqual(probe.peers.length, 1);
    assert.strictEqual(probe.peers[0].ip, '127.0.0.1');
});

test('a sealed probe ignores what its call left running', async () => {
    const { base } = await serve();
    let late;
    const { probe } = await runWithProbe(async () => {
        // A timer keeps the probe's context: this request is created after the seal.
        late = new Promise((resolve) => setTimeout(() => fetch(`${base}/late`).then((r) => r.text()).then(resolve), 20));
    });
    await late;
    assert.strictEqual(probe.peers.length, 0);
    assert.ok(Object.isFrozen(probe));
});

test('a throwing capture step never breaks the request or the process', async () => {
    const { base } = await serve();
    const uncaught = [];
    const onUncaught = (err) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    capture.setFaultHookForTests(() => { throw new Error('capture bug'); });
    try {
        const { result, probe } = await runWithProbe(async () => (await fetch(`${base}/`, { method: 'POST', body: 'x' })).json());
        assert.strictEqual(result.body, 'x', 'the request itself must be untouched');
        assert.strictEqual(probe.peers.length, 0);
    } finally {
        capture.setFaultHookForTests(null);
        process.removeListener('uncaughtException', onUncaught);
    }
    assert.deepStrictEqual(uncaught, []);
});

test('a model call inside a probe (outsideProbe) records no peer; the tool call beside it does', async () => {
    const { base } = await serve();
    const fakeAdapter = { chat: (...args) => outsideProbe(() => fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(args) }).then((r) => r.json())) };
    const { probe } = await runWithProbe(async () => {
        await fakeAdapter.chat('key', base, 'model', []);
        await (await fetch(`${base}/tool`)).text();
    });
    assert.strictEqual(probe.peers.length, 1);
    assert.strictEqual(probe.peers[0].method, 'GET', 'only the tool\'s GET, not the model POST');
});

test('the provider adapters\' model calls run outside the probe', async () => {
    const { base } = await serve((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: {} }));
    });
    const { baseAdapter } = require('../providers');
    const { result, probe } = await runWithProbe(() => baseAdapter.chat('k', base, 'test-model', [{ role: 'user', content: 'hello' }]));
    assert.strictEqual(result.content, 'hi');
    assert.deepStrictEqual(probe.peers, []);
});

test('markLocal is a hint: legacy fields say local only when nothing was seen', async () => {
    const { base } = await serve();
    const quiet = await runWithProbe(async () => { markLocal('Knowledge Base'); });
    assert.strictEqual(quiet.probe.is_local, true);
    assert.strictEqual(quiet.probe.local_label, 'Knowledge Base');
    assert.strictEqual(quiet.probe.peer_ip_source, 'local');
    assert.strictEqual(quiet.probe.hostname, 'Knowledge Base');

    const busy = await runWithProbe(async () => { markLocal('kb'); await (await fetch(`${base}/`)).text(); });
    assert.strictEqual(busy.probe.is_local, true);
    assert.strictEqual(busy.probe.peers.length, 1);
    assert.strictEqual(busy.probe.peer_ip_source, 'socket', 'a seen connection outranks the hint');
});

test('runWithProbeSettled keeps the probe of a call that threw', async () => {
    const { base } = await serve();
    const out = await runWithProbeSettled(async () => {
        await (await fetch(`${base}/`)).text();
        throw new Error('tool failed after sending');
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error.message, 'tool failed after sending');
    assert.strictEqual(out.probe.peers.length, 1);
});

test('peers on the OTLP exporter host are not the call\'s egress', async () => {
    const { base, port } = await serve();
    const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
    try {
        const { probe } = await runWithProbe(async () => (await fetch(`${base}/v1/traces`, { method: 'POST', body: '{}' })).text());
        assert.deepStrictEqual(probe.peers, []);
    } finally {
        if (saved === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
        else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
    }
});

test('proxy classification: a socket to the configured proxy is marked, a direct one is not', () => {
    const { isProxiedSocket } = capture._internals;
    const env = { HTTPS_PROXY: 'http://proxy.corp.local:3128', NO_PROXY: 'nextcloud.internal,.svc' };
    const viaProxy = { _host: 'proxy.corp.local', remoteAddress: '10.0.0.5', remotePort: 3128 };
    const direct = { _host: 'api.fireflies.ai', remoteAddress: '104.18.24.82', remotePort: 443 };
    const tunnelled = { remoteAddress: '10.0.0.5', remotePort: 3128 }; // TLS over the tunnel: no _host of its own
    assert.strictEqual(isProxiedSocket({ targetHost: 'api.fireflies.ai', targetPort: 443, socket: viaProxy, env }), true);
    assert.strictEqual(isProxiedSocket({ targetHost: 'api.fireflies.ai', targetPort: 443, socket: tunnelled, env }), true);
    assert.strictEqual(isProxiedSocket({ targetHost: 'api.fireflies.ai', targetPort: 443, socket: direct, env }), false);
    assert.strictEqual(isProxiedSocket({ targetHost: 'nextcloud.internal', targetPort: 443, socket: viaProxy, env }), false, 'NO_PROXY hosts go direct');
    assert.strictEqual(isProxiedSocket({ targetHost: 'x.svc', targetPort: 443, socket: viaProxy, env }), false);
    assert.strictEqual(isProxiedSocket({ targetHost: 'api.fireflies.ai', targetPort: 443, socket: viaProxy, env: {} }), false);
});

test('address normalisation: zone ids, IPv4-mapped IPv6, garbage', () => {
    const { normaliseIp } = capture._internals;
    assert.strictEqual(normaliseIp('::ffff:104.18.24.82'), '104.18.24.82');
    assert.strictEqual(normaliseIp('fe80::1%eth0'), 'fe80::1');
    assert.strictEqual(normaliseIp('2606:4700::6812:1852'), '2606:4700::6812:1852');
    assert.strictEqual(normaliseIp('not-an-ip'), null);
    assert.strictEqual(normaliseIp(undefined), null);
});

test('peers from outside this process: browser and child_process, and withPeers on a snapshot', async () => {
    const { probe } = await runWithProbe(async () => {
        recordPeer({ host: 'www.example.org', ip: null, basis: 'browser', method: 'GET' });
        recordPeer({ host: 'nope.example', basis: 'made-up' }); // unknown basis: refused
    });
    assert.deepStrictEqual(probe.peers.map((p) => [p.host, p.ip, p.basis]), [['www.example.org', null, 'browser']]);
    const extended = withPeers(probe, [{ host: 'soverin', ip: null, basis: 'child_process', sentBody: true }]);
    assert.strictEqual(extended.peers.length, 2);
    assert.strictEqual(extended.peers[0].at, probe.peers[0].at, 'first-seen time survives the copy');
    assert.strictEqual(extended.hostname, 'soverin');
    assert.ok(Object.isFrozen(extended));
    assert.strictEqual(withPeers(null, []).peers.length, 0);
});

test('peers are capped at eight, and a peer that received data displaces one that did not', async () => {
    const { probe } = await runWithProbe(async () => {
        for (let i = 0; i < 8; i++) recordPeer({ host: `read${i}.example`, basis: 'browser', sentBody: false });
        recordPeer({ host: 'extra-read.example', basis: 'browser', sentBody: false });
        recordPeer({ host: 'write.example', basis: 'browser', sentBody: true });
    });
    assert.strictEqual(probe.peers.length, capture._internals.MAX_PEERS);
    assert.ok(probe.peers.some((p) => p.host === 'write.example'));
    assert.ok(!probe.peers.some((p) => p.host === 'extra-read.example'));
});

test('installing twice subscribes once; the state survives a fresh copy of the module', () => {
    assert.strictEqual(capture.install(), false);
    const state = capture._internals.shared();
    assert.strictEqual(globalThis[Symbol.for('beeflow.egress')], state);
    assert.strictEqual(state.installed, true);
});

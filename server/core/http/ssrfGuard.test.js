/**
 * The canonical SSRF guard through the REAL undici dispatcher: a local HTTP
 * server on 127.0.0.1 and an injected DNS lookup, no internet.
 *
 * Every refusal has a control: the same request through a plain Agent (same
 * lookup) does reach the local server, so a pass here means the guard
 * refused, not that nothing was listening.
 *
 * Covered: private literal IPs, DNS rebinding (a name resolving to
 * 127.0.0.1 / 169.254.169.254 / ::1, or a public+private mix), redirects to
 * private targets (every hop is re-validated at connect), the post-connect
 * peer check, the lookup's callback shapes, and HTTP/1.1-only ALPN.
 * The pure tables are covered by core/customIntegrations/ssrfGuard.test.js
 * and utils/ssrfGuard.test.js (both run against this module).
 *
 * Run: cd server && node --test core/http/ssrfGuard.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const undici = require('undici');

const guard = require('./ssrfGuard');
const utilsGuard = require('../../utils/ssrfGuard');

let server;
let port;
const hits = [];

const PUBLIC_IP = '93.184.216.34';

/** Test resolver: names map to fixed answers; everything else is NXDOMAIN. */
const ANSWERS = {
    'public.test': [{ address: '127.0.0.1', family: 4 }], // only used by the unguarded control/router
    'rebind-v4.test': [{ address: '127.0.0.1', family: 4 }],
    'rebind-meta.test': [{ address: '169.254.169.254', family: 4 }],
    'rebind-v6.test': [{ address: '::1', family: 6 }],
    'rebind-mixed.test': [{ address: PUBLIC_IP, family: 4 }, { address: '127.0.0.1', family: 4 }],
};
const lookups = [];
function stubLookup(hostname, options, cb) {
    lookups.push(hostname);
    const list = ANSWERS[hostname];
    if (!list) {
        return process.nextTick(cb, Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    }
    if (options && options.all) return process.nextTick(cb, null, list);
    process.nextTick(cb, null, list[0].address, list[0].family);
}

const plain = new undici.Agent({ allowH2: false, connect: { lookup: stubLookup } });
const utilsDispatcher = utilsGuard.makeSafeDispatcher({ lookup: stubLookup });
const genericDispatcher = guard.createGuardedDispatcher({ lookup: stubLookup });

/**
 * Sends requests for `publicOrigin` through the unguarded Agent (it stands
 * in for a public server that answers with a redirect) and everything else,
 * so every redirect hop, through `guarded`.
 */
class RouterDispatcher extends undici.Dispatcher {
    constructor(publicOrigin, guarded) {
        super();
        this.publicOrigin = publicOrigin;
        this.guarded = guarded;
    }

    dispatch(opts, handler) {
        const origin = String(opts.origin);
        return (origin === this.publicOrigin ? plain : this.guarded).dispatch(opts, handler);
    }

    async close() {}

    async destroy() {}
}

before(async () => {
    server = http.createServer((req, res) => {
        hits.push(req.url);
        const m = req.url.match(/^\/redirect\?to=(.*)$/);
        if (m) {
            res.writeHead(302, { location: decodeURIComponent(m[1]) });
            return res.end();
        }
        res.end(`reached ${req.url}`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

after(async () => {
    await Promise.all([plain.close(), utilsDispatcher.close(), genericDispatcher.close()]);
    await new Promise(resolve => server.close(resolve));
});

/** Fetch through `dispatcher`; resolves to the body or the thrown error. */
async function attempt(url, dispatcher, init = {}) {
    try {
        const res = await undici.fetch(url, { ...init, dispatcher, signal: AbortSignal.timeout(5000) });
        return { body: await res.text(), status: res.status };
    } catch (err) {
        return { err };
    }
}

function causeMessages(err) {
    const out = [];
    for (let e = err, i = 0; e && i < 6; e = e.cause, i++) out.push(e.message);
    return out;
}

test('control: the local server is reachable without the guard', async () => {
    const r = await attempt(`http://127.0.0.1:${port}/control`, plain);
    assert.equal(r.body, 'reached /control');
    const viaName = await attempt(`http://rebind-v4.test:${port}/control`, plain);
    assert.equal(viaName.body, 'reached /control', 'the stub lookup really points at the local server');
});

test('private literal IPs are refused by the dispatcher itself', async () => {
    const before = hits.length;
    for (const url of [
        `http://127.0.0.1:${port}/secret`,
        `http://[::1]:${port}/secret`,
        `http://169.254.169.254/latest/meta-data`,
        `http://2130706433:${port}/secret`, // URL parser canonicalises to 127.0.0.1
        `http://[::ffff:127.0.0.1]:${port}/secret`,
    ]) {
        const u = await attempt(url, utilsDispatcher);
        assert.ok(u.err, `${url} must fail through utils dispatcher`);
        assert.equal(utilsGuard.isPrivateAddressError(u.err), true, `${url}: EPRIVATEADDRESS in the cause chain`);

        const g = await attempt(url, genericDispatcher);
        assert.ok(g.err, `${url} must fail through the generic dispatcher`);
        assert.ok(causeMessages(g.err).includes('Target address is not allowed.'), `${url}: generic message`);
    }
    assert.equal(hits.length, before, 'no refused request reached the server');
});

test('DNS rebinding: a name resolving to a private address is refused at connect', async () => {
    const before = hits.length;
    for (const host of ['rebind-v4.test', 'rebind-meta.test', 'rebind-v6.test', 'rebind-mixed.test']) {
        const url = `http://${host}:${port}/secret`;
        const u = await attempt(url, utilsDispatcher);
        assert.ok(u.err, `${host} must fail`);
        assert.equal(utilsGuard.isPrivateAddressError(u.err), true, `${host}: EPRIVATEADDRESS`);
        const g = await attempt(url, genericDispatcher);
        assert.ok(causeMessages(g.err).includes('Target address is not allowed.'), `${host}: generic message`);
    }
    assert.equal(hits.length, before, 'no rebound request reached the server');
    assert.ok(lookups.includes('rebind-mixed.test'), 'the names went through the injected lookup');
});

test('an unresolvable name stays an ordinary resolver error, not a refusal', async () => {
    const u = await attempt(`http://nx.test:${port}/`, utilsDispatcher);
    assert.ok(u.err);
    assert.equal(utilsGuard.isPrivateAddressError(u.err), false);
});

test('a redirect to a private target is refused on the hop, through utils.safeFetch', async () => {
    const publicOrigin = `http://public.test:${port}`;
    const router = new RouterDispatcher(publicOrigin, utilsDispatcher);

    const ok = await utilsGuard.safeFetch(`${publicOrigin}/redirect?to=${encodeURIComponent(`${publicOrigin}/landing`)}`,
        { dispatcher: router, signal: AbortSignal.timeout(5000) });
    assert.equal(await ok.text(), 'reached /landing', 'control: a redirect within the public origin is followed');

    for (const target of [
        `http://127.0.0.1:${port}/secret`,
        `http://[::1]:${port}/secret`,
        `http://169.254.169.254/latest/meta-data`,
        `http://localhost:${port}/secret`,
        `http://rebind-v4.test:${port}/secret`,
        `http://rebind-meta.test/latest/meta-data`,
        `http://rebind-v6.test:${port}/secret`,
    ]) {
        const before = hits.filter(h => h === '/secret').length;
        await assert.rejects(
            utilsGuard.safeFetch(`${publicOrigin}/redirect?to=${encodeURIComponent(target)}`,
                { dispatcher: router, signal: AbortSignal.timeout(5000) }),
            (e) => utilsGuard.isPrivateAddressError(e),
            `redirect to ${target} must be refused`,
        );
        assert.equal(hits.filter(h => h === '/secret').length, before, `${target} was never reached`);
    }
});

test('the post-connect peer check refuses a socket whose real peer is private', async () => {
    const make = (remoteAddress) => {
        const destroyed = { value: false };
        const socket = { remoteAddress, destroy() { destroyed.value = true; } };
        const base = (opts, cb) => process.nextTick(cb, null, socket);
        return { connect: guard.guardConnector(base, (h) => Object.assign(new Error('refused'), { host: h })), destroyed, socket };
    };
    const run = (connect, hostname) => new Promise(resolve => connect({ hostname }, (err, s) => resolve({ err, s })));

    for (const peer of ['127.0.0.1', '10.0.0.5', '::1', '::ffff:169.254.169.254', undefined]) {
        const c = make(peer);
        const r = await run(c.connect, 'public.example');
        assert.ok(r.err, `peer ${peer} must be refused`);
        assert.equal(r.err.host, 'public.example');
        assert.equal(c.destroyed.value, true, `peer ${peer}: socket destroyed`);
    }
    const okc = make(PUBLIC_IP);
    const ok = await run(okc.connect, 'public.example');
    assert.equal(ok.err, null);
    assert.equal(ok.s, okc.socket);
    assert.equal(okc.destroyed.value, false);

    let dialled = false;
    const literal = guard.guardConnector(() => { dialled = true; }, () => new Error('refused'));
    const r = await run(literal, '[::1]');
    assert.ok(r.err);
    assert.equal(dialled, false, 'a private literal is refused before dialling');
});

test('the guarded lookup answers in the shape the caller asked for', async () => {
    const lk = guard.makeGuardedLookup({
        lookup: (h, o, cb) => process.nextTick(cb, null, [{ address: '2606:4700::1', family: 6 }, { address: PUBLIC_IP, family: 4 }]),
    });
    const single = await new Promise(resolve => lk('x.example', {}, (err, address, family) => resolve({ err, address, family })));
    assert.deepEqual(single, { err: null, address: '2606:4700::1', family: 6 });
    const all = await new Promise(resolve => lk('x.example', { all: true }, (err, list) => resolve({ err, list })));
    assert.equal(all.err, null);
    assert.deepEqual(all.list.map(e => e.address), ['2606:4700::1', PUBLIC_IP]);

    const asked = [];
    const spy = guard.makeGuardedLookup({ lookup: (h, o, cb) => { asked.push(o); process.nextTick(cb, null, PUBLIC_IP, 4); } });
    const r = await new Promise(resolve => spy('y.example', { family: 4 }, (err, address, family) => resolve({ err, address, family })));
    assert.deepEqual(r, { err: null, address: PUBLIC_IP, family: 4 });
    assert.equal(asked[0].all, true, 'always resolves every record');
    assert.equal(asked[0].family, 4, 'caller options are kept');

    const empty = guard.makeGuardedLookup({ lookup: (h, o, cb) => process.nextTick(cb, null, []) });
    const e = await new Promise(resolve => empty('z.example', {}, (err) => resolve(err)));
    assert.equal(e.message, 'Target host could not be resolved.');
});

test('the guarded dispatchers offer HTTP/1.1 only (allowH2: false)', async () => {
    const seen = [];
    const original = tls.connect;
    tls.connect = (opts) => {
        seen.push(opts.ALPNProtocols);
        const s = new net.Socket();
        process.nextTick(() => s.destroy(new Error('tls stubbed')));
        return s;
    };
    const fresh = [guard.createGuardedDispatcher({ lookup: stubLookup }), utilsGuard.makeSafeDispatcher({ lookup: stubLookup })];
    try {
        for (const d of [...fresh, guard.createPinnedDispatcher()]) {
            const r = await attempt(`https://${PUBLIC_IP}/`, d);
            assert.ok(r.err, 'the stubbed TLS socket fails the request');
        }
    } finally {
        tls.connect = original;
        await Promise.all(fresh.map(d => d.destroy()));
    }
    assert.equal(seen.length, 3, 'every dispatcher reached the TLS connect');
    for (const alpn of seen) assert.deepEqual(alpn, ['http/1.1']);
});

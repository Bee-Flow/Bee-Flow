/**
 * The remote-browser request screen: literal addresses decided without DNS,
 * names resolved through the guarded lookup (every record checked), one
 * verdict per host cached, and a resolver failure counted as a refusal.
 *
 * Run: cd server && node --test core/http/browserRouteGuard.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeResolvedHostScreen, requestAllowed } = require('./browserRouteGuard');

const PUBLIC_IP = '93.184.216.34';

/** A resolver with fixed answers; unknown names are NXDOMAIN. */
function makeLookup(answers) {
    const calls = [];
    const lookup = (host, opts, cb) => {
        calls.push(host);
        const a = answers[host];
        if (!a) {
            const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
            err.code = 'ENOTFOUND';
            return process.nextTick(cb, err);
        }
        process.nextTick(cb, null, a);
    };
    return { lookup, calls };
}

const ANSWERS = {
    'public.test': [{ address: PUBLIC_IP, family: 4 }],
    'meta.test': [{ address: '169.254.169.254', family: 4 }],
    'loop6.test': [{ address: '::1', family: 6 }],
    'mixed.test': [{ address: PUBLIC_IP, family: 4 }, { address: '10.0.0.5', family: 4 }],
    'nat64.test': [{ address: '64:ff9b::7f00:1', family: 6 }],
};

test('literal addresses are decided without a lookup', async () => {
    const { lookup, calls } = makeLookup(ANSWERS);
    const screen = makeResolvedHostScreen({ lookup });
    assert.equal(await screen('127.0.0.1'), false);
    assert.equal(await screen('169.254.169.254'), false);
    assert.equal(await screen('2130706433'), false);          // decimal 127.0.0.1
    assert.equal(await screen('[::1]'), false);
    assert.equal(await screen('localhost'), false);
    assert.equal(await screen('300.1.2.3'), false);           // malformed numeric: never DNS
    assert.equal(await screen(PUBLIC_IP), true);
    assert.deepEqual(calls, []);
});

test('a name is refused when ANY resolved address is private', async () => {
    const { lookup } = makeLookup(ANSWERS);
    const screen = makeResolvedHostScreen({ lookup });
    assert.equal(await screen('public.test'), true);
    assert.equal(await screen('meta.test'), false);
    assert.equal(await screen('loop6.test'), false);
    assert.equal(await screen('mixed.test'), false);
    assert.equal(await screen('nat64.test'), false);
});

test('a resolver failure is a refusal, never a pass', async () => {
    const { lookup } = makeLookup(ANSWERS);
    const screen = makeResolvedHostScreen({ lookup });
    assert.equal(await screen('nxdomain.test'), false);
    const throwing = makeResolvedHostScreen({ lookup: () => { throw new Error('resolver down'); } });
    assert.equal(await throwing('public.test'), false);
});

test('one lookup per host within the TTL, concurrent calls share it, and the verdict expires', async () => {
    const { lookup, calls } = makeLookup(ANSWERS);
    let t = 1_000_000;
    const screen = makeResolvedHostScreen({ lookup, ttlMs: 1000, now: () => t });
    const [a, b, c] = await Promise.all([screen('public.test'), screen('public.test'), screen('PUBLIC.test.')]);
    assert.deepEqual([a, b, c], [true, true, true]);
    assert.deepEqual(calls, ['public.test'], 'three concurrent asks, one lookup (case and trailing dot folded)');
    assert.equal(await screen('public.test'), true);
    assert.equal(calls.length, 1, 'served from the cache');
    t += 1001;
    assert.equal(await screen('public.test'), true);
    assert.equal(calls.length, 2, 'resolved again after the TTL');
});

test('requestAllowed: http(s) to a public host only', async () => {
    const { lookup } = makeLookup(ANSWERS);
    const screen = makeResolvedHostScreen({ lookup });
    assert.equal(await requestAllowed('https://public.test/page', screen), true);
    assert.equal(await requestAllowed('http://meta.test/latest/meta-data/', screen), false);
    assert.equal(await requestAllowed('http://10.0.0.5/', screen), false);
    assert.equal(await requestAllowed('ftp://public.test/file', screen), false);
    assert.equal(await requestAllowed('file:///etc/passwd', screen), false);
    assert.equal(await requestAllowed('not a url', screen), false);
});

// ── Context helpers ─────────────────────────────────────────────

const { guardContextRequests, guardContextWebSockets, blockContextNetwork } = require('./browserRouteGuard');

/** A context that records its route / routeWebSocket handlers. */
function fakeContext() {
    const ctx = {
        routes: /** @type {Function[]} */ ([]),
        sockets: /** @type {Function[]} */ ([]),
        route: async (_m, h) => { ctx.routes.push(h); },
        routeWebSocket: async (_m, h) => { ctx.sockets.push(h); },
    };
    return ctx;
}

/** Run the route handler for one url; answers 'continue' | 'abort'. */
async function verdictFor(handler, url) {
    let out = null;
    await handler({
        request: () => ({ url: () => url }),
        continue: async () => { out = 'continue'; },
        abort: async () => { out = 'abort'; },
    });
    return out;
}

/** Run the ws handler for one url; answers 'connect' | 'close'. */
async function wsVerdictFor(handler, url) {
    let out = null;
    await handler({ url: () => url, connectToServer: () => { out = 'connect'; }, close: async () => { out = 'close'; } });
    return out;
}

test('guardContextRequests: public continues, private and metadata names are aborted', async () => {
    const ctx = fakeContext();
    const { lookup } = makeLookup(ANSWERS);
    await guardContextRequests(/** @type {any} */ (ctx), makeResolvedHostScreen({ lookup }));
    assert.equal(ctx.routes.length, 1);
    assert.equal(await verdictFor(ctx.routes[0], 'https://public.test/x.js'), 'continue');
    assert.equal(await verdictFor(ctx.routes[0], 'http://meta.test/latest/meta-data/'), 'abort');
    assert.equal(await verdictFor(ctx.routes[0], 'http://169.254.169.254/'), 'abort');
    assert.equal(await verdictFor(ctx.routes[0], 'http://127.0.0.1:9222/json'), 'abort');
    assert.equal(await verdictFor(ctx.routes[0], 'file:///etc/passwd'), 'abort');
});

test('guardContextWebSockets: a socket to a private host is closed, a public one connects', async () => {
    const ctx = fakeContext();
    const { lookup } = makeLookup(ANSWERS);
    await guardContextWebSockets(/** @type {any} */ (ctx), makeResolvedHostScreen({ lookup }));
    assert.equal(ctx.sockets.length, 1);
    assert.equal(await wsVerdictFor(ctx.sockets[0], 'ws://127.0.0.1:9222/beeflow-browser'), 'close');
    assert.equal(await wsVerdictFor(ctx.sockets[0], 'wss://meta.test/'), 'close');
    assert.equal(await wsVerdictFor(ctx.sockets[0], 'wss://public.test/socket'), 'connect');
});

test('blockContextNetwork: only data:, about: and blob: continue; every socket is closed', async () => {
    const ctx = fakeContext();
    await blockContextNetwork(/** @type {any} */ (ctx));
    const [handler] = ctx.routes;
    assert.equal(await verdictFor(handler, 'data:image/png;base64,AAAA'), 'continue');
    assert.equal(await verdictFor(handler, 'about:blank'), 'continue');
    assert.equal(await verdictFor(handler, 'blob:https://x/abc'), 'continue');
    assert.equal(await verdictFor(handler, 'https://cdn.example.com/a.png'), 'abort');
    assert.equal(await verdictFor(handler, 'http://169.254.169.254/'), 'abort');
    assert.equal(await wsVerdictFor(ctx.sockets[0], 'wss://public.test/'), 'close');
});

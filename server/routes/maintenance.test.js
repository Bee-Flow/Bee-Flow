/**
 * Maintenance routes — auth gate + announce/clear round trip.
 *
 * Run: node --test routes/maintenance.test.js
 *
 * Boots the router on an ephemeral port with a stubbed configStore, so no DB
 * and no supertest dependency.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// ── Stub configStore before anything pulls it in ───────────────────────
const configStorePath = require.resolve('../stores/configStore');
let _store = Object.create(null);
require.cache[configStorePath] = {
    id: configStorePath,
    filename: configStorePath,
    loaded: true,
    exports: {
        getConfig: async (k) => _store[k],
        setConfig: async (k, v) => { _store[k] = v; },
    },
};

const TOKEN = 'test-deploy-token';
process.env.MAINTENANCE_ANNOUNCE_TOKEN = TOKEN;
process.env.APP_BUILD_SHA = 'sha-abc';

// Session stub: flip `signedIn` per test.
let signedIn = true;

let server, base;

before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = signedIn ? { user: { id: 'u1' } } : {};
        next();
    });
    app.use('/api/maintenance', require('./maintenance'));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/maintenance`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function reset() { _store = Object.create(null); signedIn = true; }

const post = (path, { token, body } = {}) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
});

// ── The token gate ─────────────────────────────────────────────────────

test('announce without a token is rejected', async () => {
    reset();
    const res = await post('/announce', { body: { etaSeconds: 60 } });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(await _activeCount(), 0, 'nothing may be stored on a rejected call');
});

test('announce with a WRONG token is rejected', async () => {
    reset();
    const res = await post('/announce', { token: 'wrong', body: { etaSeconds: 60 } });
    assert.strictEqual(res.status, 401);
});

test('a token of a different LENGTH is rejected, not crashed on', async () => {
    reset();
    // timingSafeEqual throws on length mismatch; the length check must come
    // first or this is a 500 (and an oracle) instead of a clean 401.
    const res = await post('/announce', { token: 'x', body: { etaSeconds: 60 } });
    assert.strictEqual(res.status, 401);
});

test('clear is gated by the same token', async () => {
    reset();
    assert.strictEqual((await post('/clear')).status, 401);
});

// ── Happy path ─────────────────────────────────────────────────────────

test('announce with a valid token opens a window that GET returns', async () => {
    reset();
    const res = await post('/announce', { token: TOKEN, body: { etaSeconds: 120, ref: 'deadbeef' } });
    assert.strictEqual(res.status, 200);

    const got = await (await fetch(base)).json();
    assert.ok(got.maintenance, 'GET should report the open window');
    assert.strictEqual(got.maintenance.ref, 'deadbeef');
    assert.strictEqual(got.appVersion, 'sha-abc', 'the client needs this to detect the new build');
});

test('clear with a valid token closes the window', async () => {
    reset();
    await post('/announce', { token: TOKEN, body: { etaSeconds: 600 } });
    assert.strictEqual((await post('/clear', { token: TOKEN })).status, 200);
    const got = await (await fetch(base)).json();
    assert.strictEqual(got.maintenance, null);
});

test('a bad etaSeconds is the caller error it is (400, not 500)', async () => {
    reset();
    const res = await post('/announce', { token: TOKEN, body: { etaSeconds: 'soon' } });
    assert.strictEqual(res.status, 400);
});

// ── Read gate ──────────────────────────────────────────────────────────

test('GET requires a signed-in session', async () => {
    reset();
    signedIn = false;
    assert.strictEqual((await fetch(base)).status, 401);
});

// ── Build stamp source ─────────────────────────────────────────────────

test('appVersion is the buildInfo snapshot, not a raw request-time env read', async () => {
    reset();
    // utils/buildInfo reads APP_BUILD_SHA once, at require. The route must serve
    // THAT stamp (the same value /api/health/schema exposes as `build`, with the
    // same non-empty 'dev' fallback — see buildInfo.test.js). A raw
    // `process.env.APP_BUILD_SHA || ''` read would follow this mutation and
    // regress the ''-fallback that left the FE hook without a baseline.
    const saved = process.env.APP_BUILD_SHA;
    process.env.APP_BUILD_SHA = 'sha-mutated-after-boot';
    try {
        const got = await (await fetch(base)).json();
        assert.strictEqual(got.appVersion, 'sha-abc');
        assert.strictEqual(got.appVersion, require('../utils/buildInfo').APP_BUILD_SHA,
            'route and schema probe must serve the same stamp');
    } finally {
        process.env.APP_BUILD_SHA = saved;
    }
});

// ── Kill switch ────────────────────────────────────────────────────────

test('with no token configured the write paths are OFF, not open', async () => {
    reset();
    const saved = process.env.MAINTENANCE_ANNOUNCE_TOKEN;
    delete process.env.MAINTENANCE_ANNOUNCE_TOKEN;
    try {
        // Fails closed: an unauthenticated "the server is going down" broadcast
        // would be a griefing tool.
        const res = await post('/announce', { body: { etaSeconds: 60 } });
        assert.strictEqual(res.status, 503);
    } finally {
        process.env.MAINTENANCE_ANNOUNCE_TOKEN = saved;
    }
});

async function _activeCount() {
    const raw = _store['maintenance.window'];
    return raw ? 1 : 0;
}

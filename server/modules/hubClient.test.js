/**
 * hubClient tests — the product side of the Hub wire contract.
 *
 * global.fetch is SCRIPTED (a per-test handler + a call recorder); configStore
 * and license/store are stubbed via require.cache. No network, no DB.
 *
 * Run: node --test modules/hubClient.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = new Module(p);
    require.cache[p].exports = exports;
    require.cache[p].loaded = true;
}

// ── configStore (in-memory) ────────────────────────────────────────────────
const config = new Map();
const secrets = new Map();
mock('../stores/configStore', {
    getConfig: async (k) => (config.has(k) ? config.get(k) : null),
    setConfig: async (k, v) => { config.set(k, v); return true; },
    getSecret: async (k) => (secrets.has(k) ? secrets.get(k) : null),
    setSecret: async (k, v) => { if (!v) secrets.delete(k); else secrets.set(k, v); return true; },
});
// license/store — connect() reads the active server license token from it.
// Mutable so tests can simulate a licensed install (reset in beforeEach).
let activeLicense = null;
mock('../license/store', { getActiveLicenseForServer: async () => activeLicense });

const hubClient = require('./hubClient');

// ── Scripted fetch ─────────────────────────────────────────────────────────
let handler = () => { throw new Error('no handler set'); };
const calls = [];
global.fetch = async (url, opts = {}) => {
    calls.push({
        url: String(url),
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body ? JSON.parse(opts.body) : null,
    });
    return handler(String(url), opts);
};

function jsonResponse(status, body, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (h) => headers[h] ?? headers[String(h).toLowerCase()] ?? null },
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
        json: async () => body,
        arrayBuffer: async () => Buffer.from(body || ''),
    };
}

beforeEach(() => {
    config.clear();
    secrets.clear();
    calls.length = 0;
    handler = () => { throw new Error('no handler set'); };
    hubClient._reset();
    config.set(hubClient.HUB_URL_KEY, 'http://hub.test');
});

test('resolveHubUrl: config override, then default', async () => {
    assert.strictEqual(await hubClient.resolveHubUrl(), 'http://hub.test');
    config.delete(hubClient.HUB_URL_KEY);
    assert.strictEqual(await hubClient.resolveHubUrl(), 'https://hub.beeflow.nl');
});

test('connect persists install id + secret and returns tier/subject', async () => {
    handler = (url) => {
        assert.ok(url.endsWith('/hub/v1/connect'));
        return jsonResponse(201, {
            install_id: 'inst_1', install_secret: 'sek_1',
            tier: 'pro', subject: { type: 'license', id: 'lic_1' },
        });
    };
    const out = await hubClient.connect();
    assert.strictEqual(out.install_id, 'inst_1');
    assert.strictEqual(out.tier, 'pro');
    assert.deepStrictEqual(out.subject, { type: 'license', id: 'lic_1' });
    assert.strictEqual(config.get(hubClient.INSTALL_ID_KEY), 'inst_1');
    assert.strictEqual(secrets.get(hubClient.INSTALL_SECRET_KEY), 'sek_1');
    assert.strictEqual(await hubClient.isConnected(), true);
});

test('connect twice ⇒ HubError(already_connected)', async () => {
    config.set(hubClient.INSTALL_ID_KEY, 'inst_1');
    await assert.rejects(() => hubClient.connect(), (e) => e.code === 'already_connected');
});

test('connect retries anonymously when the hub rejects the auto-attached license', async () => {
    // Licensed install, but the hub can't verify the token (e.g. a production
    // license against a local hub with its own keys) → invalid_license, then
    // the retry without a token succeeds as a community connect.
    activeLicense = { rawToken: 'prod.signed.jwt' };
    try {
        handler = (url, opts) => {
            const body = JSON.parse(opts.body);
            if (body.license_token) return jsonResponse(401, { error: 'invalid_license' });
            return jsonResponse(201, {
                install_id: 'inst_anon', install_secret: 'sek_anon',
                tier: 'community', subject: { type: 'install', id: 'inst_anon' },
            });
        };
        const out = await hubClient.connect();
        assert.strictEqual(out.install_id, 'inst_anon');
        assert.strictEqual(out.tier, 'community');
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0].body.license_token, 'prod.signed.jwt');
        assert.strictEqual(calls[1].body.license_token, null);
        assert.strictEqual(await hubClient.isConnected(), true);
    } finally {
        activeLicense = null;
    }
});

test('connect with an EXPLICIT bad license still fails (no silent fallback)', async () => {
    handler = () => jsonResponse(401, { error: 'invalid_license' });
    await assert.rejects(
        () => hubClient.connect({ licenseToken: 'user.pasted.jwt' }),
        (e) => e.code === 'hub_denied' && e.detail === 'invalid_license',
    );
    assert.strictEqual(calls.length, 1); // no anonymous retry for explicit tokens
});

test('authed call mints a token once and reuses it (Bearer attached)', async () => {
    config.set(hubClient.INSTALL_ID_KEY, 'inst_1');
    secrets.set(hubClient.INSTALL_SECRET_KEY, 'sek_1');
    handler = (url) => {
        if (url.endsWith('/hub/v1/token')) return jsonResponse(200, { access_token: 'tok_1', token_type: 'Bearer', expires_in: 3600 });
        if (url.endsWith('/hub/v1/entitlements')) return jsonResponse(200, { as_of: 'now', entitlements: [{ entitlement_id: 'e1', module_id: 'm1', grant_token: 'g' }] });
        throw new Error('unexpected ' + url);
    };
    const a = await hubClient.fetchEntitlements();
    assert.strictEqual(a.entitlements.length, 1);
    const b = await hubClient.fetchEntitlements();
    assert.strictEqual(b.entitlements.length, 1);
    // one /token, two /entitlements (token cached)
    assert.strictEqual(calls.filter(c => c.url.endsWith('/hub/v1/token')).length, 1);
    const entCall = calls.find(c => c.url.endsWith('/hub/v1/entitlements'));
    assert.strictEqual(entCall.headers.Authorization, 'Bearer tok_1');
});

test('authed call with no install credentials ⇒ HubError(not_connected)', async () => {
    await assert.rejects(() => hubClient.fetchEntitlements(), (e) => e.code === 'not_connected');
});

test('fetchCatalogCached caches, then serves last-good stale on failure', async () => {
    let n = 0;
    handler = (url) => {
        if (url.includes('/hub/v1/catalog')) {
            n++;
            if (n === 1) return jsonResponse(200, { modules: [{ module_id: 'm1', name: 'M1' }] });
            throw new Error('network down');
        }
        throw new Error('unexpected');
    };
    const first = await hubClient.fetchCatalogCached({ q: 'x' });
    assert.strictEqual(first.stale, false);
    assert.strictEqual(first.modules[0].module_id, 'm1');
    // cached — no second fetch
    const second = await hubClient.fetchCatalogCached({ q: 'x' });
    assert.strictEqual(second.stale, false);
    assert.strictEqual(n, 1);
    // expire the fresh TTL cache (last-good survives); next fetch fails ⇒ stale
    hubClient._expireCatalogCache();
    const third = await hubClient.fetchCatalogCached({ q: 'x' });
    assert.strictEqual(third.stale, true);
    assert.strictEqual(third.modules[0].module_id, 'm1');
});

test('cold-cache catalog failure throws hub_unavailable', async () => {
    handler = () => { throw new Error('boom'); };
    await assert.rejects(() => hubClient.fetchCatalogCached({ q: 'y' }), (e) => e.code === 'hub_unavailable');
});

test('createPurchase: 402 ⇒ not_entitled; 409 already_entitled', async () => {
    config.set(hubClient.INSTALL_ID_KEY, 'inst_1');
    secrets.set(hubClient.INSTALL_SECRET_KEY, 'sek_1');
    handler = (url) => {
        if (url.endsWith('/hub/v1/token')) return jsonResponse(200, { access_token: 'tok', expires_in: 3600 });
        if (url.endsWith('/hub/v1/purchases')) return jsonResponse(402, { error: 'entitlement_required' });
        throw new Error('unexpected');
    };
    await assert.rejects(() => hubClient.createPurchase({ moduleId: 'm1', priceId: 'p1' }), (e) => e.code === 'not_entitled');

    hubClient._reset(); config.set(hubClient.HUB_URL_KEY, 'http://hub.test');
    config.set(hubClient.INSTALL_ID_KEY, 'inst_1'); secrets.set(hubClient.INSTALL_SECRET_KEY, 'sek_1');
    handler = (url) => {
        if (url.endsWith('/hub/v1/token')) return jsonResponse(200, { access_token: 'tok', expires_in: 3600 });
        if (url.endsWith('/hub/v1/purchases')) return jsonResponse(409, { error: 'already_entitled' });
        throw new Error('unexpected');
    };
    await assert.rejects(() => hubClient.createPurchase({ moduleId: 'm1', priceId: 'p1' }), (e) => e.code === 'already_entitled');
});

test('token mint 401 ⇒ hub_denied', async () => {
    config.set(hubClient.INSTALL_ID_KEY, 'inst_1');
    secrets.set(hubClient.INSTALL_SECRET_KEY, 'bad');
    handler = (url) => {
        if (url.endsWith('/hub/v1/token')) return jsonResponse(401, { error: 'invalid_credentials' });
        throw new Error('unexpected');
    };
    await assert.rejects(() => hubClient.fetchEntitlements(), (e) => e.code === 'hub_denied');
});

test('downloadPackage streams to disk, verifies sha256; mismatch ⇒ checksum_mismatch', async () => {
    config.set(hubClient.INSTALL_ID_KEY, 'inst_1');
    secrets.set(hubClient.INSTALL_SECRET_KEY, 'sek_1');
    const payload = Buffer.from('hello-package-bytes');
    const goodSha = crypto.createHash('sha256').update(payload).digest('hex');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubdl-'));
    const dest = path.join(dir, 'pkg.bfmod');

    handler = (url) => {
        if (url.endsWith('/hub/v1/token')) return jsonResponse(200, { access_token: 'tok', expires_in: 3600 });
        if (url.includes('/download')) {
            return {
                ok: true, status: 200,
                headers: { get: (h) => (String(h).toLowerCase() === 'x-beeflow-package-sha256' ? goodSha : null) },
                arrayBuffer: async () => payload,
                text: async () => '',
            };
        }
        throw new Error('unexpected');
    };
    const res = await hubClient.downloadPackage({ moduleId: 'm1', version: '1.0.0', destPath: dest });
    assert.strictEqual(res.sha256, goodSha);
    assert.ok(fs.existsSync(dest));
    assert.strictEqual(fs.readFileSync(dest).toString(), 'hello-package-bytes');
    assert.ok(!fs.existsSync(dest + '.part'), 'part file renamed away');

    // Wrong expected sha ⇒ checksum_mismatch, no file left behind
    const dest2 = path.join(dir, 'pkg2.bfmod');
    await assert.rejects(
        () => hubClient.downloadPackage({ moduleId: 'm1', version: '1.0.0', destPath: dest2, expectedSha256: 'deadbeef' }),
        (e) => e.code === 'checksum_mismatch'
    );
    assert.ok(!fs.existsSync(dest2));
    assert.ok(!fs.existsSync(dest2 + '.part'));
});

test('disconnect clears persisted credentials', async () => {
    config.set(hubClient.INSTALL_ID_KEY, 'inst_1');
    secrets.set(hubClient.INSTALL_SECRET_KEY, 'sek_1');
    await hubClient.disconnect();
    assert.strictEqual(await hubClient.isConnected(), false);
    assert.ok(!secrets.get(hubClient.INSTALL_SECRET_KEY));
});

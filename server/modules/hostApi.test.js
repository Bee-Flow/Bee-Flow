/**
 * Host API surface tests — the FROZEN capability object handed to a remote
 * module at activation (hostApi.build).
 *
 * Guards the v1 → v2 additive bump: every v1 field is still present, the new
 * v2 sub-objects (db.getClient/tx, ai, usage, limits, storage, webpages, net)
 * exist with the right shape, and the top-level object + every sub-object stay
 * Object.freeze'd so a module can't monkey-patch the host through it.
 *
 * db is require.cache-stubbed so no real pg pool is opened. The v2 method
 * wrappers lazy-require their heavy backing modules only on CALL, so simply
 * inspecting their shape here never drags AI SDKs / AWS S3 / the webpage store
 * into the test.
 *
 * Run: node --test modules/hostApi.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-at-least-32-chars-long';

// ── Stub ../db before hostApi loads (it destructures from it at top level) ──
const dbCalls = [];
const fakeClient = {
    async query(sql, params = []) { dbCalls.push({ fn: 'query', sql, params }); return { rows: [], rowCount: 0 }; },
    release() { dbCalls.push({ fn: 'release' }); },
};
const dbPath = require.resolve('../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => { dbCalls.push({ fn: 'getClient' }); return fakeClient; },
    pool: { query: async () => ({ rows: [] }) },
    getRedis: () => null,
};
require.cache[dbPath].loaded = true;

const hostApi = require('./hostApi');

function makeHost() {
    return hostApi.build('test_module', { dataDir: '/tmp/test_module' });
}

test('HOST_API_VERSION is 3 (permission manifest)', () => {
    assert.strictEqual(hostApi.HOST_API_VERSION, 3);
});

test('LEGACY PIN: permissions:null (mv1) carries every v1/v2 field unchanged', () => {
    const host = makeHost();
    assert.strictEqual(host.hostApiVersion, 3);
    assert.strictEqual(host.moduleId, 'test_module');
    assert.strictEqual(host.permissions, null, 'legacy modules see permissions:null');
    for (const k of ['db', 'express', 'middleware', 'stores', 'services', 'license',
                     'isModuleActive', 'fetch', 'ssrfGuard', 'log', 'dataDir']) {
        assert.ok(k in host, `v1 field '${k}' must still be present`);
    }
    // v1 db primitives intact.
    for (const fn of ['exec', 'run', 'getOne', 'getAll']) {
        assert.strictEqual(typeof host.db[fn], 'function', `db.${fn} must remain a function`);
    }
    // v1 middleware factories intact.
    assert.strictEqual(typeof host.middleware.requireCapability, 'function');
    assert.strictEqual(typeof host.middleware.requirePermission, 'function');
});

test('v2 adds db.getClient + db.tx', () => {
    const host = makeHost();
    assert.strictEqual(typeof host.db.getClient, 'function');
    assert.strictEqual(typeof host.db.tx, 'function');
});

test('db.tx runs BEGIN/COMMIT/release around the callback and returns its value', async () => {
    dbCalls.length = 0;
    const host = makeHost();
    const out = await host.db.tx(async (client) => {
        await client.query('SELECT 1');
        return 42;
    });
    assert.strictEqual(out, 42);
    const seq = dbCalls.map(c => c.fn === 'query' ? c.sql : c.fn);
    assert.deepStrictEqual(seq, ['getClient', 'BEGIN', 'SELECT 1', 'COMMIT', 'release']);
});

test('db.tx rolls back + releases when the callback throws', async () => {
    dbCalls.length = 0;
    const host = makeHost();
    await assert.rejects(() => host.db.tx(async () => { throw new Error('boom'); }), /boom/);
    const seq = dbCalls.map(c => c.fn === 'query' ? c.sql : c.fn);
    assert.deepStrictEqual(seq, ['getClient', 'BEGIN', 'ROLLBACK', 'release']);
});

test('v2 exposes the new frozen sub-objects with the documented method shape', () => {
    const host = makeHost();

    assert.strictEqual(typeof host.ai.resolveModelForTier, 'function');
    assert.strictEqual(typeof host.ai.getProviderForModel, 'function');
    assert.strictEqual(typeof host.ai.getAdapter, 'function');

    assert.strictEqual(typeof host.usage.logUsage, 'function');
    assert.strictEqual(typeof host.limits.checkSubscription, 'function');
    assert.strictEqual(typeof host.storage.getPresignedUrl, 'function');
    assert.strictEqual(typeof host.webpages.persist, 'function');
    assert.strictEqual(typeof host.net.isPrivateTarget, 'function');

    // storage exposes ONLY getPresignedUrl (no raw put/delete surface).
    assert.deepStrictEqual(Object.keys(host.storage), ['getPresignedUrl']);
});

test('net.isPrivateTarget is the shared sync predicate (blocks private, allows public)', () => {
    const host = makeHost();
    assert.strictEqual(host.net.isPrivateTarget('http://localhost/'), true);
    assert.strictEqual(host.net.isPrivateTarget('http://127.0.0.1/'), true);
    assert.strictEqual(host.net.isPrivateTarget('http://169.254.169.254/'), true);
    assert.strictEqual(host.net.isPrivateTarget('ftp://example.com/'), true); // non-http(s)
    assert.strictEqual(host.net.isPrivateTarget('https://example.com/'), false);
});

test('the host object AND every sub-object are frozen', () => {
    const host = makeHost();
    assert.ok(Object.isFrozen(host), 'top-level host must be frozen');
    for (const k of ['db', 'middleware', 'stores', 'services', 'ai', 'usage', 'limits', 'storage', 'webpages', 'net']) {
        assert.ok(Object.isFrozen(host[k]), `host.${k} must be frozen`);
    }
    // A freeze actually prevents mutation.
    assert.throws(() => { 'use strict'; host.ai.resolveModelForTier = () => {}; }, TypeError);
});

// ── v3 permission gating (M2) ────────────────────────────────────────────────

const CORE_KEYS = ['hostApiVersion', 'moduleId', 'express', 'middleware', 'net',
    'isModuleActive', 'log', 'dataDir', 'permissions'];

test('permissions:[] ⇒ core-only surface (no db/ai/config/fetch/stores)', () => {
    const host = hostApi.build('m2mod', { dataDir: '/tmp/m2mod', permissions: [] });
    assert.deepStrictEqual(Object.keys(host).sort(), [...CORE_KEYS].sort());
    assert.strictEqual(host.db, undefined);
    assert.strictEqual(host.fetch, undefined);
    assert.strictEqual(host.stores, undefined);
    assert.deepStrictEqual(host.permissions, []);
    assert.ok(Object.isFrozen(host));
});

test('each grant exposes exactly its sub-object', () => {
    const host = hostApi.build('m2mod', { dataDir: null, permissions: ['db', 'usage:write', 'license:read'] });
    assert.strictEqual(typeof host.db.tx, 'function');
    assert.strictEqual(typeof host.usage.logUsage, 'function');
    assert.strictEqual(typeof host.license.hasFeature, 'function');
    // NOT granted:
    assert.strictEqual(host.ai, undefined);
    assert.strictEqual(host.storage, undefined);
    assert.strictEqual(host.webpages, undefined);
    assert.strictEqual(host.services, undefined);
    assert.strictEqual(host.config, undefined);
    assert.strictEqual(host.fetch, undefined);
});

test('config grant is NAMESPACED — keys forced through module_<id>_', async () => {
    // Stub configStore via require.cache before the wrapper lazy-requires it.
    const csPath = require.resolve('../stores/configStore');
    const calls = [];
    require.cache[csPath] = new Module(csPath);
    require.cache[csPath].exports = {
        getConfig: async (k) => { calls.push(['getConfig', k]); return null; },
        setConfig: async (k, v) => { calls.push(['setConfig', k, v]); return true; },
        getSecret: async (k) => { calls.push(['getSecret', k]); return null; },
        setSecret: async (k, v) => { calls.push(['setSecret', k, v]); return true; },
    };
    require.cache[csPath].loaded = true;

    const host = hostApi.build('m2mod', { permissions: ['config'] });
    await host.config.setConfig('api_url', 'x');
    await host.config.getSecret('token');
    assert.deepStrictEqual(calls, [
        ['setConfig', 'module_m2mod_api_url', 'x'],
        ['getSecret', 'module_m2mod_token'],
    ]);
    // The instance-wide stores.configStore over-grant is GONE for mv2.
    assert.strictEqual(host.stores, undefined);
});

test('http:<pattern> matcher: exact host, *.suffix, and *', () => {
    assert.strictEqual(hostApi.hostAllowed('https://api.example.com/x', ['api.example.com']), true);
    assert.strictEqual(hostApi.hostAllowed('https://api.example.com:8443/x', ['api.example.com']), true);
    assert.strictEqual(hostApi.hostAllowed('https://evil.com/x', ['api.example.com']), false);
    assert.strictEqual(hostApi.hostAllowed('https://a.b.example.com/', ['*.example.com']), true);
    assert.strictEqual(hostApi.hostAllowed('https://example.com/', ['*.example.com']), true);
    assert.strictEqual(hostApi.hostAllowed('https://notexample.com/', ['*.example.com']), false);
    assert.strictEqual(hostApi.hostAllowed('https://anything.io/', ['*']), true);
    assert.strictEqual(hostApi.hostAllowed('not a url', ['*']), false);
});

test('granted fetch rejects non-allowlisted hosts; private targets stay blocked', async () => {
    const host = hostApi.build('m2mod', { permissions: ['http:api.example.com'] });
    assert.strictEqual(typeof host.fetch, 'function');
    await assert.rejects(() => host.fetch('https://evil.com/steal'), /allowlist/);
    // Allowlisted host passes the allowlist and reaches the SSRF guard, which
    // still blocks private targets — pin via a private host granted '*'.
    const anyHost = hostApi.build('m2mod', { permissions: ['http:*'] });
    await assert.rejects(() => anyHost.fetch('http://127.0.0.1/admin'));
});

test('isValidPermissionId accepts the taxonomy + http grants, rejects junk', () => {
    for (const ok of ['db', 'ai', 'usage:write', 'config', 'env:docker', 'http:*', 'http:api.x.com', 'http:*.x.com']) {
        assert.strictEqual(hostApi.isValidPermissionId(ok), true, ok);
    }
    for (const bad of ['', 'root', 'db:write', 'http:', 'http:*.', 'stores', null]) {
        assert.strictEqual(hostApi.isValidPermissionId(bad), false, String(bad));
    }
});

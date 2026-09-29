/**
 * Tenant resolution — the org-id list cache and the listKeysWithPrefix
 * contract.
 *
 * Two regressions pinned here:
 *
 * 1. THE CONTRACT TRAP: _resolveTenant consumes listKeysWithPrefix as FULL
 *    keys and strips the prefix itself. The original call site optional-
 *    chained a method that did not exist on configStore, silently falling
 *    back to getAllConfig() — a full config-table read + JSON.parse per
 *    embedded request (the top "slow inside Nextcloud" cause). A store
 *    method that returned pre-stripped ids would double-prefix getSecret
 *    and 403 every connector JWT; this suite fails on either mistake.
 *
 * 2. NEW-TENANT CORRECTNESS: with the 60s org-id list cache, a tenant that
 *    bootstrapped seconds ago on another replica must still authenticate —
 *    pass 3 refreshes the list once on a total miss before rejecting.
 *
 * Monkeypatch harness over the real configStore singleton (same pattern as
 * core/integrations/integrationTools.*.test.js) — no DB.
 *
 * Run: node --test server/auth/connectorJwt.tenantCache.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const configStore = require('../stores/configStore');
const { _resolveTenant, invalidateTenantKeyCache, _verifyHs256 } = require('./connectorJwt');

const PREFIX = 'connector_tenant_key_';
const KEY_1 = 'tenant-key-org1-32-bytes-minimum-x';
const KEY_2 = 'tenant-key-org2-32-bytes-minimum-x';

function mintToken(payload, key) {
    const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const h = enc({ alg: 'HS256', typ: 'JWT' });
    const p = enc({ iss: 'nextcloud-connector', aud: 'beeflow.nl', exp: Math.floor(Date.now() / 1000) + 300, ...payload });
    const sig = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${h}.${p}.${sig}`;
}

const calls = { listKeys: 0, getAllConfig: 0, getSecret: [], getSecretFresh: [] };
let secretRows = {};
let listedKeys = [];

beforeEach(() => {
    calls.listKeys = 0;
    calls.getAllConfig = 0;
    calls.getSecret.length = 0;
    calls.getSecretFresh.length = 0;
    secretRows = { [`${PREFIX}org1`]: KEY_1 };
    listedKeys = [`${PREFIX}org1`];
    configStore.listKeysWithPrefix = async (prefix) => {
        calls.listKeys += 1;
        assert.equal(prefix, PREFIX);
        return listedKeys.filter(k => k.startsWith(prefix));
    };
    configStore.getSecret = async (key) => { calls.getSecret.push(key); return secretRows[key] || null; };
    configStore.getSecretFresh = async (key) => { calls.getSecretFresh.push(key); return secretRows[key] || null; };
    configStore.getAllConfig = async () => { calls.getAllConfig += 1; return {}; };
    // reset both the key cache and the org-id list cache between tests
    invalidateTenantKeyCache();
});

test('full-key contract: listKeysWithPrefix keys are sliced, never double-prefixed', async () => {
    const token = mintToken({ sub: 'tom', email: 'tom@example.com' }, KEY_1);
    const resolved = await _resolveTenant(token);
    assert.ok(resolved, 'tenant must resolve');
    assert.equal(resolved.orgId, 'org1');
    // Every secret lookup must be exactly prefix + orgId — a double-prefixed
    // key here means the call site stopped slicing (or the store started
    // pre-stripping) and every connector JWT would 403.
    for (const k of [...calls.getSecret, ...calls.getSecretFresh]) {
        assert.equal(k, `${PREFIX}org1`, `malformed secret lookup: ${k}`);
    }
    assert.equal(calls.getAllConfig, 0, 'the getAllConfig full-table fallback must never run when listKeysWithPrefix exists');
});

test('org-id list is cached: repeated resolutions do one list read', async () => {
    const token = mintToken({ sub: 'tom', email: 'tom@example.com' }, KEY_1);
    await _resolveTenant(token);
    await _resolveTenant(token);
    await _resolveTenant(token);
    assert.equal(calls.listKeys, 1, 'steady-state requests must reuse the cached org-id list');
});

test('invalidateTenantKeyCache also drops the org-id list cache', async () => {
    const token = mintToken({ sub: 'tom', email: 'tom@example.com' }, KEY_1);
    await _resolveTenant(token);
    assert.equal(calls.listKeys, 1);
    invalidateTenantKeyCache();
    await _resolveTenant(token);
    assert.equal(calls.listKeys, 2, 'a key (re)mint must force a fresh org-id list');
});

test('a tenant bootstrapped mid-cache still authenticates (pass-3 refresh)', async () => {
    // Warm the cache with only org1 known.
    await _resolveTenant(mintToken({ sub: 'tom', email: 'tom@example.com' }, KEY_1));
    assert.equal(calls.listKeys, 1);
    // org2 bootstraps on another replica: its key exists in the DB but this
    // replica's cached list has never heard of it.
    secretRows[`${PREFIX}org2`] = KEY_2;
    listedKeys.push(`${PREFIX}org2`);
    const resolved = await _resolveTenant(mintToken({ sub: 'eve', email: 'eve@example.com' }, KEY_2));
    assert.ok(resolved, 'freshly bootstrapped tenant must not be 403d for the cache TTL');
    assert.equal(resolved.orgId, 'org2');
    assert.ok(calls.listKeys >= 2, 'a total miss must refresh the org-id list before rejecting');
});

test('an unknown key still rejects — pass 3 must not loop or grant', async () => {
    const rogue = mintToken({ sub: 'x', email: 'x@example.com' }, 'rogue-key-32-bytes-minimum-xxxxxx');
    const before = calls.listKeys;
    const resolved = await _resolveTenant(rogue);
    assert.equal(resolved, null);
    assert.ok(calls.listKeys - before <= 2, 'at most one refresh per resolution attempt');
});

test('sanity: the JWT primitive this suite mints is the one the middleware verifies', () => {
    const token = mintToken({ sub: 'tom', email: 'tom@example.com' }, KEY_1);
    const payload = _verifyHs256(token, KEY_1);
    assert.equal(payload.sub, 'tom');
});

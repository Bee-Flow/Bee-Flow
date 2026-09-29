/**
 * entitlementRefresh tests — the freshness owner for remote-module grants.
 *
 * Everything is stubbed via require.cache (no network, no DB): hubClient is
 * scripted per test, platformModuleStore is an in-memory row map, the runtime
 * (modules/index.js) records invalidations, entitlements.verifyModuleGrant is
 * a scripted verdict. remoteCatalog runs REAL — these tests pin the
 * refresh→persist→timestamp-gate contract end to end.
 *
 * Run: node --test modules/entitlementRefresh.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';
// Install-kill: no waiting period in tests — 3 consecutive denials trip it.
process.env.HUB_DENIED_GRACE_MS = '0';

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = new Module(p);
    require.cache[p].exports = exports;
    require.cache[p].loaded = true;
}

// ── In-memory platform_modules store ───────────────────────────────────────
const rows = new Map(); // moduleId → row
mock('../stores/platformModuleStore', {
    getAllStates: async () => [...rows.values()],
    getState: async (id) => rows.get(id) || null,
    mergeSettings: async (id, patch) => {
        const row = rows.get(id);
        if (!row) return null;
        row.settings = { ...(row.settings || {}), ...patch };
        return row;
    },
});

// ── configStore (CRL cursor + license-id history) ──────────────────────────
const config = new Map();
mock('../stores/configStore', {
    getConfig: async (k) => (config.has(k) ? config.get(k) : null),
    setConfig: async (k, v) => { config.set(k, v); return true; },
    getSecret: async () => null,
    setSecret: async () => true,
});

// ── license store (subjects.js reads the active server licence) ────────────
let activeLicense = null;
mock('../license/store', { getActiveLicenseForServer: async () => activeLicense });

// ── hubClient (scripted per test) ──────────────────────────────────────────
const hub = {
    connected: true,
    entitlements: null,        // array | Error to throw
    revocationPages: [],       // queued fetchRevocationList responses (or Error)
    revocationCalls: [],
};
mock('./hubClient', {
    isConnected: async () => hub.connected,
    getInstallId: async () => 'inst_1',
    fetchEntitlements: async () => {
        if (hub.entitlements instanceof Error) throw hub.entitlements;
        return { as_of: 'now', entitlements: hub.entitlements || [] };
    },
    fetchRevocationList: async (opts) => {
        hub.revocationCalls.push(opts);
        const next = hub.revocationPages.shift();
        if (next instanceof Error) throw next;
        return next || { as_of: 0, next_since: opts.since || 0, revoked: [] };
    },
});

// ── grant verifier (scripted verdict) ──────────────────────────────────────
let verifyResult = { valid: true, payload: {} };
let verifyCalls = [];
mock('./entitlements', {
    verifyModuleGrant: async (token, opts) => {
        verifyCalls.push({ token, opts });
        return typeof verifyResult === 'function' ? verifyResult(token, opts) : verifyResult;
    },
});

// ── runtime (records projection refreshes) ─────────────────────────────────
const runtimeCalls = { invalidate: 0, refresh: 0 };
mock('./index', {
    invalidateCache: () => { runtimeCalls.invalidate++; },
    refreshModuleActivations: async () => { runtimeCalls.refresh++; },
    isModuleActive: async () => true,
});

const refresh = require('./entitlementRefresh');
const remoteCatalog = require('./remoteCatalog');

function hubDenied() {
    const e = new Error('invalid_credentials');
    e.code = 'hub_denied';
    return e;
}

function remoteRow(moduleId, entitlement) {
    return {
        moduleId,
        status: 'imported',
        version: '1.0.0',
        settings: { remote: true, manifest: { id: moduleId }, entitlement },
    };
}

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
    rows.clear();
    config.clear();
    activeLicense = null;
    hub.connected = true;
    hub.entitlements = null;
    hub.revocationPages = [];
    hub.revocationCalls = [];
    verifyResult = { valid: true, payload: {} };
    verifyCalls = [];
    runtimeCalls.invalidate = 0;
    runtimeCalls.refresh = 0;
});

// ── P0.1: the confirmed bug — failed verify must not stay active on exp ────

test('failed re-verify stamps invalid+invalidSince; entitled only within the bounded grace', async () => {
    const in30d = Math.floor(Date.now() / 1000) + 30 * 86400;
    rows.set('m1', remoteRow('m1', { status: 'active', exp: in30d, entitlement_id: 'e1' }));
    hub.entitlements = [{ module_id: 'm1', grant_token: 'tok', entitlement_id: 'e1' }];
    verifyResult = { valid: false, error: 'subject_mismatch' };

    await refresh.tick();

    const ent = rows.get('m1').settings.entitlement;
    assert.strictEqual(ent.status, 'invalid');
    assert.ok(ent.invalidSince, 'invalidSince stamped');
    assert.strictEqual(ent.lastError, 'subject_mismatch');
    assert.strictEqual(ent.exp, in30d, 'exp kept for diagnostics');

    const row = rows.get('m1');
    const since = Date.parse(ent.invalidSince);
    // Within the invalid grace ⇒ still active (state 'grace'), past it ⇒ DOWN,
    // regardless of the future exp — this is the v1 revocation-bypass fix.
    assert.strictEqual(remoteCatalog.isEntitled(row, { now: since + DAY - 1000, graceInvalidMs: DAY }), true);
    assert.strictEqual(remoteCatalog.isEntitled(row, { now: since + DAY + 1000, graceInvalidMs: DAY }), false);
    assert.strictEqual(remoteCatalog.entitlementState(row, { now: since + DAY + 1000, graceInvalidMs: DAY }).state, 'invalid');
});

test('invalidSince is preserved across repeated failing ticks (grace cannot be reset)', async () => {
    const in30d = Math.floor(Date.now() / 1000) + 30 * 86400;
    rows.set('m1', remoteRow('m1', { status: 'active', exp: in30d }));
    hub.entitlements = [{ module_id: 'm1', grant_token: 'tok' }];
    verifyResult = { valid: false, error: 'invalid_signature' };

    await refresh.tick();
    const first = rows.get('m1').settings.entitlement.invalidSince;
    await new Promise(r => setTimeout(r, 10));
    await refresh.tick();
    assert.strictEqual(rows.get('m1').settings.entitlement.invalidSince, first);
});

test('successful re-verify clears invalid (fresh entitlement without invalidSince)', async () => {
    rows.set('m1', remoteRow('m1', {
        status: 'invalid', invalidSince: new Date().toISOString(), lastError: 'x', exp: 123,
    }));
    const exp = Math.floor(Date.now() / 1000) + 86400;
    hub.entitlements = [{ module_id: 'm1', grant_token: 'tok', kind: 'subscription', entitlement_id: 'e1' }];
    verifyResult = { valid: true, payload: { kind: 'subscription', exp, entitlement_id: 'e1' } };

    await refresh.tick();
    const ent = rows.get('m1').settings.entitlement;
    assert.strictEqual(ent.status, 'active');
    assert.strictEqual(ent.exp, exp);
    assert.strictEqual(ent.invalidSince, undefined);
    assert.strictEqual(ent.lastError, undefined);
});

test('absent grant in a successful fetch ⇒ revoked', async () => {
    rows.set('m1', remoteRow('m1', { status: 'active', exp: Math.floor(Date.now() / 1000) + 86400 }));
    hub.entitlements = []; // successful fetch, module missing
    await refresh.tick();
    assert.strictEqual(rows.get('m1').settings.entitlement.status, 'revoked');
    assert.strictEqual(remoteCatalog.isEntitled(rows.get('m1')), false);
});

test('hub outage is a NO-OP — rows untouched, error recorded', async () => {
    const ent0 = { status: 'active', exp: Math.floor(Date.now() / 1000) + 86400 };
    rows.set('m1', remoteRow('m1', { ...ent0 }));
    hub.entitlements = new Error('ECONNREFUSED');
    await refresh.tick();
    assert.deepStrictEqual(rows.get('m1').settings.entitlement, ent0);
    assert.ok(refresh.getHealth().lastTickError);
});

test('unknown persisted status is INACTIVE even with a future exp (fail closed)', () => {
    const row = remoteRow('m1', { status: 'weird_new_state', exp: Math.floor(Date.now() / 1000) + 86400 });
    const st = remoteCatalog.entitlementState(row);
    assert.strictEqual(st.active, false);
    assert.strictEqual(st.state, 'weird_new_state');
});

// ── P0.3: CRL poll ──────────────────────────────────────────────────────────

test('crlTick revokes by entitlement_id and advances the persisted cursor', async () => {
    rows.set('m1', remoteRow('m1', { status: 'active', entitlement_id: 'e1', exp: Math.floor(Date.now() / 1000) + 86400 }));
    rows.set('m2', remoteRow('m2', { status: 'active', entitlement_id: 'e2', exp: Math.floor(Date.now() / 1000) + 86400 }));
    hub.revocationPages = [{
        as_of: 1000, next_since: 900,
        revoked: [{ entitlement_id: 'e1', module_id: 'm1', revoked_at: 900, reason: 'chargeback' }],
    }];

    await refresh.crlTick();

    assert.strictEqual(rows.get('m1').settings.entitlement.status, 'revoked');
    assert.strictEqual(rows.get('m1').settings.entitlement.revokedReason, 'chargeback');
    assert.strictEqual(rows.get('m2').settings.entitlement.status, 'active', 'different entitlement id untouched');
    assert.strictEqual(config.get(refresh.CRL_CURSOR_KEY), 900);
    assert.ok(runtimeCalls.refresh >= 1, 'projection refreshed');
});

test('crlTick does NOT match a fresh entitlement id by module-id fallback', async () => {
    // Row HAS an entitlement_id (e_new) — an old revocation of the same module
    // under e_old must not kill it.
    rows.set('m1', remoteRow('m1', { status: 'active', entitlement_id: 'e_new', exp: Math.floor(Date.now() / 1000) + 86400 }));
    hub.revocationPages = [{
        as_of: 1000, next_since: 900,
        revoked: [{ entitlement_id: 'e_old', module_id: 'm1', revoked_at: 900, reason: 'refund' }],
    }];
    await refresh.crlTick();
    assert.strictEqual(rows.get('m1').settings.entitlement.status, 'active');
});

test('crlTick fail-open: unreachable CRL is a no-op and the cursor stays put', async () => {
    rows.set('m1', remoteRow('m1', { status: 'active', entitlement_id: 'e1' }));
    config.set(refresh.CRL_CURSOR_KEY, 500);
    hub.revocationPages = [new Error('boom')];
    await refresh.crlTick();
    assert.strictEqual(rows.get('m1').settings.entitlement.status, 'active');
    assert.strictEqual(config.get(refresh.CRL_CURSOR_KEY), 500);
    assert.ok(refresh.getHealth().lastCrlError);
});

test('crlTick pages until a short page, resuming from the stored cursor', async () => {
    rows.set('m1', remoteRow('m1', { status: 'active', entitlement_id: 'e1' }));
    config.set(refresh.CRL_CURSOR_KEY, 100);
    const fullPage = { as_of: 1, next_since: 200, revoked: Array.from({ length: 500 }, (_, i) => ({ entitlement_id: `x${i}` })) };
    const shortPage = { as_of: 1, next_since: 300, revoked: [{ entitlement_id: 'e1', module_id: 'm1', reason: 'crl' }] };
    hub.revocationPages = [fullPage, shortPage];

    await refresh.crlTick();

    assert.strictEqual(hub.revocationCalls[0].since, 100);
    assert.strictEqual(hub.revocationCalls[1].since, 200);
    assert.strictEqual(rows.get('m1').settings.entitlement.status, 'revoked');
    assert.strictEqual(config.get(refresh.CRL_CURSOR_KEY), 300);
});

// ── P0.3: install-kill on durable credential rejection ─────────────────────

test('3 consecutive hub_denied ticks revoke all remote rows; success resets the counter', async () => {
    rows.set('m1', remoteRow('m1', { status: 'active', exp: Math.floor(Date.now() / 1000) + 86400 }));
    hub.entitlements = hubDenied();
    await refresh.tick();
    await refresh.tick();
    assert.strictEqual(rows.get('m1').settings.entitlement.status, 'active', 'not yet — threshold is 3');
    await refresh.tick();
    assert.strictEqual(rows.get('m1').settings.entitlement.status, 'revoked');
    assert.strictEqual(rows.get('m1').settings.entitlement.revokedReason, 'install_revoked');
    assert.strictEqual(refresh.getHealth().installRevoked, true);

    // Hub comes back and re-grants ⇒ counter clears and the module recovers.
    const exp = Math.floor(Date.now() / 1000) + 86400;
    hub.entitlements = [{ module_id: 'm1', grant_token: 'tok', entitlement_id: 'e1' }];
    verifyResult = { valid: true, payload: { kind: 'subscription', exp, entitlement_id: 'e1' } };
    await refresh.tick();
    assert.strictEqual(rows.get('m1').settings.entitlement.status, 'active');
    assert.strictEqual(refresh.getHealth().installRevoked, false);
});

test('network failures never feed the install-kill counter', async () => {
    rows.set('m1', remoteRow('m1', { status: 'active', exp: Math.floor(Date.now() / 1000) + 86400 }));
    hub.entitlements = new Error('ETIMEDOUT'); // no .code === hub_denied
    for (let i = 0; i < 5; i++) await refresh.tick();
    assert.strictEqual(rows.get('m1').settings.entitlement.status, 'active');
    assert.strictEqual(refresh.getHealth().deniedCount, 0);
});

// ── P0.7: subject history rides into grant verification ────────────────────

test('grant verification receives install id + active licence + history ids', async () => {
    activeLicense = { id: 'lic_new', rawToken: 'x' };
    config.set('beeflow_license_id_history', ['lic_old1', 'lic_old2']);
    rows.set('m1', remoteRow('m1', { status: 'active' }));
    hub.entitlements = [{ module_id: 'm1', grant_token: 'tok' }];
    verifyResult = { valid: true, payload: { exp: Math.floor(Date.now() / 1000) + 86400 } };

    await refresh.tick();

    assert.deepStrictEqual(verifyCalls[0].opts.subjectIds, ['inst_1', 'lic_new', 'lic_old1', 'lic_old2']);
});

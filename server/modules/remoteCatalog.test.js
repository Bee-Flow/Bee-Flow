/**
 * remoteCatalog tests — the Hub-catalog × local-state join + the TIMESTAMP-ONLY
 * entitlement gate. catalog / hubClient / platformModuleStore are stubbed via
 * require.cache; no DB, no network.
 *
 * Run: node --test modules/remoteCatalog.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = new Module(p);
    require.cache[p].exports = exports;
    require.cache[p].loaded = true;
}

// Built-in catalog owns the slug 'security_scan' (collision drop target).
mock('./catalog', {
    listModules: () => [{ id: 'security_scan' }],
    getModule: (id) => (id === 'security_scan' ? { id: 'security_scan' } : null),
});

let hubModules = [];
let hubStale = false;
mock('./hubClient', {
    fetchCatalogCached: async () => ({ modules: hubModules, stale: hubStale }),
});

let stateRows = [];
mock('../stores/platformModuleStore', {
    getAllStates: async () => stateRows.map(r => ({ ...r })),
});

const remoteCatalog = require('./remoteCatalog');

const SECONDS = (deltaMs) => Math.floor((Date.now() + deltaMs) / 1000);

function remoteRow(overrides = {}) {
    return {
        moduleId: 'acme_crm',
        status: 'imported',
        version: '1.2.0',
        settings: {
            remote: true,
            manifest: {
                id: 'acme_crm', name: 'Acme CRM', version: '1.2.0',
                description: 'CRM', category: 'Sales', icon: 'users',
                capabilities: [{ id: 'acme_crm', kind: 'integration' }],
                frontend: { entry: 'index.js', urlSegment: 'acme' },
                requirements: { docker: false },
            },
            entitlement: { kind: 'subscription', status: 'active', exp: SECONDS(3600_000) },
            package: { version: '1.2.0', sha256: 'abc', kid: 'k1' },
            latestVersion: '1.2.0',
        },
        ...overrides,
    };
}

test('isRemoteRow distinguishes remote rows', () => {
    assert.strictEqual(remoteCatalog.isRemoteRow(remoteRow()), true);
    assert.strictEqual(remoteCatalog.isRemoteRow({ moduleId: 'x', settings: null }), false);
    assert.strictEqual(remoteCatalog.isRemoteRow({ moduleId: 'x', settings: { remote: false } }), false);
    assert.strictEqual(remoteCatalog.isRemoteRow(null), false);
});

test('entryFromRow reconstructs a catalog-shaped entry from the signed manifest', () => {
    const e = remoteCatalog.entryFromRow(remoteRow());
    assert.strictEqual(e.id, 'acme_crm');
    assert.strictEqual(e.name, 'Acme CRM');
    assert.strictEqual(e.version, '1.2.0');
    assert.strictEqual(e.remote, true);
    assert.strictEqual(e.defaultImported, false);
    assert.deepStrictEqual(e.capabilityIds, ['acme_crm']);
    assert.deepStrictEqual(e.storeModules, []); // remote modules never use the host store loop
    assert.strictEqual(e.frontend.urlSegment, 'acme');
    assert.strictEqual(e.requirements.docker, false);
    assert.strictEqual(remoteCatalog.entryFromRow({ settings: null }), null);
});

test('entitlementState is timestamp-only', () => {
    const now = Date.now();
    // active
    assert.strictEqual(remoteCatalog.entitlementState(remoteRow(), { now }).state, 'active');
    // expired (no grace)
    const expired = remoteRow();
    expired.settings.entitlement.exp = SECONDS(-3600_000);
    assert.deepStrictEqual(
        [remoteCatalog.entitlementState(expired, { now }).state, remoteCatalog.entitlementState(expired, { now }).active],
        ['expired', false]
    );
    // within grace ⇒ active
    const graced = remoteCatalog.entitlementState(expired, { now, graceMs: 2 * 3600_000 });
    assert.strictEqual(graced.state, 'grace');
    assert.strictEqual(graced.active, true);
    // revoked ⇒ inactive regardless of exp
    const revoked = remoteRow();
    revoked.settings.entitlement.status = 'revoked';
    assert.strictEqual(remoteCatalog.entitlementState(revoked, { now }).active, false);
    // no entitlement ⇒ none/inactive
    assert.strictEqual(remoteCatalog.entitlementState({ settings: { remote: true } }, { now }).state, 'none');
    // free/one_time (no exp) ⇒ active
    const free = remoteRow();
    free.settings.entitlement = { kind: 'free', status: 'active', exp: null };
    assert.strictEqual(remoteCatalog.isEntitled(free, { now }), true);
});

test('updateAvailable compares installed vs latest via semver', () => {
    const row = remoteRow();
    assert.strictEqual(remoteCatalog.updateAvailable(row, '1.2.0'), false);
    assert.strictEqual(remoteCatalog.updateAvailable(row, '1.3.0'), true);
    assert.strictEqual(remoteCatalog.updateAvailable(row, '1.1.0'), false);
    assert.strictEqual(remoteCatalog.updateAvailable(row, null), false); // no info
});

test('listMarketplace joins hub + local state and drops built-in collisions', async () => {
    hubStale = false;
    hubModules = [
        { module_id: 'acme_crm', name: 'Acme CRM', category: 'Sales', latest_version: '1.3.0', prices: [{ price_id: 'p1', kind: 'subscription' }] },
        { module_id: 'security_scan', name: 'Should be dropped', latest_version: '9.9.9' }, // collides with built-in
        { module_id: 'widget', name: 'Widget', latest_version: '2.0.0', prices: [] },
    ];
    stateRows = [remoteRow()]; // acme_crm installed @1.2.0, entitled

    const { modules: rows, stale } = await remoteCatalog.listMarketplace({ now: Date.now() });
    assert.strictEqual(stale, false);
    const ids = rows.map(r => r.id);
    assert.ok(!ids.includes('security_scan'), 'built-in collision dropped');
    assert.deepStrictEqual(ids.sort(), ['acme_crm', 'widget']);

    const acme = rows.find(r => r.id === 'acme_crm');
    assert.strictEqual(acme.installed, true);
    assert.strictEqual(acme.installedVersion, '1.2.0');
    assert.strictEqual(acme.entitled, true);
    assert.strictEqual(acme.updateAvailable, true); // 1.3.0 > 1.2.0

    const widget = rows.find(r => r.id === 'widget');
    assert.strictEqual(widget.installed, false);
    assert.strictEqual(widget.status, 'available');
});

test('listMarketplace passes through the stale flag', async () => {
    hubStale = true;
    hubModules = [{ module_id: 'widget', name: 'Widget', latest_version: '2.0.0' }];
    stateRows = [];
    const { stale } = await remoteCatalog.listMarketplace({});
    assert.strictEqual(stale, true);
});

// ── M4: server-side pricing derivation + policy-aware update resolution ─────

test('derivePricing: headline is the first active NON-TRIAL price', () => {
    assert.strictEqual(remoteCatalog.derivePricing([]), null);
    assert.strictEqual(remoteCatalog.derivePricing(null), null);
    // Trial-only module derives NO headline (trials are reserved for 3.2).
    assert.strictEqual(remoteCatalog.derivePricing([{ kind: 'trial', unit_amount: 0 }]), null);

    assert.deepStrictEqual(
        remoteCatalog.derivePricing([{ kind: 'free', unit_amount: 0, currency: 'eur' }]),
        { type: 'free', amount: 0, currency: 'eur', interval: null });
    assert.deepStrictEqual(
        remoteCatalog.derivePricing([{ kind: 'one_time', unit_amount: 4900, currency: 'eur' }]),
        { type: 'one_time', amount: 4900, currency: 'eur', interval: null });
    assert.deepStrictEqual(
        remoteCatalog.derivePricing([{ kind: 'subscription', unit_amount: 900, currency: 'eur', billing_interval: 'month' }]),
        { type: 'subscription', amount: 900, currency: 'eur', interval: 'month' });
    // Trial first in the list is skipped for the headline.
    assert.deepStrictEqual(
        remoteCatalog.derivePricing([
            { kind: 'trial', unit_amount: 0 },
            { kind: 'subscription', unit_amount: 1500, currency: 'usd', billing_interval: 'year' },
        ]),
        { type: 'subscription', amount: 1500, currency: 'usd', interval: 'year' });
});

test('resolveUpdateTarget honours channel, pin, and yank; falls back on v1 hubs', () => {
    const hm = {
        latest_version: '1.4.0',
        versions: [
            { version: '2.0.0', channel: 'beta' },
            { version: '1.5.0', channel: 'stable', yanked: true },
            { version: '1.4.0', channel: 'stable' },
            { version: '1.2.9', channel: 'stable' },
            { version: '1.2.0', channel: 'stable' },
        ],
    };
    // stable/none: highest non-yanked stable above installed.
    assert.strictEqual(remoteCatalog.resolveUpdateTarget(hm, '1.2.0', { channel: 'stable', pin: 'none' }), '1.4.0');
    // yanked 1.5.0 never wins.
    assert.strictEqual(remoteCatalog.resolveUpdateTarget(hm, '1.4.0', { channel: 'stable', pin: 'none' }), null);
    // beta channel sees 2.0.0 (and stable versions too).
    assert.strictEqual(remoteCatalog.resolveUpdateTarget(hm, '1.4.0', { channel: 'beta', pin: 'none' }), '2.0.0');
    // pin minor: only 1.2.x candidates.
    assert.strictEqual(remoteCatalog.resolveUpdateTarget(hm, '1.2.0', { channel: 'stable', pin: 'minor' }), '1.2.9');
    // pin major on beta: 2.0.0 crosses a major, excluded.
    assert.strictEqual(remoteCatalog.resolveUpdateTarget(hm, '1.4.0', { channel: 'beta', pin: 'major' }), null);
    // v1 hub (no versions/channels): flat latest_version fallback.
    assert.strictEqual(remoteCatalog.resolveUpdateTarget({ latest_version: '3.0.0' }, '1.0.0', null), '3.0.0');
    assert.strictEqual(remoteCatalog.resolveUpdateTarget({ latest_version: '1.0.0' }, '1.0.0', null), null);
    // Not installed: never an update.
    assert.strictEqual(remoteCatalog.resolveUpdateTarget(hm, null, null), null);
});

/**
 * Capability-registry remote-beta shadowing guard.
 *
 * A remote (Hub-downloaded) module may ship a 'beta'-kind capability whose
 * `licenseFeature` (or id) ALSO appears in tiers.js TIER_FEATURES — the canonical
 * case being the ported `security_scan` module, where id === licenseFeature ===
 * 'security_scan' and 'security_scan' still lives in TIER_FEATURES (enterprise).
 *
 * The BETA loop in build() SKIPS remote betas (they project via the dynamic
 * remote-module path and are id-deduped in listCapabilities()), so their
 * strings never reached the `claimedElsewhere` set. Without the fix the CORE
 * loop would then re-project that tier feature as a CORE row that shadows the
 * remote beta (the static core row is seen first in listCapabilities()'
 * id-dedupe), flipping the capability's kind from 'beta' to 'core'.
 *
 * build() adds remote-beta ids/licenseFeatures to `claimedElsewhere`, so the
 * CORE loop skips them and the remote beta wins. This is now LOAD-BEARING for
 * `security_scan`: it left core (no longer a built-in beta) but kept its
 * TIER_FEATURES entry, so without this fix the CORE loop would re-project the
 * tier feature as a core row that shadows the installed remote module's beta.
 *
 * We drive it with `sso_saml` — a pure CORE tier feature (tiers.js enterprise)
 * NOT owned by any built-in beta — so the test exercises the fix rather than
 * the no-op current state. The registry `build()` cache is warmed once per
 * process, so the remote descriptors are pushed BEFORE the first read.
 *
 * Run: node --test core/capabilityRegistry.remoteBeta.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-at-least-32-chars-long';

// ── Mock ../db before betaFeatures/stores/registry load ─────────────────────
const dbPath = require.resolve('../../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    pool: { query: async () => ({ rows: [] }) },
    getRedis: () => null,
};
require.cache[dbPath].loaded = true;

const registry = require('./capabilityRegistry');
const betaFeatures = require('./betaFeatures');

// A tier feature (tiers.js → enterprise) that is NOT owned by any built-in beta.
const TIER_FEATURE = 'sso_saml';
const REMOTE_MODULE_ID = 'remote_sso_module';

// Register a remote module's beta BEFORE any registry read warms build().
betaFeatures.setRemoteBetaFeatures([
    { id: TIER_FEATURE, name: 'Remote SSO', description: '', lifecycle: 'beta', licenseFeature: TIER_FEATURE },
]);
registry.setRemoteModuleCapabilityDescriptors([
    {
        id: TIER_FEATURE,
        kind: 'beta',
        name: 'Remote SSO',
        description: '',
        category: 'Modules',
        licenseFeature: TIER_FEATURE,
        lifecycle: 'beta',
        defaultState: 'off',
        userFacing: true,
        groupTogglable: true,
        moduleId: REMOTE_MODULE_ID,
        _remoteModule: true,
    },
]);

test('a remote beta whose licenseFeature is a tier feature is NOT shadowed by a core projection', () => {
    const cap = registry.getCapability(TIER_FEATURE);
    assert.ok(cap, `${TIER_FEATURE} must resolve`);
    // Without the fix this would be re-projected as a CORE capability.
    assert.strictEqual(cap.kind, 'beta', `${TIER_FEATURE} must resolve as the remote BETA, not a core projection`);
    assert.strictEqual(cap.moduleId, REMOTE_MODULE_ID);
});

test('listCapabilities() lists the remote beta exactly once, as a beta', () => {
    const listed = registry.listCapabilities().filter(c => c.id === TIER_FEATURE);
    assert.strictEqual(listed.length, 1, 'no duplicate/shadow row for the tier-feature id');
    assert.strictEqual(listed[0].kind, 'beta');
});

test('the fix is narrowly scoped: an unrelated tier feature still projects as core', () => {
    const control = registry.getCapability('audit_log_export');
    assert.ok(control, 'audit_log_export must exist');
    assert.strictEqual(control.kind, 'core');
});

/**
 * Regression tests for consumer-account Privacy Shield resolution.
 *
 * Covers two shipped bugs:
 *
 *   BFSF-289 — a personal account that never opened the Privacy Shield panel
 *              had no stored row, `resolveUserShield` returned null, and the
 *              account chatted completely unprotected. A missing row must now
 *              resolve to the secure defaults, while an explicitly stored
 *              `enabled:false` must still resolve to null.
 *
 *   BFSF-290 — the chat runtime resolved only the ORG shield, so a personal
 *              account's saved settings were never read. `resolveShieldFor`
 *              must fall back to the user shield when there is no org.
 *
 * configStore is stubbed via require.cache injection so no DB is needed.
 *
 * Run: cd server && node --test core/orgShield.userShield.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.NODE_ENV = 'test';

// ── Stub configStore (resolved from server/core/orgShield.js) ─────────
const cfgPath = require.resolve(path.join(__dirname, '..', '..', 'stores', 'configStore.js'));
const store = new Map();
require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true,
    exports: {
        getConfig: async (k) => (store.has(k) ? store.get(k) : null),
        getAllConfig: async () => Object.fromEntries(store),
        setConfig: async (k, v) => { store.set(k, v); },
    },
};

// Stub the license module so tier clamps resolve without a licence server.
const licPath = require.resolve(path.join(__dirname, '..', '..', 'license', 'index.js'));
require.cache[licPath] = {
    id: licPath, filename: licPath, loaded: true,
    exports: { resolveTier: async () => 'business', tiers: { tierHasFeature: () => true } },
};

// aiAgent is only reached through resolveOrgShield's regex-collection lookup.
const aiAgentPath = require.resolve(path.join(__dirname, '..', 'aiAgent.js'));
require.cache[aiAgentPath] = {
    id: aiAgentPath, filename: aiAgentPath, loaded: true,
    exports: { getAIConfig: async () => ({ regexGuardrails: { rules: [], collections: [] } }) },
};

delete require.cache[require.resolve('./orgShield')];
const { resolveUserShield, resolveShieldFor } = require('./orgShield');
const { USER_SHIELD_DEFAULTS } = require('./userShieldDefaults');

function reset() { store.clear(); }

test('BFSF-289: no stored row → secure defaults, not null', async () => {
    reset();
    const shield = await resolveUserShield('u-new');
    assert.ok(shield, 'a personal account with no saved shield must still be protected');
    assert.equal(shield.enabled, true);
    assert.equal(shield.piiDetectionAction, 'tokenize');
    assert.equal(shield.privacyScanEnabled, true);
    // Empty category list is deliberate: piiDetection.js widens it to ALL.
    assert.deepEqual(shield.piiDetectionCategories, []);
});

test('BFSF-289: stored enabled:false is respected (not overridden by defaults)', async () => {
    reset();
    store.set('user_privacy_shield_u-off', { ...USER_SHIELD_DEFAULTS, enabled: false });
    assert.equal(await resolveUserShield('u-off'), null,
        'a deliberate opt-out must not be resurrected by the secure default');
});

test('BFSF-289: implicit default can be suppressed for org members', async () => {
    reset();
    assert.equal(await resolveUserShield('u-orgmember', { allowImplicitDefault: false }), null);
});

test('BFSF-290: a stored user shield is resolved when there is no org', async () => {
    reset();
    store.set('user_privacy_shield_u1', {
        enabled: true,
        piiDetectionEnabled: true,
        piiDetectionCategories: ['Email', 'Person'],
        piiDetectionConfidenceThreshold: 0.76,
        piiDetectionAction: 'tokenize',
        showRawPayload: true,
    });
    const shield = await resolveShieldFor({ orgId: null, userId: 'u1' });
    assert.ok(shield, 'consumer accounts must resolve their own shield');
    assert.equal(shield.enabled, true);
    assert.equal(shield.piiDetectionAction, 'tokenize');
    assert.equal(shield.piiDetectionConfidenceThreshold, 0.76);
    assert.deepEqual(shield.piiDetectionCategories, ['Email', 'Person']);
    // BFSF-291 — the transparency panel is driven by this flag.
    assert.equal(shield.showRawPayload, true);
    // DLP / web-search guard stay org-only for consumer accounts.
    assert.equal(shield.dlpEnabled, false);
    assert.equal(shield.webSearchGuardEnabled, false);
});

test('org shield wins over the user shield', async () => {
    reset();
    store.set('org_privacy_shield_o1', { enabled: true, piiDetectionAction: 'block' });
    store.set('user_privacy_shield_u1', { enabled: true, piiDetectionAction: 'tokenize' });
    const shield = await resolveShieldFor({ orgId: 'o1', userId: 'u1' });
    assert.equal(shield.piiDetectionAction, 'block');
});

test('org member with the org shield off keeps their explicit user shield', async () => {
    reset();
    store.set('org_privacy_shield_o1', { enabled: false });
    store.set('user_privacy_shield_u1', { enabled: true, piiDetectionAction: 'tokenize' });
    const shield = await resolveShieldFor({ orgId: 'o1', userId: 'u1' });
    assert.ok(shield, 'an explicitly saved personal shield still applies');
    assert.equal(shield.piiDetectionAction, 'tokenize');
});

test('org member with the org shield off does NOT get an implicit personal shield', async () => {
    reset();
    store.set('org_privacy_shield_o1', { enabled: false });
    assert.equal(await resolveShieldFor({ orgId: 'o1', userId: 'u1' }), null,
        'turning the org shield off is the admin\'s call — no silent per-user shield');
});

test('no userId → null (nothing to resolve)', async () => {
    reset();
    assert.equal(await resolveUserShield(null), null);
    assert.equal(await resolveShieldFor({ orgId: null, userId: null }), null);
});

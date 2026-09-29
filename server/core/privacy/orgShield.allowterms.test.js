/**
 * resolveOrgShield must SURFACE the never-redact allowlist.
 *
 * This is the test that proves the settings UI is not writing into a void.
 *
 * `core/dlp/allowTerms.js` is consumed by piiDetection.js and dlpRunner.js, and
 * both are handed the object `resolveOrgShield` builds. That object is
 * assembled field by field, so a field that is stored on disk and simply not
 * listed there never reaches the runtime at all — no error, no log line, the
 * setting just does nothing. That is exactly what happened when the allowlist
 * shipped: the route persisted nothing and the resolver forwarded nothing,
 * while the shipped public-organisation list happened to work because an
 * absent flag reads as ON.
 *
 * A field-by-field builder cannot be covered by "it round-trips through the
 * API"; it needs an assertion at this seam.
 *
 * Run: node server/core/orgShield.allowterms.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

const storeBlobs = {};
const configStoreStub = {
    async getConfig(key) { return storeBlobs[key] !== undefined ? storeBlobs[key] : null; },
    async setConfig(key, value) { storeBlobs[key] = value; return true; },
};

const CORE_DIR = path.sep + path.join('core');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(CORE_DIR + path.sep)) {
        if (request === '../../stores/configStore') return path.join(__dirname, '__stub_cfg_ost__.js');
        if (request === '../aiAgent') return path.join(__dirname, '__stub_ai_ost__.js');
        if (request === '../../license') return path.join(__dirname, '__stub_lic_ost__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
const stubExports = {
    '__stub_cfg_ost__.js': configStoreStub,
    '__stub_ai_ost__.js': { async getAIConfig() { return {}; } },
    // Enterprise so tier clamps never interfere — they have their own test.
    '__stub_lic_ost__.js': {
        tiers: require('../../license/tiers'),
        async resolveTier() { return 'enterprise'; },
    },
};
for (const [fname, exp] of Object.entries(stubExports)) {
    const full = path.join(__dirname, fname);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exp };
}

const { resolveOrgShield } = require('./orgShield');
const { buildAllowMatcher } = require('../dlp/allowTerms');

const ORG = 'org_allow';
const KEY = `org_privacy_shield_${ORG}`;

(async () => {
    // ── 1. Stored terms reach the resolved config ───────────────────────
    storeBlobs[KEY] = {
        enabled: true,
        piiDetectionCategories: ['Person'],
        piiAllowTerms: ['Dekker Techniek', 'Bee Flow'],
        piiAllowPublicOrgs: true,
    };
    const resolved = await resolveOrgShield(ORG);
    assert.ok(resolved, 'an enabled shield must resolve');
    assert.deepStrictEqual(resolved.piiAllowTerms, ['Dekker Techniek', 'Bee Flow'],
        'resolveOrgShield must forward piiAllowTerms — without this the UI writes into a void');
    assert.strictEqual(resolved.piiAllowPublicOrgs, true);

    // ── 2. …and the matcher built from it actually honours them ─────────
    // The seam this test exists for: the whole chain, not just the field.
    const matcher = buildAllowMatcher(resolved);
    assert.strictEqual(matcher.isAllowed('Dekker Techniek', 'Organization'), true,
        "the org's own term must be allowlisted end to end");
    assert.strictEqual(matcher.isAllowed('Microsoft', 'Organization'), true,
        'the shipped public-organisation list is on by default');
    assert.strictEqual(matcher.isAllowed('Dekker Workforce', 'Organization'), false,
        'a different company must still be redacted');

    // ── 3. An absent flag means ON, never off ───────────────────────────
    storeBlobs[KEY] = { enabled: true, piiDetectionCategories: ['Person'] };
    const legacy = await resolveOrgShield(ORG);
    assert.strictEqual(legacy.piiAllowPublicOrgs, true,
        'a row predating the field must not silently disable the public list');
    assert.deepStrictEqual(legacy.piiAllowTerms, []);
    assert.strictEqual(buildAllowMatcher(legacy).isAllowed('PostNL', 'Organization'), true);

    // ── 4. An explicit false switches the shipped list off ──────────────
    storeBlobs[KEY] = {
        enabled: true, piiDetectionCategories: ['Person'],
        piiAllowPublicOrgs: false, piiAllowTerms: ['Eigen BV'],
    };
    const off = await resolveOrgShield(ORG);
    assert.strictEqual(off.piiAllowPublicOrgs, false);
    const offMatcher = buildAllowMatcher(off);
    assert.strictEqual(offMatcher.isAllowed('Microsoft', 'Organization'), false,
        'switching the public list off must actually stop matching it');
    assert.strictEqual(offMatcher.isAllowed('Eigen BV', 'Organization'), true,
        "the org's own terms survive the public list being off");

    console.log('✓ core/orgShield.allowterms.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ core/orgShield.allowterms.test.js failed:', err);
    process.exit(1);
});

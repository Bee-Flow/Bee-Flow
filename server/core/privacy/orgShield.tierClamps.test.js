/**
 * Unit test for the runtime tier-clamp policy in orgShield.applyTierClampsToShield
 * and resolveOrgShield.
 *
 * Policy: the licence is checked on the server at use time. A saved
 * `piiDetectionAction:'tokenize'` is honoured only when the TARGET org has
 * `pii_tokenize` (its tier, or an explicit plan grant); otherwise it is
 * treated as 'block' without touching the stored row and without throwing.
 * A failing licence lookup fails closed. The Web Search Guard clamp is
 * unchanged.
 *
 * The licence module is injected through orgShield._deps so no DB is needed.
 *
 * Run: node server/core/privacy/orgShield.tierClamps.test.js
 */

const assert = require('assert');

process.env.NODE_ENV = 'test';

const orgShield = require('./orgShield');
const { applyTierClampsToShield, resolveOrgShield, _deps } = orgShield;

const realDeps = { ..._deps };

/** A licence stand-in: `tokenize` / `wsg` say which features the org has. */
function licence({ tokenize = false, wsg = false, throwOn = null } = {}) {
    return {
        resolveTier: async () => {
            if (throwOn === 'tier') throw new Error('resolver down');
            return tokenize ? 'enterprise' : 'community';
        },
        hasFeature: async (_scope, feature) => {
            if (throwOn === 'feature') throw new Error('resolver down');
            if (feature === 'pii_tokenize') return tokenize;
            if (feature === 'web_search_guard') return wsg;
            return false;
        },
        tiers: { tierHasFeature: (_tier, feature) => feature === 'web_search_guard' ? wsg : false },
    };
}

function communityShield() {
    return {
        piiDetectionAction: 'tokenize',
        webSearchGuardEnabled: true,
        webSearchGuardPiiCategories: ['Email'],
        toolPiiPolicy: { external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } },
    };
}

(async () => {
    try {
        // Community, no grant: tokenize is ignored (block), WSG still clamped.
        _deps.license = () => licence();
        const shield = communityShield();
        await applyTierClampsToShield(shield, { organizationId: 'o1', userId: 'u1' });
        assert.strictEqual(shield.piiDetectionAction, 'block', 'tokenize needs pii_tokenize on the org');
        assert.strictEqual(shield.webSearchGuardEnabled, false);
        assert.deepStrictEqual(shield.webSearchGuardPiiCategories, []);
        assert.deepStrictEqual(shield.toolPiiPolicy.external.blockCategories, []);

        // An explicit plan grant (hasFeature true) keeps tokenize on a low tier.
        _deps.license = () => licence({ tokenize: true });
        const granted = communityShield();
        await applyTierClampsToShield(granted, { organizationId: 'o1' });
        assert.strictEqual(granted.piiDetectionAction, 'tokenize', 'a grant keeps tokenize');

        // The licence lookup fails: closed, and no throw.
        _deps.license = () => licence({ tokenize: true, throwOn: 'feature' });
        const broken = communityShield();
        await applyTierClampsToShield(broken, { organizationId: 'o1' });
        assert.strictEqual(broken.piiDetectionAction, 'block', 'fail closed when the licence cannot be read');

        // Only the tokenize action is touched: block and warn stay as saved.
        _deps.license = () => licence();
        for (const action of ['block', 'warn']) {
            const s = { piiDetectionAction: action };
            await applyTierClampsToShield(s, { organizationId: 'o1' });
            assert.strictEqual(s.piiDetectionAction, action);
        }

        // resolveOrgShield: the stored row is read-only (shared cache object),
        // the resolved shield and its legacy-derived privacy action follow the clamp.
        const stored = { enabled: true, piiDetectionAction: 'tokenize', piiDetectionCategories: ['Email'] };
        _deps.configStore = { getConfig: async () => stored };
        _deps.getAIConfig = async () => ({});
        _deps.license = () => licence();
        const low = await resolveOrgShield('o1');
        assert.strictEqual(low.piiDetectionAction, 'block');
        assert.strictEqual(low.privacyAction, 'block', 'legacy-derived privacy action follows the clamp');
        assert.strictEqual(stored.piiDetectionAction, 'tokenize', 'stored row must not be mutated');

        _deps.license = () => licence({ tokenize: true });
        const high = await resolveOrgShield('o1');
        assert.strictEqual(high.piiDetectionAction, 'tokenize', 'after an upgrade the saved choice applies again');
        assert.strictEqual(high.privacyAction, 'redact');

        // A global default of tokenize (no value on the org row) is gated too.
        const bare = { enabled: true };
        _deps.configStore = { getConfig: async () => bare };
        _deps.getAIConfig = async () => ({ piiDetectionAction: 'tokenize' });
        _deps.license = () => licence();
        const viaGlobal = await resolveOrgShield('o1');
        assert.strictEqual(viaGlobal.piiDetectionAction, 'block');

        console.log('ok core/privacy/orgShield.tierClamps');
    } finally {
        Object.assign(_deps, realDeps);
    }
})().catch(err => { console.error('FAIL core/privacy/orgShield.tierClamps:', err); process.exit(1); });

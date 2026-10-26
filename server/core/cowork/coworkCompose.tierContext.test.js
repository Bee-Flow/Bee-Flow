// @typecheck
/**
 * The composer writes the instruction FROM THE WORDS OF THE USER, so it too resolves its model
 * under the org of that user (EU overrides and org tiers included), not under the global map.
 * The route supplies {userId, userOrgId}; this proves that compose really passes them on,
 * and that a failed resolution still ends neatly in the fallback spec.
 *
 * Run: node --test --test-force-exit core/cowork/coworkCompose.tierContext.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

/** @type {{ raw: unknown, opts?: { userOrgId?: string, userId?: string } } | null} */
let captured = null;

const restore = installResolveStub({
    '../llm/modelResolver': {
        resolveModelForTier: async (/** @type {unknown} */ raw, /** @type {{ userOrgId?: string, userId?: string } | undefined} */ opts) => { captured = { raw, opts }; return null; },
        TIER_DEFAULTS: { fast: {} },
    },
    '../aiAgent': { getProviderForModel: async () => ({}) },
    '../providers/index': { getAdapter: () => null },
});

const { composeCowork } = require('./coworkCompose');

test('compose geeft de identiteit door aan de tier-resolutie', async () => {
    const spec = await composeCowork({
        brief: 'Wens me elke ochtend een goede morgen.',
        userId: 'u1',
        userOrgId: 'org-eu',
    });
    assert.ok(captured, 'resolveModelForTier hoort aangeroepen te zijn');
    assert.strictEqual(captured.raw, 'tier:fast');
    assert.strictEqual(captured.opts?.userOrgId, 'org-eu');
    assert.strictEqual(captured.opts?.userId, 'u1');
    // Resolutie leverde null → compose valt terug, hij faalt niet.
    assert.ok(spec && typeof spec.title === 'string' && spec.title.length > 0);
});

test.after(() => restore());

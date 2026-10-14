/**
 * Notebook chat: the tier a turn runs on is measured against the person's
 * groups (core/llm/resolveTurnModel.js).
 *
 * A member whose group may only use `fast` POSTed `modelTier: "pro"` and the
 * route indexed its tier map with it: the turn ran on Deep Thinking. Pinned:
 *
 *   - no tier, `fast` and `standard` run on the fast model, as before;
 *   - a tier the groups leave out is a JSON 403 `tier_not_permitted` before
 *     the stream opens, and no model is resolved;
 *   - a tier the groups allow runs on that tier's model.
 *
 * Scaffolding: notebookChat.testkit.js. Synthetic data.
 *
 * Run: cd server && node --test routes/ai/notebookChat.tiers.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { makeSwaps } = require('../../testUtils/swaps');
const {
    SIGNED_IN, gateFixture, resetFixture, serveRouter, postJson,
} = require('../../testUtils/toolPiiGateHarness');
const { notebookChatStubs } = require('./notebookChat.testkit');

const fx = gateFixture({ models: [], groups: [] });

const restore = installResolveStub(notebookChatStubs(fx, {
    '../../core/aiAgent': {
        getProviderForModel: async (modelId) => { fx.models.push(modelId); return { providerType: 'test', url: 'http://model.invalid', apiKey: 'k' }; },
    },
    '../../core/providers': { getAdapter: () => ({ stream: async (_k, _u, _m, _msgs, _o, cb) => { cb('text', { text: 'ok' }); } }) },
    '../../core/llm/modelResolver': {
        getEUAwareTiers: async () => ({ fast: { modelId: 'model-fast' }, pro: { modelId: 'model-pro' } }),
    },
}));

// The person's groups, read by the real rule (core/entitlements/userTiers).
const userStore = require('../../stores/userStore');
const { swap, restore: unswap } = makeSwaps();
swap(userStore, 'getUser', async (id) => ({ id, groups: fx.groups.map(g => g.id) }));
swap(userStore, 'getAllGroups', async () => fx.groups);
test.after(unswap);

const baseUrl = serveRouter(test, require('./notebookChat'), { prefix: '/ai', session: SIGNED_IN, restore });

async function turn({ modelTier, allowedTiers }) {
    resetFixture(fx, { groups: allowedTiers ? [{ id: 'g1', allowedTiers }] : [] });
    const body = { message: 'summarise', notebookId: 'nb-1' };
    if (modelTier !== undefined) body.modelTier = modelTier;
    return postJson(`${baseUrl()}/chat/notebook/stream`, body);
}

test('no tier, fast and standard run on the fast model, whatever the groups say', async () => {
    for (const modelTier of [undefined, 'fast', 'standard']) {
        const res = await turn({ modelTier, allowedTiers: ['pro'] });
        assert.strictEqual(res.status, 200, res.body);
        assert.deepStrictEqual(fx.models, ['model-fast'], String(modelTier));
    }
});

test('a fast-only member naming pro is refused before any model is resolved', async () => {
    const res = await turn({ modelTier: 'pro', allowedTiers: ['fast'] });
    assert.strictEqual(res.status, 403, res.body);
    assert.deepStrictEqual(JSON.parse(res.body), { error: 'Tier "pro" is not available on your account.', code: 'tier_not_permitted' });
    assert.deepStrictEqual(fx.models, []);
});

test('a tier the groups allow runs on its model', async () => {
    const res = await turn({ modelTier: 'pro', allowedTiers: ['fast', 'pro'] });
    assert.strictEqual(res.status, 200, res.body);
    assert.deepStrictEqual(fx.models, ['model-pro']);
    const open = await turn({ modelTier: 'pro' });
    assert.strictEqual(open.status, 200, open.body);
    assert.deepStrictEqual(fx.models, ['model-pro']);
});

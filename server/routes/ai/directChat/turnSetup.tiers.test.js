// @typecheck
/**
 * Direct chat: the tier a turn runs on is measured against the person's
 * groups (./turnSetup.js → core/llm/resolveTurnModel.js), and so is the
 * Swarm tier (./swarmTurn.js).
 *
 * A member whose group may only use `fast` POSTed `modelTier: "pro"` and the
 * turn ran on Deep Thinking; only Flow (`standard`) had a server-side gate,
 * and that one checks the betas, not the groups. Pinned:
 *
 *   - no tier runs on the fast model, as before;
 *   - Flow without its betas still runs as fast (not refused);
 *   - a tier the groups leave out is a JSON 403 `tier_not_permitted` before
 *     any model is resolved; Flow with its betas but outside the groups too;
 *   - `auto` only classifies over the tiers the groups allow (plus fast);
 *   - Swarm with its beta but outside the groups is refused the same way.
 *
 * Run: cd server && node --test routes/ai/directChat/turnSetup.tiers.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');
const { makeSwaps } = require('../../../testUtils/swaps');

const fx = { models: [], groups: [], betas: false, classifierPools: [] };

const TIERS = {
    fast: { modelId: 'model-fast' },
    thinking: { modelId: 'model-thinking' },
    pro: { modelId: 'model-pro' },
    standard: { modelId: 'model-flow' },
    swarm: { modelId: 'model-swarm' },
};

const restoreStubs = installResolveStub({
    '../../../core/aiAgent': {
        getAIConfig: async () => ({ model: 'model-default' }),
        getProviderForModel: async (modelId) => { fx.models.push(modelId); return { providerType: 'test', url: '', apiKey: 'k' }; },
    },
    '../../../stores/configStore': { getConfig: async () => null },
    '../../../core/providers': { getAdapter: () => ({ name: 'test' }) },
    '../../../stores/agentStore': { getConversationOwnerId: async () => null },
    '../../../core/entitlements/limits': { checkSubscriptionLimits: async () => null, resolveOrgId: async () => 'org-1' },
    '../../../services/orgHealth': { problem: () => {} },
    '../../../auth': { resolveUserOrgIds: async () => new Set(['org-1']) },
    '../../../core/llm/modelResolver': {
        getUserTierMap: async () => ({ ...TIERS }),
        resolveEffectiveOrgId: async () => 'org-1',
        resolveModelForTier: async () => 'model-swarm',
    },
    '../../../core/entitlements/betaFeatures': { userHasBetaFeature: async () => fx.betas },
});
after(restoreStubs);

// The person's groups, read by the real rule (core/entitlements/userTiers).
const userStore = require('../../../stores/userStore');
const promptClassifier = require('../../../core/llm/promptClassifier');
const { swap, restore } = makeSwaps();
swap(userStore, 'getUser', async (id) => ({ id, groups: fx.groups.map(g => g.id) }));
swap(userStore, 'getAllGroups', async () => fx.groups);
swap(promptClassifier, 'classifyWithLLM', async (_m, pool) => {
    fx.classifierPools.push(Object.keys(pool).sort());
    return { tier: 'thinking', method: 'classifier', reason: 'test' };
});
after(restore);

const { resolveTurnSetup } = require('./turnSetup');
const { runSwarmTierTurn } = require('./swarmTurn');

function fakeRes() {
    return {
        statusCode: 200, headersSent: false, body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; this.headersSent = true; return this; },
        writeHead(c) { this.statusCode = c; this.headersSent = true; },
        write() {},
        end() {},
    };
}

beforeEach(() => {
    fx.models = [];
    fx.groups = [];
    fx.betas = false;
    fx.classifierPools = [];
});

const allow = (...allowedTiers) => { fx.groups = [{ id: 'g1', allowedTiers }]; };

async function turn(modelTier) {
    const res = fakeRes();
    const req = { session: { user: { id: 'u1', organizationId: 'org-1' } }, body: {} };
    const setup = await resolveTurnSetup({ req, res, userId: 'u1', message: 'hello', modelTier, conversationId: null, attachments: [] });
    return { res, setup };
}

test('no tier runs on the fast model without asking the groups', async () => {
    allow('pro');
    const { res, setup } = await turn(undefined);
    assert.equal(res.headersSent, false);
    assert.equal(setup.resolvedTier, 'fast');
    assert.deepEqual(fx.models, ['model-fast']);
});

test('Flow without its betas still runs as fast, not refused', async () => {
    allow('fast');
    const { res, setup } = await turn('standard');
    assert.equal(res.headersSent, false);
    assert.equal(setup.resolvedTier, 'fast');
});

test('a fast-only member naming pro is refused before any model is resolved (the leak)', async () => {
    allow('fast');
    const { res } = await turn('pro');
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'Tier "pro" is not available on your account.', code: 'tier_not_permitted' });
    assert.deepEqual(fx.models, []);
});

test('Flow with its betas is measured against the groups too', async () => {
    fx.betas = true;
    allow('fast');
    assert.equal((await turn('standard')).res.statusCode, 403);
    allow('fast', 'standard');
    const { res, setup } = await turn('standard');
    assert.equal(res.headersSent, false);
    assert.equal(setup.modelId, 'model-flow');
});

test('a tier the groups allow, or a person in no group, runs on its model', async () => {
    allow('fast', 'pro');
    assert.equal((await turn('pro')).setup.modelId, 'model-pro');
    fx.groups = [];
    assert.equal((await turn('pro')).setup.modelId, 'model-pro');
});

test('auto classifies only over the tiers the groups allow, plus fast', async () => {
    allow('auto', 'thinking');
    const { setup } = await turn('auto');
    assert.equal(setup.resolvedTier, 'thinking');
    assert.deepEqual(fx.classifierPools, [['fast', 'thinking']]);
    fx.groups = [];
    await turn('auto');
    assert.deepEqual(fx.classifierPools[1], ['fast', 'pro', 'standard', 'thinking'], 'unrestricted: the pool as before (no swarm, no custom)');
});

test('Swarm with its beta but outside the groups is refused', async () => {
    fx.betas = true;
    allow('fast');
    const res = fakeRes();
    await runSwarmTierTurn({ req: { session: { user: { id: 'u1' } }, body: {} }, res, userId: 'u1', message: 'x', conversationId: null, attachments: [] });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'tier_not_permitted');
});

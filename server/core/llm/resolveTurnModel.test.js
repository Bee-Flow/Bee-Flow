'use strict';

/**
 * Which tier a chat turn runs on (core/llm/resolveTurnModel.js), for direct,
 * notebook, webpage and template chat.
 *
 * What this file pins:
 *
 *   - a turn that names no tier runs on `fast`, without asking the groups or
 *     the classifier — the path every chat had before, unchanged; so does one
 *     that names `fast`, and (where the surface reads it so) `standard`;
 *   - a turn that names a tier its groups leave out is refused with
 *     tierAccess's 403 `tier_not_permitted` (the leak: a fast-only member
 *     POSTing `modelTier: "pro"` ran on Deep Thinking);
 *   - the group editor's names count: `deep_thinking` is `pro`, `smart` is
 *     `thinking`; a person in no group, or in a group that lists nothing,
 *     keeps every tier;
 *   - `auto` is never refused; the classifier chooses only from the tiers the
 *     groups allow plus `fast`, and for an unrestricted person from the same
 *     pool as before; a classifier failure lands on `fast`;
 *   - a surface without the classifier (template chat) leaves `auto` alone.
 *
 * Run: cd server && node --test core/llm/resolveTurnModel.test.js
 */

process.env.NODE_ENV = 'test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../testUtils/swaps');

const userStore = require('../../stores/userStore');
const { tierRefusal } = require('../entitlements/tierAccess');
const { resolveTurnTier, turnTierRefusal } = require('./resolveTurnModel');

const TIERS = {
    fast: { modelId: 'small' },
    thinking: { modelId: 'mid' },
    writer: { modelId: 'writer' },
    pro: { modelId: 'big' },
    standard: { modelId: 'flow' },
    swarm: { modelId: 'swarm' },
    'custom:legal': { modelId: 'legal', custom: true },
};

// The person's groups, read through the real userTiers rule.
const fx = { user: { id: 'u1', groups: [] }, groups: [], userReads: 0 };
const { swap, restore } = makeSwaps();
swap(userStore, 'getUser', async () => { fx.userReads++; return fx.user; });
swap(userStore, 'getAllGroups', async () => fx.groups);
after(restore);

function inGroups(...allowedLists) {
    fx.groups = allowedLists.map((allowedTiers, i) => ({ id: `g${i}`, allowedTiers }));
    fx.user = { id: 'u1', groups: fx.groups.map(g => g.id) };
}

beforeEach(() => {
    fx.user = { id: 'u1', groups: [] };
    fx.groups = [];
    fx.userReads = 0;
});

function classifierSpy(answer = { tier: 'fast', method: 'shortcut', reason: 'test' }) {
    const calls = [];
    const fn = async (message, pool) => {
        calls.push({ message, pool: Object.keys(pool).sort() });
        if (answer instanceof Error) throw answer;
        return answer;
    };
    return { calls, fn };
}

const turn = (over = {}) => resolveTurnTier({
    modelTier: undefined, message: 'hello', tiers: TIERS, userId: 'u1', userOrgId: 'org-1', surface: 'Test', ...over,
});

test('no tier runs on fast, asking neither the groups nor the classifier (the path as it was)', async () => {
    inGroups(['pro']);
    const classify = classifierSpy();
    for (const modelTier of [undefined, null, '']) {
        assert.deepEqual(await turn({ modelTier, deps: { classifyWithLLM: classify.fn } }), { tier: 'fast' });
    }
    assert.equal(fx.userReads, 0, 'no group lookup');
    assert.equal(classify.calls.length, 0, 'no classification');
});

test('`fast` is the default and never refused; `standard` reads as fast where the surface says so', async () => {
    inGroups(['pro']);
    assert.deepEqual(await turn({ modelTier: 'fast' }), { tier: 'fast' });
    assert.deepEqual(await turn({ modelTier: 'standard', standardIsFast: true }), { tier: 'fast' });
    assert.equal(fx.userReads, 0);
});

test('a fast-only member naming `pro` is refused with the builders\' 403 (the leak)', async () => {
    inGroups(['fast']);
    const out = await turn({ modelTier: 'pro' });
    assert.deepEqual(out, { refusal: tierRefusal('pro') });
    assert.equal(out.refusal.status, 403);
    assert.equal(out.refusal.code, 'tier_not_permitted');
});

test('the group editor\'s names count: deep_thinking is pro, smart is thinking', async () => {
    inGroups(['fast', 'thinking']);
    assert.deepEqual(await turn({ modelTier: 'smart' }), { tier: 'smart' });
    assert.ok((await turn({ modelTier: 'deep_thinking' })).refusal);
    inGroups(['pro']);
    assert.deepEqual(await turn({ modelTier: 'deep_thinking' }), { tier: 'deep_thinking' });
});

test('one group that allows the tier is enough; a group listing nothing allows everything', async () => {
    inGroups(['fast'], ['writer']);
    assert.deepEqual(await turn({ modelTier: 'writer' }), { tier: 'writer' });
    assert.ok((await turn({ modelTier: 'pro' })).refusal);
    inGroups(['fast'], []);
    assert.deepEqual(await turn({ modelTier: 'pro' }), { tier: 'pro' });
});

test('a person in no group keeps every tier', async () => {
    for (const modelTier of ['pro', 'thinking', 'writer', 'standard', 'custom:legal']) {
        assert.deepEqual(await turn({ modelTier }), { tier: modelTier });
    }
});

test('custom tiers and swarm are measured by the same rule', async () => {
    inGroups(['fast', 'custom:legal']);
    assert.deepEqual(await turn({ modelTier: 'custom:legal' }), { tier: 'custom:legal' });
    assert.ok((await turn({ modelTier: 'custom:other' })).refusal);
    assert.deepEqual(await turnTierRefusal({ tier: 'swarm', userId: 'u1' }), tierRefusal('swarm'));
    inGroups(['swarm']);
    assert.equal(await turnTierRefusal({ tier: 'swarm', userId: 'u1' }), null);
});

test('without a person every named tier is refused', async () => {
    assert.deepEqual(await turnTierRefusal({ tier: 'pro', userId: null }), tierRefusal('pro'));
    assert.equal(await turnTierRefusal({ tier: 'fast', userId: null }), null);
});

test('`auto` is not refused, and chooses only from what the groups allow (plus fast)', async () => {
    inGroups(['auto', 'thinking']);
    const classify = classifierSpy({ tier: 'thinking', method: 'classifier', reason: 'x' });
    const out = await turn({ modelTier: 'auto', deps: { classifyWithLLM: classify.fn } });
    assert.deepEqual(out, { tier: 'thinking' });
    assert.deepEqual(classify.calls[0].pool, ['fast', 'thinking']);
});

test('`auto` for an unrestricted person classifies over the same pool as before', async () => {
    const classify = classifierSpy({ tier: 'pro', method: 'classifier', reason: 'x' });
    const eligible = (k) => !k.startsWith('custom:') && k !== 'swarm';
    assert.deepEqual(await turn({ modelTier: 'auto', autoEligible: eligible, deps: { classifyWithLLM: classify.fn } }), { tier: 'pro' });
    assert.deepEqual(classify.calls[0].pool, Object.keys(TIERS).filter(eligible).sort());
    // Without a filter (notebook, webpage) the whole map, as before.
    await turn({ modelTier: 'auto', deps: { classifyWithLLM: classify.fn } });
    assert.deepEqual(classify.calls[1].pool, Object.keys(TIERS).sort());
});

test('`auto`: a classifier failure lands on fast; `standard` from it reads as fast where the surface says so', async () => {
    assert.deepEqual(await turn({ modelTier: 'auto', deps: { classifyWithLLM: classifierSpy(new Error('down')).fn } }), { tier: 'fast' });
    const flow = classifierSpy({ tier: 'standard', method: 'classifier', reason: 'x' });
    assert.deepEqual(await turn({ modelTier: 'auto', standardIsFast: true, deps: { classifyWithLLM: flow.fn } }), { tier: 'fast' });
    assert.deepEqual(await turn({ modelTier: 'auto', deps: { classifyWithLLM: flow.fn } }), { tier: 'standard' });
});

test('a surface without the classifier (template chat) leaves `auto` as it is', async () => {
    inGroups(['fast']);
    const classify = classifierSpy();
    assert.deepEqual(await turn({ modelTier: 'auto', tiers: null, classifyAuto: false, deps: { classifyWithLLM: classify.fn } }), { tier: 'auto' });
    assert.equal(classify.calls.length, 0);
});

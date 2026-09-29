/**
 * Which tiers a routine-builder turn may run on
 * (routes/ai/automationBuilder/chatStream.js), measured against the list the
 * builder's own dropdown offers.
 *
 * The route resolved `modelTier` against the tier MAP only. An explicit tier
 * the person's groups do not allow ran; `auto` classified over every
 * configured tier and took the classifier's `fast` fallback even when fast was
 * not theirs; the capability floor bumped a small pick onto any tier; the
 * builder AI was told it could put any configured tier on an ai_step; and the
 * flowlet sub-agents ran on the thinking tier whoever asked. What this file
 * pins:
 *
 *   - an explicit tier outside the list ends the turn with the refusal the
 *     playbook routes give (in this stream's own `error` event), before a
 *     draft is loaded or a model is asked;
 *   - `auto` with none of the configured tiers theirs is the same refusal;
 *   - `auto` classifies over the person's own tiers, lands inside them when
 *     the classifier answers outside them, and is floored only within them;
 *   - the ai_step tiers the builder AI may pick are the person's own;
 *   - a flowlet sub-agent runs on thinking only when thinking is theirs;
 *   - the list is asked for automation, with the caller's session.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/chatStream.tiers.test.js
 */

'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.join(__dirname, '..', '..', '..');
function stub(rel, exports) {
    const file = require.resolve(path.join(SERVER, rel));
    const m = new Module(file);
    m.exports = exports;
    m.loaded = true;
    require.cache[file] = m;
}

// The list the dropdown is built from, and the classifier `auto` asks.
let permitted = new Set();
const asked = [];
stub('core/entitlements/userTiers', {
    async getPermittedTierKeys(args) { asked.push(args); return permitted; },
});
let classifierPick = 'fast';
const classified = [];
stub('core/llm/promptClassifier', {
    async classifyWithLLM(_message, tiers) {
        classified.push(Object.keys(tiers).sort());
        return { tier: classifierPick, method: 'test', reason: 'scripted' };
    },
});

const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');

const h = createBuilderStream();
after(() => h.restore());

const TIERS = {
    fast: { modelId: 'claude-haiku-4-5' },
    thinking: { modelId: 'claude-sonnet-4-6' },
    pro: { modelId: 'claude-opus-4-8' },
    standard: { modelId: 'claude-sonnet-5' },
    'custom:legal': { modelId: 'legal-model', custom: true },
};

beforeEach(() => {
    permitted = new Set(['auto', 'fast', 'thinking']);
    asked.length = 0;
    classified.length = 0;
    classifierPick = 'fast';
});

const refusal = (tier) => ({ error: `Tier "${tier}" is not available on your account.`, code: 'tier_not_permitted' });

test('an explicit tier the person may not use ends the turn with the refusal, before a draft or a model', async () => {
    const run = await h.run({ tiers: TIERS, body: { modelTier: 'pro' } });
    assert.deepStrictEqual(run.last('error'), refusal('pro'));
    assert.strictEqual(run.rounds.length, 0, 'no model was asked');
    assert.ok(!run.has('builder_session'), 'no draft was loaded or minted');
});

test('auto with none of the configured tiers theirs is the same refusal', async () => {
    permitted = new Set(['writer']);
    const run = await h.run({ tiers: TIERS, body: { modelTier: 'auto' } });
    assert.deepStrictEqual(run.last('error'), refusal('auto'));
    assert.strictEqual(run.rounds.length, 0);
});

test('auto classifies over the person\'s own tiers only', async () => {
    classifierPick = 'thinking';
    const run = await h.run({ tiers: TIERS, body: { modelTier: 'auto' } });
    assert.deepStrictEqual(classified, [['fast', 'thinking']], 'not pro, not standard, never a custom tier');
    assert.deepStrictEqual(run.first('model_selected'), { tier: 'thinking', modelId: 'claude-sonnet-4-6' });
});

test('a classifier answer outside the person\'s tiers lands inside them', async () => {
    // classifyWithLLM answers `fast` on its own fallbacks, whether or not
    // that tier is in the map it was handed.
    permitted = new Set(['thinking', 'pro']);
    classifierPick = 'fast';
    const run = await h.run({ tiers: TIERS, body: { modelTier: 'auto' } });
    assert.deepStrictEqual(run.first('model_selected'), { tier: 'thinking', modelId: 'claude-sonnet-4-6' });
});

test('the capability floor bumps a small auto pick only within the person\'s tiers', async () => {
    permitted = new Set(['fast']);
    const run = await h.run({ tiers: TIERS, body: { modelTier: 'auto' } });
    assert.deepStrictEqual(run.first('model_selected'), { tier: 'fast', modelId: 'claude-haiku-4-5' },
        'thinking and standard are configured, but not theirs to be floored onto');
});

test('the ai_step tiers the builder AI may pick are the person\'s own', async () => {
    let offered = null;
    await h.run({
        tiers: TIERS,
        body: { modelTier: 'fast' },
        rounds: [{ toolCalls: [call('builder_add_steps', { steps: [] })] }, { text: 'Klaar.' }],
        tools: { builder_add_steps: (_args, draftWrap) => { offered = [...draftWrap._allowedModelTiers].sort(); return { ok: true, added: [] }; } },
    });
    assert.deepStrictEqual(offered, ['auto', 'fast', 'thinking']);
});

test('a flowlet sub-agent runs on thinking only when thinking is the person\'s', async () => {
    const subAgentModel = async () => {
        let model = null;
        await h.run({
            tiers: TIERS,
            // What resolveLayerAgentModel answers: the thinking tier's model.
            modelId: 'claude-sonnet-4-6',
            body: { modelTier: 'fast' },
            rounds: [{ toolCalls: [call('builder_generate_layer', { title: 'Facturen', instruction: 'x' })] }, { text: 'Klaar.' }],
            tools: { builder_generate_layer: (_args, _draftWrap, ctx) => { model = ctx.thinkingModelId; return { ok: true }; } },
        });
        return model;
    };
    assert.strictEqual(await subAgentModel(), 'claude-sonnet-4-6');
    permitted = new Set(['fast']);
    assert.strictEqual(await subAgentModel(), 'claude-haiku-4-5', 'thinking is not theirs: the sub-agent stays on fast');
});

test('the list is asked for automation, with the caller\'s session', async () => {
    await h.run({ tiers: TIERS, body: { modelTier: 'fast' } });
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].userId, 'u1');
    assert.strictEqual(asked[0].taskType, 'automation');
    assert.deepStrictEqual(asked[0].session, { user: { id: 'u1', organizationId: 'org1' } });
});

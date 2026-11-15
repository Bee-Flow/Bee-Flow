/**
 * The worked examples under the safety-limit slider come from the
 * organisation's own chat tiers (core/llm/contextWindowExamples.mts), not from
 * two fixed models of one provider.
 *
 * What this pins:
 *   - the largest and the smallest context window among the org's tiers, each
 *     labelled by its tier name and the model's display name;
 *   - tiers that share a window collapse to one example (the cheapest tier);
 *   - an org's own custom tier counts for that org only;
 *   - nothing configured, or an unreadable config, gives a neutral pair that
 *     names no model.
 *
 * Run: cd server && node --test core/llm/contextWindowExamples.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const configStore = require('../../stores/configStore');
const { contextWindowFor } = require('./contextPolicy');
const { contextWindowExamples } = require('./contextWindowExamples.mts');

function stubConfig(t, rows) {
    t.mock.method(configStore, 'getConfig', async (key) => (Object.hasOwn(rows, key) ? rows[key] : null));
}

const BIG = 'gemini-3.1-pro-preview';
const MID = 'gpt-4.1';
const SMALL = 'some-self-hosted-model';

test('the windows these tests rely on are distinct', () => {
    assert.ok(contextWindowFor(BIG) > contextWindowFor(MID));
    assert.ok(contextWindowFor(MID) > contextWindowFor(SMALL));
});

test('the org\'s largest and smallest window, labelled by tier and model', async (t) => {
    stubConfig(t, {
        chat_model_tiers: {
            fast: { modelId: SMALL },
            thinking: { modelId: MID },
            pro: { modelId: BIG },
        },
    });
    const examples = await contextWindowExamples('orgA');
    assert.deepStrictEqual(examples, [
        { label: 'Deep Thinking (Gemini 3.1 Pro)', contextWindow: contextWindowFor(BIG), kind: 'tier', tierKey: 'deep_thinking', model: 'Gemini 3.1 Pro' },
        { label: `Fast (${SMALL})`, contextWindow: contextWindowFor(SMALL), kind: 'tier', tierKey: 'fast', model: SMALL },
    ]);
});

test('tiers that share a window give one example, the cheapest tier', async (t) => {
    stubConfig(t, {
        chat_model_tiers: {
            pro: { modelId: MID },
            thinking: { modelId: MID },
            fast: { modelId: MID },
        },
    });
    const examples = await contextWindowExamples('orgA');
    assert.strictEqual(examples.length, 1, 'one window is one example, not the same number twice');
    assert.strictEqual(examples[0].tierKey, 'fast');
    assert.strictEqual(examples[0].contextWindow, contextWindowFor(MID));
});

test('an org\'s custom tier counts for that org only, under its own label', async (t) => {
    stubConfig(t, {
        chat_model_tiers: { fast: { modelId: SMALL }, thinking: { modelId: MID } },
        custom_chat_model_tiers_org_orgA: [{ id: 'custom:long-docs', modelId: BIG, label: 'Long documents' }],
    });
    const forA = await contextWindowExamples('orgA');
    assert.strictEqual(forA[0].label, 'Long documents (Gemini 3.1 Pro)');
    assert.strictEqual(forA[0].kind, 'custom');
    assert.strictEqual(forA[0].tierKey, null);

    const forB = await contextWindowExamples('orgB');
    assert.ok(forB.every((ex) => ex.kind === 'tier'), 'another org never sees org A\'s tier');
    assert.strictEqual(forB[0].contextWindow, contextWindowFor(MID));
});

test('nothing configured gives a neutral pair that names no model', async (t) => {
    stubConfig(t, { chat_model_tiers: { fast: { modelId: '' }, thinking: {} } });
    const examples = await contextWindowExamples('orgA');
    assert.deepStrictEqual(examples, [
        { label: 'A 1,000,000-token model', contextWindow: 1_000_000, kind: 'generic', tierKey: null, model: null },
        { label: 'A 200,000-token model', contextWindow: 200_000, kind: 'generic', tierKey: null, model: null },
    ]);
});

test('an unreadable tier config gives the neutral pair instead of failing the settings page', async (t) => {
    t.mock.method(configStore, 'getConfig', async () => { throw new Error('db down'); });
    const examples = await contextWindowExamples('orgA');
    assert.deepStrictEqual(examples.map((ex) => ex.kind), ['generic', 'generic']);
});

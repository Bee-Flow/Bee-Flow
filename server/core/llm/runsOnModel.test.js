/**
 * The "runs on" line of the organisation's long-conversation and memory
 * settings (core/llm/runsOnModel.mts): the display name of the model the
 * background job uses, resolved exactly as that job resolves it.
 *
 * What this pins:
 *   - summaries: the organisation's Fast tier, by display name;
 *   - memory: the server's dedicated extraction model first, else the
 *     extractor agent's model through the tiers;
 *   - nothing configured, or a failing lookup, gives null (no line), never a
 *     guessed vendor model and never an error on the settings screen.
 *
 * Run: cd server && node --test core/llm/runsOnModel.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const configStore = require('../../stores/configStore');
const agentStore = require('../../stores/agentStore');
const { compactionRunsOn, memoryExtractionRunsOn, modelDisplayName } = require('./runsOnModel.mts');

function stubConfig(t, rows) {
    t.mock.method(configStore, 'getConfig', async (key) => (Object.hasOwn(rows, key) ? rows[key] : null));
}

test('a known model id reads as its display name, an unknown one as itself', () => {
    assert.strictEqual(modelDisplayName('gemini-3.1-pro-preview'), 'Gemini 3.1 Pro');
    assert.strictEqual(modelDisplayName('my-local-model'), 'my-local-model');
});

test('summaries run on the organisation\'s Fast tier', async (t) => {
    stubConfig(t, { chat_model_tiers: { fast: { modelId: 'my-local-model' }, thinking: { modelId: 'gemini-3.1-pro-preview' } } });
    assert.strictEqual(await compactionRunsOn('org1'), 'my-local-model');
});

test('no Fast tier: no line', async (t) => {
    stubConfig(t, {});
    assert.strictEqual(await compactionRunsOn('org1'), null);
});

test('memory runs on the dedicated extraction model when the server sets one', async (t) => {
    stubConfig(t, { memory_extraction_model: 'gemini-3.1-pro-preview', chat_model_tiers: { fast: { modelId: 'my-local-model' } } });
    t.mock.method(agentStore, 'getSystemAgent', async () => ({ model: 'tier:fast' }));
    assert.strictEqual(await memoryExtractionRunsOn('org1'), 'Gemini 3.1 Pro');
});

test('without one, memory runs on the extractor agent\'s model through the tiers', async (t) => {
    stubConfig(t, { chat_model_tiers: { fast: { modelId: 'my-local-model' } } });
    t.mock.method(agentStore, 'getSystemAgent', async () => ({ model: 'tier:fast' }));
    assert.strictEqual(await memoryExtractionRunsOn('org1'), 'my-local-model');
});

test('a lookup that fails gives no line instead of an error', async (t) => {
    stubConfig(t, {});
    t.mock.method(agentStore, 'getSystemAgent', async () => { throw new Error('database down'); });
    assert.strictEqual(await memoryExtractionRunsOn('org1'), null);
});

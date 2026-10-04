/**
 * Contract tests — a custom-named Azure deployment answers as its model.
 *
 * Run: node --test core/providers/azureDeployments.test.js
 *
 * `prod-chat=gpt-6-astra` must be priced, windowed and given reasoning
 * defaults as gpt-6-astra. Without the registry the name matches nothing:
 * upper-bound pricing, a 128k window inside a million-token model, and no
 * reasoning summaries.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { parseDeployments, setAzureDeployments, azureModelFor } = require('./azureDeployments');
const { contextWindowFor } = require('../llm/contextPolicy');
const { isReasoningModel } = require('../llm/modelResolver');
const { getCacheDiscount } = require('../llm/modelCosts');

beforeEach(() => setAzureDeployments(parseDeployments('prod-chat=gpt-6-astra, gpt-4.1')));

test('a mapped deployment resolves to its model; anything else is left alone', () => {
    assert.strictEqual(azureModelFor('prod-chat'), 'gpt-6-astra');
    assert.strictEqual(azureModelFor('azure/prod-chat'), 'gpt-6-astra');
    assert.strictEqual(azureModelFor('gpt-4.1'), 'gpt-4.1');
    assert.strictEqual(azureModelFor('claude-opus-5'), 'claude-opus-5');
    assert.strictEqual(azureModelFor(null), null);
});

test('the context window is the model\'s', () => {
    assert.strictEqual(contextWindowFor('prod-chat'), contextWindowFor('gpt-6-astra'));
    assert.ok(contextWindowFor('prod-chat') > 128_000);
});

test('reasoning defaults apply to the deployment', () => {
    assert.strictEqual(isReasoningModel('prod-chat'), true);
    setAzureDeployments([]);
    assert.strictEqual(isReasoningModel('prod-chat'), false, 'unmapped, the name says nothing');
});

test('cache pricing follows the model', () => {
    assert.strictEqual(getCacheDiscount('prod-chat'), getCacheDiscount('gpt-6-astra'));
});

/**
 * resolveModelId: a saved display name still resolves to the id the API
 * wants, and anything id-shaped passes through untouched.
 *
 * Run: node --test --test-force-exit core/llm/modelNames.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { DISPLAY_NAME_TO_ID, resolveModelId } = require('./modelNames');
const { listCatalogModels } = require('../providers/claudeModels');

test('an empty value resolves to null', () => {
    assert.strictEqual(resolveModelId(null), null);
    assert.strictEqual(resolveModelId(undefined), null);
    assert.strictEqual(resolveModelId(''), null);
});

test('an id-shaped value passes through as it is', () => {
    assert.strictEqual(resolveModelId('gpt-4o-mini'), 'gpt-4o-mini');
    assert.strictEqual(resolveModelId('mistral-large-2411'), 'mistral-large-2411');
    assert.strictEqual(resolveModelId('claude-haiku-4-5'), 'claude-haiku-4-5');
});

test('a display name resolves to its id', () => {
    assert.strictEqual(resolveModelId('GPT-4o Mini'), 'gpt-4o-mini');
    assert.strictEqual(resolveModelId('Mistral Large 3'), 'mistral-large-latest');
    assert.strictEqual(resolveModelId('Gemini 3 Flash'), 'gemini-3-flash-preview');
});

test('every model in the Claude catalog resolves by its display name', () => {
    // The map is generated from the catalog so that a model selectable in the
    // admin UI can never be missing here (which is what happened to Opus 5).
    const catalog = listCatalogModels();
    assert.ok(catalog.length > 0);
    for (const m of catalog) {
        assert.strictEqual(DISPLAY_NAME_TO_ID[m.name], m.id, `catalog entry "${m.name}"`);
        assert.strictEqual(resolveModelId(m.name), m.id);
    }
});

test('a name that is neither id-shaped nor known comes back unchanged', () => {
    // A slash-separated self-hosted id is not id-shaped by the regex but has
    // no display-name entry either; the caller gets it back as it was.
    assert.strictEqual(resolveModelId('Qwen/Qwen3-30B-A3B'), 'Qwen/Qwen3-30B-A3B');
    assert.strictEqual(resolveModelId('Some Unknown Model'), 'Some Unknown Model');
});

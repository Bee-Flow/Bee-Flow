/**
 * What a save of the AI configuration does to the vector length asked of the
 * embedding model (./embeddingChoice.mts). The length is decided only when the
 * model changes; a save that leaves it as it is passes no decision, so a
 * configuration whose vectors are stored at the model's own length keeps
 * getting full-length vectors.
 *
 * Run: cd server && node --test core/embed/embeddingChoice.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { embeddingChoice, savedDimensions } = require('./embeddingChoice.mts');

const SCW = { id: 'scw', type: 'scaleway' };
const QWEN = 'qwen3-embedding-8b';

function deps({ nativeStored = false } = {}) {
    const asked = [];
    return {
        asked,
        readAi: async () => ({ providers: [SCW] }),
        nativeVectorsStored: async (providerId, modelId) => { asked.push([providerId, modelId]); return nativeStored; },
    };
}

test('choosing a Matryoshka model over the index limit decides 1536, bound to the provider and model', async () => {
    const r = await embeddingChoice({ embeddingProviderId: null, embeddingModel: null }, { embeddingProviderId: 'scw', embeddingModel: QWEN }, deps());
    assert.deepStrictEqual(r, { providerId: 'scw', modelId: QWEN, changed: true, output: { providerId: 'scw', modelId: QWEN, dimensions: 1536 } });
});

test('a save that leaves the model as it is passes no decision: the stored one, or none, stays', async () => {
    const existing = { embeddingProviderId: 'scw', embeddingModel: QWEN };
    const d = deps();
    for (const sent of [{ embeddingProviderId: 'scw', embeddingModel: QWEN }, {}]) {
        const r = await embeddingChoice(existing, sent, d);
        assert.deepStrictEqual(r, { providerId: 'scw', modelId: QWEN, changed: false, output: undefined });
    }
    assert.deepStrictEqual(d.asked, [], 'not even looked at');
});

test('picking the model again while its full-length vectors are stored asks for nothing', async () => {
    const d = deps({ nativeStored: true });
    const r = await embeddingChoice({ embeddingProviderId: 'scw', embeddingModel: null }, { embeddingModel: QWEN }, d);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.output, null);
    assert.deepStrictEqual(d.asked, [['scw', QWEN]]);
});

test('a model that cannot be shortened, or no model, clears an earlier decision', async () => {
    const existing = { embeddingProviderId: 'scw', embeddingModel: QWEN };
    assert.strictEqual((await embeddingChoice(existing, { embeddingModel: 'bge-multilingual-gemma2' }, deps())).output, null);
    assert.strictEqual((await embeddingChoice(existing, { embeddingModel: '' }, deps())).output, null);
});

test('savedDimensions: the stored length for the configured model only', () => {
    const embeddingOutput = { providerId: 'scw', modelId: QWEN, dimensions: 1536 };
    assert.strictEqual(savedDimensions({ embeddingProviderId: 'scw', embeddingModel: QWEN, embeddingOutput }), 1536);
    assert.strictEqual(savedDimensions({ embeddingProviderId: 'scw', embeddingModel: 'bge-multilingual-gemma2', embeddingOutput }), null);
    assert.strictEqual(savedDimensions(null), null);
});

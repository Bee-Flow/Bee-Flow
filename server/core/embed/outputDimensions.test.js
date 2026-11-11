/**
 * The vector length of the embedding model (./outputDimensions.mts), from the
 * moment an admin picks the model to the vectors that come back.
 *
 * What must hold: a model picked from now on that returns more than the 2000
 * dimensions pgvector's index takes, and that can be shortened (Matryoshka),
 * has its vectors cut to their first 1536 values and L2-normalised (no
 * `dimensions` field is sent: not every host supports one); a configuration
 * that existed before, whose vectors are stored at the model's own length,
 * keeps full-length vectors. Otherwise new vectors of another length would
 * land next to the stored ones without a re-embed.
 *
 * Run: cd server && node --test core/embed/outputDimensions.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    INDEX_MAX_DIMS, REDUCED_DIMS, embeddingShape, chooseDimensions, decideEmbeddingOutput, storedDimensions, reduceVector,
} = require('./outputDimensions.mts');
const { embedTargetFrom } = require('./resolveTarget');
const { _test: { fingerprintOf } } = require('../kb/embeddingMigration');

const SCW = { id: 'scw', name: 'Scaleway', type: 'scaleway', url: 'https://api.scaleway.ai/v1', apiKey: 'k' };
const IONOS = { id: 'ion', name: 'IONOS', type: 'ionos', url: 'https://openai.inference.de-txl.ionos.com/v1', apiKey: 'k' };
const OPENAI = { id: 'oai', name: 'OpenAI', type: 'openai', url: 'https://api.openai.com', apiKey: 'k' };

/** A native 4096-dimension vector, not normalised. */
const NATIVE = Array.from({ length: 4096 }, (_, i) => ((i % 7) - 3) / 10);
const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
/** What the dispatcher makes of a returned vector for a stored `ai` record (core/embed/dispatch.js). */
const vectorFor = (ai, vec = NATIVE) => reduceVector(vec, embedTargetFrom(ai).dimensions);

test('the catalog: qwen3-embedding-8b is Matryoshka at 4096, bge-multilingual-gemma2 is 3584 and fixed', () => {
    assert.deepStrictEqual(embeddingShape('scaleway', 'qwen3-embedding-8b'), { dims: 4096, matryoshka: { min: 32, max: 4096 } });
    assert.deepStrictEqual(embeddingShape('scaleway', 'bge-multilingual-gemma2'), { dims: 3584, matryoshka: null });
    assert.deepStrictEqual(embeddingShape('ionos', 'BAAI/bge-m3'), { dims: 1024, matryoshka: null });
    // No length is stated for it, so none is assumed.
    assert.deepStrictEqual(embeddingShape('ionos', 'Qwen/Qwen3-VL-Embedding-8B'), { dims: null, matryoshka: null });
    // The catalog of one provider says nothing about another provider's ids.
    assert.deepStrictEqual(embeddingShape('openai', 'qwen3-embedding-8b'), { dims: null, matryoshka: null });
});

test('only a Matryoshka model above the index limit is shortened', () => {
    assert.strictEqual(INDEX_MAX_DIMS, 2000);
    assert.strictEqual(chooseDimensions('scaleway', 'qwen3-embedding-8b'), REDUCED_DIMS);
    assert.strictEqual(chooseDimensions('scaleway', 'bge-multilingual-gemma2'), null, 'not Matryoshka');
    assert.strictEqual(chooseDimensions('ionos', 'BAAI/bge-m3'), null, 'already under the limit');
    assert.strictEqual(chooseDimensions('ionos', 'Qwen/Qwen3-VL-Embedding-8B'), null, 'no evidence it can be shortened');
    assert.strictEqual(chooseDimensions('openai', 'text-embedding-3-large'), null, 'no catalog entry');
    assert.strictEqual(chooseDimensions('scaleway', ''), null);
});

test('the decision is bound to the provider and model it was made for', () => {
    const out = decideEmbeddingOutput([SCW, OPENAI], 'scw', 'qwen3-embedding-8b');
    assert.deepStrictEqual(out, { providerId: 'scw', modelId: 'qwen3-embedding-8b', dimensions: 1536 });
    assert.strictEqual(storedDimensions(out, 'scw', 'qwen3-embedding-8b'), 1536);
    assert.strictEqual(storedDimensions(out, 'scw', 'bge-multilingual-gemma2'), null, 'another model');
    assert.strictEqual(storedDimensions(out, 'other', 'qwen3-embedding-8b'), null, 'another provider');
    assert.strictEqual(storedDimensions(undefined, 'scw', 'qwen3-embedding-8b'), null, 'no decision stored');
    assert.strictEqual(storedDimensions({ ...out, dimensions: 4096 }, 'scw', 'qwen3-embedding-8b'), null, 'over the limit is not a decision');
    assert.strictEqual(storedDimensions({ ...out, dimensions: '1536' }, 'scw', 'qwen3-embedding-8b'), null, 'malformed');
    assert.strictEqual(decideEmbeddingOutput([SCW], 'scw', 'bge-multilingual-gemma2'), null);
    assert.strictEqual(decideEmbeddingOutput([SCW], 'missing', 'qwen3-embedding-8b'), null, 'unknown provider: no type, no catalog');
});

test('picking the model again while its full-length vectors are stored keeps them: nothing is sent', () => {
    assert.strictEqual(decideEmbeddingOutput([SCW], 'scw', 'qwen3-embedding-8b', { nativeVectorsStored: true }), null);
});

test('a NEW configuration of a Matryoshka model over the limit gets 1536-value unit vectors', () => {
    const ai = {
        providers: [SCW], embeddingProviderId: 'scw', embeddingModel: 'qwen3-embedding-8b',
        embeddingOutput: decideEmbeddingOutput([SCW], 'scw', 'qwen3-embedding-8b'),
    };
    const target = embedTargetFrom(ai);
    assert.strictEqual(target.dimensions, 1536);
    const v = vectorFor(ai);
    assert.strictEqual(v.length, 1536);
    assert.ok(Math.abs(norm(v) - 1) < 1e-9, 'unit norm');
    // The length is part of the migration fingerprint, so the vectors stored at
    // the full length are re-embedded rather than searched with shorter queries.
    assert.strictEqual(fingerprintOf(target), 'scw:qwen3-embedding-8b:1536');
});

test('an EXISTING configuration (no stored decision) keeps its vectors and its fingerprint', () => {
    const ai = { providers: [SCW], embeddingProviderId: 'scw', embeddingModel: 'qwen3-embedding-8b' };
    const target = embedTargetFrom(ai);
    assert.strictEqual(target.dimensions, null);
    assert.strictEqual(vectorFor(ai), NATIVE, 'the very vector the model returned');
    assert.strictEqual(fingerprintOf(target), 'scw:qwen3-embedding-8b', 'the fingerprint it had before this change');
});

test('a decision left over from another model is not applied to the configured one', () => {
    const ai = {
        providers: [SCW], embeddingProviderId: 'scw', embeddingModel: 'bge-multilingual-gemma2',
        embeddingOutput: { providerId: 'scw', modelId: 'qwen3-embedding-8b', dimensions: 1536 },
    };
    assert.strictEqual(vectorFor(ai), NATIVE);
});

test('a non-Matryoshka model over the limit and a model under it are never shortened', () => {
    for (const [provider, modelId] of [[SCW, 'bge-multilingual-gemma2'], [IONOS, 'BAAI/bge-m3'], [OPENAI, 'text-embedding-3-small']]) {
        const ai = {
            providers: [provider], embeddingProviderId: provider.id, embeddingModel: modelId,
            embeddingOutput: decideEmbeddingOutput([provider], provider.id, modelId),
        };
        assert.strictEqual(vectorFor(ai), NATIVE, `${modelId} must not be shortened`);
    }
});

test('reduceVector: the first n values, L2-normalised', () => {
    assert.deepStrictEqual(reduceVector([3, 4, 12], 2), [0.6, 0.8]);
    const v = reduceVector(NATIVE, 1536);
    assert.deepStrictEqual(v.map((x) => x * norm(NATIVE.slice(0, 1536))).map((x) => Math.round(x * 1e9) / 1e9),
        NATIVE.slice(0, 1536).map((x) => Math.round(x * 1e9) / 1e9), 'same direction as the prefix');
});

test('reduceVector: a vector at or below the length, or no length, is returned as it is', () => {
    const short = [3, 4];
    assert.strictEqual(reduceVector(short, 2), short);
    assert.strictEqual(reduceVector(short, 1536), short);
    assert.strictEqual(reduceVector(NATIVE, null), NATIVE);
    assert.strictEqual(reduceVector(NATIVE, undefined), NATIVE);
});

test('reduceVector: an all-zero prefix does not divide by zero', () => {
    const v = reduceVector([0, 0, 0, 5], 3);
    assert.deepStrictEqual(v, [0, 0, 0]);
    assert.ok(v.every(Number.isFinite));
});

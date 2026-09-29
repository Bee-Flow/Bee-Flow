/**
 * Embedding dispatch — the query/document distinction.
 *
 * EmbeddingGemma and e5 are ASYMMETRIC: a question and the passage answering it
 * only land near each other when each is labelled for its role. Nothing errors
 * when you get it wrong; retrieval just quietly gets worse, which is precisely
 * why it needs a test rather than a comment.
 *
 * Before `kind` existed, `dispatchEmbedTexts` had no way to say which side it
 * was embedding, and its CPU fallback hard-coded 'passage' — so every SEARCH
 * QUERY that reached the CPU embedder was embedded as stored text.
 *
 * Run: cd server && node --test --test-force-exit core/embed/dispatch.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const stubPath = path.join(__dirname, '..', '..', 'stores', 'configStore.js');
require.cache[stubPath] = {
    id: stubPath, filename: stubPath, loaded: true,
    exports: { async getConfig() { return undefined; }, async getSecret() { return null; } },
};

const { applyModelPrefix } = require('./dispatch');

test('EmbeddingGemma gets its documented prefixes, and they differ by role', () => {
    const [q] = applyModelPrefix(['hoeveel kost het'], 'embedding-gemma', 'query');
    const [d] = applyModelPrefix(['hoeveel kost het'], 'embedding-gemma', 'passage');
    assert.strictEqual(q, 'task: search result | query: hoeveel kost het');
    assert.strictEqual(d, 'title: none | text: hoeveel kost het');
    assert.notStrictEqual(q, d, 'the whole point is that the two sides differ');
});

test('the gemma match is not fooled by naming variants', () => {
    for (const id of ['embedding-gemma', 'EmbeddingGemma', 'google/embeddinggemma-300m', 'embedding-gemma-Q8_0']) {
        const [q] = applyModelPrefix(['x'], id, 'query');
        assert.ok(q.startsWith('task: search result | query:'), `${id} should be recognised as EmbeddingGemma`);
    }
});

test('e5 models reached over HTTP get query:/passage: prefixes', () => {
    assert.deepStrictEqual(applyModelPrefix(['x'], 'multilingual-e5-large', 'query'), ['query: x']);
    assert.deepStrictEqual(applyModelPrefix(['x'], 'multilingual-e5-large', 'passage'), ['passage: x']);
});

test('symmetric models are left completely alone', () => {
    // Prefixing OpenAI's embeddings would put literal "query:" tokens into the
    // vector for no benefit at all.
    for (const id of ['text-embedding-3-small', 'text-embedding-ada-002', 'mistral-embed', 'bge-m3']) {
        assert.deepStrictEqual(applyModelPrefix(['x'], id, 'query'), ['x'], id);
        assert.deepStrictEqual(applyModelPrefix(['x'], id, 'passage'), ['x'], id);
    }
});

test('an unknown or missing model id is a no-op, never a crash', () => {
    assert.deepStrictEqual(applyModelPrefix(['x'], undefined, 'query'), ['x']);
    assert.deepStrictEqual(applyModelPrefix(['x'], null, 'passage'), ['x']);
    assert.deepStrictEqual(applyModelPrefix([], 'embedding-gemma', 'query'), []);
});

test('every text in a batch is prefixed, not just the first', () => {
    const out = applyModelPrefix(['a', 'b', 'c'], 'embedding-gemma', 'passage');
    assert.strictEqual(out.length, 3);
    assert.ok(out.every(t => t.startsWith('title: none | text: ')), 'a partially-prefixed batch would be worse than none');
});

test('anything other than "query" is treated as a document', () => {
    // Defensive: the default must be the storage side, which is what every
    // caller got before the parameter existed.
    for (const kind of ['passage', 'document', undefined, 'nonsense']) {
        const [t] = applyModelPrefix(['x'], 'embedding-gemma', kind);
        assert.strictEqual(t, 'title: none | text: x', `kind=${kind}`);
    }
});

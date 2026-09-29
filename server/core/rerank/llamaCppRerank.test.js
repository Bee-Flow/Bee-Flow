/**
 * llama.cpp reranker — the contract that matters is SCORE SHAPE.
 *
 * llama.cpp returns raw cross-encoder logits (measured on the demo box: +4.35
 * for a match, -11.02 for a distractor). Everything downstream compares against
 * 0..1 thresholds — knowledgeSearch.js filters at 0.72, notebookKnowledgeSearch
 * at 0.15/0.2/0.25 — so passing logits through would quietly bin every relevant
 * passage scoring between 0 and 0.72 while letting anything above it through.
 * These tests pin the sigmoid.
 *
 * Run: cd server && node --test --test-force-exit core/rerank/llamaCppRerank.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Stub configStore before the module under test requires it.
const stubPath = path.join(__dirname, '..', '..', 'stores', 'configStore.js');
let CONFIG = {};
require.cache[stubPath] = {
    id: stubPath, filename: stubPath, loaded: true,
    exports: { async getConfig(k) { return CONFIG[k]; }, async getSecret() { return null; } },
};

const { rerankLlamaCpp, isEnabled, _internals } = require('./llamaCppRerank');

const ENABLED = { llamacpp_rerank_enabled: true, llamacpp_rerank_url: 'http://stub:8080', llamacpp_rerank_model: 'bge-reranker-v2-m3' };
const realFetch = global.fetch;
function stubFetch(handler) { global.fetch = handler; }
function restoreFetch() { global.fetch = realFetch; }

test('raw logits become 0..1 scores, ordered best first', async () => {
    CONFIG = { ...ENABLED };
    stubFetch(async () => ({
        ok: true,
        async json() {
            return { results: [
                { index: 1, relevance_score: -11.02 },
                { index: 0, relevance_score: 4.35 },
                { index: 2, relevance_score: 0.0 },
            ] };
        },
    }));
    try {
        const out = await rerankLlamaCpp('q', ['a', 'b', 'c'], 3);
        assert.strictEqual(out.length, 3);
        assert.strictEqual(out[0].index, 0, 'highest logit ranks first');
        assert.ok(out.every(r => r.relevance_score >= 0 && r.relevance_score <= 1),
            'every score must be a 0..1 value, not a logit');
        assert.ok(out[0].relevance_score > 0.98, `+4.35 -> ~0.987, got ${out[0].relevance_score}`);
        assert.ok(out[0].relevance_score >= 0.72,
            'a clear match must survive the knowledgeSearch 0.72 filter');
        assert.ok(out[2].relevance_score < 0.0001, '-11.02 -> ~0.00002');
        // A logit of 0 is the model saying "no idea" — it must land at 0.5,
        // i.e. BELOW the 0.72 filter. Passing the raw 0 through would have been
        // below threshold too, but a logit of 1.0 would have sneaked past it.
        assert.strictEqual(out[1].relevance_score, 0.5, 'logit 0 -> 0.5');
    } finally { restoreFetch(); }
});

test('a logit that would beat the 0.72 filter raw is correctly demoted', async () => {
    // This is the exact bug the sigmoid prevents: a logit of 0.8 is a WEAK
    // match (sigmoid 0.69) but would pass a raw >= 0.72 comparison... and a
    // logit of 0.5 is likewise weak. Without normalisation the filter is
    // meaningless because the scale is wrong.
    CONFIG = { ...ENABLED };
    stubFetch(async () => ({ ok: true, async json() { return { results: [{ index: 0, relevance_score: 0.8 }] }; } }));
    try {
        const [r] = await rerankLlamaCpp('q', ['a'], 1);
        assert.ok(r.relevance_score < 0.72, `weak match must not pass the filter, got ${r.relevance_score}`);
    } finally { restoreFetch(); }
});

test('disabled by default — no network call at all', async () => {
    CONFIG = {};
    let called = false;
    stubFetch(async () => { called = true; throw new Error('should not be reached'); });
    try {
        assert.strictEqual(await isEnabled(), false);
        assert.deepStrictEqual(await rerankLlamaCpp('q', ['a']), []);
        assert.strictEqual(called, false, 'an opt-in feature must not touch the network when off');
    } finally { restoreFetch(); }
});

test('failures return [] so the caller falls through to its next tier', async () => {
    CONFIG = { ...ENABLED };
    for (const mode of ['http', 'throw', 'garbage']) {
        stubFetch(async () => {
            if (mode === 'throw') throw new Error('ECONNREFUSED');
            if (mode === 'http') return { ok: false, status: 503, async text() { return 'no model'; } };
            return { ok: true, async json() { return { nonsense: true }; } };
        });
        const out = await rerankLlamaCpp('q', ['a', 'b']);
        assert.deepStrictEqual(out, [], `${mode} must degrade to [] and never throw`);
    }
    restoreFetch();
});

test('an out-of-range index is dropped, not used to score the wrong row', async () => {
    CONFIG = { ...ENABLED };
    stubFetch(async () => ({
        ok: true,
        async json() { return { results: [{ index: 9, relevance_score: 5 }, { index: 0, relevance_score: 1 }] }; },
    }));
    try {
        const out = await rerankLlamaCpp('q', ['a', 'b'], 2);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].index, 0);
    } finally { restoreFetch(); }
});

test('top_n never exceeds the document count', async () => {
    CONFIG = { ...ENABLED };
    let sent = null;
    stubFetch(async (_url, opts) => {
        sent = JSON.parse(opts.body);
        return { ok: true, async json() { return { results: [] }; } };
    });
    try {
        await rerankLlamaCpp('q', ['a', 'b'], 50);
        assert.strictEqual(sent.top_n, 2);
        assert.strictEqual(sent.model, 'bge-reranker-v2-m3');
    } finally { restoreFetch(); }
});

test('sigmoid is the standard logistic', () => {
    assert.strictEqual(_internals.sigmoid(0), 0.5);
    assert.ok(_internals.sigmoid(10) > 0.9999);
    assert.ok(_internals.sigmoid(-10) < 0.0001);
});

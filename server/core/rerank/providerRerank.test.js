/**
 * Provider rerank: request shape, url handling, mapping and failure modes.
 * Run: cd server && node --test core/rerank/providerRerank.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
let CONFIG = {};
let calls = [];
let responder;
const logged = [];
// Collaborators go in through the second argument, not through the module system.
const deps = {
    async getConfig(k) { return CONFIG[k]; },
    async fetch(url, init) { calls.push({ url, init }); return responder(url, init); },
    async logUsage(e) { logged.push(e); },
};

const { providerRerank: realRerank } = require('./providerRerank');
const providerRerank = (args) => realRerank(args, deps);

const provider = (url) => ({ ai: { providers: [{ id: 'p1', type: 'ionos', url, apiKey: 'sk-test' }] } });
const ok = (body) => async () => ({ ok: true, async json() { return body; } });

beforeEach(() => { calls = []; logged.length = 0; CONFIG = provider('https://host.example/v1'); });

test('posts the documented body with a bearer key and maps scores best first', async () => {
    responder = ok({ results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.9 }], usage: { prompt_tokens: 12, total_tokens: 12 } });
    const out = await providerRerank({ providerId: 'p1', model: 'Qwen/Qwen3-VL-Reranker-8B', query: 'q', documents: ['a', 'b'], topN: 5 });
    assert.deepStrictEqual(out, [{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }]);
    assert.strictEqual(calls[0].url, 'https://host.example/v1/rerank');
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer sk-test');
    assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
        model: 'Qwen/Qwen3-VL-Reranker-8B', query: 'q', documents: ['a', 'b'], top_n: 2, return_documents: false,
    });
});

test('a base url without /v1 gets it, trailing slashes are ignored', async () => {
    responder = ok({ results: [] });
    for (const base of ['https://host.example', 'https://host.example/', 'https://host.example/v1/']) {
        CONFIG = provider(base);
        await providerRerank({ providerId: 'p1', model: 'm', query: 'q', documents: ['a'] });
    }
    assert.deepStrictEqual(calls.map(c => c.url), Array(3).fill('https://host.example/v1/rerank'));
});

test('logs the billed input tokens as usage', async () => {
    responder = ok({ results: [{ index: 0, relevance_score: 1 }], usage: { prompt_tokens: 40, total_tokens: 40 } });
    await providerRerank({ providerId: 'p1', model: 'm', query: 'q', documents: ['a'] });
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].prompt_tokens, 40);
    assert.strictEqual(logged[0].source, 'knowledge_rerank');
});

test('drops indexes outside the input', async () => {
    responder = ok({ results: [{ index: 7, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] });
    const out = await providerRerank({ providerId: 'p1', model: 'm', query: 'q', documents: ['a'] });
    assert.deepStrictEqual(out, [{ index: 0, score: 0.1 }]);
});

test('a non-2xx answer throws', async () => {
    responder = async () => ({ ok: false, status: 401, async text() { return 'nope'; } });
    await assert.rejects(providerRerank({ providerId: 'p1', model: 'm', query: 'q', documents: ['a'] }), /401/);
});

test('a body without results throws', async () => {
    responder = ok({ oops: true });
    await assert.rejects(providerRerank({ providerId: 'p1', model: 'm', query: 'q', documents: ['a'] }), /results/);
});

test('an unknown provider throws', async () => {
    responder = ok({ results: [] });
    await assert.rejects(providerRerank({ providerId: 'missing', model: 'm', query: 'q', documents: ['a'] }), /not found/);
    assert.strictEqual(calls.length, 0);
});

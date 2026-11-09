/**
 * The reranker chain: llama.cpp > provider rerank > Azure Cohere > CPU, and
 * the calibrated-score flag. Run: cd server && node --test core/kb/localRerank.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
let providerImpl;
let providerCalls = 0;

const localRerank = require('./localRerank');

let CONFIG = {};
let llamaOn = false;
const rows = [{ id: 1, content: 'a', score: 0.03 }, { id: 2, content: 'b', score: 0.02 }];
localRerank.wire({
    configStore: { async getConfig(k) { return CONFIG[k]; }, async getSecret() { return CONFIG.secret; } },
    loadLlamaCppRerank: () => ({
        isAvailable: async () => llamaOn,
        rerankLlamaCpp: async () => [{ index: 0, relevance_score: 0.4 }],
    }),
    loadProviderRerank: () => ({ async providerRerank(a) { providerCalls++; return providerImpl(a); } }),
});

const realFetch = global.fetch;
let fetched = [];
beforeEach(() => {
    CONFIG = { rerank_provider_id: 'p1', rerank_model: 'm', cpu_reranker_enabled: false };
    llamaOn = false; providerCalls = 0; fetched = [];
    providerImpl = async () => [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }];
    global.fetch = async (url) => { fetched.push(String(url)); return { ok: false, status: 500, async text() { return ''; } }; };
});
test.after(() => { global.fetch = realFetch; });

test('the provider tier reorders rows and carries the score', async () => {
    const out = await localRerank.rerankCandidates(rows, 'q', 2);
    assert.deepStrictEqual(out.map(r => [r.id, r.score]), [[2, 0.9], [1, 0.1]]);
});

test('not configured: the provider is never called', async () => {
    CONFIG.rerank_model = '';
    await localRerank.rerankCandidates(rows, 'q', 2);
    assert.strictEqual(providerCalls, 0);
});

test('llama.cpp opt-in goes before the provider tier', async () => {
    llamaOn = true;
    const out = await localRerank.rerankCandidates(rows, 'q', 2);
    assert.strictEqual(providerCalls, 0);
    assert.strictEqual(out[0].score, 0.4);
});

test('an error falls through to Azure Cohere', async () => {
    providerImpl = async () => { throw new Error('boom'); };
    CONFIG.azure_reranker_endpoint = 'https://az.example';
    CONFIG.secret = 'k';
    const out = await localRerank.rerankCandidates(rows, 'q', 2);
    assert.ok(fetched[0].startsWith('https://az.example'), 'azure was tried');
    assert.deepStrictEqual(out, rows);
});

test('the provider tier goes before Azure when both are configured', async () => {
    CONFIG.azure_reranker_endpoint = 'https://az.example';
    CONFIG.secret = 'k';
    await localRerank.rerankCandidates(rows, 'q', 2);
    assert.strictEqual(fetched.length, 0);
});

test('a configured provider tier means the CPU tier is not reached', () => {
    assert.strictEqual(localRerank.cpuTierConfigured({ llamaCppEnabled: false, providerId: 'p', providerModel: 'm', cpuEnabled: true }), false);
    assert.strictEqual(localRerank.cpuTierConfigured({ llamaCppEnabled: false, cpuEnabled: true }), true);
});

test('hasCalibratedReranker counts the provider tier', async () => {
    const { hasCalibratedReranker } = require('../agentRuntime/knowledgeRanking');
    const store = { async getConfig(k) { return CONFIG[k]; } };
    assert.strictEqual(await hasCalibratedReranker(store), true);
    CONFIG.rerank_model = '';
    assert.strictEqual(await hasCalibratedReranker(store), false);
});

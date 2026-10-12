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
 * Run: cd server && node --test core/embed/dispatch.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Mutable config/target so the Azure tests below can set them per test; the
// prefix tests leave them empty.
const config = {};
const secrets = {};
let target = null;
const stub = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub(path.join(__dirname, '..', '..', 'stores', 'configStore.js'), {
    async getConfig(k) { return config[k]; },
    async getSecret(k) { return secrets[k] ?? null; },
});
stub(path.join(__dirname, 'resolveTarget.js'), { async resolveEmbedTarget() { return target; } });

const { applyModelPrefix, dispatchEmbedTexts, azureEmbed, _setSleepForTests } = require('./dispatch');
// A retry's backoff costs no wall-clock time here.
const waits = [];
_setSleepForTests(async (ms) => { waits.push(ms); });

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

// ── Azure: the v1 GA surface ──────────────────────────────────────────────────
// Azure embeddings go to `POST <origin>/openai/v1/embeddings` with the deployment
// name as `model` in the body and no `api-version`: the same base URL the chat
// adapter builds (utils/azureUrl.js). The old dated route
// (`/openai/deployments/<x>/embeddings?api-version=2024-06-01`) must not come back.

const realFetch = global.fetch;
let calls = [];
function captureFetch() {
    calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url: String(url), init, body: JSON.parse(init.body) });
        const n = JSON.parse(init.body).input.length;
        return new Response(JSON.stringify({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: [index, 1] })) }), { status: 200 });
    };
}
afterEach(() => {
    global.fetch = realFetch;
    target = null;
    for (const k of Object.keys(config)) delete config[k];
    for (const k of Object.keys(secrets)) delete secrets[k];
});

test('configured Azure provider: v1 URL, deployment as model, api-key header, no api-version', async () => {
    captureFetch();
    target = { providerType: 'azure', providerName: 'Azure', endpoint: 'https://res.openai.azure.com/openai/', apiKey: 'k', modelId: 'prod embed' };
    const { vectors, source } = await dispatchEmbedTexts(['a', 'b']);
    assert.strictEqual(source, 'provider');
    assert.strictEqual(vectors.length, 2);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://res.openai.azure.com/openai/v1/embeddings');
    assert.ok(!calls[0].url.includes('api-version'));
    assert.ok(!calls[0].url.includes('/deployments/'));
    assert.deepStrictEqual(calls[0].body, { model: 'prod embed', input: ['a', 'b'] });
    assert.strictEqual(calls[0].init.headers['api-key'], 'k');
    assert.strictEqual(calls[0].init.method, 'POST');
});

test('a pasted dated Azure URL is normalised to v1 too', async () => {
    captureFetch();
    target = {
        providerType: 'azure', apiKey: 'k', modelId: 'emb',
        endpoint: 'https://res.services.ai.azure.com/openai/deployments/emb/embeddings?api-version=2024-06-01',
    };
    await dispatchEmbedTexts(['x']);
    assert.strictEqual(calls[0].url, 'https://res.services.ai.azure.com/openai/v1/embeddings');
});

test('legacy azure_openai_embedding_* config: v1 URL and deployment as model', async () => {
    captureFetch();
    config.azure_openai_embedding_endpoint = 'https://legacy.openai.azure.com/';
    config.azure_openai_embedding_model = 'text-embedding-3-small';
    secrets.azure_openai_embedding_key = 'lk';
    const { source } = await dispatchEmbedTexts(['q']);
    assert.strictEqual(source, 'azure');
    assert.strictEqual(calls[0].url, 'https://legacy.openai.azure.com/openai/v1/embeddings');
    assert.deepStrictEqual(calls[0].body, { model: 'text-embedding-3-small', input: ['q'] });
    assert.strictEqual(calls[0].init.headers['api-key'], 'lk');
});

test('azureEmbed batches by 16 and every batch carries the deployment', async () => {
    captureFetch();
    const texts = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const out = await azureEmbed(texts, 'https://r.openai.azure.com', 'k', 'dep');
    assert.strictEqual(out.length, 20);
    assert.strictEqual(calls.length, 2);
    for (const c of calls) {
        assert.strictEqual(c.url, 'https://r.openai.azure.com/openai/v1/embeddings');
        assert.strictEqual(c.body.model, 'dep');
    }
});

test('non-Azure providers keep their own /v1/embeddings route and Bearer auth', async () => {
    captureFetch();
    target = { providerType: 'openai', endpoint: 'https://api.openai.com', apiKey: 'sk', modelId: 'text-embedding-3-small' };
    await dispatchEmbedTexts(['x']);
    assert.strictEqual(calls[0].url, 'https://api.openai.com/v1/embeddings');
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer sk');
    assert.deepStrictEqual(calls[0].body, { model: 'text-embedding-3-small', input: ['x'] });
});

// ── Temporary provider failures are waited out ───────────────────────────────
// A 975-page PDF is hundreds of batches; a per-minute quota answers 429 halfway.
// That one batch used to throw the whole document over to the CPU embedder
// (384 dims), which the 1536-dim column then refused.

function scriptedFetch(script) {
    calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        const step = script.shift();
        if (step instanceof Error) throw step;
        if (step && step.status !== 200) {
            return new Response('slow down', { status: step.status, headers: step.headers || {} });
        }
        const n = JSON.parse(init.body).input.length;
        return new Response(JSON.stringify({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: [index, 1] })) }), { status: 200 });
    };
}

test('a 429 is retried (Retry-After honoured) and the provider still answers', async () => {
    waits.length = 0;
    scriptedFetch([{ status: 429, headers: { 'retry-after': '3' } }, { status: 503 }, { status: 200 }]);
    target = { providerType: 'openai', endpoint: 'https://api.example.com/v1', apiKey: 'k', modelId: 'text-embedding-3-small' };
    const { vectors, source, providerError } = await dispatchEmbedTexts(['a', 'b']);
    assert.strictEqual(source, 'provider');
    assert.strictEqual(vectors.length, 2);
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(waits[0], 3000, 'Retry-After in seconds becomes the wait');
    assert.strictEqual(providerError, undefined);
});

test('a timeout is retried like a 429', async () => {
    waits.length = 0;
    scriptedFetch([new Error('The operation was aborted due to timeout'), { status: 200 }]);
    target = { providerType: 'openai', endpoint: 'https://api.example.com/v1', apiKey: 'k', modelId: 'm' };
    const { source } = await dispatchEmbedTexts(['a']);
    assert.strictEqual(source, 'provider');
    assert.strictEqual(waits.length, 1);
});

test('a 400 is not retried, and the reason travels with the fallback', async () => {
    waits.length = 0;
    scriptedFetch([{ status: 400 }]);
    target = { providerType: 'openai', providerName: 'OpenAI', endpoint: 'https://api.example.com/v1', apiKey: 'k', modelId: 'm' };
    const res = await dispatchEmbedTexts(['a'], { strict: false }).catch((e) => ({ thrown: e }));
    assert.strictEqual(calls.length, 1, 'a client error is final');
    assert.strictEqual(waits.length, 0);
    assert.match(String(res.providerError), /OpenAI embed 400/);
});

test('strict: a 429 that never clears throws after the retries', async () => {
    waits.length = 0;
    scriptedFetch([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    target = { providerType: 'openai', endpoint: 'https://api.example.com/v1', apiKey: 'k', modelId: 'm' };
    await assert.rejects(dispatchEmbedTexts(['a'], { strict: true }), /embed 429/);
    assert.strictEqual(calls.length, 5);
});

// ── Azure: the same retry on both Azure paths ────────────────────────────────
// Azure OpenAI / AI Foundry deployments have a tokens-per-minute quota and answer
// 429 with Retry-After. A configured Azure provider and the legacy
// azure_openai_embedding_* keys must both wait it out instead of falling to CPU.

test('configured Azure provider: a 429 is waited out, the vectors stay Azure', async () => {
    waits.length = 0;
    scriptedFetch([{ status: 429, headers: { 'retry-after': '7' } }, { status: 200 }]);
    target = { providerType: 'azure', providerName: 'Azure', endpoint: 'https://res.openai.azure.com/', apiKey: 'k', modelId: 'text-embedding-3-small' };
    const { source, vectors } = await dispatchEmbedTexts(['a']);
    assert.strictEqual(source, 'provider');
    assert.strictEqual(vectors.length, 1);
    assert.deepStrictEqual(waits, [7000]);
    assert.ok(calls.every(c => c.url === 'https://res.openai.azure.com/openai/v1/embeddings'));
});

test('legacy Azure config: a 429 is waited out instead of falling to the CPU embedder', async () => {
    waits.length = 0;
    scriptedFetch([{ status: 429 }, { status: 200 }]);
    config.azure_openai_embedding_endpoint = 'https://legacy.openai.azure.com/';
    config.azure_openai_embedding_model = 'text-embedding-3-small';
    secrets.azure_openai_embedding_key = 'lk';
    const { source } = await dispatchEmbedTexts(['q']);
    assert.strictEqual(source, 'azure');
    assert.strictEqual(calls.length, 2);
});

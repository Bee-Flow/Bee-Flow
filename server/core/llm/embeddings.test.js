/**
 * generateEmbedding: which provider and model it picks, the request it
 * sends, the usage row it logs, and how it fails.
 *
 * Run: node --test --test-force-exit core/llm/embeddings.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const store = { ai: null };
const usage = { rows: [], failing: false };

const restore = installResolveStub({
    '../../stores/configStore': {
        getConfig: async (key) => (key === 'ai' ? store.ai : null),
        setConfig: async () => {},
        getSecret: async () => null,
        setSecret: async () => {},
    },
    '../../stores/usageStore': {
        logUsage: async (row) => {
            if (usage.failing) throw new Error('usage table is down');
            usage.rows.push(row);
        },
    },
});
test.after(() => restore());

const { generateEmbedding } = require('./embeddings');

const VECTOR = [0.1, 0.2, 0.3];
const requests = [];

function stubFetch(t, { status = 200, body = { data: [{ embedding: VECTOR }], usage: { prompt_tokens: 7, total_tokens: 7 } } } = {}) {
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    });
}

test.beforeEach(() => {
    store.ai = null;
    usage.rows = [];
    usage.failing = false;
    requests.length = 0;
});

const providers = () => [
    { id: 'chat', name: 'Chat', type: 'openai', url: 'https://chat.example/v1', model: 'gpt-4o', apiKey: 'chat-key' },
    { id: 'emb', name: 'Embed', type: 'mistral', url: 'https://embed.example', model: 'mistral-embed', apiKey: 'embed-key' },
];

test('uses the explicit embedding provider and the global embedding model, and logs the usage', async (t) => {
    stubFetch(t);
    store.ai = { providers: providers(), defaultProviderId: 'chat', embeddingProviderId: 'emb', embeddingModel: 'text-embedding-3-small' };

    const vec = await generateEmbedding('hello', { agentId: 'a1', agentName: 'Bea', source: 'kb_ingest' });

    assert.deepStrictEqual(vec, VECTOR);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].url, 'https://embed.example/v1/embeddings', '/v1 is appended when the URL lacks it');
    assert.strictEqual(requests[0].headers.Authorization, 'Bearer embed-key');
    assert.deepStrictEqual(requests[0].body, { model: 'text-embedding-3-small', input: 'hello' });

    assert.strictEqual(usage.rows.length, 1);
    assert.deepStrictEqual(usage.rows[0], {
        agent_id: 'a1', agent_name: 'Bea', model: 'text-embedding-3-small',
        prompt_tokens: 7, completion_tokens: 0, total_tokens: 7, source: 'kb_ingest',
    });
});

test('without an explicit embedding provider the default provider is used, and the model falls back to mistral-embed', async (t) => {
    stubFetch(t);
    store.ai = { providers: providers(), defaultProviderId: 'chat' };
    await generateEmbedding('x');
    assert.strictEqual(requests[0].url, 'https://chat.example/v1/embeddings', 'a URL already ending in /v1 is not doubled');
    assert.strictEqual(requests[0].headers.Authorization, 'Bearer chat-key');
    assert.strictEqual(requests[0].body.model, 'mistral-embed', 'gpt-4o is not an embedding model, so the default applies');
});

test('a provider whose own model is an embedding model is used when no global model is set', async (t) => {
    stubFetch(t);
    store.ai = { providers: providers(), embeddingProviderId: 'emb' };
    await generateEmbedding('x');
    assert.strictEqual(requests[0].body.model, 'mistral-embed');

    requests.length = 0;
    store.ai = { providers: [{ ...providers()[1], model: 'nomic-embedding-v2' }], embeddingProviderId: 'emb' };
    await generateEmbedding('x');
    assert.strictEqual(requests[0].body.model, 'nomic-embedding-v2');
});

test('with no default the first provider serves; with no providers the legacy fields do', async (t) => {
    stubFetch(t);
    store.ai = { providers: providers() };
    await generateEmbedding('x');
    assert.strictEqual(requests[0].url, 'https://chat.example/v1/embeddings');

    requests.length = 0;
    store.ai = { url: 'https://legacy.example/', apiKey: 'legacy-key' };
    await generateEmbedding('x');
    assert.strictEqual(requests[0].url, 'https://legacy.example/v1/embeddings');
    assert.strictEqual(requests[0].headers.Authorization, 'Bearer legacy-key');
    assert.strictEqual(requests[0].body.model, 'mistral-embed');
});

test('the usage row defaults to a system knowledge-embedding entry, and its failure does not fail the call', async (t) => {
    stubFetch(t);
    store.ai = { providers: providers(), defaultProviderId: 'emb' };
    await generateEmbedding('x');
    assert.strictEqual(usage.rows[0].agent_name, 'system');
    assert.strictEqual(usage.rows[0].agent_id, null);
    assert.strictEqual(usage.rows[0].source, 'knowledge_embedding');

    usage.failing = true;
    assert.deepStrictEqual(await generateEmbedding('x'), VECTOR);
});

test('a non-2xx answer throws with the status, and an answer without a vector throws too', async (t) => {
    store.ai = { providers: providers(), defaultProviderId: 'emb' };
    stubFetch(t, { status: 401, body: 'bad key' });
    await assert.rejects(() => generateEmbedding('x'), /Embedding API Error: 401 - bad key/);

    stubFetch(t, { body: { data: [] } });
    await assert.rejects(() => generateEmbedding('x'), /No embedding found in response/);
    assert.strictEqual(usage.rows.length, 0, 'nothing is logged for a failed request');
});

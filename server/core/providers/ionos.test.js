// @typecheck
/**
 * Unit tests: IONOS AI Model Hub adapter + catalog.
 *
 * Run: node --test core/providers/ionos.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const IonosProvider = require('./ionos');
const { getAdapter } = require('./index');
const {
    IONOS_BASE_URL,
    describeIonosModel,
    normalizeIonosName,
    normalizeReasoningEffort,
    clampMaxTokens,
    ionosPricingKey,
    getIonosListPrice,
    isIonosServedModel,
    _resetIonosModelRegistry,
} = require('./ionosModels');

const ionos = new IonosProvider();

test('normalises names: org prefix, case, separators and release suffixes', () => {
    assert.strictEqual(normalizeIonosName('meta-llama/Llama-3.3-70B-Instruct'), 'llama-3-3-70b');
    assert.strictEqual(normalizeIonosName('openai/gpt-oss-120b'), 'gpt-oss-120b');
    assert.strictEqual(normalizeIonosName('Qwen/Qwen3.5-9B-FP8'), 'qwen3-5-9b');
    assert.strictEqual(normalizeIonosName('mistralai/Mistral-Small-24B-Instruct-2501'), 'mistral-small-24b');
    assert.strictEqual(normalizeIonosName('Qwen3_8 27B'), 'qwen3-8-27b');
});

test('describes catalogued models by normalised name, stamped ionos', () => {
    const llama = describeIonosModel('meta-llama/Llama-3.3-70B-Instruct');
    assert.strictEqual(llama.ionos, true);
    assert.strictEqual(llama.id, 'meta-llama/Llama-3.3-70B-Instruct');
    const gptOss = describeIonosModel('openai/gpt-oss-120b');
    assert.strictEqual(gptOss.reasoning, true);
    const qwen = describeIonosModel('Qwen/Qwen3.5-9B');
    assert.deepStrictEqual([qwen.vision, qwen.tools, qwen.reasoning, qwen.context], [true, true, true, 262_144]);
    // Limits that were not stated stay unset.
    assert.strictEqual(describeIonosModel('Qwen/Qwen3.5-397B-A17B').context, null);
    assert.strictEqual(describeIonosModel('Qwen/Qwen3.5-397B-A17B').maxOutput, null);
});

test('embedding and rerank models carry their flags', () => {
    const bge = describeIonosModel('BAAI/bge-m3');
    assert.strictEqual(bge.embedding, true);
    assert.strictEqual(bge.dims, 1024);
    assert.strictEqual(describeIonosModel('Qwen/Qwen3-VL-Reranker-8B').rerank, true);
    assert.strictEqual(describeIonosModel('Qwen/Qwen3-VL-Reranker-8B').embedding, false);
    assert.strictEqual(describeIonosModel('sentence-transformers/paraphrase-multilingual-mpnet-base-v2').dims, 768);
    assert.strictEqual(bge.matryoshka, null);
    // IONOS states neither a length nor a shortening range for it, so none is
    // assumed: its vectors are never shortened.
    const qwenVl = describeIonosModel('Qwen/Qwen3-VL-Embedding-8B');
    assert.strictEqual(qwenVl.embedding, true);
    assert.strictEqual(qwenVl.dims, null);
    assert.strictEqual(qwenVl.matryoshka, null);
});

test('an unknown id falls back to the family guess and carries no price', () => {
    const m = describeIonosModel('acme/brand-new-model-7b');
    assert.strictEqual(m.ionos, true);
    assert.strictEqual(m.context, null);
    assert.strictEqual(getIonosListPrice('acme/brand-new-model-7b'), null);
    assert.strictEqual(ionosPricingKey('acme/brand-new-model-7b'), null);
});

test('list prices (EUR per 1M); the retiring mpnet model has none', () => {
    assert.deepStrictEqual(getIonosListPrice('openai/gpt-oss-120b'), { input: 0.15, output: 0.65, cacheRead: 0 });
    assert.deepStrictEqual(getIonosListPrice('meta-llama/Llama-3.3-70B-Instruct'), { input: 0.65, output: 0.65, cacheRead: 0 });
    assert.deepStrictEqual(getIonosListPrice('BAAI/bge-m3'), { input: 0.02, output: 0, cacheRead: 0 });
    assert.deepStrictEqual(getIonosListPrice('Qwen/Qwen3-VL-Reranker-8B'), { input: 0.04, output: 0, cacheRead: 0 });
    assert.strictEqual(getIonosListPrice('sentence-transformers/paraphrase-multilingual-mpnet-base-v2'), null);
});

test('pricing key is ionos/<org>/<served id without org>', () => {
    assert.strictEqual(ionosPricingKey('openai/gpt-oss-120b'), 'ionos/openai/gpt-oss-120b');
    assert.strictEqual(ionosPricingKey('meta-llama/Llama-3.3-70B-Instruct'), 'ionos/meta-llama/llama-3.3-70b-instruct');
});

test('reasoning_effort: only gpt-oss has a known vocabulary', () => {
    assert.strictEqual(normalizeReasoningEffort('openai/gpt-oss-120b', 'high'), 'high');
    assert.strictEqual(normalizeReasoningEffort('openai/gpt-oss-120b', 'none'), null);
    assert.strictEqual(normalizeReasoningEffort('Qwen/Qwen3.5-9B', 'high'), null);
    assert.strictEqual(normalizeReasoningEffort('acme/unknown', 'high'), null);
});

test('max_tokens passes through when no cap is known', () => {
    assert.strictEqual(clampMaxTokens('openai/gpt-oss-120b', 5000), 5000);
    assert.strictEqual(clampMaxTokens('openai/gpt-oss-120b', 0), undefined);
});

test('adapter resolves by stored type and by URL', () => {
    assert.strictEqual(getAdapter('ionos').name, 'ionos');
    assert.strictEqual(getAdapter(null, IONOS_BASE_URL).name, 'ionos');
});

test('request body: usage chunk on streams, effort only where supported', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    const body = ionos.buildRequestBody('openai/gpt-oss-120b', msgs, { stream: true, reasoningEffort: 'low', maxTokens: 100 });
    assert.deepStrictEqual(body.stream_options, { include_usage: true });
    assert.strictEqual(body.reasoning_effort, 'low');
    const qwen = ionos.buildRequestBody('Qwen/Qwen3.5-9B', msgs, { reasoningEffort: 'low' });
    assert.strictEqual(qwen.reasoning_effort, undefined);
    assert.strictEqual(qwen.stream_options, undefined);
});

test('capabilities come from the catalog', () => {
    assert.strictEqual(ionos.supportsVision('Qwen/Qwen3.5-9B'), true);
    assert.strictEqual(ionos.supportsVision('openai/gpt-oss-120b'), false);
    assert.strictEqual(ionos.supportsReasoning('openai/gpt-oss-120b'), true);
});

// ─── listModels against a local server ───────────────────────────────────────

/** @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler */
async function withServer(handler, fn) {
    const server = http.createServer(handler);
    await new Promise(r => server.listen(0, '127.0.0.1', () => r(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    try { return await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

test('listModels reads /v1/models (base URL with or without /v1), describes and registers each id', async () => {
    _resetIonosModelRegistry();
    /** @type {string[]} */
    const seen = [];
    await withServer((req, res) => {
        seen.push(`${req.url} ${req.headers.authorization}`);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'BAAI/bge-m3' }, { id: 'acme/x' }] }));
    }, async (base) => {
        const a = await ionos.listModels('tok', base);
        const b = await ionos.listModels('tok', `${base}/v1/`);
        assert.deepStrictEqual(a.map(m => m.id), ['openai/gpt-oss-120b', 'BAAI/bge-m3', 'acme/x']);
        assert.strictEqual(b.length, 3);
        assert.strictEqual(a[1].embedding, true);
    });
    assert.deepStrictEqual(seen, ['/v1/models Bearer tok', '/v1/models Bearer tok']);
    assert.strictEqual(isIonosServedModel('openai/gpt-oss-120b'), true);
    assert.strictEqual(isIonosServedModel('nope'), false);
});

test('listModels returns [] on an HTTP error and registers nothing', async () => {
    _resetIonosModelRegistry();
    await withServer((_req, res) => { res.statusCode = 401; res.end('{}'); }, async (base) => {
        assert.deepStrictEqual(await ionos.listModels('bad', base), []);
    });
    assert.strictEqual(isIonosServedModel('openai/gpt-oss-120b'), false);
});

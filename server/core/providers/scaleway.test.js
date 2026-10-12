/**
 * Unit tests — Scaleway Generative APIs adapter + serverless model catalog.
 *
 * Run: node --test core/providers/scaleway.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const ScalewayProvider = require('./scaleway');
const { getAdapter } = require('./index');
const {
    SCALEWAY_BASE_URL,
    SCALEWAY_MODELS,
    describeScalewayModel,
    listServerlessModels,
    normalizeScalewayModelId,
    normalizeReasoningEffort,
    clampMaxTokens,
    scalewayPricingKey,
    getScalewayListPrice,
    isScalewayServedModel,
    _resetScalewayModelRegistry,
} = require('./scalewayModels');

const scaleway = new ScalewayProvider();

// ─── catalog ─────────────────────────────────────────────────────────────────

test('the catalog carries every model Generative APIs serves serverless', () => {
    // The console's Serverless filter, 2026-08-15. Kept as a literal list so a
    // catalog edit that silently drops one fails here rather than in the UI.
    const expected = [
        'bge-multilingual-gemma2',
        'deepseek-v4-flash-0731',
        'gemma-4-26b-a4b-it',
        'glm-5.2',
        'gpt-oss-120b',
        'llama-3.3-70b-instruct',
        'mistral-medium-3.5-128b',
        'mistral-small-3.2-24b-instruct-2506',
        'pixtral-12b-2409',
        'qwen3-235b-a22b-instruct-2507',
        'qwen3-coder-30b-a3b-instruct',
        'qwen3-embedding-8b',
        'qwen3.5-397b-a17b',
        'qwen3.6-35b-a3b',
        'whisper-large-v3',
    ];
    assert.deepStrictEqual(listServerlessModels().map(m => m.id).sort(), expected);
});

test('describes capabilities, limits and category from the catalog', () => {
    const qwen = describeScalewayModel('qwen3.5-397b-a17b');
    assert.strictEqual(qwen.cat, 'Reasoning');
    assert.strictEqual(qwen.vision, true);
    assert.strictEqual(qwen.tools, true);
    assert.strictEqual(qwen.reasoning, true);
    assert.strictEqual(qwen.context, 250_000);
    assert.strictEqual(qwen.maxOutput, 16_384);
    assert.strictEqual(qwen.scaleway, true);

    const embed = describeScalewayModel('qwen3-embedding-8b');
    assert.strictEqual(embed.cat, 'Embedding');
    assert.strictEqual(embed.embedding, true);

    // Vision-capable but not a reasoning model — the flags are independent.
    const small = describeScalewayModel('mistral-small-3.2-24b-instruct-2506');
    assert.strictEqual(small.vision, true);
    assert.strictEqual(small.reasoning, false);
});

test('a model Scaleway adds later still gets a family-based description', () => {
    // Not in the catalog: the open-weight family patterns have to carry it, or
    // it shows up in the tier picker as an unlabelled string.
    const m = describeScalewayModel('qwen4-500b-a30b-instruct');
    assert.strictEqual(m.cat, 'Generalist');
    assert.strictEqual(m.tools, true);
    assert.strictEqual(m.scaleway, true);
    // No invented limits for a model we know nothing about.
    assert.strictEqual(m.context, null);
    assert.strictEqual(m.maxOutput, null);
});

test('accepts a vendor-qualified id, which routing layers write', () => {
    assert.strictEqual(normalizeScalewayModelId('qwen/qwen3.6-35b-a3b'), 'qwen3.6-35b-a3b');
    assert.strictEqual(describeScalewayModel('qwen/qwen3.6-35b-a3b').name, 'Qwen3.6 35B A3B');
    // The raw id is what goes over the wire — normalisation is lookup-only.
    assert.strictEqual(describeScalewayModel('qwen/qwen3.6-35b-a3b').id, 'qwen/qwen3.6-35b-a3b');
});

test('adapter resolves by stored type and by URL', () => {
    assert.strictEqual(getAdapter('scaleway').name, 'scaleway');
    assert.strictEqual(getAdapter(null, SCALEWAY_BASE_URL).name, 'scaleway');
    // Project-scoped endpoints live on the same host.
    assert.strictEqual(
        getAdapter(null, 'https://api.scaleway.ai/11111111-2222-3333-4444-555555555555/v1').name,
        'scaleway',
    );
});

// ─── reasoning_effort ────────────────────────────────────────────────────────

test('drops reasoning_effort=none for the one model that has no off switch', () => {
    // gpt-oss-120b rejects `none` with a 400. Title generation asks every
    // provider for `none`, so passing it through would break titles outright.
    assert.strictEqual(normalizeReasoningEffort('gpt-oss-120b', 'none'), null);
    assert.strictEqual(normalizeReasoningEffort('gpt-oss-120b', 'high'), 'high');
});

test('honours per-model effort vocabularies', () => {
    // GLM-5.2 speaks none/high/max — `medium` is not in its vocabulary.
    assert.strictEqual(normalizeReasoningEffort('glm-5.2', 'max'), 'max');
    assert.strictEqual(normalizeReasoningEffort('glm-5.2', 'medium'), null);
    // A standard reasoning model takes the usual four.
    assert.strictEqual(normalizeReasoningEffort('qwen3.6-35b-a3b', 'none'), 'none');
    assert.strictEqual(normalizeReasoningEffort('qwen3.6-35b-a3b', 'medium'), 'medium');
});

test('never sends reasoning_effort to a non-reasoning model', () => {
    assert.strictEqual(normalizeReasoningEffort('mistral-small-3.2-24b-instruct-2506', 'high'), null);
    assert.strictEqual(normalizeReasoningEffort('llama-3.3-70b-instruct', 'low'), null);
});

test('body carries the coerced effort, not the requested one', () => {
    const body = scaleway.buildRequestBody('gpt-oss-120b', [{ role: 'user', content: 'hi' }], {
        reasoningEffort: 'none',
    });
    assert.strictEqual(body.reasoning_effort, undefined);

    const glm = scaleway.buildRequestBody('glm-5.2', [{ role: 'user', content: 'hi' }], {
        reasoningEffort: 'high',
    });
    assert.strictEqual(glm.reasoning_effort, 'high');
});

test('an explicit extraBody effort wins over the coercion', () => {
    const body = scaleway.buildRequestBody('gpt-oss-120b', [], {
        reasoningEffort: 'none',
        extraBody: { reasoning_effort: 'high' },
    });
    assert.strictEqual(body.reasoning_effort, 'high');
});

// ─── max_tokens ──────────────────────────────────────────────────────────────

test('clamps max_tokens to the serverless output cap', () => {
    // 250k context but only 16k of output — asking for more is a 400.
    assert.strictEqual(clampMaxTokens('qwen3.5-397b-a17b', 100_000), 16_384);
    assert.strictEqual(clampMaxTokens('qwen3.5-397b-a17b', 4_000), 4_000);
    assert.strictEqual(clampMaxTokens('pixtral-12b-2409', 8_000), 4_096);
    // Unknown model: no cap to apply, so pass the request through untouched.
    assert.strictEqual(clampMaxTokens('some-new-model', 100_000), 100_000);
    assert.strictEqual(clampMaxTokens('gpt-oss-120b', undefined), undefined);
});

test('request body clamps rather than forwarding an over-cap max_tokens', () => {
    const body = scaleway.buildRequestBody('mistral-medium-3.5-128b', [], { maxTokens: 60_000 });
    assert.strictEqual(body.max_tokens, 16_384);
});

// ─── streaming usage ─────────────────────────────────────────────────────────

test('asks for the usage chunk only when streaming', () => {
    const streamed = scaleway.buildRequestBody('gpt-oss-120b', [], { stream: true });
    assert.deepStrictEqual(streamed.stream_options, { include_usage: true });

    const plain = scaleway.buildRequestBody('gpt-oss-120b', [], { stream: false });
    assert.strictEqual(plain.stream_options, undefined);
});

test('streamed turns report real token counts instead of billing as zero', async () => {
    // include_usage puts usage in a trailing chunk whose `choices` is empty —
    // the shape that used to be skipped before the delta guard.
    const sse = [
        'data: {"choices":[{"delta":{"content":"Bonjour"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15,'
            + '"prompt_tokens_details":{"cached_tokens":8}}}',
        'data: [DONE]',
        '',
    ].join('\n');

    const events = [];
    await scaleway._parseSseStream(
        (async function* () { yield Buffer.from(sse); })(),
        (type, data) => events.push([type, data]),
    );

    const done = events.find(([type]) => type === 'done');
    // The normalised usage (usageNormalizer.js) carries more than these counts.
    assert.deepStrictEqual(
        Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens'].map((k) => [k, done[1][k]])),
        { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15, cached_tokens: 8, reasoning_tokens: 0 });
    assert.deepStrictEqual(events.find(([type]) => type === 'text')[1], { text: 'Bonjour' });
});

// ─── discovery ───────────────────────────────────────────────────────────────

test('discovers models over /v1/models and enriches them from the catalog', async (t) => {
    _resetScalewayModelRegistry();
    const urls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({
            data: [{ id: 'qwen3.6-35b-a3b' }, { id: 'gpt-oss-120b' }],
        }), { status: 200 });
    });

    const models = await scaleway.listModels('scw-secret', SCALEWAY_BASE_URL);
    assert.deepStrictEqual(urls, ['https://api.scaleway.ai/v1/models']);
    assert.deepStrictEqual(models.map(m => m.name), ['Qwen3.6 35B A3B', 'GPT-OSS 120B']);
    assert.strictEqual(models[0].vision, true);
    // Discovery is what proves these are Scaleway-served, so it registers them.
    assert.strictEqual(isScalewayServedModel('gpt-oss-120b'), true);
});

test('appends /v1 only when the configured URL lacks it', async (t) => {
    const urls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    await scaleway.listModels('k', 'https://api.scaleway.ai');
    await scaleway.listModels('k', 'https://api.scaleway.ai/v1');
    await scaleway.listModels('k', 'https://api.scaleway.ai/project-id/v1/');
    assert.deepStrictEqual(urls, [
        'https://api.scaleway.ai/v1/models',
        'https://api.scaleway.ai/v1/models',
        'https://api.scaleway.ai/project-id/v1/models',
    ]);
});

test('a rejected key yields no models rather than the shipped catalog', async (t) => {
    // A provider that answers with fifteen models it cannot actually serve
    // would win model resolution and 401 every chat routed to it.
    t.mock.method(globalThis, 'fetch', async () => new Response('unauthorized', { status: 401 }));
    assert.deepStrictEqual(await scaleway.listModels('bad-key', SCALEWAY_BASE_URL), []);

    t.mock.method(globalThis, 'fetch', async () => { throw new Error('ENOTFOUND'); });
    assert.deepStrictEqual(await scaleway.listModels('k', SCALEWAY_BASE_URL), []);
});

test('sends the secret key as a bearer token', () => {
    assert.strictEqual(scaleway.getHeaders('scw-abc').Authorization, 'Bearer scw-abc');
});

// ─── pricing ─────────────────────────────────────────────────────────────────

test('builds the exact community-pricing key, vendor segment included', () => {
    assert.strictEqual(scalewayPricingKey('qwen3.6-35b-a3b'), 'scaleway/qwen/qwen3.6-35b-a3b');
    assert.strictEqual(scalewayPricingKey('gpt-oss-120b'), 'scaleway/openai/gpt-oss-120b');
    // Case-sensitive vendor segments are preserved.
    assert.strictEqual(scalewayPricingKey('bge-multilingual-gemma2'), 'scaleway/BAAI/bge-multilingual-gemma2');
    // Unknown model — no key to guess, so cost falls through to other sources.
    assert.strictEqual(scalewayPricingKey('some-new-model'), null);
});

test('carries a list price for preview models the pricing database lacks', () => {
    // glm-5.2 and deepseek-v4-flash-0731 landed in the console before the
    // community database picked them up.
    assert.deepStrictEqual(getScalewayListPrice('glm-5.2'), { input: 1.80, output: 5.50, cacheRead: 0 });
    assert.deepStrictEqual(
        getScalewayListPrice('deepseek-v4-flash-0731'),
        { input: 0.40, output: 0.80, cacheRead: 0.08 },
    );
    // Whisper is billed per audio minute — no per-token rate to report.
    assert.strictEqual(getScalewayListPrice('whisper-large-v3'), null);
});

test('every priced serverless model has a rate we can fall back to', () => {
    for (const m of listServerlessModels()) {
        if (SCALEWAY_MODELS[m.id].price === null) continue; // per-minute billing
        const price = getScalewayListPrice(m.id);
        assert.ok(price, `${m.id} has no list price`);
        assert.ok(Number.isFinite(price.input) && Number.isFinite(price.output), `${m.id} price is not numeric`);
    }
});

// Cost accounting itself is exercised in ../modelCosts.scaleway.test.js, which
// stubs the DB-backed config store the way the other cost tests do.

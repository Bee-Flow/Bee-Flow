/**
 * Unit tests for the shared usage normaliser.
 *
 * Run: node --test core/providers/usageNormalizer.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
    normalizeUsage,
    usageLogFields,
    createUsageAccumulator,
    trackUsageTotals,
    usageTotalsLogFields,
    emptyUsage,
} = require('./usageNormalizer');

// ─── Anthropic ──────────────────────────────────────────────────────

test('Anthropic: input_tokens stays the UNCACHED remainder, cache read/write ride beside it', () => {
    const u = normalizeUsage('claude', {
        input_tokens: 120,
        output_tokens: 80,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 700,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 500 },
        service_tier: 'standard',
        inference_geo: 'us',
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
    });
    assert.strictEqual(u.prompt_tokens, 120, 'not folded into a total: modelCosts relies on the remainder');
    assert.strictEqual(u.completion_tokens, 80);
    assert.strictEqual(u.total_tokens, 200);
    assert.strictEqual(u.cached_tokens, 5000);
    assert.strictEqual(u.cache_creation_tokens, 700);
    assert.strictEqual(u.cache_creation_5m_tokens, 200);
    assert.strictEqual(u.cache_creation_1h_tokens, 500);
    assert.strictEqual(u.cache_creation_ttl_assumed, false);
    assert.strictEqual(u.prompt_includes_cache, false);
    assert.strictEqual(u.service_tier, 'standard');
    assert.strictEqual(u.inference_geo, 'us');
    assert.deepStrictEqual(u.tool_use, { web_search_requests: 2, web_fetch_requests: 1 });
    // legacy single TTL: only derived, the split above is what to price
    assert.strictEqual(u.cache_ttl, '1h');
});

test('Anthropic: a mixed 5m/1h write keeps BOTH parts (no dominant-TTL attribution)', () => {
    const u = normalizeUsage('claude', {
        input_tokens: 10, output_tokens: 5,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 100 },
    });
    assert.strictEqual(u.cache_creation_5m_tokens, 900);
    assert.strictEqual(u.cache_creation_1h_tokens, 100);
    assert.strictEqual(u.cache_creation_5m_tokens + u.cache_creation_1h_tokens, u.cache_creation_tokens);
});

test('Anthropic: a write total without the TTL breakdown is attributed to 1h and flagged as assumed', () => {
    const u = normalizeUsage('claude', { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 400 });
    assert.strictEqual(u.cache_creation_tokens, 400);
    assert.strictEqual(u.cache_creation_1h_tokens, 400);
    assert.strictEqual(u.cache_creation_5m_tokens, 0);
    assert.strictEqual(u.cache_creation_ttl_assumed, true);
    assert.strictEqual(u.cache_ttl, '1h');
});

test('Anthropic: only the breakdown present -> the total is the sum of the parts', () => {
    const u = normalizeUsage('claude', {
        input_tokens: 1, output_tokens: 1,
        cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 0 },
    });
    assert.strictEqual(u.cache_creation_tokens, 30);
    assert.strictEqual(u.cache_ttl, '5m');
    assert.strictEqual(u.cache_creation_ttl_assumed, false);
});

test('Anthropic: bare input/output tokens are Anthropic only with the hint (else the Responses API reading applies)', () => {
    const hinted = normalizeUsage('claude', { input_tokens: 9, output_tokens: 4 });
    assert.strictEqual(hinted.prompt_includes_cache, false);
    const responses = normalizeUsage('openai', { input_tokens: 9, output_tokens: 4 });
    assert.strictEqual(responses.prompt_includes_cache, true);
    assert.strictEqual(responses.prompt_tokens, 9);
});

// ─── OpenAI-shaped ──────────────────────────────────────────────────

test('OpenAI Chat Completions: cached and reasoning counts, tier from the response meta', () => {
    const u = normalizeUsage('openai', {
        prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300,
        prompt_tokens_details: { cached_tokens: 640, audio_tokens: 12 },
        completion_tokens_details: { reasoning_tokens: 200 },
    }, { service_tier: 'flex' });
    assert.strictEqual(u.prompt_tokens, 1000);
    assert.strictEqual(u.prompt_includes_cache, true, 'cached is a subset of the prompt');
    assert.strictEqual(u.cached_tokens, 640);
    assert.strictEqual(u.reasoning_tokens, 200);
    assert.strictEqual(u.cache_creation_tokens, 0);
    assert.strictEqual(u.service_tier, 'flex');
    assert.deepStrictEqual(u.modality.prompt, { audio: 12 });
});

test('OpenAI Responses: input/output spelling and *_details', () => {
    const u = normalizeUsage('azure', {
        input_tokens: 50, output_tokens: 20,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens_details: { reasoning_tokens: 7 },
    });
    assert.deepStrictEqual(
        [u.prompt_tokens, u.completion_tokens, u.total_tokens, u.cached_tokens, u.reasoning_tokens],
        [50, 20, 70, 30, 7],
    );
});

test('Mistral SDK camelCase and local num_cached_tokens are read', () => {
    const m = normalizeUsage('mistral', {
        promptTokens: 40, completionTokens: 10, totalTokens: 50,
        promptTokensDetails: { cachedTokens: 25 },
    });
    assert.deepStrictEqual([m.prompt_tokens, m.completion_tokens, m.total_tokens, m.cached_tokens], [40, 10, 50, 25]);
    const l = normalizeUsage('scaleway', { prompt_tokens: 8, completion_tokens: 2, num_cached_tokens: 6 });
    assert.strictEqual(l.cached_tokens, 6);
});

// ─── Gemini / Vertex ────────────────────────────────────────────────

test('Gemini: thoughts are billed as output, tool-use prompt tokens as input, modalities and traffic type are kept', () => {
    const u = normalizeUsage('google', {
        promptTokenCount: 1000,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 400,
        cachedContentTokenCount: 600,
        toolUsePromptTokenCount: 50,
        totalTokenCount: 1550,
        trafficType: 'PROVISIONED_THROUGHPUT',
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 900 }, { modality: 'IMAGE', tokenCount: 100 }],
        candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 100 }],
        cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 600 }],
    });
    assert.strictEqual(u.prompt_tokens, 1050);
    assert.strictEqual(u.completion_tokens, 500);
    assert.strictEqual(u.total_tokens, 1550);
    assert.strictEqual(u.cached_tokens, 600);
    assert.strictEqual(u.reasoning_tokens, 400);
    assert.strictEqual(u.prompt_includes_cache, true);
    assert.strictEqual(u.traffic_type, 'provisioned_throughput');
    assert.deepStrictEqual(u.tool_use, { prompt_tokens: 50 });
    assert.deepStrictEqual(u.modality.prompt, { text: 900, image: 100 });
    assert.deepStrictEqual(u.modality.completion, { text: 100 });
    assert.deepStrictEqual(u.modality.cached, { text: 600 });
});

test('Gemini REST snake_case spelling is read too', () => {
    const u = normalizeUsage('google-vertex', {
        prompt_token_count: 11, candidates_token_count: 4, thoughts_token_count: 1, total_token_count: 16,
    });
    assert.deepStrictEqual([u.prompt_tokens, u.completion_tokens, u.total_tokens], [11, 5, 16]);
});

// ─── Idempotence, null, shape ───────────────────────────────────────

test('normalizeUsage is idempotent for every provider shape', () => {
    const raws = [
        ['claude', { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 9,
            cache_creation_input_tokens: 40,
            cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 30 },
            service_tier: 'priority', inference_geo: 'us', server_tool_use: { web_search_requests: 1 } }],
        ['claude', { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 40 }],
        ['openai', { prompt_tokens: 5, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } }],
        ['google', { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 4,
            promptTokensDetails: [{ modality: 'TEXT', tokenCount: 8 }] }],
    ];
    for (const [provider, raw] of raws) {
        const once = normalizeUsage(provider, raw);
        assert.deepStrictEqual(normalizeUsage(provider, once), once, `${provider} ${JSON.stringify(raw)}`);
        assert.deepStrictEqual(normalizeUsage(undefined, once), once, 'also without the hint');
    }
});

test('no usage at all is null (callers keep telling "no usage" from "zero")', () => {
    assert.strictEqual(normalizeUsage('claude', null), null);
    assert.strictEqual(normalizeUsage('claude', undefined), null);
    assert.strictEqual(normalizeUsage('claude', 'x'), null);
});

test('usageLogFields: null usage -> all zero, never undefined', () => {
    const f = usageLogFields(null);
    assert.strictEqual(f.prompt_tokens, 0);
    assert.strictEqual(f.cache_creation_tokens, 0);
    assert.deepStrictEqual(f, emptyUsage());
});

test('usageLogFields reads a raw Claude block (the consumer that is not sure what it holds)', () => {
    const f = usageLogFields({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 5 }, 'claude');
    assert.strictEqual(f.prompt_tokens, 7);
    assert.strictEqual(f.cached_tokens, 11);
    assert.strictEqual(f.cache_creation_tokens, 5);
    assert.strictEqual(f.cache_ttl, '1h');
});

// ─── Accumulator ────────────────────────────────────────────────────

test('accumulator sums rounds, keeps the 5m/1h split and takes the last tier', () => {
    const acc = createUsageAccumulator();
    assert.strictEqual(acc.hasUsage, false);
    acc.add(null);
    assert.strictEqual(acc.hasUsage, false);
    acc.add({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 0 },
        cache_creation_input_tokens: 20, service_tier: 'standard',
        server_tool_use: { web_search_requests: 1 } }, 'claude');
    acc.add({ input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 80 },
        cache_creation_input_tokens: 80, server_tool_use: { web_search_requests: 2 } }, 'claude');
    const t = acc.total();
    assert.strictEqual(acc.hasUsage, true);
    assert.deepStrictEqual(
        [t.prompt_tokens, t.completion_tokens, t.cached_tokens, t.cache_creation_tokens,
            t.cache_creation_5m_tokens, t.cache_creation_1h_tokens],
        [14, 11, 150, 100, 20, 80],
    );
    assert.strictEqual(t.service_tier, 'standard');
    assert.deepStrictEqual(t.tool_use, { web_search_requests: 3 });
    assert.strictEqual(t.cache_ttl, '1h');
});

// ─── Untrusted input ────────────────────────────────────────────────

test('hostile counts are clamped, never NaN, negative or beyond an INTEGER column', () => {
    const u = normalizeUsage('openai', {
        prompt_tokens: 1e300, completion_tokens: -5, total_tokens: 'abc',
        prompt_tokens_details: { cached_tokens: Infinity },
    });
    assert.strictEqual(u.prompt_tokens, 2_000_000_000);
    assert.strictEqual(u.completion_tokens, 0);
    assert.strictEqual(u.cached_tokens, 0);
    for (const v of [u.total_tokens, u.cached_tokens, u.reasoning_tokens]) {
        assert.ok(Number.isInteger(v) && v >= 0 && v <= 2_000_000_000);
    }
});

test('free-form strings are accepted only when they look like an identifier', () => {
    const u = normalizeUsage('claude', {
        input_tokens: 1, output_tokens: 1,
        service_tier: "standard'; DROP TABLE ai_usage_log;--",
        inference_geo: 'x'.repeat(500),
    });
    assert.strictEqual(u.service_tier, null);
    assert.strictEqual(u.inference_geo, null);
    const ok = normalizeUsage('claude', { input_tokens: 1, output_tokens: 1, service_tier: 'Batch' });
    assert.strictEqual(ok.service_tier, 'batch');
});

test('tool_use keys are allow-listed by shape and capped; prototype keys never land', () => {
    const raw = JSON.parse('{"input_tokens":1,"output_tokens":1,"server_tool_use":{"__proto__":5,"web_search_requests":2,"Bad Key":3,"<script>":4}}');
    for (let i = 0; i < 40; i++) raw.server_tool_use[`tool_${i}`] = 1;
    const u = normalizeUsage('claude', raw);
    assert.strictEqual(u.tool_use.web_search_requests, 2);
    assert.ok(!('Bad Key' in u.tool_use) && !('<script>' in u.tool_use));
    assert.ok(Object.keys(u.tool_use).length <= 16);
    assert.strictEqual(Object.getPrototypeOf(u.tool_use), Object.prototype);
    assert.strictEqual({}.polluted, undefined);

    const acc = createUsageAccumulator();
    acc.add(JSON.parse('{"input_tokens":1,"output_tokens":1,"server_tool_use":{"constructor":4}}'), 'claude');
    acc.add(JSON.parse('{"input_tokens":1,"output_tokens":1,"server_tool_use":{"constructor":4}}'), 'claude');
    assert.strictEqual(acc.total().tool_use.constructor, 8, 'a number, not a string built from Object.prototype.constructor');
});

test('unknown modalities are dropped', () => {
    const u = normalizeUsage('google', {
        promptTokenCount: 3,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 2 }, { modality: '__proto__', tokenCount: 9 }, { modality: 'HOLOGRAM', tokenCount: 1 }],
    });
    assert.deepStrictEqual(u.modality.prompt, { text: 2 });
});

// ─── Builder loops with a legacy { inputTokens, outputTokens } pair ──

test('trackUsageTotals keeps the legacy pair AND the cache counts, and the pair stays spread-safe', () => {
    const totals = { inputTokens: 0, outputTokens: 0 };
    const round = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100,
        cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40 } };
    trackUsageTotals(totals, round, 'claude');
    trackUsageTotals(totals, round, 'claude');
    trackUsageTotals(totals, null);
    assert.deepStrictEqual({ ...totals }, { inputTokens: 20, outputTokens: 10 }, 'what is sent to the client is unchanged');
    assert.deepStrictEqual(Object.keys(totals), ['inputTokens', 'outputTokens'], 'the accumulator is not enumerable');
    assert.strictEqual(JSON.stringify(totals), '{"inputTokens":20,"outputTokens":10}');
    const f = usageTotalsLogFields(totals);
    assert.deepStrictEqual(
        [f.prompt_tokens, f.completion_tokens, f.cached_tokens, f.cache_creation_tokens, f.cache_creation_1h_tokens],
        [20, 10, 200, 80, 80],
    );
});

test('usageTotalsLogFields falls back to the plain pair when nothing was tracked', () => {
    const f = usageTotalsLogFields({ inputTokens: 7, outputTokens: 3 });
    assert.deepStrictEqual([f.prompt_tokens, f.completion_tokens, f.total_tokens, f.cached_tokens], [7, 3, 10, 0]);
    assert.strictEqual(usageTotalsLogFields(undefined).prompt_tokens, 0);
});

// ─── provider_type (adapter self-stamp) ─────────────────────────────

test('provider_type survives normalisation only for an adapter type from the closed list', () => {
    assert.strictEqual(normalizeUsage('openai', { prompt_tokens: 1, provider_type: 'azure' }).provider_type, 'azure');
    for (const hostile of ['evil', 'AZURE; DROP', '__proto__', 'azure x', '', 5, {}, null]) {
        assert.ok(!('provider_type' in normalizeUsage('openai', { prompt_tokens: 1, provider_type: hostile })), String(hostile));
    }
    assert.ok(!('provider_type' in normalizeUsage('openai', { prompt_tokens: 1 })), 'absent unless stamped');
    assert.ok(!('provider_type' in emptyUsage()));
    // idempotent, and carried by the accumulator
    const once = normalizeUsage('openai', { prompt_tokens: 1, provider_type: 'azure' });
    assert.strictEqual(normalizeUsage('openai', once).provider_type, 'azure');
    const acc = createUsageAccumulator();
    acc.add({ prompt_tokens: 1, provider_type: 'azure' });
    acc.add({ prompt_tokens: 2 });
    assert.strictEqual(acc.total().provider_type, 'azure');
});

/**
 * Unit tests for the shared builder-route internals (builderShared.js):
 * isTransientChatError, isGemini3Model, applyBuilderTierFloor,
 * streamWithRetry (retry gating + event assembly + emitter seam).
 *
 * Run: node --test routes/ai/builderShared.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    isTransientChatError,
    isGemini3Model,
    BUILDER_FLOOR_TIER_ORDER,
    applyBuilderTierFloor,
    streamWithRetry,
} = require('./builderShared');

// ── isTransientChatError ────────────────────────────────────────────

test('isTransientChatError — status matrix', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
        assert.strictEqual(isTransientChatError({ status }), true, `${status} is transient`);
    }
    for (const status of [400, 401, 403, 404, 422]) {
        assert.strictEqual(isTransientChatError({ status }), false, `${status} is permanent`);
    }
    assert.strictEqual(isTransientChatError({ statusCode: 503 }), true, 'statusCode field also honoured');
});

test('isTransientChatError — message matrix', () => {
    const transient = [
        'Rate limit exceeded', 'overloaded', 'Too Many Requests', 'request timed out',
        'read ECONNRESET', 'ETIMEDOUT', 'getaddrinfo ENOTFOUND api.example', 'EAI_AGAIN',
        'socket hang up', 'fetch failed', 'network error', 'The operation was aborted',
        '502 Bad Gateway', 'upstream returned 429',
    ];
    for (const m of transient) {
        assert.strictEqual(isTransientChatError(new Error(m)), true, `"${m}" is transient`);
    }
    const permanent = ['invalid api key', 'model not found', 'context length exceeded', ''];
    for (const m of permanent) {
        assert.strictEqual(isTransientChatError(new Error(m)), false, `"${m}" is permanent`);
    }
    assert.strictEqual(isTransientChatError(null), false, 'null error is permanent');
    assert.strictEqual(isTransientChatError(undefined), false, 'undefined error is permanent');
});

// ── isGemini3Model ──────────────────────────────────────────────────

test('isGemini3Model — matrix', () => {
    const yes = ['gemini-3-pro', 'gemini-3-flash', 'gemini-3.1-pro', 'gemini-3.5-flash', 'Gemini-3-Pro', 'models/gemini-3.1-pro-preview'];
    for (const id of yes) assert.strictEqual(isGemini3Model(id), true, `${id} is Gemini 3.x`);
    const no = ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-3', 'gemini-3-ultra', 'claude-opus-4-8', 'gpt-5-mini', '', null, undefined];
    for (const id of no) assert.strictEqual(isGemini3Model(id), false, `${id} is not Gemini 3.x`);
});

test('isGemini3Model — stateless across calls (no /g lastIndex leakage)', () => {
    assert.strictEqual(isGemini3Model('gemini-3-pro'), true);
    assert.strictEqual(isGemini3Model('gemini-3-pro'), true);
});

// ── applyBuilderTierFloor ───────────────────────────────────────────

test('applyBuilderTierFloor — small model floored to first non-small tier in order', () => {
    const tiers = { fast: { modelId: 'ministral-8b' }, standard: { modelId: 'claude-sonnet-4-6' }, thinking: { modelId: 'claude-opus-4-8' } };
    const r = applyBuilderTierFloor('fast', 'ministral-8b', tiers);
    assert.deepStrictEqual(r, { tier: 'standard', modelId: 'claude-sonnet-4-6' });
});

test('applyBuilderTierFloor — floor order skips tiers whose model is also small', () => {
    const tiers = { fast: { modelId: 'ministral-8b' }, standard: { modelId: 'gpt-5-mini' }, thinking: { modelId: 'claude-opus-4-8' } };
    const r = applyBuilderTierFloor('fast', 'ministral-8b', tiers);
    assert.deepStrictEqual(r, { tier: 'thinking', modelId: 'claude-opus-4-8' }, 'small standard tier skipped');
});

test('applyBuilderTierFloor — non-small model unchanged', () => {
    const tiers = { fast: { modelId: 'ministral-8b' }, standard: { modelId: 'claude-sonnet-4-6' } };
    const r = applyBuilderTierFloor('standard', 'claude-sonnet-4-6', tiers);
    assert.deepStrictEqual(r, { tier: 'standard', modelId: 'claude-sonnet-4-6' });
});

test('applyBuilderTierFloor — small-only org keeps the small model', () => {
    const tiers = { fast: { modelId: 'ministral-8b' }, standard: { modelId: 'gpt-5-mini' } };
    const r = applyBuilderTierFloor('fast', 'ministral-8b', tiers);
    assert.deepStrictEqual(r, { tier: 'fast', modelId: 'ministral-8b' });
});

test('applyBuilderTierFloor — custom:/swarm tiers never win the floor', () => {
    // Even with capable models behind custom:/swarm keys, only the fixed
    // tier order may be floored to — those require explicit user choice.
    const tiers = { fast: { modelId: 'ministral-8b' }, 'custom:big': { modelId: 'claude-opus-4-8' }, swarm: { modelId: 'claude-opus-4-8' } };
    const r = applyBuilderTierFloor('fast', 'ministral-8b', tiers);
    assert.deepStrictEqual(r, { tier: 'fast', modelId: 'ministral-8b' });
    assert.ok(!BUILDER_FLOOR_TIER_ORDER.some(k => k.startsWith('custom:') || k === 'swarm'), 'order list is clean');
});

test('applyBuilderTierFloor — tolerates missing/empty tiers map', () => {
    assert.deepStrictEqual(applyBuilderTierFloor('fast', 'ministral-8b', undefined), { tier: 'fast', modelId: 'ministral-8b' });
    assert.deepStrictEqual(applyBuilderTierFloor('fast', 'ministral-8b', {}), { tier: 'fast', modelId: 'ministral-8b' });
});

// ── streamWithRetry ─────────────────────────────────────────────────

function makeSink() {
    const events = [];
    const send = (event, data) => events.push({ event, data });
    // Pass-through emitter: SSE payloads mirror the seam payloads exactly.
    const emitThinking = {
        start: (s, payload) => s('thinking_start', payload),
        delta: (s, payload) => s('thinking', payload),
        stop: (s, payload) => s('thinking_stop', payload),
    };
    return { events, send, emitThinking };
}

const CFG = { apiKey: 'k', url: 'u' };

test('streamWithRetry — assembles content, tool calls, signed thinking and usage', async () => {
    const { events, send, emitThinking } = makeSink();
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            onEvent('thinking_start', { partId: 'claude-0' });
            onEvent('thinking', { partId: 'claude-0', text: 'plan ' });
            onEvent('thinking', { partId: 'claude-0', text: 'it' });
            onEvent('thinking_signature', { partId: 'claude-0', signature: 'sig1' });
            onEvent('thinking_stop', { partId: 'claude-0' });
            onEvent('text', { text: 'Hello ' });
            onEvent('text', { text: 'world' });
            onEvent('tool_use', { id: 'c1', name: 'do_thing', input: { a: 1 }, thought_signature: 'ts1' });
            onEvent('done', { prompt_tokens: 10, completion_tokens: 2 });
        },
    };
    const res = await streamWithRetry(adapter, CFG, 'm', [], {}, { send, emitThinking, retries: 0, baseDelayMs: 1 });

    assert.strictEqual(res.content, 'Hello world');
    assert.strictEqual(res.toolCalls.length, 1);
    assert.strictEqual(res.toolCalls[0].id, 'c1');
    assert.strictEqual(res.toolCalls[0].function.name, 'do_thing');
    assert.strictEqual(res.toolCalls[0].function.arguments, '{"a":1}');
    assert.strictEqual(res.toolCalls[0]._thought_signature, 'ts1');
    assert.strictEqual(res.thinkingParts.length, 1);
    assert.strictEqual(res.thinkingParts[0].text, 'plan it');
    assert.strictEqual(res.thinkingParts[0].signature, 'sig1', 'signature attached via tagged part id');
    assert.deepStrictEqual(res.usage, { prompt_tokens: 10, completion_tokens: 2 });

    // Emitter seam: thinking events forwarded with the namespaced partId.
    const starts = events.filter(e => e.event === 'thinking_start');
    assert.strictEqual(starts.length, 1);
    const partId = starts[0].data.partId;
    assert.ok(/^s\d+-claude-0$/.test(partId), `part id is per-turn namespaced: ${partId}`);
    const deltas = events.filter(e => e.event === 'thinking');
    assert.deepStrictEqual(deltas.map(e => e.data), [{ partId, text: 'plan ' }, { partId, text: 'it' }]);
    const stops = events.filter(e => e.event === 'thinking_stop');
    assert.deepStrictEqual(stops[0].data, { partId, redacted: undefined });
    // Text always goes out as message { content }.
    assert.deepStrictEqual(events.filter(e => e.event === 'message').map(e => e.data.content), ['Hello ', 'world']);
});

test('streamWithRetry — a tool_use the adapter repaired keeps `_repaired`; a clean one carries no flag', async () => {
    // base.js emits `_repaired: true` when it closed a cut-off argument string
    // with the loose parser. The builder loops read it off the rebuilt call to
    // tell the model that only the landed entries exist, so the rebuild must
    // not drop it — and must not invent it on an ordinary call.
    const { send, emitThinking } = makeSink();
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            onEvent('tool_use', { id: 'c1', name: 'builder_add_steps', input: { steps: [{ tempId: 'a' }] }, _repaired: true });
            onEvent('tool_use', { id: 'c2', name: 'builder_set_plan', input: { todos: [] } });
            onEvent('done', {});
        },
    };
    const res = await streamWithRetry(adapter, CFG, 'm', [], {}, { send, emitThinking, retries: 0, baseDelayMs: 1 });
    assert.strictEqual(res.toolCalls.length, 2);
    assert.strictEqual(res.toolCalls[0]._repaired, true);
    assert.strictEqual(res.toolCalls[0].function.arguments, '{"steps":[{"tempId":"a"}]}', 'the closed (valid JSON) arguments are what gets replayed');
    assert.strictEqual(res.toolCalls[1]._repaired, undefined);
});

test('streamWithRetry — part-id namespace differs across calls', async () => {
    const seen = [];
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            onEvent('thinking_start', { partId: 't0' });
            onEvent('thinking', { partId: 't0', text: 'x' });
        },
    };
    const emitThinking = {
        start: (s, { partId }) => seen.push(partId),
        delta: () => {},
        stop: () => {},
    };
    await streamWithRetry(adapter, CFG, 'm', [], {}, { send: () => {}, emitThinking, retries: 0 });
    await streamWithRetry(adapter, CFG, 'm', [], {}, { send: () => {}, emitThinking, retries: 0 });
    assert.strictEqual(seen.length, 2);
    assert.notStrictEqual(seen[0], seen[1], 'successive turns never collide into one part');
});

test('streamWithRetry — transient failure before any output is retried', async () => {
    const { send, emitThinking } = makeSink();
    let calls = 0;
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            calls++;
            if (calls < 3) throw Object.assign(new Error('overloaded'), { status: 503 });
            onEvent('text', { text: 'ok' });
        },
    };
    const res = await streamWithRetry(adapter, CFG, 'm', [], {}, { send, emitThinking, retries: 2, baseDelayMs: 1 });
    assert.strictEqual(res.content, 'ok');
    assert.strictEqual(calls, 3, 'retried twice then succeeded');
});

test('streamWithRetry — NO retry once tokens are on the wire', async () => {
    const { send, emitThinking } = makeSink();
    let calls = 0;
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            calls++;
            onEvent('text', { text: 'partial' });
            throw Object.assign(new Error('overloaded'), { status: 503 });
        },
    };
    await assert.rejects(
        () => streamWithRetry(adapter, CFG, 'm', [], {}, { send, emitThinking, retries: 2, baseDelayMs: 1 }),
        /overloaded/,
    );
    assert.strictEqual(calls, 1, 'a blind retry would duplicate streamed tokens');
});

test('streamWithRetry — permanent error is not retried', async () => {
    const { send, emitThinking } = makeSink();
    let calls = 0;
    const adapter = {
        async stream() { calls++; throw Object.assign(new Error('bad key'), { status: 401 }); },
    };
    await assert.rejects(
        () => streamWithRetry(adapter, CFG, 'm', [], {}, { send, emitThinking, retries: 2, baseDelayMs: 1 }),
        /bad key/,
    );
    assert.strictEqual(calls, 1);
});

test('streamWithRetry — exhausts retries then throws the last error', async () => {
    const { send, emitThinking } = makeSink();
    let calls = 0;
    const adapter = {
        async stream() { calls++; throw Object.assign(new Error('boom'), { status: 500 }); },
    };
    await assert.rejects(
        () => streamWithRetry(adapter, CFG, 'm', [], {}, { send, emitThinking, retries: 2, baseDelayMs: 1 }),
        /boom/,
    );
    assert.strictEqual(calls, 3, 'tried retries+1 times');
});

test('streamWithRetry — in-stream error event with no usable output throws', async () => {
    const { send, emitThinking } = makeSink();
    let calls = 0;
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            calls++;
            onEvent('error', { error: 'invalid request payload' });
        },
    };
    await assert.rejects(
        () => streamWithRetry(adapter, CFG, 'm', [], {}, { send, emitThinking, retries: 2, baseDelayMs: 1 }),
        /invalid request payload/,
    );
    assert.strictEqual(calls, 1, 'permanent in-stream error is not retried');
});

test('streamWithRetry — in-stream error AFTER usable output returns the partial turn', async () => {
    const { send, emitThinking } = makeSink();
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            onEvent('text', { text: 'kept' });
            onEvent('error', { error: 'stream hiccup' });
        },
    };
    const res = await streamWithRetry(adapter, CFG, 'm', [], {}, { send, emitThinking, retries: 0 });
    assert.strictEqual(res.content, 'kept');
    assert.strictEqual(res.toolCalls, null);
});

test('streamWithRetry — empty turn normalises to nulls; done without usage stays null', async () => {
    const { send, emitThinking } = makeSink();
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) { onEvent('done', {}); },
    };
    const res = await streamWithRetry(adapter, CFG, 'm', [], {}, { send, emitThinking, retries: 0 });
    // invalidToolCalls joins the same all-null shape: a truly silent round has
    // neither real calls nor broken ones, and the loops tell those apart.
    assert.deepStrictEqual(res, { content: null, toolCalls: null, invalidToolCalls: null, thinkingParts: [], usage: null, finishReason: null });
});

test('streamWithRetry — the stop reason is handed back on its own, never inside usage', async () => {
    // The builder re-emits `usage` verbatim as an SSE event and folds it into
    // per-turn totals, so the stop reason (which rides on the same adapter
    // 'done' payload) must be split off — and it is what lets the loop tell a
    // max_tokens cut-off from a final answer.
    const { send, emitThinking } = makeSink();
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            onEvent('thinking_start', { partId: 't' });
            onEvent('thinking', { partId: 't', text: 'still thinking…' });
            onEvent('done', { prompt_tokens: 100, completion_tokens: 8192, stop_reason: 'length' });
        },
    };
    const res = await streamWithRetry(adapter, CFG, 'm', [], {}, { send, emitThinking, retries: 0 });
    assert.strictEqual(res.finishReason, 'length');
    assert.deepStrictEqual(res.usage, { prompt_tokens: 100, completion_tokens: 8192 });
    assert.strictEqual(res.toolCalls, null);
    // OpenAI spelling is accepted too.
    const alt = { async stream(a, u, m, msgs, o, onEvent) { onEvent('done', { prompt_tokens: 1, completion_tokens: 1, finish_reason: 'stop' }); } };
    assert.strictEqual((await streamWithRetry(alt, CFG, 'm', [], {}, { send, emitThinking, retries: 0 })).finishReason, 'stop');
});

// ── streamWithRetry — observation hooks (build visualisations) ───────

test('streamWithRetry — onToolArgsDelta / onPromptProgress receive the adapter payloads in order; the turn is unchanged', async () => {
    const { events, send, emitThinking } = makeSink();
    const seen = [];
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            onEvent('prompt_progress', { total: 100, cache: 40, processed: 60, time_ms: 900 });
            onEvent('prompt_progress', { total: 100, cache: 40, processed: 100, time_ms: 1500 });
            onEvent('tool_args_delta', { name: 'builder_add_action', partial: '{"tool":"gm' });
            onEvent('tool_args_delta', { name: 'builder_add_action', partial: '{"tool":"gmail_send"}' });
            onEvent('tool_use', { id: 'c1', name: 'builder_add_action', input: { tool: 'gmail_send' } });
            onEvent('done', { prompt_tokens: 1, completion_tokens: 1 });
        },
    };
    const res = await streamWithRetry(adapter, CFG, 'm', [], {}, {
        send, emitThinking, retries: 0,
        onToolArgsDelta: (d) => seen.push(['args', d]),
        onPromptProgress: (d) => seen.push(['progress', d]),
    });
    assert.deepStrictEqual(seen, [
        ['progress', { total: 100, cache: 40, processed: 60, time_ms: 900 }],
        ['progress', { total: 100, cache: 40, processed: 100, time_ms: 1500 }],
        ['args', { name: 'builder_add_action', partial: '{"tool":"gm' }],
        ['args', { name: 'builder_add_action', partial: '{"tool":"gmail_send"}' }],
    ]);
    // The hooks observe; the assembled turn is exactly what it was without them.
    assert.strictEqual(res.toolCalls.length, 1);
    assert.deepStrictEqual(JSON.parse(res.toolCalls[0].function.arguments), { tool: 'gmail_send' });
    assert.strictEqual(res.content, null);
    // And nothing was written to the client by the shell itself for them —
    // the route decides what (if anything) becomes an SSE event.
    assert.deepStrictEqual(events, []);
});

test('streamWithRetry — a hook that throws is swallowed; the build goes on', async () => {
    const { send, emitThinking } = makeSink();
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            onEvent('prompt_progress', { total: 1, cache: 0, processed: 1, time_ms: 1 });
            onEvent('tool_args_delta', { name: 'builder_add_action', partial: '{' });
            onEvent('text', { text: 'ok' });
            onEvent('done', { prompt_tokens: 1, completion_tokens: 1 });
        },
    };
    const res = await streamWithRetry(adapter, CFG, 'm', [], {}, {
        send, emitThinking, retries: 0,
        onToolArgsDelta: () => { throw new Error('viz bug'); },
        onPromptProgress: () => { throw new Error('viz bug'); },
    });
    assert.strictEqual(res.content, 'ok');
});

test('streamWithRetry — without the hooks the two event types are simply ignored (no throw, no SSE)', async () => {
    const { events, send, emitThinking } = makeSink();
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            onEvent('prompt_progress', { total: 1, cache: 0, processed: 1, time_ms: 1 });
            onEvent('tool_args_delta', { name: 'x', partial: '{' });
            onEvent('tool_args_delta', null);
            onEvent('text', { text: 'fine' });
            onEvent('done', {});
        },
    };
    const res = await streamWithRetry(adapter, CFG, 'm', [], {}, { send, emitThinking, retries: 0 });
    assert.strictEqual(res.content, 'fine');
    assert.deepStrictEqual(events.map(e => e.event), ['message']);
});

test('streamWithRetry — progress and argument deltas do not count as output: a transient failure after them is still retried', async () => {
    const { send, emitThinking } = makeSink();
    let attempts = 0;
    const adapter = {
        async stream(apiKey, url, modelId, messages, options, onEvent) {
            attempts += 1;
            onEvent('prompt_progress', { total: 10, cache: 0, processed: 10, time_ms: 5 });
            onEvent('tool_args_delta', { name: 'builder_add_action', partial: '{"to' });
            if (attempts === 1) { const e = new Error('upstream 503'); e.status = 503; throw e; }
            onEvent('text', { text: 'second try' });
            onEvent('done', {});
        },
    };
    const res = await streamWithRetry(adapter, CFG, 'm', [], {}, {
        send, emitThinking, retries: 2, baseDelayMs: 1,
        onToolArgsDelta: () => {}, onPromptProgress: () => {},
    });
    assert.strictEqual(attempts, 2);
    assert.strictEqual(res.content, 'second try');
});

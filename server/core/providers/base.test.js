/**
 * BaseProvider timeout behavior — options.timeoutMs on chat()/stream().
 *
 * Regression: the generic OpenAI-compatible adapter did a bare fetch() with no
 * AbortController, so a stalled connection hung the await forever. In the
 * background meeting-notes workers that outlived the 10-minute job lease and
 * wedged the worker. This pins: a hung request rejects within timeoutMs, no
 * timer leaks, and omitting timeoutMs keeps the old no-signal behavior.
 *
 * Pure + network-free (global.fetch stubbed).
 * Run: cd server && node --test core/providers/base.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const BaseProvider = require('./base');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

test('chat rejects within timeoutMs when the request hangs', async () => {
    global.fetch = (url, opts) => new Promise((resolve, reject) => {
        // Never resolves; only the abort signal can end it (undici semantics).
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason));
    });

    const provider = new BaseProvider('generic');
    const started = Date.now();
    await assert.rejects(
        () => provider.chat('key', 'https://llm.example/v1', 'model-x', [{ role: 'user', content: 'hi' }], { timeoutMs: 50 }),
        /timed out after 50ms/,
    );
    assert.ok(Date.now() - started < 2000, 'must reject promptly, not hang');
});

test('chat without timeoutMs sends no abort signal (previous behavior)', async () => {
    let sawSignal = 'unset';
    global.fetch = async (url, opts) => {
        sawSignal = opts.signal;
        return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'hoi' } }], usage: { total_tokens: 1 } }),
        };
    };

    const provider = new BaseProvider('generic');
    const out = await provider.chat('key', 'https://llm.example/v1', 'model-x', [{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(out.content, 'hoi');
    assert.strictEqual(sawSignal, undefined);
});

test('chat clears its timer on success (no open-handle leak)', async () => {
    global.fetch = async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });

    const provider = new BaseProvider('generic');
    const out = await provider.chat('key', 'https://llm.example/v1', 'model-x', [], { timeoutMs: 60_000 });
    assert.strictEqual(out.content, 'ok');
    // If the 60s timer leaked, node:test would report an open handle / the
    // process would linger — reaching this assertion synchronously is the test.
});

test('timeoutMs never leaks into the request body', async () => {
    let sentBody = null;
    global.fetch = async (url, opts) => {
        sentBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };

    const provider = new BaseProvider('generic');
    await provider.chat('key', 'https://llm.example/v1', 'model-x', [], { timeoutMs: 5000, maxTokens: 7 });
    assert.strictEqual(sentBody.timeoutMs, undefined);
    assert.strictEqual(sentBody.max_tokens, 7);
});

test('stream rejects when the connection stalls before responding', async () => {
    global.fetch = (url, opts) => new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason));
    });

    const provider = new BaseProvider('generic');
    await assert.rejects(
        () => provider.stream('key', 'https://llm.example/v1', 'model-x', [], { timeoutMs: 50 }, () => {}),
        /stalled for 50ms/,
    );
});

test('stream re-arms the stall watchdog on every chunk', async () => {
    const encoder = new TextEncoder();
    // Three chunks, each arriving after 40ms — under a 60ms watchdog this only
    // survives if the timer re-arms per chunk.
    const body = (async function* () {
        for (const text of ['eerste', 'tweede', 'derde']) {
            await new Promise(r => setTimeout(r, 40));
            yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        }
        yield encoder.encode('data: [DONE]\n\n');
    })();
    global.fetch = async () => ({ ok: true, body });

    const provider = new BaseProvider('generic');
    const texts = [];
    await provider.stream('key', 'https://llm.example/v1', 'model-x', [], { timeoutMs: 60 }, (type, data) => {
        if (type === 'text') texts.push(data.text);
    });
    assert.deepStrictEqual(texts, ['eerste', 'tweede', 'derde']);
});

// ─── reasoning field aliases ────────────────────────────────────────────────
//
// Ollama's OpenAI-compatible route names the reasoning field `reasoning`;
// DeepSeek and vLLM name it `reasoning_content`. Reading only the latter meant
// every thinking model served through Ollama had its reasoning silently
// dropped — the answer arrived, the thinking block never did. Verified against
// Ollama 0.33.2, whose stream deltas carry keys: role, content, reasoning.

test('_parseNonStreamingResponse reads both reasoning field spellings', () => {
    const p = new BaseProvider('test');
    const parse = (message) => p._parseNonStreamingResponse({ choices: [{ message }] });

    assert.strictEqual(parse({ content: 'hi', reasoning: 'because' }).thinking, 'because');
    assert.strictEqual(parse({ content: 'hi', reasoning_content: 'because' }).thinking, 'because');
    // Content is never polluted by the reasoning that sat beside it.
    assert.strictEqual(parse({ content: 'hi', reasoning: 'because' }).content, 'hi');
    // Neither present → no thinking key at all, as before.
    assert.strictEqual(parse({ content: 'hi' }).thinking, undefined);
});

test('streaming emits thinking events for Ollama-style `reasoning` deltas', async () => {
    const p = new BaseProvider('test');
    const frames = [
        { choices: [{ delta: { role: 'assistant', content: '', reasoning: 'Okay' } }] },
        { choices: [{ delta: { reasoning: ', so 2+2' } }] },
        { choices: [{ delta: { content: '4' } }] },
    ];
    const sse = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';

    const body = (async function* () { yield new TextEncoder().encode(sse); })();
    global.fetch = async () => ({ ok: true, body });
    try {
        let thinking = '';
        await p.stream('k', 'http://x', 'm', [{ role: 'user', content: 'q' }], {},
            (ev, d) => { if (ev === 'thinking') thinking += d.text; });
        assert.strictEqual(thinking, 'Okay, so 2+2');
    } finally {
        global.fetch = realFetch;
    }
});

// ─── the Reasoning Summary switch ───────────────────────────────────────────
//
// On a hosted reasoning API the switch decides whether a summary is REQUESTED,
// so there is nothing left to filter. A self-hosted runtime streams the raw
// chain of thought unconditionally, so the adapter is the only place it can be
// withheld — which is why the toggle used to do nothing for Ollama.

/** Stands in for LocalProvider, which streams the model's own reasoning. */
class RawReasoningProvider extends BaseProvider {
    surfacesRawReasoning() { return true; }
}

test('reasoningSummary:false withholds raw reasoning but keeps the answer', () => {
    const raw = new RawReasoningProvider('local');
    const data = { choices: [{ message: { content: 'four', reasoning: 'let me think' } }] };

    assert.strictEqual(raw._parseNonStreamingResponse(data, { reasoningSummary: false }).thinking, undefined);
    // The answer itself is untouched — reasoning is discarded, never inlined.
    assert.strictEqual(raw._parseNonStreamingResponse(data, { reasoningSummary: false }).content, 'four');
    // Left on, or unspecified, it still comes through.
    assert.strictEqual(raw._parseNonStreamingResponse(data, { reasoningSummary: true }).thinking, 'let me think');
    assert.strictEqual(raw._parseNonStreamingResponse(data, {}).thinking, 'let me think');
});

test('an adapter that returns a provider summary ignores the switch', () => {
    // BaseProvider does not surface raw reasoning, so reasoningSummary is the
    // request-shaping concern of whichever adapter honours it — never a filter.
    const p = new BaseProvider('hosted');
    const data = { choices: [{ message: { content: 'four', reasoning_content: 'summary' } }] };
    assert.strictEqual(p._parseNonStreamingResponse(data, { reasoningSummary: false }).thinking, 'summary');
});

test('reasoningSummary:false emits no thinking events while streaming', async () => {
    const raw = new RawReasoningProvider('local');
    const sse = [
        { choices: [{ delta: { reasoning: 'thinking hard' } }] },
        { choices: [{ delta: { content: 'four' } }] },
    ].map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';

    const run = async (options) => {
        const body = (async function* () { yield new TextEncoder().encode(sse); })();
        global.fetch = async () => ({ ok: true, body });
        const seen = [];
        await raw.stream('k', 'http://x', 'm', [{ role: 'user', content: 'q' }], options,
            (ev, d) => seen.push([ev, d?.text]));
        return seen;
    };

    try {
        const off = await run({ reasoningSummary: false });
        assert.strictEqual(off.filter(([ev]) => ev === 'thinking').length, 0);
        // No orphaned thinking_start/stop bracket around nothing, either.
        assert.strictEqual(off.filter(([ev]) => ev === 'thinking_start').length, 0);
        assert.ok(off.some(([ev, t]) => ev === 'text' && t === 'four'), 'answer still streamed');

        const on = await run({ reasoningSummary: true });
        assert.deepStrictEqual(on.filter(([ev]) => ev === 'thinking').map(([, t]) => t), ['thinking hard']);
    } finally {
        global.fetch = realFetch;
    }
});

// ─── streamed tool calls ────────────────────────────────────────────────────
//
// The contract on stream() is one 'tool_use' per call with `input` already a
// parsed OBJECT. The parser used to forward each SSE fragment verbatim with
// `input` set to the raw arguments STRING, which broke every provider that
// inherits it — all ten self-hosted runtimes and Scaleway — in two different
// ways depending on how the runtime chunks its stream. There was no coverage
// here at all, which is why it survived. These pin both shapes.

/** Drive a canned SSE transcript through the real parser. */
const streamToolCalls = async (frames, { provider = new BaseProvider('generic'), done = true } = {}) => {
    const sse = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('')
        + (done ? 'data: [DONE]\n\n' : '');
    const body = (async function* () { yield new TextEncoder().encode(sse); })();
    global.fetch = async () => ({ ok: true, body });
    const events = [];
    await provider.stream('k', 'http://x', 'm', [{ role: 'user', content: 'q' }], {},
        (type, data) => events.push({ type, data }));
    return events;
};

test('whole-call-in-one-delta (Ollama) yields one tool_use with parsed object input', async () => {
    const events = await streamToolCalls([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'builder_add_step', arguments: '{"type":"ai","label":"Triage"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const calls = events.filter(e => e.type === 'tool_use');
    assert.strictEqual(calls.length, 1, 'exactly one tool_use per call');
    assert.strictEqual(calls[0].data.name, 'builder_add_step');
    assert.strictEqual(calls[0].data.id, 'c1');
    // The regression: `input` used to be the raw JSON string, so every field
    // read as undefined and the builder added an empty step.
    assert.strictEqual(typeof calls[0].data.input, 'object');
    assert.deepStrictEqual(calls[0].data.input, { type: 'ai', label: 'Triage' });
});

test('fragmented arguments (vLLM/llama.cpp/LM Studio) accumulate into one call', async () => {
    const events = await streamToolCalls([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'builder_add_step', arguments: '{"type":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ai","lab' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'el":"Triage"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const calls = events.filter(e => e.type === 'tool_use');
    // Used to emit three calls, two of them nameless.
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].data.input, { type: 'ai', label: 'Triage' });
    assert.ok(calls.every(c => c.data.name), 'no nameless tool calls escape');
});

test('parallel tool calls stay separate, keyed on index', async () => {
    const events = await streamToolCalls([
        { choices: [{ delta: { tool_calls: [
            { index: 0, id: 'a', function: { name: 'first', arguments: '{"n":' } },
            { index: 1, id: 'b', function: { name: 'second', arguments: '{"n":' } },
        ] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const calls = events.filter(e => e.type === 'tool_use').map(e => e.data);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls.find(c => c.name === 'first').input, { n: 1 });
    assert.deepStrictEqual(calls.find(c => c.name === 'second').input, { n: 2 });
});

test('a runtime that omits index still produces one call per tool call', async () => {
    const events = await streamToolCalls([
        { choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'first', arguments: '{"n":' } }] } }] },
        // A continuation carries neither id nor name, so it appends rather than
        // opening a second slot.
        { choices: [{ delta: { tool_calls: [{ function: { arguments: '1}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'second', arguments: '{"n":2}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const calls = events.filter(e => e.type === 'tool_use').map(e => e.data);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls.find(c => c.name === 'first').input, { n: 1 });
    assert.deepStrictEqual(calls.find(c => c.name === 'second').input, { n: 2 });
});

test('a stream that ends without finish_reason still flushes its tool calls', async () => {
    // Not every runtime sends one; without the end-of-stream backstop the call
    // would be accumulated and then silently dropped.
    const events = await streamToolCalls([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'only', arguments: '{"ok":true}' } }] } }] },
    ]);

    const calls = events.filter(e => e.type === 'tool_use');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].data.input, { ok: true });
});

test('the done payload carries the stop reason, in every chunk shape', async () => {
    // A reply cut off at max_tokens looks exactly like a final answer without
    // it — the builder read four 8192-token thinking rounds as "done" that way.
    const stopOf = (events) => events.find(e => e.type === 'done').data.stop_reason;
    assert.strictEqual(stopOf(await streamToolCalls([
        { choices: [{ delta: { content: 'x' } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
    ])), 'length', 'llama.cpp shape: finish chunk with an empty delta');
    assert.strictEqual(stopOf(await streamToolCalls([
        { choices: [{ delta: { content: 'x' } }] },
        { choices: [{ finish_reason: 'length' }] },
    ])), 'length', 'read before the delta guard: a finish chunk without delta still counts');
    assert.strictEqual(stopOf(await streamToolCalls([
        { choices: [{ delta: { content: 'x' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])), 'stop', 'null on intermediate chunks does not erase a later reason');
    const none = await streamToolCalls([{ choices: [{ delta: { content: 'x' } }] }]);
    assert.strictEqual('stop_reason' in none.find(e => e.type === 'done').data, false, 'no finish_reason → no key');
});

test('the flush is idempotent — finish_reason then [DONE] emits once', async () => {
    const events = await streamToolCalls([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'only', arguments: '{}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);

    assert.strictEqual(events.filter(e => e.type === 'tool_use').length, 1);
});

test('malformed and nameless tool calls are dropped, not forwarded', async () => {
    // Both would be echoed back to the provider next round and can trigger an
    // upstream 400 or a spin loop, so they are dropped rather than repaired.
    const events = await streamToolCalls([
        { choices: [{ delta: { tool_calls: [
            { index: 0, id: 'a', function: { name: 'broken', arguments: '{"unterminated' } },
            { index: 1, id: 'b', function: { arguments: '{"orphan":1}' } },
            { index: 2, id: 'c', function: { name: 'good', arguments: '{"n":3}' } },
        ] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const calls = events.filter(e => e.type === 'tool_use').map(e => e.data);
    assert.deepStrictEqual(calls.map(c => c.name), ['good']);
    assert.deepStrictEqual(calls[0].input, { n: 3 });
});

test('a tool call with no arguments at all becomes an empty object', async () => {
    const events = await streamToolCalls([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'no_args' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const calls = events.filter(e => e.type === 'tool_use');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].data.input, {});
});

test('text and tool calls in the same stream both arrive intact', async () => {
    const events = await streamToolCalls([
        { choices: [{ delta: { content: 'Adding a step' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'builder_add_step', arguments: '{"type":"ai"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    assert.strictEqual(events.filter(e => e.type === 'text').map(e => e.data.text).join(''), 'Adding a step');
    assert.strictEqual(events.filter(e => e.type === 'tool_use').length, 1);
    assert.ok(events.some(e => e.type === 'done'), 'stream still completes');
});

// ─── max_tokens default + aliases ───────────────────────────────────────────
//
// A request with no cap let a self-hosted model generate until its context
// ran out, holding the single llama.cpp slot for minutes. Two call sites
// passed `max_tokens` (snake) and were silently uncapped because only the
// camelCase key was read.

test('buildRequestBody defaults max_tokens when the caller passed no cap', () => {
    const body = new BaseProvider('generic').buildRequestBody('m', [{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(body.max_tokens, 8192);
});

test('the snake_case alias is honoured', () => {
    const body = new BaseProvider('generic').buildRequestBody('m', [], { max_tokens: 1000 });
    assert.strictEqual(body.max_tokens, 1000);
});

test('maxTokens wins over max_tokens, and 0 is a value, not "unset"', () => {
    const p = new BaseProvider('generic');
    assert.strictEqual(p.buildRequestBody('m', [], { maxTokens: 7, max_tokens: 1000 }).max_tokens, 7);
    assert.strictEqual(p.buildRequestBody('m', [], { maxTokens: 0 }).max_tokens, 0);
});

test('extraBody still overrides the default', () => {
    const body = new BaseProvider('generic').buildRequestBody('m', [], { extraBody: { max_tokens: 42 } });
    assert.strictEqual(body.max_tokens, 42);
});

// ─── options.signal — the caller's abort ─────────────────────────────────────
//
// The agent runtime's raw-fetch path propagated the client's disconnect; the
// adapter path did not, so once local flavours went through the adapter a
// closed tab would have left the model generating for nobody.

test('stream honours options.signal — a client abort aborts the fetch', async () => {
    global.fetch = (url, opts) => new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason));
    });
    const ac = new AbortController();
    const provider = new BaseProvider('generic');
    const run = provider.stream('k', 'https://llm.example/v1', 'm', [], { signal: ac.signal }, () => {});
    setTimeout(() => ac.abort(new Error('client went away')), 10);
    await assert.rejects(run, /client went away/);
});

test('stream combines the caller signal with the stall watchdog — either ends it', async () => {
    global.fetch = (url, opts) => new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason));
    });
    const ac = new AbortController(); // never aborted — the watchdog must still fire
    const provider = new BaseProvider('generic');
    await assert.rejects(
        () => provider.stream('k', 'https://llm.example/v1', 'm', [], { signal: ac.signal, timeoutMs: 50 }, () => {}),
        /stalled for 50ms/,
    );
});

test('stream without a signal or a timeout sends no signal at all (previous shape)', async () => {
    let sawSignal = 'unset';
    global.fetch = async (url, opts) => {
        sawSignal = opts.signal;
        const body = (async function* () { yield new TextEncoder().encode('data: [DONE]\n\n'); })();
        return { ok: true, body };
    };
    await new BaseProvider('generic').stream('k', 'https://llm.example/v1', 'm', [], {}, () => {});
    assert.strictEqual(sawSignal, undefined);
});

test('chat honours options.signal too', async () => {
    global.fetch = (url, opts) => new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason));
    });
    const ac = new AbortController();
    const run = new BaseProvider('generic').chat('k', 'https://llm.example/v1', 'm', [], { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('caller gave up')), 10);
    await assert.rejects(run, /caller gave up/);
});

// ─── llama-server timings ────────────────────────────────────────────────────
//
// `timings.cache_n` is llama.cpp's own count of prompt tokens served from
// its prefix cache — the ground truth for the whole prompt-layout work. It
// does not report reuse in prompt_tokens_details, so without reading it a
// local turn logged every prompt as fully uncached.

test('llama-server timings ride the done payload and feed cached_tokens', async () => {
    const frames = [
        { choices: [{ delta: { content: 'hi' } }] },
        {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
            timings: { prompt_n: 60, cache_n: 40, prompt_ms: 400.5, predicted_n: 5, predicted_ms: 50, extra: 'dropped' },
        },
    ];
    const sse = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
    const body = (async function* () { yield new TextEncoder().encode(sse); })();
    global.fetch = async () => ({ ok: true, body });

    let done = null;
    await new BaseProvider('generic').stream('k', 'http://x', 'm', [{ role: 'user', content: 'q' }], {},
        (ev, d) => { if (ev === 'done') done = d; });
    assert.deepStrictEqual(done.timings, { prompt_n: 60, cache_n: 40, prompt_ms: 400.5, predicted_n: 5, predicted_ms: 50 });
    assert.strictEqual(done.cached_tokens, 40);
    assert.strictEqual(done.prompt_tokens, 100);
    assert.strictEqual(done.stop_reason, 'stop');
});

test('a runtime without timings reports no timings key and zero cached tokens', async () => {
    const frames = [
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
    ];
    const sse = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
    const body = (async function* () { yield new TextEncoder().encode(sse); })();
    global.fetch = async () => ({ ok: true, body });
    let done = null;
    await new BaseProvider('generic').stream('k', 'http://x', 'm', [], {}, (ev, d) => { if (ev === 'done') done = d; });
    assert.strictEqual(done.timings, undefined);
    assert.strictEqual(done.cached_tokens, 0);
});

// ─── llama-server prefill progress ──────────────────────────────────────────
//
// `return_progress: true` makes llama-server stream chunks that carry only
// `prompt_progress` — `choices` is EMPTY on them. The parser forwards each as a
// typed 'prompt_progress' event (numbers coerced, missing → 0) and must say
// nothing else for such a chunk: no text, no tool_use, no crash on
// `choices[0]`.

/** Drive canned frames through the real parser and return every event. */
const streamFrames = async (frames) => {
    const sse = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
    const body = (async function* () { yield new TextEncoder().encode(sse); })();
    global.fetch = async () => ({ ok: true, body });
    const events = [];
    await new BaseProvider('generic').stream('k', 'http://x', 'm', [{ role: 'user', content: 'q' }], {},
        (type, data) => events.push({ type, data }));
    return events;
};

test('a prompt_progress chunk emits one typed event with numeric fields', async () => {
    const events = await streamFrames([
        { choices: [], prompt_progress: { total: 4000, cache: 1500, processed: 2048, time_ms: 8123.4 } },
    ]);
    const progress = events.filter(e => e.type === 'prompt_progress');
    assert.strictEqual(progress.length, 1);
    assert.deepStrictEqual(progress[0].data, { total: 4000, cache: 1500, processed: 2048, time_ms: 8123.4 });
});

test('progress fields are coerced: strings become numbers, missing or junk become 0', async () => {
    const events = await streamFrames([
        { choices: [], prompt_progress: { total: '100', processed: 'abc', cache: null } },
    ]);
    const [p] = events.filter(e => e.type === 'prompt_progress');
    assert.deepStrictEqual(p.data, { total: 100, cache: 0, processed: 0, time_ms: 0 });
});

test('a chunk with empty choices emits no text and no tool call, and the stream still completes', async () => {
    const events = await streamFrames([
        { choices: [], prompt_progress: { total: 10, cache: 0, processed: 5, time_ms: 1 } },
        { choices: [] },                                   // a bare empty-choices chunk is skipped silently
        { choices: [{ delta: { content: 'hi' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const types = events.map(e => e.type);
    assert.deepStrictEqual(types.filter(t => t === 'text'), ['text'], 'exactly the one real text delta');
    assert.ok(!types.includes('tool_use'));
    assert.strictEqual(events.find(e => e.type === 'text').data.text, 'hi');
    assert.strictEqual(types[types.length - 1], 'done');
    assert.strictEqual(events[events.length - 1].data.stop_reason, 'stop');
});

test('ordering is preserved: progress events precede the first token, in stream order', async () => {
    const events = await streamFrames([
        { choices: [], prompt_progress: { total: 100, cache: 0, processed: 40, time_ms: 100 } },
        { choices: [], prompt_progress: { total: 100, cache: 0, processed: 100, time_ms: 250 } },
        { choices: [{ delta: { content: 'a' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'builder_add_step', arguments: '{"x":1}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const seq = events.map(e => e.type);
    assert.deepStrictEqual(seq.slice(0, 3), ['prompt_progress', 'prompt_progress', 'text']);
    const processed = events.filter(e => e.type === 'prompt_progress').map(e => e.data.processed);
    assert.deepStrictEqual(processed, [40, 100]);
    assert.ok(seq.indexOf('tool_args_delta') > seq.indexOf('text'));
    assert.ok(seq.indexOf('tool_use') > seq.indexOf('tool_args_delta'));
    assert.strictEqual(seq[seq.length - 1], 'done');
});

test('a chunk with no prompt_progress object emits no progress event (only an object counts)', async () => {
    const events = await streamFrames([
        { choices: [{ delta: { content: 'x' } }], prompt_progress: 'nope' },
        { choices: [{ delta: { content: 'y' } }], prompt_progress: null },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    assert.strictEqual(events.filter(e => e.type === 'prompt_progress').length, 0);
    assert.deepStrictEqual(events.filter(e => e.type === 'text').map(e => e.data.text), ['x', 'y']);
});

// ─── loose repair before tool_use_invalid ────────────────────────────────────
// A call whose arguments are not valid JSON gets one pass through the loose
// parser (core/llm/leakedToolCalls): a batch cut at max_tokens right after a
// complete entry is closed, bare-word values and Gemma's fence syntax are
// read. What comes back is exactly what was on the wire, flagged `_repaired`
// so the consumer can tell the model. A cut inside a string or after a
// scalar is still tool_use_invalid — nothing is invented.

test('a batch cut right after a complete entry is handed up as tool_use with _repaired', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const events = await streamToolCalls([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'builder_set_plan', arguments: '{"items":[{"id":"p1","label":"Tabel"},{"id":"p2","label":"Automation"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]);
    const uses = events.filter(e => e.type === 'tool_use');
    assert.strictEqual(uses.length, 1);
    assert.strictEqual(uses[0].data.name, 'builder_set_plan');
    assert.deepStrictEqual(uses[0].data.input, { items: [{ id: 'p1', label: 'Tabel' }, { id: 'p2', label: 'Automation' }] });
    assert.strictEqual(uses[0].data._repaired, true);
    assert.strictEqual(events.filter(e => e.type === 'tool_use_invalid').length, 0);
});

test('bare-word values and Gemma fence syntax inside the arguments are read the same way', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const events = await streamToolCalls([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'app_update_component', arguments: '{"updates":[{"id":"cmp_1","props":{"mode":read,"label":<|">Facturen<|">}}]}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const uses = events.filter(e => e.type === 'tool_use');
    assert.deepStrictEqual(uses[0].data.input, { updates: [{ id: 'cmp_1', props: { mode: 'read', label: 'Facturen' } }] });
    assert.strictEqual(uses[0].data._repaired, true);
});

test('a cut inside a string, or after a scalar, is still tool_use_invalid — and a valid call carries no _repaired flag', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const events = await streamToolCalls([
        { choices: [{ delta: { tool_calls: [
            { index: 0, id: 'a', function: { name: 'app_add_components', arguments: '{"components":[{"type":"card","props":{"title":"Overzicht van de fact' } },
            { index: 1, id: 'b', function: { name: 'builder_add_steps', arguments: '{"steps":[{"tempId":"a"' } },
            { index: 2, id: 'c', function: { name: 'good', arguments: '{"n":3}' } },
        ] } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]);
    const invalid = events.filter(e => e.type === 'tool_use_invalid').map(e => e.data.name);
    assert.deepStrictEqual(invalid, ['app_add_components', 'builder_add_steps']);
    const uses = events.filter(e => e.type === 'tool_use').map(e => e.data);
    assert.deepStrictEqual(uses.map(c => c.name), ['good']);
    assert.strictEqual(uses[0]._repaired, undefined);
});

test('a runaway nesting cut at the length limit is tool_use_invalid + done, on both flush paths — never a rejected stream', async (t) => {
    t.mock.method(console, 'warn', () => {});
    // A small model looping on `[` until max_tokens. The loose repair used
    // to recurse into a RangeError here; on the [DONE] flush (no
    // finish_reason on the last chunk — the backstop path) that sits outside
    // the per-chunk try/catch and rejected stream() with no tool_use_invalid
    // and no done, on the finish_reason path it was swallowed after the
    // accumulator was drained, so the call vanished without an event.
    const runaway = '{"steps":' + '['.repeat(6000);
    for (const finish of ['length', null]) {
        const frames = [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'r1', function: { name: 'builder_add_steps', arguments: runaway } }] } }] },
        ];
        if (finish) frames.push({ choices: [{ delta: {}, finish_reason: finish }] });
        const events = await streamToolCalls(frames);
        const invalid = events.filter(e => e.type === 'tool_use_invalid').map(e => e.data);
        assert.strictEqual(invalid.length, 1, `finish=${finish}: one tool_use_invalid`);
        assert.strictEqual(invalid[0].name, 'builder_add_steps');
        assert.strictEqual(invalid[0].arguments, runaway, 'the raw tail rides the event for the builder to quote back');
        assert.strictEqual(events.filter(e => e.type === 'tool_use').length, 0, `finish=${finish}: nothing invented`);
        assert.ok(events.some(e => e.type === 'done'), `finish=${finish}: the stream still completes`);
    }
});

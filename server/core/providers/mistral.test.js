/**
 * Contract tests — Mistral adapter on @mistralai/mistralai v2.
 *
 * Run: node --test core/providers/mistral.test.js
 *
 * Fixtures are written in the API's WIRE format and pushed through the SDK's
 * own inbound schemas, so what the adapter sees is exactly what the SDK
 * yields — including its defaults (a missing tool-call `index` becomes 0, a
 * missing `id` the string "null") and its `{ type: 'UNKNOWN' }` wrapper for
 * chunk types it does not know. A hand-written "SDK-shaped" object would hide
 * precisely those.
 *
 * Requests go the other way: through the SDK's OUTBOUND schema, which strips
 * every key it does not know without a word. That is how `reasoningEffort`
 * never reached Mistral on SDK 1.x; the schema-guard tests below fail if a
 * param we set does not make it onto the wire.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const components = require('@mistralai/mistralai/models/components');

const MistralProvider = require('./mistral');
const { _resetMistralRegistries, describeMistralModel } = require('./mistralModels');
const { classifyStreamError } = require('../agentRuntime/streamRetry');

const REASONING_MODEL = 'mistral-small-latest';
const PLAIN_MODEL = 'mistral-large-latest';

beforeEach(() => _resetMistralRegistries());

// ─── Helpers ────────────────────────────────────────────────────────────────

const chunk = (wire) => ({ data: components.CompletionChunk$inboundSchema.parse({ id: 'c', model: 'm', ...wire }) });
const delta = (d, finish = null, extra = {}) => chunk({ choices: [{ index: 0, delta: d, finish_reason: finish }], ...extra });

function fakeStream(events, { afterEvents } = {}) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
            if (afterEvents) await afterEvents();
        },
    };
}

/** Provider with a fake SDK client; records the params and per-call options. */
function withClient({ streamEvents = [], streamOpts, completeWire, streamError, completeError, models } = {}) {
    const provider = new MistralProvider();
    const captured = {};
    provider.createClient = (apiKey, baseUrl) => {
        captured.apiKey = apiKey;
        captured.baseUrl = baseUrl;
        return {
            chat: {
                stream: async (params, reqOpts) => {
                    captured.params = params;
                    captured.reqOpts = reqOpts;
                    if (streamError) throw streamError;
                    return fakeStream(streamEvents, typeof streamOpts === 'function' ? streamOpts(reqOpts) : streamOpts);
                },
                complete: async (params, reqOpts) => {
                    captured.params = params;
                    captured.reqOpts = reqOpts;
                    if (completeError) throw completeError;
                    return components.ChatCompletionResponse$inboundSchema.parse({
                        id: 'r', object: 'chat.completion', model: 'm', created: 1, ...completeWire,
                    });
                },
            },
            models: {
                list: async () => components.ModelList$inboundSchema.parse({ object: 'list', data: models || [] }),
            },
        };
    };
    return { provider, captured };
}

async function runStream(provider, options = {}, messages = [{ role: 'user', content: 'hi' }], model = REASONING_MODEL) {
    const seen = [];
    await provider.stream('key', 'https://api.mistral.ai/v1', model, messages, options, (type, data) => seen.push({ type, ...data }));
    return seen;
}

/** The request body exactly as the SDK would put it on the wire. */
const wire = (params) => (params.stream
    ? components.ChatCompletionStreamRequest$outboundSchema.parse(params)
    : components.ChatCompletionRequest$outboundSchema.parse(params));

// ─── tool_choice ────────────────────────────────────────────────────────────

test("mapToolChoice: 'required' → 'any' (Mistral's must-call value)", () => {
    assert.strictEqual(new MistralProvider().mapToolChoice('required'), 'any');
});

test("mapToolChoice: 'auto' / 'none' / 'any' and a function object pass through; unset → 'auto'", () => {
    const p = new MistralProvider();
    assert.strictEqual(p.mapToolChoice('auto'), 'auto');
    assert.strictEqual(p.mapToolChoice('none'), 'none');
    assert.strictEqual(p.mapToolChoice('any'), 'any');
    assert.strictEqual(p.mapToolChoice(undefined), 'auto');
    const fn = { type: 'function', function: { name: 'builder_propose_trigger' } };
    assert.strictEqual(p.mapToolChoice(fn), fn);
});

// ─── Schema guard: every param we set reaches the wire ─────────────────────

test('schema guard: effort, cache key, tools and tool_choice survive the SDK outbound schema', () => {
    const p = new MistralProvider();
    const params = p.buildParams(REASONING_MODEL, [{ role: 'user', content: 'hi' }], {
        reasoningEffort: 'medium',
        promptCacheKey: 'conv-123',
        temperature: 0.3,
        tools: [{ type: 'function', function: { name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } } }],
        toolChoice: 'required',
    }, { stream: true });
    const body = wire(params);
    assert.strictEqual(body.reasoning_effort, 'high');
    assert.strictEqual(body.prompt_cache_key, 'conv-123');
    assert.strictEqual(body.tool_choice, 'any');
    assert.strictEqual(body.tools[0].type, 'function');
    assert.strictEqual(body.tools[0].function.name, 'lookup');
    assert.strictEqual(body.temperature, 0.3);
    assert.strictEqual(body.max_tokens, 16384, 'reasoning gets headroom over the 8192 default');
    assert.strictEqual(body.stream, true);
});

test('schema guard: a tool without an explicit type gets type:function (v2 rejects it otherwise)', () => {
    const p = new MistralProvider();
    const params = p.buildParams(PLAIN_MODEL, [{ role: 'user', content: 'hi' }], {
        tools: [{ function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
    });
    assert.strictEqual(wire(params).tools[0].type, 'function');
});

test('schema guard: a converted history (tool calls, tool result, image, replayed thinking) survives intact', () => {
    const p = new MistralProvider();
    const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
        {
            role: 'assistant', content: null,
            thinking: [{ id: 't1', text: 'I should look it up' }],
            tool_calls: [{ id: 'toolu_01XYZ', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
        },
        { role: 'tool', tool_call_id: 'toolu_01XYZ', name: 'lookup', content: 'result' },
    ];
    const body = wire(p.buildParams(REASONING_MODEL, messages, { reasoningEffort: 'high' }));
    const [, user, assistant, tool] = body.messages;
    assert.deepStrictEqual(user.content[1], { type: 'image_url', image_url: 'data:image/png;base64,AAA' });
    assert.strictEqual(assistant.content[0].type, 'thinking');
    assert.strictEqual(assistant.content[0].thinking[0].text, 'I should look it up');
    assert.match(assistant.tool_calls[0].id, /^[a-zA-Z0-9]{9}$/);
    assert.strictEqual(assistant.tool_calls[0].function.arguments, '{"q":"x"}');
    assert.strictEqual(tool.tool_call_id, assistant.tool_calls[0].id, 'call and result stay paired');
    assert.ok(!('thinking' in assistant), 'the internal thinking field itself never goes out');
});

// ─── Reasoning effort per tier ──────────────────────────────────────────────

test('effort: the tier values map onto none/high for a reasoning model', () => {
    const p = new MistralProvider();
    const effortFor = (reasoningEffort) => p.buildParams(REASONING_MODEL, [], { reasoningEffort }).reasoningEffort;
    assert.strictEqual(effortFor(undefined), 'none', 'nothing asked → reasoning off, explicitly');
    assert.strictEqual(effortFor('none'), 'none', 'titles/classifier: reasoning off');
    assert.strictEqual(effortFor('minimal'), 'none');
    assert.strictEqual(effortFor('low'), 'none', 'standard/swarm/writer stay fast');
    assert.strictEqual(effortFor('medium'), 'high', 'thinking tier reasons');
    assert.strictEqual(effortFor('high'), 'high', 'deep_thinking reasons');
    assert.strictEqual(effortFor('xhigh'), 'high');
    assert.strictEqual(effortFor('max'), 'high');
});

test('effort: never sent to a model without the switch', () => {
    const p = new MistralProvider();
    for (const model of [PLAIN_MODEL, 'ministral-8b-latest', 'codestral-latest', 'magistral-medium-latest']) {
        assert.strictEqual(p.buildParams(model, [], { reasoningEffort: 'high' }).reasoningEffort, undefined, model);
    }
});

test('max tokens: 8192 by default, raised to 16384 only while reasoning, never lowered', () => {
    const p = new MistralProvider();
    assert.strictEqual(p.buildParams(PLAIN_MODEL, [], {}).maxTokens, 8192);
    assert.strictEqual(p.buildParams(REASONING_MODEL, [], { maxTokens: 1024, reasoningEffort: 'none' }).maxTokens, 1024);
    assert.strictEqual(p.buildParams(REASONING_MODEL, [], { maxTokens: 4096, reasoningEffort: 'high' }).maxTokens, 16384);
    assert.strictEqual(p.buildParams(REASONING_MODEL, [], { maxTokens: 32000, reasoningEffort: 'high' }).maxTokens, 32000);
    assert.strictEqual(p.buildParams(PLAIN_MODEL, [], { max_tokens: 500 }).maxTokens, 500, 'snake_case alias honoured');
});

// ─── Prompt cache key ───────────────────────────────────────────────────────

test('prompt cache key: a conversation key is forwarded, a bare user id is not', () => {
    const p = new MistralProvider();
    assert.strictEqual(p.buildParams(PLAIN_MODEL, [], { promptCacheKey: 'conv-9f2c' }).promptCacheKey, 'conv-9f2c');
    assert.strictEqual(p.buildParams(PLAIN_MODEL, [], { promptCacheKey: '42' }).promptCacheKey, undefined);
    assert.strictEqual(p.buildParams(PLAIN_MODEL, [], {}).promptCacheKey, undefined);
});

// ─── Server URL ─────────────────────────────────────────────────────────────

test('server URL: the default host is left to the SDK, a regional host is used, anything else ignored', () => {
    const { resolveServerUrl } = MistralProvider;
    assert.strictEqual(resolveServerUrl('https://api.mistral.ai/v1'), undefined);
    assert.strictEqual(resolveServerUrl('https://api.mistral.ai'), undefined);
    assert.strictEqual(resolveServerUrl('https://api.eu.mistral.ai/v1'), 'https://api.eu.mistral.ai');
    assert.strictEqual(resolveServerUrl('https://api.us.mistral.ai/'), 'https://api.us.mistral.ai');
    assert.strictEqual(resolveServerUrl('http://localhost:11434/v1'), undefined);
    assert.strictEqual(resolveServerUrl('https://evilmistral.ai'), undefined);
    assert.strictEqual(resolveServerUrl(null), undefined);
    assert.strictEqual(resolveServerUrl('not a url'), undefined);
});

test('the real client gets the regional server URL and no SDK timeout or retries', () => {
    const client = /** @type {any} */ (new MistralProvider().createClient('k', 'https://api.eu.mistral.ai/v1'));
    assert.strictEqual(client._options.serverURL, 'https://api.eu.mistral.ai');
    assert.strictEqual(client._options.timeoutMs, -1);
    assert.deepStrictEqual(client._options.retryConfig, { strategy: 'none' });
});

// ─── Tool-call ids ──────────────────────────────────────────────────────────

test('tool-call ids: a valid 9-char id is kept, anything else maps deterministically to one', () => {
    const { toMistralToolCallId } = MistralProvider;
    assert.strictEqual(toMistralToolCallId('Ab3dE6gH9'), 'Ab3dE6gH9');
    const mapped = toMistralToolCallId('toolu_01ABCDEF');
    assert.match(mapped, /^[a-zA-Z0-9]{9}$/);
    assert.strictEqual(toMistralToolCallId('toolu_01ABCDEF'), mapped, 'same input, same id');
    assert.notStrictEqual(toMistralToolCallId('toolu_01ABCDEG'), mapped);
    assert.match(toMistralToolCallId('call_1727_ab12cd'), /^[a-zA-Z0-9]{9}$/);
});

test('tool-call ids: missing ids are derived, never random — the history is byte-identical twice', () => {
    const p = new MistralProvider();
    const messages = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'a', arguments: '{}' } }, { function: { name: 'b', arguments: {} } }] },
        { role: 'tool', content: 'r' },
    ];
    const first = JSON.stringify(p.normalizeMessages(messages));
    const second = JSON.stringify(p.normalizeMessages(messages));
    assert.strictEqual(first, second);
    const [, assistant, tool] = p.normalizeMessages(messages);
    assert.notStrictEqual(assistant.toolCalls[0].id, assistant.toolCalls[1].id);
    assert.strictEqual(assistant.toolCalls[1].function.arguments, '{}', 'object arguments become a string');
    assert.match(tool.toolCallId, /^[a-zA-Z0-9]{9}$/);
});

// ─── Thinking replay ────────────────────────────────────────────────────────

test('thinking replay: only after the last user message, only while reasoning, never signed parts', () => {
    const p = new MistralProvider();
    const messages = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'old answer', thinking: [{ text: 'old thought' }] },
        { role: 'user', content: 'second' },
        {
            role: 'assistant', content: null,
            thinking: [{ text: 'fresh thought' }, { text: 'claude part', signature: 'sig' }],
            tool_calls: [{ id: 'abcdefghi', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'abcdefghi', content: 'r' },
    ];

    const on = p.normalizeMessages(messages, { replayThinking: true });
    assert.strictEqual(on[1].content, 'old answer', 'a turn before the last user message is left alone');
    assert.deepStrictEqual(on[3].content, [{ type: 'thinking', thinking: [{ type: 'text', text: 'fresh thought' }] }]);

    const off = p.normalizeMessages(messages, { replayThinking: false });
    assert.strictEqual(off[3].content, '');
});

// ─── Streaming ──────────────────────────────────────────────────────────────

test('stream: bracketed thinking with a partId, then text, then usage and stop reason on done', async () => {
    const { provider } = withClient({
        streamEvents: [
            delta({ role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Let me ' }] }] }),
            delta({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'think.' }] }, { type: 'text', text: 'Hello' }] }),
            delta({ content: ' world' }),
            delta({ content: '' }, 'stop', {
                usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240, prompt_tokens_details: { cached_tokens: 1024 } },
            }),
        ],
    });
    const seen = await runStream(provider, { reasoningEffort: 'high' });
    assert.deepStrictEqual(seen.map(e => e.type), ['thinking_start', 'thinking', 'thinking', 'thinking_stop', 'text', 'text', 'done']);
    assert.ok(seen.filter(e => e.type.startsWith('thinking')).every(e => e.partId === 'mistral-0'));
    assert.strictEqual(seen.filter(e => e.type === 'text').map(e => e.text).join(''), 'Hello world');
    // The normalised usage (usageNormalizer.js) carries more than these counts.
    const done = seen.at(-1);
    assert.deepStrictEqual({
        type: done.type,
        prompt_tokens: done.prompt_tokens, completion_tokens: done.completion_tokens, total_tokens: done.total_tokens,
        cached_tokens: done.cached_tokens, reasoning_tokens: done.reasoning_tokens,
        stop_reason: done.stop_reason,
    }, {
        type: 'done',
        prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240,
        cached_tokens: 1024, reasoning_tokens: 0,
        stop_reason: 'stop',
    });
});

test('reasoning summary off: the thinking is withheld, never rerouted into the answer', async () => {
    const thinkingThenText = [
        delta({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'private' }] }, { type: 'text', text: 'Answer' }] }, 'stop'),
    ];
    const { provider } = withClient({ streamEvents: thinkingThenText });
    const seen = await runStream(provider, { reasoningEffort: 'high', reasoningSummary: false });
    assert.deepStrictEqual(seen.map(e => e.type), ['text', 'done']);
    assert.strictEqual(seen[0].text, 'Answer');

    const { provider: chatProvider } = withClient({
        completeWire: {
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'private' }] }, { type: 'text', text: 'Answer' }] } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
    });
    const result = await chatProvider.chat('k', null, REASONING_MODEL, [{ role: 'user', content: 'q' }], { reasoningEffort: 'high', reasoningSummary: false });
    assert.strictEqual(result.content, 'Answer');
    assert.strictEqual(result.thinking, undefined);
});

test('stream: a chunk type the SDK does not know is never rendered as text', async () => {
    const { provider } = withClient({
        streamEvents: [delta({ content: [{ type: 'brand_new_chunk', text: 'LEAK' }, { type: 'text', text: 'ok' }] }, 'stop')],
    });
    const seen = await runStream(provider);
    assert.strictEqual(seen.filter(e => e.type === 'text').map(e => e.text).join(''), 'ok');
});

test('stream: argument fragments accumulate into one tool_use with parsed input', async () => {
    const { provider } = withClient({
        streamEvents: [
            delta({ tool_calls: [{ id: 'Ab3dE6gH9', index: 0, function: { name: 'lookup', arguments: '{"q":' } }] }),
            delta({ tool_calls: [{ index: 0, function: { name: '', arguments: '"x"}' } }] }),
            delta({}, 'tool_calls'),
        ],
    });
    const seen = await runStream(provider, { tools: [{ type: 'function', function: { name: 'lookup' } }] });
    const uses = seen.filter(e => e.type === 'tool_use');
    assert.deepStrictEqual(uses, [{ type: 'tool_use', id: 'Ab3dE6gH9', name: 'lookup', input: { q: 'x' } }]);
    assert.ok(seen.some(e => e.type === 'tool_args_delta'));
    assert.strictEqual(seen.at(-1).stop_reason, 'tool_calls');
});

test('stream: two parallel calls without an index (SDK defaults both to 0) stay two calls', async () => {
    const { provider } = withClient({
        streamEvents: [
            delta({ tool_calls: [
                { id: 'aaaaaaaa1', function: { name: 'alpha', arguments: '{"x":1}' } },
                { id: 'bbbbbbbb2', function: { name: 'beta', arguments: '{"y":2}' } },
            ] }, 'tool_calls'),
        ],
    });
    const seen = await runStream(provider);
    assert.deepStrictEqual(
        seen.filter(e => e.type === 'tool_use').map(e => [e.id, e.name, e.input]),
        [['aaaaaaaa1', 'alpha', { x: 1 }], ['bbbbbbbb2', 'beta', { y: 2 }]],
    );
});

test('stream: arguments that never become JSON are announced as tool_use_invalid, not run with {}', async () => {
    const { provider } = withClient({
        streamEvents: [delta({ tool_calls: [{ id: 'Ab3dE6gH9', function: { name: 'lookup', arguments: 'not json at all' } }] }, 'tool_calls')],
    });
    const seen = await runStream(provider);
    assert.strictEqual(seen.filter(e => e.type === 'tool_use').length, 0);
    const invalid = seen.find(e => e.type === 'tool_use_invalid');
    assert.strictEqual(invalid.name, 'lookup');
    assert.strictEqual(invalid.arguments, 'not json at all');
});

test('stream: a cut-off reply reports stop_reason length', async () => {
    const { provider } = withClient({ streamEvents: [delta({ content: 'partial' }, 'length')] });
    const seen = await runStream(provider);
    assert.strictEqual(seen.at(-1).stop_reason, 'length');
});

test('stream: calls without a finish reason are still handed over at the end', async () => {
    const { provider } = withClient({
        streamEvents: [delta({ tool_calls: [{ id: 'Ab3dE6gH9', function: { name: 'lookup', arguments: '{}' } }] })],
    });
    const seen = await runStream(provider);
    assert.strictEqual(seen.filter(e => e.type === 'tool_use').length, 1);
    assert.strictEqual(seen.at(-1).type, 'done');
});

test('stream: a 429 becomes "mistral API error 429", which the retry layer retries', async () => {
    const sdkError = Object.assign(new Error('API error occurred: Status 429'), { statusCode: 429, body: '{"message":"rate limited"}' });
    const { provider } = withClient({ streamError: sdkError });
    const err = await runStream(provider).then(() => null, e => e);
    assert.match(err.message, /^mistral API error 429: \{"message":"rate limited"\}$/);
    assert.strictEqual(err.status, 429);
    assert.strictEqual(classifyStreamError(err).retryable, true);
});

test('stream: the caller signal reaches the SDK, and a caller abort surfaces as the caller\'s own reason', async () => {
    const controller = new AbortController();
    const reason = new Error('client went away');
    const { provider, captured } = withClient({
        streamEvents: [delta({ content: 'a' })],
        streamOpts: () => ({
            afterEvents: async () => {
                controller.abort(reason);
                throw Object.assign(new Error('Request aborted by client'), { name: 'RequestAbortedError' });
            },
        }),
    });
    const err = await runStream(provider, { signal: controller.signal }).then(() => null, e => e);
    assert.strictEqual(err, reason);
    assert.strictEqual(captured.reqOpts.signal, controller.signal);
});

test('stream: the stall watchdog aborts a wedged stream with a stalled error', async () => {
    const { provider, captured } = withClient({
        streamEvents: [delta({ content: 'a' })],
        streamOpts: (reqOpts) => ({
            afterEvents: () => new Promise((_, reject) => {
                reqOpts.signal.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'RequestAbortedError' })));
            }),
        }),
    });
    const err = await runStream(provider, { timeoutMs: 30 }).then(() => null, e => e);
    assert.match(err.message, /mistral stream stalled for 30ms/);
    assert.ok(captured.reqOpts.signal, 'a signal is always passed when there is a timeout');
});

test('stream: retries pass through for callers that set them (node search)', async () => {
    const { provider, captured } = withClient({ streamEvents: [delta({ content: 'a' }, 'stop')] });
    await runStream(provider, { retries: { strategy: 'none' } });
    assert.deepStrictEqual(captured.reqOpts, { retries: { strategy: 'none' } });
});

// ─── Non-streaming ──────────────────────────────────────────────────────────

test('chat: snake_case usage with cached tokens, thinking split off, stop reason', async () => {
    const { provider } = withClient({
        completeWire: {
            choices: [{
                index: 0, finish_reason: 'stop',
                message: { role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'hmm' }] }, { type: 'text', text: 'Answer' }] },
            }],
            usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520, prompt_tokens_details: { cached_tokens: 448 } },
        },
    });
    const result = await provider.chat('k', null, REASONING_MODEL, [{ role: 'user', content: 'q' }], { reasoningEffort: 'high' });
    assert.strictEqual(result.content, 'Answer');
    assert.strictEqual(result.thinking, 'hmm');
    assert.deepStrictEqual(
        Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens'].map((k) => [k, result.usage[k]])),
        { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520, cached_tokens: 448, reasoning_tokens: 0 });
    assert.strictEqual(result.stop_reason, 'stop');
});

test('chat: model_length is a truncation (length); tool-call arguments come back as a string', async () => {
    const { provider } = withClient({
        completeWire: {
            choices: [{
                index: 0, finish_reason: 'model_length',
                message: { role: 'assistant', content: '', tool_calls: [{ id: 'Ab3dE6gH9', function: { name: 'f', arguments: { a: 1 } } }] },
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
    });
    const result = await provider.chat('k', null, PLAIN_MODEL, [{ role: 'user', content: 'q' }]);
    assert.strictEqual(result.stop_reason, 'length');
    assert.strictEqual(result.content, null);
    assert.deepStrictEqual(result.toolCalls, [{ id: 'Ab3dE6gH9', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }]);
});

test('chat: a timeout aborts through the signal and says so', async () => {
    const provider = new MistralProvider();
    provider.createClient = () => ({
        chat: {
            complete: (_params, reqOpts) => new Promise((_, reject) => {
                reqOpts.signal.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'RequestAbortedError' })));
            }),
        },
    });
    const err = await provider.chat('k', null, PLAIN_MODEL, [{ role: 'user', content: 'q' }], { timeoutMs: 20 }).then(() => null, e => e);
    assert.match(err.message, /mistral request timed out after 20ms/);
    assert.strictEqual(classifyStreamError(err).retryable, true);
});

// ─── Model discovery ────────────────────────────────────────────────────────

test('listModels: aliases listed as ids, non-chat models categorised, capabilities remembered', async () => {
    const card = (id, caps, extra = {}) => ({
        id, object: 'model', owned_by: 'mistralai', type: 'base', max_context_length: 262144,
        capabilities: { completion_chat: true, function_calling: true, ...caps }, ...extra,
    });
    const { provider } = withClient({
        models: [
            card('mistral-small-2603', { reasoning: true, vision: true }, { aliases: ['mistral-small-latest', 'mistral-small-4'] }),
            card('mistral-embed-2312', { completion_chat: false, function_calling: false }, { max_context_length: 8192 }),
            card('mistral-ocr-2512', { completion_chat: false, function_calling: false, ocr: true }),
            card('voxtral-mini-2602', { completion_chat: false, audio_transcription: true }),
            card('new-model-2701', { vision: true }, { deprecation: '2027-06-01T00:00:00Z' }),
            { id: 'unknown-card', type: 'something_new' },
        ],
    });
    const models = await provider.listModels('k', 'https://api.mistral.ai/v1');
    const byId = Object.fromEntries(models.map(m => [m.id, m]));

    assert.deepStrictEqual(Object.keys(byId).sort(), [
        'mistral-embed-2312', 'mistral-ocr-2512', 'mistral-small-2603', 'mistral-small-4',
        'mistral-small-latest', 'new-model-2701', 'voxtral-mini-2602',
    ]);
    assert.deepStrictEqual(byId['mistral-small-latest'], {
        id: 'mistral-small-latest', name: 'Mistral Small 4', cat: 'Generalist',
        vision: true, tools: true, reasoning: true, efforts: ['none', 'high'], contextWindow: 262144,
    });
    assert.strictEqual(byId['mistral-embed-2312'].cat, 'Embedding');
    assert.strictEqual(byId['mistral-ocr-2512'].cat, 'OCR');
    assert.strictEqual(byId['voxtral-mini-2602'].cat, 'Audio');
    assert.strictEqual(byId['new-model-2701'].deprecated, true);

    // What the API said is what the capability checks answer now.
    assert.strictEqual(provider.supportsVision('new-model-2701'), true);
    assert.strictEqual(describeMistralModel('new-model-2701').context, 262144);
});

test('listModels: a failed call lists nothing (an invalid key must not look like a working provider)', async () => {
    const provider = new MistralProvider();
    provider.createClient = () => ({ models: { list: async () => { throw new Error('401'); } } });
    assert.deepStrictEqual(await provider.listModels('bad', null), []);
});

// ─── Capabilities ───────────────────────────────────────────────────────────

test('vision: current models see images, not only the retired Pixtral line', () => {
    const p = new MistralProvider();
    for (const model of ['mistral-medium-latest', 'mistral-small-latest', 'mistral-large-latest', 'ministral-8b-latest', 'pixtral-large-latest']) {
        assert.strictEqual(p.supportsVision(model), true, model);
    }
    for (const model of ['codestral-latest', 'mistral-large-2411', 'ministral-8b-2410']) {
        assert.strictEqual(p.supportsVision(model), false, model);
    }
});

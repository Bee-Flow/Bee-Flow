/**
 * Contract tests — OpenAI streaming event mapping.
 *
 * Run: node --test core/providers/openai.stream.test.js
 *
 * The two stream paths had no coverage at all, which is how a single-slot
 * function-call accumulator survived on the Responses path: it works perfectly
 * until the model emits two tools in one turn, and then one of them silently
 * disappears.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const OpenAIProvider = require('./openai');

const REASONING_MODEL = 'gpt-5.6-terra';
const PLAIN_MODEL = 'gpt-4o';

/**
 * An SDK-shaped stream: an async iterable of typed events.
 *
 * The event shapes below mirror the SDK's own types EXACTLY, and that matters
 * more than it looks. `response.output_item.added` carries `item` and
 * `output_index` and NO `item_id`; the argument delta/done events carry
 * `item_id` and `output_index`. A fixture that invents `item_id` on the added
 * event hides a real bug — keying the in-flight call on `item_id ?? output_index`
 * then stores under one key and looks up under another, and every tool call
 * disappears. That shipped once. Do not "tidy" these fixtures.
 */
function fakeStream(events) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
        },
    };
}

function collect(provider, events, { responses = true } = {}) {
    const seen = [];
    const client = responses
        ? { responses: { create: async () => fakeStream(events) } }
        : { chat: { completions: { create: async () => fakeStream(events) } } };
    provider.createClient = () => client;
    return { seen, client, onEvent: (type, data) => seen.push({ type, ...data }) };
}

// ─── Responses path ─────────────────────────────────────────────────────────

test('two parallel tool calls in one Responses stream BOTH arrive', async () => {
    const provider = new OpenAIProvider();
    const { seen, onEvent } = collect(provider, [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'alpha' } },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'beta' } },
        // Interleaved argument deltas — the shape that clobbered a single slot.
        { type: 'response.function_call_arguments.delta', item_id: 'fc_a', output_index: 0, delta: '{"x":' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_b', output_index: 1, delta: '{"y":' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_a', output_index: 0, delta: '1}' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_b', output_index: 1, delta: '2}' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_a', output_index: 0, arguments: '{"x":1}' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_b', output_index: 1, arguments: '{"y":2}' },
        { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: {} } },
    ]);

    await provider.stream('k', null, REASONING_MODEL, [{ role: 'user', content: 'go' }], {}, onEvent);

    const calls = seen.filter(e => e.type === 'tool_use');
    assert.strictEqual(calls.length, 2, 'both tool calls emitted');
    assert.deepStrictEqual(calls.map(c => c.name).sort(), ['alpha', 'beta']);
    assert.deepStrictEqual(calls.find(c => c.name === 'alpha').input, { x: 1 });
    assert.deepStrictEqual(calls.find(c => c.name === 'beta').input, { y: 2 });
});

test('a Responses tool call with unparseable arguments is dropped, not sent as {}', async () => {
    // Emitting input:{} means the tool runs with no arguments and DOES
    // something; the poisoned call also gets echoed back next round (BFSF-143).
    const provider = new OpenAIProvider();
    const { seen, onEvent } = collect(provider, [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'delete_rows' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_a', output_index: 0, delta: '{"ids": [1,' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_a', output_index: 0, arguments: '{"ids": [1,' },
        { type: 'response.completed', response: { id: 'r', status: 'completed', usage: {} } },
    ]);

    await provider.stream('k', null, REASONING_MODEL, [{ role: 'user', content: 'go' }], {}, onEvent);

    assert.strictEqual(seen.filter(e => e.type === 'tool_use').length, 0);
});

test('Responses tool arguments stream out as tool_args_delta', async () => {
    const provider = new OpenAIProvider();
    const { seen, onEvent } = collect(provider, [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'notebook_write' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_a', output_index: 0, delta: '{"body":"he' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_a', output_index: 0, delta: 'llo"}' },
        { type: 'response.function_call_arguments.done', item_id: 'fc_a', output_index: 0, arguments: '{"body":"hello"}' },
        { type: 'response.completed', response: { id: 'r', status: 'completed', usage: {} } },
    ]);

    await provider.stream('k', null, REASONING_MODEL, [{ role: 'user', content: 'go' }], {}, onEvent);

    const deltas = seen.filter(e => e.type === 'tool_args_delta');
    assert.strictEqual(deltas.length, 2);
    assert.strictEqual(deltas[1].partial, '{"body":"hello"}');
    assert.strictEqual(deltas[1].name, 'notebook_write');
});

test('Responses usage is normalised, cached and reasoning tokens included', async () => {
    const provider = new OpenAIProvider();
    const { seen, onEvent } = collect(provider, [
        { type: 'response.output_text.delta', delta: 'hi' },
        {
            type: 'response.completed',
            response: {
                id: 'resp_9', status: 'completed',
                usage: {
                    input_tokens: 1000, output_tokens: 200, total_tokens: 1200,
                    input_tokens_details: { cached_tokens: 768 },
                    output_tokens_details: { reasoning_tokens: 150 },
                },
            },
        },
    ]);

    await provider.stream('k', null, REASONING_MODEL, [{ role: 'user', content: 'go' }], {}, onEvent);

    const done = seen.find(e => e.type === 'done');
    assert.strictEqual(done.prompt_tokens, 1000);
    assert.strictEqual(done.completion_tokens, 200);
    assert.strictEqual(done.cached_tokens, 768);
    assert.strictEqual(done.reasoning_tokens, 150);
    assert.strictEqual(done.responseId, 'resp_9');
});

test('a truncated response surfaces its reason instead of a bare done', async () => {
    const provider = new OpenAIProvider();
    const { seen, onEvent } = collect(provider, [
        { type: 'response.output_text.delta', delta: 'partial' },
        {
            type: 'response.incomplete',
            response: {
                id: 'resp_x', status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                usage: { input_tokens: 10, output_tokens: 5 },
            },
        },
    ]);

    await provider.stream('k', null, REASONING_MODEL, [{ role: 'user', content: 'go' }], {}, onEvent);

    const done = seen.find(e => e.type === 'done');
    assert.strictEqual(done.stop_reason, 'max_output_tokens');
    assert.strictEqual(done.prompt_tokens, 10);
});

test('a failed response emits an error event', async () => {
    const provider = new OpenAIProvider();
    const { seen, onEvent } = collect(provider, [
        { type: 'response.failed', response: { id: 'r', status: 'failed', error: { message: 'upstream exploded' } } },
    ]);

    await provider.stream('k', null, REASONING_MODEL, [{ role: 'user', content: 'go' }], {}, onEvent);

    const err = seen.find(e => e.type === 'error');
    assert.ok(err, 'error event emitted');
    assert.match(err.error, /upstream exploded/);
    assert.strictEqual(seen.find(e => e.type === 'done').stop_reason, 'error');
});

test('a bare error event carries its message at the top level', async () => {
    // Different shape from response.failed: `message`/`code`/`param`, no wrapper.
    const provider = new OpenAIProvider();
    const { seen, onEvent } = collect(provider, [
        { type: 'error', code: 'server_error', message: 'the model is overloaded', param: null },
    ]);

    await provider.stream('k', null, REASONING_MODEL, [{ role: 'user', content: 'go' }], {}, onEvent);

    assert.match(seen.find(e => e.type === 'error').error, /overloaded/);
});

test('a reasoning summary opens on the part event the SDK actually emits', async () => {
    const provider = new OpenAIProvider();
    const { seen, onEvent } = collect(provider, [
        { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0 },
        { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'weighing…' },
        { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'weighing…' },
        { type: 'response.completed', response: { id: 'r', status: 'completed', usage: {} } },
    ]);

    await provider.stream('k', null, REASONING_MODEL, [{ role: 'user', content: 'go' }], {}, onEvent);

    assert.strictEqual(seen.filter(e => e.type === 'thinking_start').length, 1);
    assert.strictEqual(seen.filter(e => e.type === 'thinking').length, 1);
    assert.strictEqual(seen.filter(e => e.type === 'thinking_stop').length, 1);
});

test('an unterminated reasoning summary is still closed', async () => {
    const provider = new OpenAIProvider();
    const { seen, onEvent } = collect(provider, [
        { type: 'response.reasoning_summary_text.added', summary_index: 0 },
        { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'thinking…' },
        { type: 'response.completed', response: { id: 'r', status: 'completed', usage: {} } },
    ]);

    await provider.stream('k', null, REASONING_MODEL, [{ role: 'user', content: 'go' }], {}, onEvent);

    assert.strictEqual(seen.filter(e => e.type === 'thinking_start').length, 1);
    assert.strictEqual(seen.filter(e => e.type === 'thinking_stop').length, 1);
});

// ─── Chat Completions path ──────────────────────────────────────────────────

test('Completions usage is normalised the same way', async () => {
    const provider = new OpenAIProvider();
    const { seen, onEvent } = collect(provider, [
        { choices: [{ delta: { content: 'hi' } }] },
        {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: {
                prompt_tokens: 500, completion_tokens: 60, total_tokens: 560,
                prompt_tokens_details: { cached_tokens: 384 },
                completion_tokens_details: { reasoning_tokens: 20 },
            },
        },
    ], { responses: false });

    await provider.stream('k', null, PLAIN_MODEL, [{ role: 'user', content: 'go' }], { useChatCompletions: true }, onEvent);

    const done = seen.find(e => e.type === 'done');
    assert.strictEqual(done.prompt_tokens, 500);
    assert.strictEqual(done.cached_tokens, 384);
    assert.strictEqual(done.reasoning_tokens, 20);
    assert.strictEqual(done.stop_reason, 'stop');
});

test('Completions still drops nameless and unparseable tool calls', async () => {
    const provider = new OpenAIProvider();
    const { seen, onEvent } = collect(provider, [
        {
            choices: [{
                delta: {
                    tool_calls: [
                        { index: 0, id: 'call_a', function: { name: 'good', arguments: '{"a":1}' } },
                        { index: 1, id: 'call_b', function: { name: '', arguments: '{}' } },
                        { index: 2, id: 'call_c', function: { name: 'broken', arguments: '{"a":' } },
                    ],
                },
            }],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ], { responses: false });

    await provider.stream('k', null, PLAIN_MODEL, [{ role: 'user', content: 'go' }], { useChatCompletions: true }, onEvent);

    const calls = seen.filter(e => e.type === 'tool_use');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'good');
});

/**
 * Contract tests — OpenAI Responses API input construction.
 *
 * Run: node --test core/providers/openai.responsesInput.test.js
 *
 * These pin down the adapter behavior the direct-chat chaining guard depends
 * on: when `previousResponseId` chaining is active, ONLY the last user message
 * is transmitted — any hydrated attachment text living in earlier history
 * never reaches the provider. That is exactly why directChat disables chaining
 * for conversations with attachment context (see routes/ai/directChat/
 * historyMerge.js shouldDisableResponsesChaining).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const OpenAIProvider = require('./openai');

const REASONING_MODEL = 'gpt-5'; // routes through the Responses API

function fakeClient(captured) {
    return {
        responses: {
            create: async (params) => {
                captured.params = params;
                return { id: 'resp_new', output: [], output_text: 'ok', usage: { total_tokens: 1 } };
            },
        },
    };
}

function historyWithHydratedFile() {
    return [
        { role: 'system', content: 'be helpful' },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'summarize the report' },
                { type: 'text', text: 'HYDRATED-FILE-TEXT' }, // historyHydrator re-injection
            ],
        },
        { role: 'assistant', content: 'the report says X' },
        { role: 'user', content: 'and what about Q3?' },
    ];
}

test('chaining sends ONLY the last user message — hydrated history is dropped', async () => {
    const provider = new OpenAIProvider();
    const captured = {};
    provider.createClient = () => fakeClient(captured);

    const result = await provider.chat('k', null, REASONING_MODEL, historyWithHydratedFile(), {
        previousResponseId: 'resp_prev',
    });

    assert.strictEqual(captured.params.previous_response_id, 'resp_prev');
    const flat = JSON.stringify(captured.params.input);
    assert.ok(flat.includes('and what about Q3?'), 'last user message transmitted');
    assert.ok(!flat.includes('HYDRATED-FILE-TEXT'), 'earlier hydrated file text is NOT transmitted');
    assert.ok(!flat.includes('the report says X'), 'earlier assistant turn is NOT transmitted');
    assert.strictEqual(result.responseId, 'resp_new');
});

test('without previousResponseId the full hydrated history is transmitted', async () => {
    const provider = new OpenAIProvider();
    const captured = {};
    provider.createClient = () => fakeClient(captured);

    await provider.chat('k', null, REASONING_MODEL, historyWithHydratedFile(), {});

    assert.strictEqual(captured.params.previous_response_id, undefined);
    const flat = JSON.stringify(captured.params.input);
    assert.ok(flat.includes('HYDRATED-FILE-TEXT'), 'hydrated file text reaches the provider');
    assert.ok(flat.includes('and what about Q3?'));
    // Text blocks are normalized to Responses input_text parts
    assert.ok(flat.includes('input_text'));
});

test('responsesStore=false (Azure behavior) never chains, even with previousResponseId', async () => {
    const provider = new OpenAIProvider();
    provider.responsesStore = false;
    const captured = {};
    provider.createClient = () => fakeClient(captured);

    const result = await provider.chat('k', null, REASONING_MODEL, historyWithHydratedFile(), {
        previousResponseId: 'resp_prev',
    });

    assert.strictEqual(captured.params.previous_response_id, undefined, 'no chaining without server-side storage');
    const flat = JSON.stringify(captured.params.input);
    assert.ok(flat.includes('HYDRATED-FILE-TEXT'), 'full history sent instead');
    assert.strictEqual(result.responseId, null, 'no chaining anchor handed back');
});

test('chaining keeps the tool results that follow the last user message', async () => {
    // Regression: the non-streaming path used to send ONLY the last user
    // message, so a chained tool round arrived without the tool output the
    // model was waiting for. The streaming path always sent the whole tail.
    const provider = new OpenAIProvider();
    const captured = {};
    provider.createClient = () => fakeClient(captured);

    await provider.chat('k', null, REASONING_MODEL, [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'what is the weather?' },
        {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'SUNNY-18C' },
    ], { previousResponseId: 'resp_prev' });

    const flat = JSON.stringify(captured.params.input);
    assert.ok(flat.includes('SUNNY-18C'), 'tool output reaches the provider');
    assert.ok(flat.includes('function_call_output'), 'sent as a function_call_output item');
});

test('stateless mode replays the encrypted reasoning it was given', async () => {
    // With store:false there is no server-side state, so the model's reasoning
    // is lost between tool rounds unless we carry it ourselves.
    const provider = new OpenAIProvider();
    provider.responsesStore = false;
    const captured = {};
    provider.createClient = () => fakeClient(captured);

    await provider.chat('k', null, REASONING_MODEL, [
        { role: 'user', content: 'think hard' },
        {
            role: 'assistant',
            content: null,
            reasoningItems: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENCRYPTED-BLOB' }],
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ], { reasoningSummary: true });

    // No `include` is sent: encrypted reasoning comes back by default in
    // stateless mode, and the legacy include value is one more thing to be
    // rejected for no gain.
    assert.strictEqual(captured.params.include, undefined);
    const input = captured.params.input;
    const reasoningIdx = input.findIndex(i => i.type === 'reasoning');
    const callIdx = input.findIndex(i => i.type === 'function_call');
    assert.ok(reasoningIdx >= 0, 'encrypted reasoning item is replayed');
    assert.ok(reasoningIdx < callIdx, 'and precedes the tool call it led to');
});

test('no cache breakpoint is sent unless it is asked for', async () => {
    // Regression: it used to be on by default AND placed on the input ITEM,
    // which the API answers with
    // `400 Unknown parameter: 'input[1].prompt_cache_breakpoint'` — every
    // message in a chat failed.
    const provider = new OpenAIProvider();
    const captured = {};
    provider.createClient = () => fakeClient(captured);

    await provider.chat('k', null, REASONING_MODEL, historyWithHydratedFile(), {});

    const flat = JSON.stringify(captured.params.input);
    assert.ok(!flat.includes('prompt_cache_breakpoint'), 'nothing emitted by default');
});

test('an opt-in breakpoint lands on the content object, not the item', async () => {
    const provider = new OpenAIProvider();
    const captured = {};
    provider.createClient = () => fakeClient(captured);

    await provider.chat('k', null, 'gpt-5.6-terra', historyWithHydratedFile(), { cacheBreakpoint: true });

    const developer = captured.params.input.find(i => i.role === 'developer');
    assert.ok(developer, 'system message becomes a developer item');
    assert.strictEqual(developer.prompt_cache_breakpoint, undefined, 'never on the item');
    const part = developer.content[developer.content.length - 1];
    assert.deepStrictEqual(part.prompt_cache_breakpoint, { mode: 'explicit' });

    // Exactly one breakpoint — more than one would fragment the prefix.
    const marked = JSON.stringify(captured.params.input).match(/prompt_cache_breakpoint/g) || [];
    assert.strictEqual(marked.length, 1);
});

test('a model whose generation lacks the parameter never receives it', async () => {
    const provider = new OpenAIProvider();
    const captured = {};
    provider.createClient = () => fakeClient(captured);

    // gpt-5.2 predates explicit breakpoints — asking for one must be ignored,
    // not forwarded into a 400.
    await provider.chat('k', null, 'gpt-5.2', historyWithHydratedFile(), { cacheBreakpoint: true });

    const flat = JSON.stringify(captured.params.input);
    assert.ok(!flat.includes('prompt_cache_breakpoint'));
});

test('an image always carries a detail — it is required on Responses', async () => {
    // Optional on a Chat Completions image_url block, REQUIRED on a Responses
    // input_image. A caller that omitted it used to take the whole request down.
    const provider = new OpenAIProvider();
    const captured = {};
    provider.createClient = () => fakeClient(captured);

    await provider.chat('k', null, REASONING_MODEL, [{
        role: 'user',
        content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            { type: 'image_url', image_url: 'https://example.test/b.png' },
            { type: 'image_url', image_url: { url: 'https://example.test/c.png', detail: 'high' } },
        ],
    }], {});

    const images = captured.params.input[0].content.filter(c => c.type === 'input_image');
    assert.strictEqual(images.length, 3);
    assert.deepStrictEqual(images.map(i => i.detail), ['auto', 'auto', 'high']);
    assert.ok(images.every(i => typeof i.image_url === 'string' && i.image_url));
});

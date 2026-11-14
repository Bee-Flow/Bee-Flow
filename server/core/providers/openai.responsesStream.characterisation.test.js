'use strict';

/**
 * Characterisation (golden) test for the Responses-API stream of the OpenAI
 * adapter (OpenAIProvider._streamResponses, reached through stream()): the
 * ordered onEvent sequence a recorded event stream produces. Pins text,
 * reasoning-summary parts (opened on the part event, the legacy text event or
 * the first delta; closed on done, on the terminal events and at the end),
 * keyed parallel function calls (by output index, by item id, by neither),
 * the final arguments overriding the deltas, and what the completed,
 * incomplete, failed and error events put in `done`.
 *
 * openai.stream.test.js holds the contract tests; this file pins the whole
 * sequence so the function can be split without a change.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/providers/openai.responsesStream.characterisation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';

const OpenAIProvider = require('./openai');

const GOLDEN = path.join(__dirname, 'openai.responsesStream.characterisation.golden.json');
const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

const fc = (outputIndex, id, callId, name) => ({ type: 'response.output_item.added', output_index: outputIndex, item: { type: 'function_call', id, call_id: callId, name } });
const argDelta = (extra, delta) => ({ type: 'response.function_call_arguments.delta', ...extra, delta });
const argDone = (extra, args) => ({ type: 'response.function_call_arguments.done', ...extra, ...(args === undefined ? {} : { arguments: args }) });
const usage = { input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } };

const CASES = {
    textAndReasoning: [
        { type: 'response.reasoning_summary_part.added', summary_index: 0 },
        { type: 'response.reasoning_summary_part.added', summary_index: 0 },
        { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'think ' },
        { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: '' },
        { type: 'response.reasoning_summary_text.done', summary_index: 0 },
        { type: 'response.reasoning_summary_text.done', summary_index: 0 },
        { type: 'response.reasoning_summary_text.added', summary_index: 1 },
        { type: 'response.reasoning_summary_text.delta', delta: 'no index opens part 0' },
        { type: 'response.reasoning_summary_text.delta', summary_index: 2, delta: 'opened by delta' },
        { type: 'response.output_text.delta', delta: 'Hello ' },
        { type: 'response.output_text.delta', delta: '' },
        { type: 'response.output_text.delta', delta: 'world' },
        { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage, service_tier: 'default', output: [
            { type: 'reasoning', encrypted_content: 'enc-1' }, { type: 'reasoning' }, { type: 'message' }, null,
        ] } },
    ],
    toolCalls: [
        fc(0, 'fc_a', 'call_a', 'alpha'),
        fc(1, 'fc_b', undefined, 'beta'),
        { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_c' } },
        { type: 'response.output_item.added', output_index: 3, item: { type: 'message', id: 'msg' } },
        argDelta({ item_id: 'fc_a', output_index: 0 }, '{"x":'),
        argDelta({ item_id: 'fc_b', output_index: 1 }, '{"y":'),
        argDelta({ item_id: 'fc_c', output_index: 2 }, '{}'),
        argDelta({ item_id: 'fc_a', output_index: 0 }, ''),
        argDelta({ item_id: 'fc_a', output_index: 0 }, '1}'),
        argDelta({ item_id: 'nobody', output_index: 9 }, '{"lost":1}'),
        argDone({ item_id: 'fc_b', output_index: 1 }, '{"y":"final"}'),
        argDone({ item_id: 'fc_a', output_index: 0 }, ''),
        argDone({ item_id: 'fc_a', output_index: 0 }, '{"again":1}'),
        argDone({ item_id: 'fc_c', output_index: 2 }),
        argDone({ item_id: 'nobody', output_index: 9 }, '{}'),
        { type: 'response.completed', response: { status: 'completed' } },
    ],
    keyedByItemIdOnly: [
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_z', call_id: 'call_z', name: 'zed' } },
        argDelta({ item_id: 'fc_z' }, '{"z":1}'),
        argDone({ item_id: 'fc_z' }),
    ],
    keyedByNothing: [
        { type: 'response.output_item.added', item: { type: 'function_call', name: 'anon' } },
        argDelta({}, '{"a":'),
        argDelta({}, '2}'),
        argDone({}),
    ],
    // A delta or done whose keys match no call in flight is ignored; it never
    // lands on another call.
    strayKeys: [
        fc(0, 'fc_s', 'call_s', 'steady'),
        argDelta({ item_id: 'fc_s', output_index: 0 }, '{"s":1}'),
        argDelta({ item_id: 'elsewhere', output_index: 5 }, ',"stray":2}'),
        argDone({ item_id: 'elsewhere', output_index: 5 }, '{"wrong":true}'),
        argDone({ item_id: 'fc_s', output_index: 0 }),
    ],
    badArguments: [
        fc(0, 'fc_bad', 'call_bad', 'broken'),
        argDelta({ item_id: 'fc_bad', output_index: 0 }, '{not json'),
        argDone({ item_id: 'fc_bad', output_index: 0 }),
        fc(1, 'fc_nameless', 'call_nameless', ''),
        argDelta({ item_id: 'fc_nameless', output_index: 1 }, '{}'),
        argDone({ item_id: 'fc_nameless', output_index: 1 }),
    ],
    incomplete: [
        { type: 'response.reasoning_summary_part.added', summary_index: 0 },
        { type: 'response.output_text.delta', delta: 'cut' },
        { type: 'response.incomplete', response: { id: 'resp_i', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage } },
    ],
    incompleteNoReason: [
        { type: 'response.incomplete', response: { status: 'incomplete' } },
    ],
    incompleteNoResponse: [
        { type: 'response.incomplete' },
    ],
    completedWithIncompleteDetails: [
        { type: 'response.completed', response: { status: 'completed', incomplete_details: { reason: 'content_filter' } } },
    ],
    completedTwice: [
        { type: 'response.completed', response: { id: 'r1', status: 'completed', usage } },
        { type: 'response.completed', response: { status: 'in_progress' } },
    ],
    failed: [
        { type: 'response.reasoning_summary_part.added', summary_index: 3 },
        { type: 'response.failed', response: { error: { message: 'server_error happened' } } },
    ],
    failedAfterCompleted: [
        { type: 'response.completed', response: { id: 'r2', status: 'completed', usage } },
        { type: 'error', message: 'late error' },
    ],
    errorShapes: [
        { type: 'error', error: { message: 'nested message' } },
        { type: 'error', message: 'top-level message', code: 'x' },
        { type: 'error' },
    ],
    unknownEventsOnly: [
        { type: 'response.created', response: { id: 'r0' } },
        { type: 'response.in_progress' },
        { type: 'response.content_part.added' },
    ],
    empty: [],
};

const OPTION_CASES = {
    previousResponseId: { previousResponseId: 'resp_prev' },
};

function fakeStream(events) {
    return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } };
}

async function run(events, options = {}) {
    const provider = new OpenAIProvider();
    const sent = [];
    provider.createClient = () => ({ responses: { create: async (params) => { sent.push(clone({ stream: params.stream, previous_response_id: params.previous_response_id ?? null })); return fakeStream(events); } } });
    const seen = [];
    let error = null;
    try {
        await provider.stream('sk-test', null, 'gpt-5.6-terra', [{ role: 'user', content: 'hi' }], options, (type, data) => seen.push([type, clone(data)]));
    } catch (e) {
        error = e.message;
    }
    return { sent, seen, error };
}

let _collected = null;
async function collect() {
    if (_collected) return _collected;
    const out = {};
    for (const [key, events] of Object.entries(CASES)) out[key] = await run(events);
    for (const [key, options] of Object.entries(OPTION_CASES)) out[key] = await run(CASES.empty, options);
    _collected = out;
    return out;
}

function loadOrWrite(actual) {
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    return JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
}

for (const key of [...Object.keys(CASES), ...Object.keys(OPTION_CASES)]) {
    test(`golden: ${key}`, async () => {
        const actual = await collect();
        const golden = loadOrWrite(actual);
        assert.deepEqual(clone(actual[key]), golden[key]);
    });
}

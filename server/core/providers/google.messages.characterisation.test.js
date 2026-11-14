'use strict';

/**
 * Characterisation (golden) test for the message conversion of the Google
 * adapter (GoogleProvider.normalizeMessages, inherited by Vertex): the
 * `contents` and `systemInstruction` chat() sends to the SDK for a given
 * OpenAI-shaped history. Pins system folding, the function name a tool result
 * gets, tool-result wrapping, the verbatim replay of Gemini 3 raw parts, the
 * assistant and user part shapes, and the merge of consecutive same-role
 * turns.
 *
 * No network: createClient is replaced with a fake SDK client, and the system
 * prompts are too short for the explicit context cache.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/providers/google.messages.characterisation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';

const GoogleProvider = require('./google');

const GOLDEN = path.join(__dirname, 'google.messages.characterisation.golden.json');

const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const call = (id, name, args, extra = {}) => ({ id, type: 'function', function: { name, arguments: args }, ...extra });

const CASES = {
    systemFolding: [
        { role: 'system', content: 'first' },
        { role: 'system', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { text: 'b' }] },
        { role: 'system', content: { rule: 1 } },
        { role: 'user', content: 'hi' },
    ],
    systemNullContent: [{ role: 'system', content: null }, { role: 'user', content: 'hi' }],
    toolNames: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'first try', tool_calls: [call('dup', 'oldest', '{}'), call('dup', 'second_in_same', '{}')] },
        { role: 'tool', tool_call_id: 'dup', content: '{"ok":true}' },
        { role: 'assistant', content: null, tool_calls: [call('dup', 'newest', '{}'), call('solo', 'solo_fn', '{"x":1}')] },
        { role: 'tool', tool_call_id: 'dup', content: 'text result' },
        { role: 'tool', tool_call_id: 'solo', content: '[1,2]' },
        { role: 'tool', tool_call_id: 'nobody', name: 'given_name', content: '7' },
        { role: 'tool', content: { not: 'a string' } },
        { role: 'tool', name: 'no_content' },
        { role: 'tool', tool_call_id: 'nobody', content: 'null' },
    ],
    toolBeforeAnyCall: [{ role: 'tool', tool_call_id: 'x', content: '{}' }, { role: 'user', content: 'then' }],
    assistantShapes: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '   ' },
        { role: 'assistant', content: [{ type: 'text', text: 'array text is not sent' }] },
        { role: 'assistant', content: 'answer', tool_calls: [] },
        { role: 'assistant', content: '', tool_calls: [
            call('b1', 'bad_args', 'not json'),
            { id: 'b2', name: 'bare_name', _thought_signature: 'sig-b2' },
            call('b3', 'no_args', undefined),
            call('b4', 'with_sig', '{"k":"v"}', { _thought_signature: 'sig-b4' }),
        ] },
        { role: 'tool', tool_call_id: 'b2', content: 'r2' },
        { role: 'tool', tool_call_id: 'b4', content: 'r4' },
    ],
    rawReplay: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'ignored when raw parts exist', tool_calls: [
            call('r1', 'raw_one', '{}', { _raw_content_parts: [
                { thought: true, text: 'thinking', thoughtSignature: 'ts' },
                { functionCall: { name: 'raw_one', args: {} }, thoughtSignature: 'ts1' },
                'a string part',
                { functionCall: { name: 'raw_two', args: { a: 1 } } },
                { functionCall: { name: 'raw_three', args: {} } },
            ] }),
            call('r2', 'raw_two', '{"a":1}'),
        ] },
        { role: 'tool', tool_call_id: 'r2', content: '{"two":2}' },
        { role: 'tool', tool_call_id: 'r1', content: '{"one":1}' },
    ],
    rawReplayEmptyFallsBack: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'plain', tool_calls: [call('e1', 'empty_raw', '{}', { _raw_content_parts: [] })] },
    ],
    userShapes: [
        { role: 'user', content: '' },
        { role: 'user', content: '  \n ' },
        { role: 'user', content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
            { type: 'image_url', image_url: 'data:image/png;nobase64' },
            { type: 'image_url', image_url: 'https://example.test/a.png' },
            { type: 'image_url', image_url: { url: 'http://example.test/b.webp', mimeType: 'image/webp' } },
            { type: 'image_url', image_url: { url: 'ftp://example.test/c.png' } },
            { type: 'image_url' },
            { type: 'input_audio', input_audio: {} },
        ] },
        { role: 'user', content: [{ type: 'image_url', image_url: 'ftp://nothing' }] },
        { role: 'user', content: { an: 'object' } },
        { content: 'no role is a user turn' },
        { role: 'developer', content: 'unknown roles are user turns' },
    ],
};

function fakeClient(log) {
    return {
        models: { generateContent: async (params) => { log.push(clone({ contents: params.contents, systemInstruction: params.config?.systemInstruction ?? null })); return { text: 'ok' }; } },
        caches: { create: async () => { throw new Error('no cache in this test'); } },
    };
}

async function run(messages) {
    const p = new GoogleProvider();
    const sent = [];
    p.createClient = () => fakeClient(sent);
    try {
        await p.chat('key', null, 'gemini-2.5-flash', clone(messages), {});
    } catch (e) {
        return { error: e.message };
    }
    return sent[0];
}

let _collected = null;
async function collect() {
    if (_collected) return _collected;
    const out = {};
    for (const [key, messages] of Object.entries(CASES)) out[key] = await run(messages);
    // A raw part that is null is not an object to clean up.
    out.rawReplayNullPart = await run([{ role: 'assistant', content: '', tool_calls: [call('n1', 'f', '{}', { _raw_content_parts: [null] })] }]);
    // The caller's history is not changed by the conversion.
    const history = clone(CASES.rawReplay);
    const before = JSON.stringify(history);
    new GoogleProvider().normalizeMessages(history);
    out.inputUntouched = JSON.stringify(history) === before;
    _collected = out;
    return out;
}

function loadOrWrite(actual) {
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    return JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
}

for (const key of [...Object.keys(CASES), 'rawReplayNullPart', 'inputUntouched']) {
    test(`golden: ${key}`, async () => {
        const actual = await collect();
        const golden = loadOrWrite(actual);
        assert.deepEqual(clone(actual[key]), golden[key]);
    });
}

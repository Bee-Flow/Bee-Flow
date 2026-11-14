'use strict';

/**
 * Characterisation (golden) test for llmClient.extractForcedResult: what a
 * forced-tool answer is read as, and the warning lines it logs, for answers
 * shaped the way the adapters hand them up. Pins the call chosen (the named
 * one, else the first), argument parsing (object, JSON, a loose Gemma parse,
 * unparsable), a call written as text into the content or the thinking, the
 * JSON-body fallback, the stop reason of either spelling, rawArguments, and
 * the log line of each path (tool call, loose parse, text, content,
 * unparsable, garbled).
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/llm/llmClient.extractForcedResult.characterisation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';

const { extractForcedResult } = require('./llmClient');

const GOLDEN = path.join(__dirname, 'llmClient.extractForcedResult.characterisation.golden.json');
const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

const call = (name, args) => ({ id: `c_${name}`, type: 'function', function: { name, arguments: args } });
const T = 'emit_result';

const CASES = {
    nullResult: [null, T],
    namedCallWins: [{ toolCalls: [call('other', '{"a":1}'), call(T, '{"ok":true}')], content: 'prose', usage: { total_tokens: 3 }, raw: { id: 'r' }, stopReason: 'tool_use' }, T],
    firstCallFallback: [{ toolCalls: [call('other', '{"a":1}')], stop_reason: 'stop', stopReason: 'ignored' }, T],
    bareNameCall: [{ toolCalls: [{ name: T, input: { via: 'input' } }] }, T],
    objectArguments: [{ toolCalls: [{ function: { name: T, arguments: { already: 'object' } } }] }, T],
    jsonNotObject: [{ toolCalls: [call(T, '42')] }, T],
    numberArguments: [{ toolCalls: [{ function: { name: T, arguments: 7 } }] }, T],
    looseGemma: [{ toolCalls: [call(T, '{ok:true,note:<|">done<|">}<tool_call|>trailing')] }, T],
    unparsableLogged: [{ toolCalls: [call(T, '{"ok":true,"text":"cut')], stop_reason: 'length', content: null }, T, { modelId: 'local-x' }],
    unparsableBlank: [{ toolCalls: [call(T, '   ')] }, T],
    garbledButReturned: [{ toolCalls: [call(T, '{"text":"a},b:{c"}')], stopReason: 'end_turn' }, T],
    garbledControlToken: [{ toolCalls: [call(T, '{"text":"x}]}<tool_call|>y"}')] }, T],
    writtenInContent: [{ toolCalls: [], content: 'Sure.\n<tool_call>{"name":"emit_result","arguments":{"ok":false}}</tool_call>' }, T],
    writtenInThinking: [{ toolCalls: null, content: null, thinking: 'I should.\n<|tool_call>call:emit_result{ok:true,note:<|">done<|">}<tool_call|>', stop_reason: 'stop' }, T],
    writtenOtherTool: [{ content: '<tool_call>{"name":"not_it","arguments":{"x":1}}</tool_call>' }, T],
    writtenBadArgs: [{ content: '<tool_call>{"name":"emit_result","arguments":"{broken"}</tool_call>' }, T],
    bareJsonNamingTool: [{ content: '{"name":"emit_result","arguments":{"ok":"named"}}' }, T],
    bareJsonBody: [{ content: '{"name":"invoices","ok":true}' }, T],
    fencedJsonBody: [{ content: '```json\n{"fenced":true}\n```' }, T],
    proseOnly: [{ content: 'I cannot do that.', stopReason: 'end_turn' }, T],
    // The raw of the real call stays what a repair round quotes, even when
    // the answer is read from a call written into the content.
    unparsableThenWritten: [{ toolCalls: [call(T, 'nope')], content: '<tool_call>{"name":"emit_result","arguments":{"ok":"text"}}</tool_call>' }, T],
    writtenNullArgs: [{ content: '<tool_call>{"name":"emit_result","arguments":null}</tool_call>' }, T],
    unparsableThenContent: [{ toolCalls: [call(T, 'nope')], content: '{"from":"content"}' }, T],
    noToolName: [{ content: '{"x":1}' }, ''],
    thinkingNotString: [{ content: null, thinking: [{ text: 'x' }] }, T],
};

function run(args) {
    const lines = [];
    const original = console.warn;
    console.warn = (...parts) => lines.push(parts.map(String).join(' '));
    try {
        const out = extractForcedResult(...args);
        return { out: clone(out), warnings: lines };
    } finally {
        console.warn = original;
    }
}

let _collected = null;
function collect() {
    if (_collected) return _collected;
    _collected = {};
    for (const [key, args] of Object.entries(CASES)) _collected[key] = run(clone(args));
    return _collected;
}

function loadOrWrite(actual) {
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    return JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
}

for (const key of Object.keys(CASES)) {
    test(`golden: ${key}`, () => {
        const actual = collect();
        const golden = loadOrWrite(actual);
        assert.deepEqual(actual[key], golden[key]);
    });
}

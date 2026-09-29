'use strict';

/**
 * One whole assistant turn with a scripted model and the REAL analyser: the
 * edit lands, the check runs, a BLOCK finding opens a repair round, and the
 * client gets exactly one `code` event with the repaired code.
 *
 * Run: node --test routes/ai/automationBuilder/codeAssistTurn.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { runCodeAssistTurn } = require('./codeAssistTurn');
const { analyzeCode } = require('../../../automation/codeSafety');

const usage = { input_tokens: 10, output_tokens: 5 };
const write = (id, code, summary) => ({
    content: '', finishReason: 'tool_calls', usage, thinkingParts: [], invalidToolCalls: [],
    toolCalls: [{ id, type: 'function', function: { name: 'code_write', arguments: JSON.stringify({ code, summary }) } }],
});
const say = (text) => ({ content: text, finishReason: 'stop', usage, thinkingParts: [], invalidToolCalls: [], toolCalls: [] });

function scripted(replies) {
    const seen = [];
    return {
        seen,
        streamRound: async (msgs, { onText }) => {
            seen.push(msgs.map((m) => m.role));
            const r = replies.shift();
            if (!r) throw new Error('the script ran out');
            if (r.content) onText(r.content);
            return r;
        },
    };
}

const CLEAN = `/**
 * Adds VAT to an amount.
 * @param {number} amount - The amount without VAT
 */
async function main(inputs, ctx) {
    return { total: inputs.amount * 1.21 };
}`;

test('a turn that writes blocked code is repaired server-side before the client sees it', async () => {
    const events = [];
    const model = scripted([
        write('c1', 'return eval("inputs.amount * 1.21");', 'Wrote it'),
        say('Done.'),
        write('c2', CLEAN, 'Rewrote it without eval'),
        say('Fixed: it no longer builds code from text.'),
    ]);
    const turn = await runCodeAssistTurn({
        messages: [{ role: 'user', content: 'Add 21% VAT to the amount' }],
        code: '',
        streamRound: model.streamRound,
        analyse: analyzeCode,
        send: (event, data) => events.push([event, data]),
    });
    assert.strictEqual(turn.code, CLEAN);
    assert.strictEqual(turn.repairRounds, 1);
    assert.strictEqual(turn.changed, true);
    assert.deepStrictEqual(turn.analysis.findings.filter((f) => f.severity === 'block'), []);
    const kinds = events.map(([e]) => e);
    assert.strictEqual(kinds.filter((k) => k === 'code').length, 1, 'exactly one code event');
    assert.strictEqual(kinds[kinds.length - 1], 'code');
    assert.strictEqual(kinds.filter((k) => k === 'edit').length, 2, 'both edits went out as they landed');
    const final = events.find(([e]) => e === 'code')[1];
    assert.strictEqual(final.code, CLEAN);
    assert.deepStrictEqual(final.analysis.params.map((p) => p.name), ['amount']);
    // The repair round told the model what the check found.
    assert.ok(model.seen.length >= 3);
});

test('a turn that only answers a question is never repaired and changes nothing', async () => {
    const events = [];
    const model = scripted([say('This code adds VAT to the amount.')]);
    const turn = await runCodeAssistTurn({
        messages: [{ role: 'user', content: 'What does this do?' }],
        code: 'return eval("1");',
        streamRound: model.streamRound,
        analyse: analyzeCode,
        send: (event, data) => events.push([event, data]),
    });
    assert.strictEqual(turn.changed, false);
    assert.strictEqual(turn.repairRounds, 0);
    assert.strictEqual(turn.code, 'return eval("1");');
    assert.deepStrictEqual(events.map(([e]) => e), ['delta', 'code']);
});

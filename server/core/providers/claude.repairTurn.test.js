/**
 * Regression test (BFSF-184): the webpage chat's end-of-turn validation
 * repair round must leave the Claude request ending on a USER turn.
 *
 * The repair used to be pushed as a role:'system' message after the model's
 * closing text. The adapter lifts system messages out of the list, so the
 * request ended on the assistant turn: prefill, which Claude 4.6+ rejects
 * with "This model does not support assistant message prefill".
 *
 * Run: node --test core/providers/claude.repairTurn.test.js
 * Pure message shaping — no network, no SDK client.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ClaudeProvider = require('./claude');
const { validationRepairTurn } = require('../../services/webpageValidation');

const base = [
    { role: 'system', content: 'webpage builder rules' },
    { role: 'user', content: 'add a picture next to the title' },
];

test('repair round built by validationRepairTurn ends on a user turn', () => {
    const p = new ClaudeProvider();
    const messages = [...base, ...validationRepairTurn('Done, the page is updated.', 'fix the missing image')];
    const params = p._buildSdkParams('claude-sonnet-5', messages, {});
    const roles = params.messages.map(m => m.role);
    assert.deepStrictEqual(roles, ['user', 'assistant', 'user']);
    const last = params.messages[params.messages.length - 1];
    const lastText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    assert.ok(lastText.includes('fix the missing image'), 'the repair note is the final user turn');
});

test('the old system-message shape is what ended on the assistant turn', () => {
    // Documents the failure mode: a trailing system message disappears from
    // `messages`, so the assistant text becomes the last turn (prefill).
    const p = new ClaudeProvider();
    const messages = [
        ...base,
        { role: 'assistant', content: 'Done, the page is updated.' },
        { role: 'system', content: 'fix the missing image' },
    ];
    const params = p._buildSdkParams('claude-sonnet-5', messages, {});
    assert.strictEqual(params.messages[params.messages.length - 1].role, 'assistant');
});

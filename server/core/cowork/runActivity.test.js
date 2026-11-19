/**
 * What one Cowork run did, in names and counts only: which tools it called (and how each call ended, a refusal by
 * policy with its reason code), which skills took part, which tools it was offered and whether it asked for a review.
 *
 * Run: node --test core/cowork/runActivity.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const act = require('./runActivity.mts');

const APPS = { gmail_search: 'gmail', gmail_read: 'gmail', outlook_create_draft: 'outlook', gmail_send_reply: 'gmail' };
const appOf = (name) => APPS[name] || null;

const call = (toolName, extra = {}) => ({ toolName, toolArgs: { to: 'ann@example.com', body: 'secret text' }, finalToolResult: { ok: true }, blocked: false, ...extra });

test('a successful call, a failed call and a policy refusal each count under their own outcome', () => {
    const run = act.createRunActivity({ appOf });
    act.noteToolOutcome(run, call('gmail_search'));
    act.noteToolOutcome(run, call('gmail_search'));
    act.noteToolOutcome(run, call('gmail_read', { finalToolResult: { error: 'not found' } }));
    act.noteToolOutcome(run, call('outlook_create_draft', { blocked: true, policyReason: 'privacy_shield', finalToolResult: '[Tool was not called: ...]' }));
    const summary = act.summariseActivity(run, new Map());
    assert.deepStrictEqual(summary.tools.find((t) => t.name === 'gmail_search'), { name: 'gmail_search', app: 'gmail', ok: 2, failed: 0, refused: 0, reasons: [] });
    assert.deepStrictEqual(summary.tools.find((t) => t.name === 'gmail_read'), { name: 'gmail_read', app: 'gmail', ok: 0, failed: 1, refused: 0, reasons: [] });
    assert.deepStrictEqual(summary.tools.find((t) => t.name === 'outlook_create_draft'), { name: 'outlook_create_draft', app: 'outlook', ok: 0, failed: 0, refused: 1, reasons: ['privacy_shield'] });
    assert.strictEqual(summary.toolCalls, 4);
});

test('the gate flags become reason codes; a thrown tool is a failure, not a refusal', () => {
    assert.deepStrictEqual(act.classifyToolOutcome(call('x', { blocked: true, policyRefused: true })), { outcome: 'refused', reason: 'not_offered' });
    assert.deepStrictEqual(act.classifyToolOutcome(call('x', { blocked: true, confirmPending: true })), { outcome: 'refused', reason: 'needs_confirmation' });
    assert.deepStrictEqual(act.classifyToolOutcome(call('x', { blocked: true, confirmDeclined: true })), { outcome: 'refused', reason: 'declined' });
    assert.deepStrictEqual(act.classifyToolOutcome(call('x', { blocked: true, policyReason: 'guardrail' })), { outcome: 'refused', reason: 'guardrail' });
    assert.deepStrictEqual(act.classifyToolOutcome(call('x', { blocked: true, finalToolResult: "[Tool 'x' failed: boom]" })), { outcome: 'failed', reason: null });
    assert.deepStrictEqual(act.classifyToolOutcome(call('x', { finalToolResult: { success: false } })), { outcome: 'failed', reason: null });
    assert.deepStrictEqual(act.classifyToolOutcome(call('x', { finalToolResult: 'Done.' })), { outcome: 'ok', reason: null });
});

test('nothing of a call but its name, app and outcome is kept: no arguments, no result text', () => {
    const run = act.createRunActivity();
    act.noteToolOutcome(run, call('gmail_send_reply', { finalToolResult: { message: 'Sent to ann@example.com' } }));
    const stored = JSON.stringify(act.summariseActivity(run, new Map()));
    assert.ok(!stored.includes('ann@example.com'), stored);
    assert.ok(!stored.includes('secret text'), stored);
});

test('an unknown reason code is not stored as given', () => {
    const run = act.createRunActivity();
    act.noteToolOutcome(run, call('x', { blocked: true, policyReason: 'ann@example.com' }));
    assert.deepStrictEqual(act.summariseActivity(run, new Map()).tools[0].reasons, ['other']);
});

test('skills: static ones and activated ones by name, an activated static one is listed once, unknown ids are left out', () => {
    const run = act.createRunActivity();
    act.noteStaticSkills(run, ['s1', 's2']);
    act.noteActivatedSkills(run, ['s3', 's1', 'gone']);
    const names = new Map([['s1', 'Tone of voice'], ['s2', 'Pricing'], ['s3', 'Offer letter']]);
    assert.deepStrictEqual(act.summariseActivity(run, names).skills, [
        { id: 's1', name: 'Tone of voice', how: 'static' },
        { id: 's2', name: 'Pricing', how: 'static' },
        { id: 's3', name: 'Offer letter', how: 'activated' },
    ]);
    assert.deepStrictEqual(act.skillIdsOf(run).sort(), ['gone', 's1', 's2', 's3']);
});

test('offered tools are remembered as names; the ceiling of a follow-up keeps only those and the review tool', () => {
    const run = act.createRunActivity();
    act.noteOfferedTools(run, [{ function: { name: 'gmail_read' } }, { function: { name: 'gmail_create_draft' } }, { function: {} }]);
    assert.deepStrictEqual(act.offeredToolNames(run), ['gmail_read', 'gmail_create_draft']);

    const followUp = act.createRunActivity({ toolCeiling: ['gmail_read'] });
    const tools = [{ function: { name: 'gmail_read' } }, { function: { name: 'gmail_send_reply' } }, { function: { name: act.REVIEW_TOOL_NAME } }];
    assert.deepStrictEqual(act.applyToolCeiling(followUp, tools).map((t) => t.function.name), ['gmail_read', act.REVIEW_TOOL_NAME]);
    assert.strictEqual(act.applyToolCeiling(act.createRunActivity(), tools).length, 3, 'no ceiling: nothing is taken away');
});

test('a run context that is not a Cowork run is ignored by every note', () => {
    for (const ctx of [null, undefined, {}, 'x']) {
        act.noteToolOutcome(ctx, call('x'));
        act.noteStaticSkills(ctx, ['s1']);
        act.noteActivatedSkills(ctx, ['s1']);
        act.noteOfferedTools(ctx, [{ function: { name: 'x' } }]);
    }
    assert.ok(true);
});

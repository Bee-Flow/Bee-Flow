/**
 * execAiStep with `reportOutcome` (./aiStepVerdict.mts, set by Cowork on a plan's run copy): the verdict is asked in
 * the step's structured answer, comes back beside the output, and never in it. A step without the flag is untouched.
 *
 * Run: node --test core/automationRunner/execAi.verdict.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { installAiStepHarness, runStateWith } = require('../../testUtils/aiStepHarness');

const h = installAiStepHarness({
    extraStubs: {
        './aiStepTools': { async resolveAiStepTools() { return { tools: null, toolsWithheld: [], toolsWithheldReasons: {} }; } },
        '../tools/toolDispatcher': { async executeTool() { return { ok: true }; } },
    },
});
after(() => h.restore());
const { execAiStep } = h.load();

const CTX = { userId: 'u1', orgId: 'org1', session: {}, definition: { steps: [] } };

beforeEach(() => {
    h.chatCalls.length = 0; h.forcedCalls.length = 0; h.usageRows.length = 0;
    h.forced = null;
});

test('a step with a schema: one more field asked, the verdict beside the output', async () => {
    h.forced = async () => ({ structured: { digest: 'Three meetings.', coworkOutcome: { outcome: 'done', reason: 'Summarised them.' } }, usage: {} });
    const r = await execAiStep({ id: 'ai', type: 'ai_step', prompt: 'Summarise.', inputs: {}, outputSchema: { digest: 'string' }, reportOutcome: true }, CTX, runStateWith(), 'live');
    assert.deepStrictEqual(r.output, { digest: 'Three meetings.' });
    assert.deepStrictEqual(r.verdict, { outcome: 'done', reason: 'Summarised them.' });
    assert.ok(h.forcedCalls[0].toolDef.function.parameters.properties.coworkOutcome, 'the verdict is part of the asked answer');
});

test('a step that answers in text answers it again as text, with its verdict beside it', async () => {
    h.forced = async () => ({ structured: { answer: 'No meetings found.', coworkOutcome: { outcome: 'failed', reason: 'The meeting list was empty where it should not be.' } }, usage: {} });
    const r = await execAiStep({ id: 'ai', type: 'ai_step', prompt: 'Write the overview.', inputs: {}, reportOutcome: true }, CTX, runStateWith(), 'live');
    assert.strictEqual(r.output, 'No meetings found.');
    assert.deepStrictEqual(r.verdict, { outcome: 'failed', reason: 'The meeting list was empty where it should not be.' });
});

test('a step that does not ask for a verdict answers exactly as before', async () => {
    h.chat = async () => ({ content: 'Plain text.', usage: {} });
    const r = await execAiStep({ id: 'ai', type: 'ai_step', prompt: 'Write.', inputs: {} }, CTX, runStateWith(), 'live');
    assert.strictEqual(r.output, 'Plain text.');
    assert.strictEqual(r.verdict, undefined);
    assert.strictEqual(h.forcedCalls.length, 0);
});

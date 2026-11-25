/**
 * `cowork_report_outcome` (./outcomeTool.mts): the verdict of a prompt or agent run's AI, which can only make the run
 * worse. Failed is a failed run with the AI's reason; done changes nothing; the row keeps the code, never the reason.
 *
 * Run: cd server && node --test core/cowork/outcomeTool.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { addOutcomeTool, executeOutcomeTool, failureOf, outcomeClose, OUTCOME_TOOL_NAME, AI_VERDICT_ERROR } = require('./outcomeTool.mts');
const { createRunActivity } = require('./runActivity.mts');

test('offered once, only to a run that can keep the verdict', () => {
    const tools = [];
    addOutcomeTool(tools, null);
    assert.deepStrictEqual(tools, []);
    const run = createRunActivity();
    addOutcomeTool(tools, run);
    addOutcomeTool(tools, run);
    assert.deepStrictEqual(tools.map((t) => t.function.name), [OUTCOME_TOOL_NAME]);
});

test('"failed" fails the run with the AI\'s reason; the row keeps the code alone', () => {
    const run = createRunActivity();
    assert.ok(executeOutcomeTool({ outcome: 'failed', reason: 'No meeting data reached me.' }, run).ok);
    const err = failureOf(run);
    assert.deepStrictEqual([err.message, err.name], ['The AI says: No meeting data reached me.', AI_VERDICT_ERROR]);
    assert.deepStrictEqual(outcomeClose(run, err), { outcome: { kind: 'ai_failed' } });
    assert.ok(!JSON.stringify(outcomeClose(run, err)).includes('meeting'), 'no reason in the facts');
});

test('"done" and "nothing to do" never fail a run, and a later "done" does not undo an earlier "failed"', () => {
    const run = createRunActivity();
    executeOutcomeTool({ outcome: 'nothing_to_do' }, run);
    assert.strictEqual(failureOf(run), null);
    assert.deepStrictEqual(outcomeClose(run), { outcome: { kind: 'nothing_to_do' } });
    executeOutcomeTool({ outcome: 'failed', reason: 'A tool errored.' }, run);
    executeOutcomeTool({ outcome: 'done' }, run);
    assert.strictEqual(run.outcome.outcome, 'failed');
    assert.deepStrictEqual(outcomeClose(run, new Error('timeout')), {}, 'a failure of another kind is not the AI\'s');
});

test('outside a Cowork run, or without an outcome, it refuses', () => {
    assert.ok(executeOutcomeTool({ outcome: 'done' }, null).error);
    assert.ok(executeOutcomeTool({}, createRunActivity()).error);
});

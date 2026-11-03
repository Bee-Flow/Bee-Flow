/**
 * How a root partial run enters: which trigger reaches the step, which trigger
 * node that is, and which payload it enters with (RM-8). Pure.
 *
 * Run: cd server && node --test core/automationRunner/partialRunEntry.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rootReaching, enteredTriggerOf, replayedTriggerPayload } from './partialRunEntry.mts';

const def = {
    trigger: { id: 't1' },
    triggers: [{ id: 't2', pinnedOutput: { pinned: true } }],
    edges: [{ from: 't1', to: 'a' }, { from: 't2', to: 'b' }, { from: 'b', to: 'c' }],
};

test('rootReaching: null for the primary, the id of the first extra trigger that reaches the step', () => {
    assert.equal(rootReaching(def, 'a'), null);
    assert.equal(rootReaching(def, 'c'), 't2');
    assert.equal(rootReaching(def, 'nowhere'), null);
    assert.equal(rootReaching({ edges: [] }, 'a'), null);
});

test('enteredTriggerOf: the primary for null, else the named trigger', () => {
    assert.equal(enteredTriggerOf(def, null)?.id, 't1');
    assert.equal(enteredTriggerOf(def, 't2')?.id, 't2');
    assert.equal(enteredTriggerOf(def, 'gone'), null);
});

test('replayedTriggerPayload: caller, then chosen run, then pin, then the newest run with a payload', () => {
    const runsWindow = [{ id: 'r3', triggerPayload: null }, { id: 'r2', version: 4, startedAt: '2026-11-01T00:00:00.000Z', triggerPayload: { email: 'a@example.org' } }];
    assert.deepEqual(replayedTriggerPayload({ triggerPayload: { x: 1 }, seedRunId: null, runsWindow }), { payload: { x: 1 }, source: null });
    assert.deepEqual(replayedTriggerPayload({ triggerPayload: null, seedRunId: 'r3', runsWindow }), { payload: null, source: null });
    assert.deepEqual(replayedTriggerPayload({ triggerPayload: null, seedRunId: null, runsWindow, enteredTrigger: def.triggers[0] }), { payload: null, source: null });
    assert.deepEqual(replayedTriggerPayload({ triggerPayload: null, seedRunId: null, runsWindow, enteredTrigger: def.trigger }), {
        payload: { email: 'a@example.org' },
        source: { runId: 'r2', version: 4, startedAt: '2026-11-01T00:00:00.000Z', triggerPayload: true },
    });
    assert.deepEqual(replayedTriggerPayload({ triggerPayload: undefined, seedRunId: null, runsWindow: [] }), { payload: null, source: null });
});

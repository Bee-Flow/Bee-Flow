// @typecheck
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeProjectAiParticipationStore } = require('./projectAiParticipationStore');

test('makeProjectAiParticipationStore exposes exactly the documented API', () => {
    const store = makeProjectAiParticipationStore({ query: async () => ({ rows: [] }), tx: async (fn) => fn({ query: async () => ({ rows: [] }) }) });
    assert.deepEqual(Object.keys(store).sort(), [
        'cancelPending', 'capsFor', 'claimDue', 'completeDecision', 'eraseUser', 'feedbackFor', 'finishWatch',
        'getPendingWatch', 'listDecisions', 'postponeWatch', 'prune', 'reapStuck', 'recordDecision', 'recordFeedback',
        'reserveGate', 'summarizeProject', 'upsertWatch',
    ]);
});

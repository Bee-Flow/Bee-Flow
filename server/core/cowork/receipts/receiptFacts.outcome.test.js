/**
 * A receipt records how a run really ended as a fact (./receiptFacts.mts `outcome`: a code), never the AI's reason or
 * any other text; a run that was not judged carries no outcome at all, so older receipts read as before.
 *
 * Run: cd server && node --test core/cowork/receipts/receiptFacts.outcome.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { receiptFacts } = require('./receiptFacts.mts');
const { fakeLookups } = require('../plan/plan.testkit');

const REASON = 'No meeting data reached me from Fireflies';
const run = (over = {}) => ({
    id: 'r1', scheduleId: 's1', status: 'error', triggerKind: 'schedule', startedAt: null, finishedAt: null, planId: null, automationRunId: null,
    conversationId: null, independence: null, trustedSteps: [], activity: null, ...over,
});

test('the outcome is a code on the receipt; the AI\'s reason is not in it', () => {
    const payload = receiptFacts({ run: run({ outcome: 'ai_failed', error: `The AI says: ${REASON}` }), plan: null, steps: [], lookups: fakeLookups() });
    assert.strictEqual(payload.outcome, 'ai_failed');
    assert.ok(!JSON.stringify(payload).includes('Fireflies'), 'no reason, no text');
});

test('an incomplete run says so; a run nobody judged carries no outcome', () => {
    assert.strictEqual(receiptFacts({ run: run({ status: 'incomplete', outcome: 'incomplete' }), plan: null, steps: [], lookups: fakeLookups() }).outcome, 'incomplete');
    assert.ok(!('outcome' in receiptFacts({ run: run(), plan: null, steps: [], lookups: fakeLookups() })));
});

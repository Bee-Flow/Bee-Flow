/**
 * logAiStepUsage: the ledger row of an ai_step.
 *
 * The automation's owner pays, so `user_id` stays the owner; the person who
 * pressed Run / Test or submitted the form is `actor_user_id`, and the run is
 * `run_id`, so "who uses this automation" and "what did this run cost" can be
 * read from the ledger. The automation stays the Studio object (`agent_id`).
 * The ledger sink is handed to logAiStepUsage.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { areaOf } = require('../../shared/usageAreas');
const { logAiStepUsage } = require('./aiStepMessages');

const usageRows = [];
const sink = { async logUsage(row) { usageRows.push(row); } };

const acc = { total: () => ({ promptTokens: 12, completionTokens: 3 }) };

test('the row carries the owner, the starter as actor and the run id', () => {
    usageRows.length = 0;
    const ctx = { userId: 'owner-1', orgId: 'org-1', automationId: 'auto-1', automationTitle: 'Invoices', runId: 'run-9', actorUserId: 'starter-2' };
    logAiStepUsage(ctx, 'model-x', acc, false, sink);
    assert.strictEqual(usageRows.length, 1);
    const row = usageRows[0];
    assert.strictEqual(row.user_id, 'owner-1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.actor_user_id, 'starter-2');
    assert.strictEqual(row.run_id, 'run-9');
    assert.strictEqual(row.agent_id, 'auto-1');
    assert.strictEqual(row.source, 'automation');
    assert.notStrictEqual(areaOf(row.source), 'other');
});

test('a scheduled run (nobody started it) has a null actor', () => {
    usageRows.length = 0;
    logAiStepUsage({ userId: 'owner-1', orgId: 'org-1', automationId: 'auto-1', runId: 'run-10' }, 'model-x', acc, false, sink);
    assert.strictEqual(usageRows[0].actor_user_id, null);
    assert.strictEqual(usageRows[0].run_id, 'run-10');
});

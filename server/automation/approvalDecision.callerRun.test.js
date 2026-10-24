// @typecheck
'use strict';

/**
 * Deciding an approval on a run that used its starter's own connections answers
 * with the continued run WITHOUT its values unless the decider is the starter:
 * approving or rejecting lets a colleague carry a run on, not read it.
 *
 * Run: node --test automation/approvalDecision.callerRun.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { serverStubber } = require('../testUtils/stubServer');

const mock = serverStubber();
const CONTINUED = {
    id: 'child', status: 'success', connectionsMode: 'caller', startedByUserId: 'starter',
    summary: 'private summary', error: null, triggerPayload: { subject: 'private' }, lastOutput: { v: 'private' },
};
mock('stores/automationStore', {
    decideApproval: async (id) => ({ id, status: 'approved', ownerId: 'owner' }),
    appendApprovalAudit: async () => {},
    updateRun: async () => {},
    getRun: async () => ({ ...CONTINUED, status: 'error', error: 'Approval rejected: no' }),
    getApproval: async () => null,
});
mock('stores/userStore', { getUser: async () => ({ displayName: 'Decider' }) });
mock('automation/approvalEvents', { dispatchApprovalDecided: () => {} });
mock('automation/approvalHooks', { runOnDecidedHook: async () => {} });
mock('automation/approvalNotify', { notifyApproval: async () => {}, automationForApproval: async () => null });
mock('core/automationRunner', { resumeFromStep: async () => ({ ...CONTINUED }) });

const { finalizeDecision } = require('./approvalDecision');
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

const APPROVAL = { id: 'ap1', ownerId: 'owner', stepId: 'gate', source: 'run', runId: 'run1' };
const decide = (deciderId, decision = 'approve') => finalizeDecision({
    approval: APPROVAL, run: { id: 'run1' }, deciderId, decision, trimmedReason: 'no', coercedAnswers: null, source: 'studio',
});

test('approve: the continued run reaches the decider without its values; the starter keeps them', async () => {
    for (const who of ['owner', 'assignee']) {
        const out = await decide(who);
        assert.strictEqual(out.code, 200);
        assert.strictEqual(out.body.run.status, 'success');
        assert.ok(!JSON.stringify(out.body.run).includes('private'), `nothing of the run's data reaches ${who}`);
    }
    const mine = await decide('starter');
    assert.strictEqual(mine.body.run.summary, 'private summary');
});

test('reject: the closed run is redacted for the decider too', async () => {
    const out = await decide('owner', 'reject');
    assert.strictEqual(out.body.run.status, 'error');
    assert.ok(!('error' in out.body.run) && !('summary' in out.body.run));
});

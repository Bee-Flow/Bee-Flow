// @typecheck
'use strict';

/**
 * A run paused at an approval: who hears about it follows the run's profile.
 * The configured approvers are never notified for a test or a dry run; a live
 * test run sends its tester one "Test:" bell; a dry run sends nothing; a
 * production run (and a legacy row without a profile) asks the approvers
 * through the policy, as before.
 *
 * Run: node --test core/automationRunner/runFinalizeEffects.testApproval.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { notifyRunEnd } = require('./runFinalizeEffects');
const { profileFor } = require('../automationModel/runProfile.mts');
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

class ApprovalRequiredError { constructor() { this.stepId = 'ap1'; this.prompt = 'Ship it?'; } }

/** @param {any} run @param {any} [approvalRow] */
async function paused(run, approvalRow = null) {
    /** @type {{ policy: any[], tester: any[] }} */
    const sent = { policy: [], tester: [] };
    const deps = {
        notifyRunEvent: async (/** @type {any} */ _a, /** @type {string} */ ev, /** @type {any} */ payload) => { sent.policy.push({ ev, payload }); },
        engine: { ApprovalRequiredError },
        loadApprovalLifecycle: () => ({
            approvalNotificationTargets: async (/** @type {any} */ row) => ({ link: '/x', userIds: row?.approvers?.map((/** @type {any} */ s) => s.userId) || ['owner'] }),
            notifyTesterApprovalNeeded: async (/** @type {any} */ p) => { sent.tester.push(p); return 'tester'; },
        }),
    };
    await notifyRunEnd(/** @type {any} */ (deps), {
        automation: { id: 'a1', title: 'Flow', userId: 'owner' }, run, firstRunNeedsConfirm: false,
        runStatus: 'awaiting_approval', runErrorObj: new ApprovalRequiredError(), summary: '', userSafeError: '',
        triggerKind: 'manual', effectiveMode: run.mode || 'live', testRun: run.profile ? run.profile.kind !== 'production' : false,
        approvalRow,
    });
    return sent;
}

const PANEL_ROW = { id: 'apr1', approvers: [{ userId: 'u1' }, { userId: 'u2' }] };

test('production: the configured approvers are asked through the policy', async () => {
    const sent = await paused({ id: 'r1', profile: profileFor({ mode: 'live', triggerKind: 'webhook' }, {}) }, PANEL_ROW);
    assert.equal(sent.policy.length, 1);
    assert.equal(sent.policy[0].ev, 'onApproval');
    assert.deepEqual(sent.policy[0].payload.approverIds, ['u1', 'u2']);
    assert.equal(sent.tester.length, 0);
});

test('a legacy row without a profile routes as before', async () => {
    const sent = await paused({ id: 'r1', mode: 'live', triggerKind: 'manual' }, PANEL_ROW);
    assert.equal(sent.policy.length, 1);
});

test('a live test run: never the configured approvers, one bell request to the tester', async () => {
    const run = { id: 'r1', profile: profileFor({ mode: 'live', isTest: true, startedByUserId: 'tester' }, {}) };
    const sent = await paused(run, { id: 'apr1', isTest: true, sandboxUserId: 'tester', assigneeUserId: 'tester' });
    assert.equal(sent.policy.length, 0, 'no onApproval to anybody configured');
    assert.equal(sent.tester.length, 1);
    assert.equal(sent.tester[0].stepId, 'ap1');
    assert.equal(sent.tester[0].approval.sandboxUserId, 'tester');
});

test('a dry run: the configured approvers are never notified either', async () => {
    const run = { id: 'r1', mode: 'dry_run', profile: profileFor({ mode: 'dry_run', pausesRequested: true, startedByUserId: 'tester' }, {}) };
    const sent = await paused(run, { id: 'apr1', isTest: true, sandboxUserId: 'tester' });
    assert.equal(sent.policy.length, 0);
    // The lifecycle's bell decides "nothing for a dry run" (approvalLifecycle.sandbox.test.js).
    assert.equal(sent.tester.length, 1);
});

test('a test row whose run lost its profile still never reaches the configured approvers', async () => {
    const sent = await paused({ id: 'r1', mode: 'live' }, { id: 'apr1', isTest: true, sandboxUserId: 'tester' });
    assert.equal(sent.policy.length, 0);
});

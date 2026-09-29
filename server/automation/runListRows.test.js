'use strict';

/**
 * The Runs tab's row fields (handoff 5): step bars, "n of m steps", how a run
 * was started and by whom, the approval a waiting run waits on. Lookups are
 * injected; nothing is mocked.
 *
 * Run: cd server && node --test automation/runListRows.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeRunRowDecorator, stepProgress, howStartedOf, segmentCounts, STEP_BARS_MAX } = require('./runListRows');

const DEF = {
    trigger: { id: 't1', kind: 'manual' },
    triggers: [{ id: 't2', kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'file.created' } }],
    steps: [
        { id: 's1', type: 'integration_action' },
        { id: 'n1', type: 'note' },
        { id: 's2', type: 'condition' },
        { id: 's3', type: 'approval' },
        { id: 's4', type: 'notification' },
    ],
};
const st = (stepId, status, extra = {}) => ({ stepId, status, parentStepId: null, stepType: 'x', attempts: 1, ...extra });

test('stepProgress: a finished run counts the steps it took, pads nothing', () => {
    const p = stepProgress(DEF, [st('t1', 'success'), st('s1', 'success'), st('s2', 'success')], 'success');
    assert.deepEqual(p, { stepsTotal: 2, stepsDone: 2, stepStatuses: ['success', 'success'] });
});

test('stepProgress: a failed or waiting run counts the plan and pads with pending', () => {
    const failed = stepProgress(DEF, [st('s1', 'success'), st('s2', 'error', { attempts: 1 }), st('s2', 'error', { attempts: 2 })], 'error');
    assert.deepEqual(failed, { stepsTotal: 4, stepsDone: 1, stepStatuses: ['success', 'error', 'pending', 'pending'] });
    const waiting = stepProgress(DEF, [st('s1', 'success'), st('s2', 'success'), st('s3', 'awaiting_approval')], 'awaiting_approval');
    assert.deepEqual(waiting.stepStatuses, ['success', 'success', 'awaiting_approval', 'pending']);
    assert.equal(waiting.stepsDone, 2);
});

test('stepProgress: sub-steps, triggers and notes are not steps; a later attempt wins; the bars are capped', () => {
    const p = stepProgress(DEF, [
        st('s1', 'error'), st('s1', 'success', { attempts: 2 }),
        st('s1/inner', 'success', { parentStepId: 's1' }),
        st('n1', 'success', { stepType: 'note' }),
    ], 'running');
    assert.deepEqual(p.stepStatuses, ['success', 'pending', 'pending', 'pending']);
    const big = { steps: Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, type: 'code' })) };
    const b = stepProgress(big, [], 'running');
    assert.equal(b.stepsTotal, 80);
    assert.equal(b.stepStatuses.length, STEP_BARS_MAX);
    assert.deepEqual(stepProgress(null, [], 'success'), { stepsTotal: 0, stepsDone: 0, stepStatuses: [] });
});

test('howStartedOf: the vocabulary, from the trigger kind, the payload or the entered trigger', () => {
    assert.equal(howStartedOf({ triggerKind: 'manual' }), 'manual');
    assert.equal(howStartedOf({ triggerKind: 'dry_run' }), 'manual');
    assert.equal(howStartedOf({ triggerKind: 'schedule' }), 'schedule');
    assert.equal(howStartedOf({ triggerKind: 'form' }), 'form');
    assert.equal(howStartedOf({ triggerKind: 'webpage' }), 'form');
    assert.equal(howStartedOf({ triggerKind: 'webhook' }), 'webhook');
    assert.equal(howStartedOf({ triggerKind: 'agent_call' }), 'agent');
    assert.equal(howStartedOf({ triggerKind: 'manual', callerAgentId: 'ag1' }), 'agent');
    assert.equal(howStartedOf({ triggerKind: 'studio_app' }), 'app_button');
    assert.equal(howStartedOf({ triggerKind: 'app_button' }), 'app_button');
    assert.equal(howStartedOf({ triggerKind: 'app_event', triggerPayload: { provider: 'gmail', event: 'mail.new' } }), 'email');
    assert.equal(howStartedOf({ triggerKind: 'app_event', triggerPayload: { provider: 'nextcloud', event: 'nextcloud.file.new' } }), 'file');
    assert.equal(howStartedOf({ triggerKind: 'app_event', triggerPayload: { provider: 'nextcloud', event: 'talk.message.new' } }), 'app');
    // The org log's rows carry no payload: the entered trigger answers.
    assert.equal(howStartedOf({ triggerKind: 'app_event', rootStepId: 't2' }, DEF), 'file');
    assert.equal(howStartedOf({ triggerKind: 'something_new' }), 'manual');
});

test('decorate: one batched read per kind of fact, names and approval ids on the rows', async () => {
    const calls = [];
    const decorator = makeRunRowDecorator({
        store: {
            getJourneyStepStatuses: async (ids) => { calls.push(['steps', ids]); return new Map([['r1', [st('s1', 'success')]]]); },
            getVersionDefinitions: async (pairs) => { calls.push(['defs', pairs]); return new Map([['a1@3', DEF]]); },
            getPendingApprovalIdsForRuns: async (ids) => { calls.push(['approvals', ids]); return new Map([['leg2', 'ap9']]); },
        },
        getUsersByIds: async (ids) => { calls.push(['users', ids]); return [{ id: 'u1', displayName: 'Admin' }, { id: 'u2', username: 'm.jansen' }]; },
    });
    const rows = await decorator.decorate([
        { id: 'r1', automationId: 'a1', version: 3, status: 'success', triggerKind: 'manual', startedByUserId: 'u1', outcome: { code: 'success', params: {}, text: 'Finished' } },
        { id: 'r2', automationId: 'a1', version: 3, status: 'awaiting_approval', journeyRunId: 'leg2', triggerKind: 'form', submittedByUserId: 'u2', isTest: true },
        { id: 'r3', automationId: 'a1', version: 3, status: 'error', triggerKind: 'schedule' },
    ]);
    assert.equal(calls.length, 4, 'one call per kind, never per row');
    assert.deepEqual(calls.find(c => c[0] === 'defs')[1], [{ automationId: 'a1', version: 3 }, { automationId: 'a1', version: 3 }, { automationId: 'a1', version: 3 }]);
    assert.deepEqual(calls.find(c => c[0] === 'approvals')[1], ['leg2']);

    assert.deepEqual(rows[0].startedBy, { id: 'u1', name: 'Admin' });
    assert.equal(rows[0].howStarted, 'manual');
    assert.equal(rows[0].stepsTotal, 1);
    assert.equal(rows[0].isTest, false);
    assert.equal(rows[0].approvalId, undefined, 'only waiting rows carry approvalId');

    assert.deepEqual(rows[1].startedBy, { id: 'u2', name: 'm.jansen' });
    assert.equal(rows[1].howStarted, 'form');
    assert.equal(rows[1].approvalId, 'ap9');
    assert.equal(rows[1].isTest, true);
    assert.equal(rows[1].outcome, null);

    assert.equal(rows[2].startedBy, null);
    assert.equal(rows[2].howStarted, 'schedule');
    assert.equal(rows[2].stepsTotal, 4);
});

test('decorate: the org log gets no names and no approval lookups; a failing lookup costs detail, not the list', async () => {
    const decorator = makeRunRowDecorator({
        store: {
            getJourneyStepStatuses: async () => { throw new Error('db down'); },
            getPendingApprovalIdsForRuns: async () => { throw new Error('should not be called'); },
        },
        getUsersByIds: async () => { throw new Error('should not be called'); },
    });
    const rows = await decorator.decorate(
        [{ id: 'r1', automationId: 'a1', version: 1, status: 'awaiting_approval', triggerKind: 'manual', startedByUserId: 'u1' }],
        { withStarter: false, withApprovals: false, automation: { id: 'a1', definition: DEF } },
    );
    assert.equal(rows[0].startedBy, null);
    assert.equal(rows[0].approvalId, undefined);
    assert.equal(rows[0].stepsTotal, 4, 'the routine\'s own definition stands in for a missing snapshot');
    assert.deepEqual(await decorator.decorate([]), []);
});

test('segmentCounts: all / failed / waiting / running', () => {
    assert.deepEqual(segmentCounts({ success: 2, error: 1, awaiting_approval: 1, awaiting_form: 1, running: 1, queued: 1, cancelled: 1 }), {
        all: 8, failed: 1, waiting: 2, running: 2,
        byStatus: { success: 2, error: 1, awaiting_approval: 1, awaiting_form: 1, running: 1, queued: 1, cancelled: 1 },
    });
    assert.deepEqual(segmentCounts(null), { all: 0, failed: 0, waiting: 0, running: 0, byStatus: {} });
});

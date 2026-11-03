// @typecheck
/**
 * A test approval (the sandbox seat, D2) is decided by the tester alone.
 *
 * The step was configured as a 3-stage chain; in a test run its row is a
 * single-assignee row for the tester (approvalLifecycle.sandbox.test.js), so:
 *
 *   - the tester, and the owner, may decide it; a configured approver may not;
 *   - ONE decision resumes the run, and the step output carries votes: [];
 *   - no approval.decided event, webhook or feed entry, and no record hook;
 *   - the owner's "decided" heads-up says Test and never posts a Talk card;
 *   - a withdrawal tells the tester and nobody else.
 *
 * Run: cd server && node --test automation/approvalService.testDecide.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const automationStore = require('../stores/automationStore');
const userStore = require('../stores/userStore');
const notificationStore = require('../stores/notificationStore');
const dispatchMod = require('./triggerBus/dispatch');
const runner = require('../core/automationRunner');
const { decide, withdraw, canDecide } = require('./approvalService');
const { runOnDecidedHook } = require('./approvalHooks');
const { _notifyTest } = require('./approvalNotify');
const { approvalOutput } = require('../core/automationModel/approvalOutput.mts');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

const TEST_APPROVAL = {
    id: 'apr_t', source: 'run', status: 'pending', organizationId: 'org1', ownerId: 'owner',
    automationId: 'a1', automationTitle: 'Invoices', runId: 'leg1', rootRunId: 'leg1', stepId: 'ap_1',
    prompt: 'Pay this?', fields: null, expiresAt: null, approvers: null, stages: null, stage: null,
    assigneeUserId: 'tester', assigneeGroupId: null, projectId: 'p1',
    isTest: true, sandboxUserId: 'tester',
    configuredRouting: {
        runKind: 'test', approvers: null, rule: null, quorum: null, assignee: null, finalApprover: null,
        stages: [
            { key: 'lead', name: 'Team lead', rule: 'first', quorum: null, skipped: false, approvers: [{ userId: 'u1' }] },
            { key: 'fin', name: 'Finance', rule: 'all', quorum: null, skipped: false, approvers: [{ groupId: 'g1' }] },
            { key: 'dir', name: 'Director', rule: 'first', quorum: null, skipped: false, approvers: [{ userId: 'u2' }] },
        ],
    },
};
const RUN = { id: 'leg1', userId: 'owner', automationId: 'a1', status: 'awaiting_approval', awaitingStepId: 'ap_1', rootRunId: 'leg1', mode: 'live' };

/**
 * @param {(rec: { resume: any[], bells: any[], dispatched: any[] }) => Promise<void>} fn
 */
async function withPatched(fn) {
    const rec = { resume: /** @type {any[]} */ ([]), bells: /** @type {any[]} */ ([]), dispatched: /** @type {any[]} */ ([]) };
    /** @type {Array<[Record<string, any>, string, any]>} */
    const patches = [
        [automationStore, 'decideApproval', async (/** @type {string} */ _id, /** @type {any} */ p) => ({ ...TEST_APPROVAL, ...p })],
        [automationStore, 'appendApprovalAudit', async () => {}],
        [automationStore, 'getApproval', async () => TEST_APPROVAL],
        [automationStore, 'getRun', async () => ({ ...RUN })],
        [automationStore, 'updateRun', async () => true],
        [automationStore, 'closeAwaitingStepRow', async () => 1],
        [automationStore, 'getAutomation', async () => ({ id: 'a1', title: 'Invoices', notificationPolicy: { onApproval: { enabled: true, channels: ['bell', 'talk'] } } })],
        [userStore, 'getUser', async (/** @type {string} */ id) => ({ id, displayName: id === 'tester' ? 'Tess' : id })],
        [notificationStore, 'createNotification', async (/** @type {any} */ n) => { rec.bells.push(n); return { id: 'n' }; }],
        [dispatchMod, 'dispatchOrgScopedEvent', (/** @type {any[]} */ ...a) => { rec.dispatched.push(a); return Promise.resolve([]); }],
        [dispatchMod, 'dispatchEvent', (/** @type {any[]} */ ...a) => { rec.dispatched.push(a); return Promise.resolve([]); }],
        [runner, 'resumeFromStep', async (/** @type {string} */ runId, /** @type {string} */ stepId, /** @type {any} */ opts) => {
            rec.resume.push({ runId, stepId, opts });
            await opts.onRunCreated?.({ id: 'leg2' });
            return { id: 'leg2', status: 'success' };
        }],
    ];
    const saved = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, v] of patches) obj[key] = v;
    try { await fn(rec); } finally {
        for (const [obj, key, v] of saved) obj[key] = v;
    }
}

const viewer = (/** @type {string} */ userId) => ({ userId, groupIds: userId === 'u-fin' ? ['g1'] : [], isOrgAdminOfOrg: () => false });

test('the tester and the owner may decide a test approval; a configured approver may not', () => {
    assert.equal(canDecide(TEST_APPROVAL, viewer('tester')), true);
    assert.equal(canDecide(TEST_APPROVAL, viewer('owner')), true);
    assert.equal(canDecide(TEST_APPROVAL, viewer('u1')), false);
    assert.equal(canDecide(TEST_APPROVAL, viewer('u-fin')), false);
});

test('one decision by the tester resumes the run with votes: [], and dispatches no event', async () => {
    await withPatched(async (rec) => {
        const { code, body } = await decide({ approval: TEST_APPROVAL, run: { ...RUN }, deciderId: 'tester', decision: 'approve', source: 'studio' });
        assert.equal(code, 200, JSON.stringify(body));
        assert.notEqual(body.decision, 'vote_recorded', 'not a vote: the row resolves at once');
        assert.equal(rec.resume.length, 1);
        assert.equal(rec.resume[0].stepId, 'ap_1');
        const output = approvalOutput(rec.resume[0].opts.decision);
        assert.equal(output.approved, true);
        assert.equal(output.by, 'tester');
        assert.deepEqual(output.votes, []);
        await new Promise((r) => setImmediate(r));
        assert.equal(rec.dispatched.length, 0, 'no approval.decided for a test approval');
        // The owner hears that the tester decided, marked Test; nobody configured does.
        assert.deepEqual(rec.bells.map((b) => b.userId), ['owner']);
        assert.match(rec.bells[0].title, /^Test: /);
    });
});

test('withdrawing a test approval tells the tester, nobody else', async () => {
    await withPatched(async (rec) => {
        const { code } = await withdraw({ approval: TEST_APPROVAL, deciderId: 'owner', source: 'studio' });
        assert.equal(code, 200);
        assert.deepEqual(rec.bells.map((b) => b.userId), ['tester']);
        assert.match(rec.bells[0].title, /^Test: /);
        await new Promise((r) => setImmediate(r));
        assert.equal(rec.dispatched.length, 0);
    });
    await withPatched(async (rec) => {
        await withdraw({ approval: TEST_APPROVAL, deciderId: 'tester', source: 'studio' });
        assert.equal(rec.bells.length, 0, 'the tester withdrew it themselves');
    });
});

test('a test approval runs no record hook', async () => {
    const res = await runOnDecidedHook({
        ...TEST_APPROVAL, status: 'approved', studioAppId: 'app1',
        onDecided: { tableId: 't', recordId: 'r', set: { approved: { status: 'ok' } } },
    });
    assert.deepEqual(res, { ran: false });
});

test('a test announcement keeps only the tester and the owner, and says Test once', () => {
    const { testAnnouncement } = _notifyTest;
    const out = testAnnouncement(TEST_APPROVAL, ['u1', 'tester', 'owner', 'u2'], 'Test: already marked');
    assert.deepEqual(out.recipientIds, ['tester', 'owner']);
    assert.equal(out.title, 'Test: already marked');
    assert.equal(testAnnouncement(TEST_APPROVAL, [], 'Approval expired').title, 'Test: Approval expired');
});

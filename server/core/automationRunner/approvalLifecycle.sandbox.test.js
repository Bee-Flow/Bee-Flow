// @typecheck
/**
 * The sandbox seat (D2): an approval in a test or dry run goes to the person
 * who started the run, and to nobody else.
 *
 *   - a 3-stage chain in a test run becomes ONE row assigned to the tester:
 *     no stages, no panel, no clocks, is_test, the configured routing kept
 *     for the "in production this goes to ..." preview;
 *   - no approval.requested event, webhook, feed entry or Talk card
 *     (dispatchApprovalRequested is never called); the 'requested' audit
 *     still lands, with source 'test';
 *   - a production run, and a legacy run without a profile, route exactly as
 *     before.
 *
 * Run: cd server && node --test core/automationRunner/approvalLifecycle.sandbox.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const automationStore = require('../../stores/automationStore');
const userStore = require('../../stores/userStore');
const notificationStore = require('../../stores/notificationStore');
const approvalEvents = require('../../automation/approvalEvents');
// The lifecycle reaches automation/ through core/automationRunner/featurePorts.js.
require('../../automation/runnerPorts');
const { createApprovalOnPause, notifyTesterApprovalNeeded } = require('./approvalLifecycle');
const { profileFor } = require('../automationModel/runProfile.mts');
const { testerBell, routingSnapshot, approvalClocks } = require('./approvalRouting.mts');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

const AUTOMATION = { id: 'aut_1', userId: 'owner', title: 'Invoice payment', organizationId: 'org1' };
const CHAIN = [
    { key: 'lead', name: 'Team lead', approvers: [{ userId: 'u1' }], rule: 'first', quorum: null },
    { key: 'finance', name: 'Finance', approvers: [{ groupId: 'g-fin' }], rule: 'all', quorum: null },
    { key: 'director', name: 'Director', approvers: [{ userId: 'u2' }, { userId: 'u3' }], rule: 'quorum', quorum: 1 },
];
const ERR = {
    stepId: 's1', prompt: 'Pay this?', stages: CHAIN,
    remindAfterHours: 2, escalateAfterHours: 4, escalateTo: { userId: 'u3' },
    expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
};

/** @param {Record<string, unknown>} over */
const runWith = (over) => ({ id: 'run_1', rootRunId: 'run_1', triggerPayload: {}, ...over });

/** @param {(rec: { created: any[], audits: any[], dispatched: any[], bells: any[] }) => Promise<void>} fn */
async function withPatched(fn) {
    const rec = { created: /** @type {any[]} */ ([]), audits: /** @type {any[]} */ ([]), dispatched: /** @type {any[]} */ ([]), bells: /** @type {any[]} */ ([]) };
    const store = /** @type {Record<string, any>} */ (automationStore);
    const users = /** @type {Record<string, any>} */ (userStore);
    const events = /** @type {Record<string, any>} */ (approvalEvents);
    const bells = /** @type {Record<string, any>} */ (notificationStore);
    const saved = {
        createApproval: store.createApproval, appendApprovalAudit: store.appendApprovalAudit,
        getRunsInChain: store.getRunsInChain, listGeneratedFilesForRuns: store.listGeneratedFilesForRuns,
        getUser: users.getUser, getAllGroups: users.getAllGroups,
        dispatch: events.dispatchApprovalRequested, createNotification: bells.createNotification,
    };
    store.createApproval = async (/** @type {any} */ row) => { rec.created.push(row); return { id: 'apr_1', ...row }; };
    store.appendApprovalAudit = async (/** @type {any} */ ev) => { rec.audits.push(ev); };
    store.getRunsInChain = async () => [];
    store.listGeneratedFilesForRuns = async () => [];
    users.getUser = async (/** @type {string} */ id) => ({ id, organizationId: 'org1', groups: '[]' });
    users.getAllGroups = async () => [{ id: 'g-fin', organizationId: 'org1' }];
    events.dispatchApprovalRequested = (/** @type {any} */ a) => { rec.dispatched.push(a); };
    bells.createNotification = async (/** @type {any} */ n) => { rec.bells.push(n); return { id: 'n1' }; };
    try { await fn(rec); } finally {
        Object.assign(store, { createApproval: saved.createApproval, appendApprovalAudit: saved.appendApprovalAudit, getRunsInChain: saved.getRunsInChain, listGeneratedFilesForRuns: saved.listGeneratedFilesForRuns });
        Object.assign(users, { getUser: saved.getUser, getAllGroups: saved.getAllGroups });
        events.dispatchApprovalRequested = saved.dispatch;
        bells.createNotification = saved.createNotification;
    }
}

test('a test run with a 3-stage chain: one row for the tester, the chain kept as a preview, no event', async () => {
    await withPatched(async (rec) => {
        const profile = profileFor({ mode: 'live', isTest: true, startedByUserId: 'tester' }, {});
        const row = await createApprovalOnPause({ automation: AUTOMATION, run: runWith({ profile }), err: ERR });
        assert.ok(row);
        const written = rec.created[0];
        assert.equal(written.assigneeUserId, 'tester');
        assert.equal(written.assigneeGroupId, null);
        assert.equal(written.isTest, true);
        assert.equal(written.sandboxUserId, 'tester');
        for (const k of ['stages', 'stageParticipants', 'stageKey', 'approvers', 'approvalRule', 'quorumCount',
            'finalApproverUserId', 'finalApproverGroupId', 'remindAt', 'escalateAt', 'escalateToUserId', 'escalateToGroupId']) {
            assert.equal(written[k], null, `${k} is empty on a test row`);
        }
        const routing = written.configuredRouting;
        assert.equal(routing.runKind, 'test');
        assert.deepEqual(routing.stages.map((/** @type {any} */ s) => [s.name, s.approvers.length, s.rule]),
            [['Team lead', 1, 'first'], ['Finance', 1, 'all'], ['Director', 2, 'quorum']]);
        assert.ok(!JSON.stringify(routing).includes('Pay this?'), 'the routing holds no request content');
        assert.equal(rec.dispatched.length, 0, 'no approval.requested for a test approval');
        assert.deepEqual(rec.audits.map((a) => [a.decision, a.source]), [['requested', 'test']]);
    });
});

test('a dry run is marked as such; without a starter the owner holds the seat', async () => {
    await withPatched(async (rec) => {
        const profile = profileFor({ mode: 'dry_run', pausesRequested: true }, {});
        await createApprovalOnPause({ automation: AUTOMATION, run: runWith({ profile }), err: ERR });
        assert.equal(rec.created[0].assigneeUserId, 'owner');
        assert.equal(rec.created[0].configuredRouting.runKind, 'dry');
        assert.equal(rec.dispatched.length, 0);
    });
});

test('a production run routes exactly as before: the chain, the participants, the event', async () => {
    await withPatched(async (rec) => {
        const profile = profileFor({ mode: 'live', triggerKind: 'webhook' }, {});
        await createApprovalOnPause({ automation: AUTOMATION, run: runWith({ profile }), err: ERR });
        const written = rec.created[0];
        assert.deepEqual(written.stages.map((/** @type {any} */ s) => s.key), ['lead', 'finance', 'director']);
        assert.equal(written.stageKey, 'lead');
        assert.deepEqual(written.approvers, [{ userId: 'u1' }]);
        assert.equal(written.approvalRule, 'first');
        assert.ok(written.remindAt, 'the reminder clock is set');
        assert.equal(written.escalateAt, null, 'a chain does not escalate');
        assert.equal(written.isTest, undefined);
        assert.equal(written.configuredRouting, undefined);
        assert.equal(rec.dispatched.length, 1);
        assert.equal(rec.audits[0].source, 'runner');
    });
});

test('a legacy test run (no stored profile) keeps the configured approvers', async () => {
    await withPatched(async (rec) => {
        await createApprovalOnPause({
            automation: AUTOMATION, run: runWith({ mode: 'live', triggerKind: 'manual_step', isTest: true }),
            err: { stepId: 's1', prompt: 'q', assignee: { userId: 'u1' }, escalateAfterHours: 4, escalateTo: { userId: 'u3' } },
        });
        const written = rec.created[0];
        assert.equal(written.assigneeUserId, 'u1');
        assert.equal(written.escalateToUserId, 'u3');
        assert.ok(written.escalateAt);
        assert.equal(rec.dispatched.length, 1);
    });
});

test('a test run of a managed automation runs its live copy: the configured chain decides, not the editor who started it', async () => {
    const { selectRunCopy } = require('./runSetup');
    const { configureStageVars } = require('./stageVars');
    const { canDecide } = require('../../automation/approvalRulebook');
    const restore = configureStageVars({ managedInfo: async () => ({ stage: 'prd' }) });
    try {
        const managed = { ...AUTOMATION, kind: 'automation', projectId: 'p-prd', version: 4, liveVersion: 3, definition: { steps: ['working'] } };
        Object.defineProperty(managed, 'liveDefinition', { value: { steps: ['live'] }, enumerable: false, writable: true, configurable: true });
        const { profile } = await selectRunCopy(/** @type {any} */ ({ automationStore: {} }), managed,
            { mode: 'live', triggerKind: 'manual', isTest: true, startedByUserId: 'editor' });
        assert.equal(profile.kind, 'test');
        assert.equal(profile.copy, 'live');
        await withPatched(async (rec) => {
            const row = await createApprovalOnPause({ automation: AUTOMATION, run: runWith({ profile }), err: ERR });
            assert.ok(row);
            const written = rec.created[0];
            assert.notEqual(written.isTest, true);
            assert.equal(written.sandboxUserId, undefined);
            assert.deepEqual(written.stages.map((/** @type {any} */ s) => s.key), ['lead', 'finance', 'director']);
            assert.equal(rec.dispatched.length, 1, 'the configured approvers are asked');
            const approval = { ...row, status: 'pending', organizationId: 'org1' };
            assert.equal(canDecide(approval, { userId: 'editor', groupIds: [] }), false, 'the editor holds no seat');
            assert.equal(canDecide(approval, { userId: 'owner', groupIds: [], isOrgAdminOfOrg: () => true }), false);
            assert.equal(canDecide(approval, { userId: 'u1', groupIds: [] }), true, 'the first stage decides');
        });
    } finally { restore(); }
});

test('the tester bell: one "Test:" bell for a live test run, nothing for a dry or production run', async () => {
    await withPatched(async (rec) => {
        const test = profileFor({ mode: 'live', isTest: true, startedByUserId: 'tester' }, {});
        const who = await notifyTesterApprovalNeeded({ automation: AUTOMATION, run: runWith({ profile: test }), stepId: 's1', prompt: 'Pay this?' });
        assert.equal(who, 'tester');
        assert.equal(rec.bells.length, 1);
        assert.equal(rec.bells[0].userId, 'tester');
        assert.equal(rec.bells[0].title, 'Test: approval needed in Invoice payment');
        assert.equal(rec.bells[0].link, '/app/studio/automations/aut_1?view=runs&run=run_1&step=s1');

        const dry = profileFor({ mode: 'dry_run', startedByUserId: 'tester' }, {});
        assert.equal(await notifyTesterApprovalNeeded({ automation: AUTOMATION, run: runWith({ profile: dry }), stepId: 's1' }), null);
        const prod = profileFor({ mode: 'live' }, {});
        assert.equal(await notifyTesterApprovalNeeded({ automation: AUTOMATION, run: runWith({ profile: prod }), stepId: 's1' }), null);
        assert.equal(rec.bells.length, 1);
    });
});

test('approvalRouting: the bell prefers the row\'s sandbox seat; the snapshot of a panel keeps its rule', () => {
    const profile = profileFor({ mode: 'live', isTest: true, startedByUserId: 'starter' }, {});
    assert.equal(testerBell({ profile, ownerId: 'owner', sandboxUserId: 'seat' })?.userId, 'seat');
    const panel = { stages: null, firstKey: null, firstStage: null, approvers: [{ userId: 'a' }, { userId: 'b' }], assignee: null, finalApprover: null };
    const snap = routingSnapshot(panel, { rule: 'quorum', quorum: 5 }, 'test');
    assert.equal(snap.rule, 'quorum');
    assert.equal(snap.quorum, 2, 'clamped to the seats');
    assert.equal(snap.approvers?.length, 2);
    // The clocks moved with the routing; a clock past the deadline is dropped.
    const now = Date.UTC(2026, 10, 3);
    const c = approvalClocks({ remindAfterHours: 1, escalateAfterHours: 48, expiresAt: new Date(now + 24 * 3_600_000).toISOString() }, now);
    assert.ok(c.remindAt);
    assert.equal(c.escalateAt, null);
});

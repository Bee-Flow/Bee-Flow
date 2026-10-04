/**
 * Deployment-sourced approvals (design D8, D9, 6.6): the PRD gate of a
 * Solution asks through automation_approvals with source='deployment', and
 * its outcome moves the deployment through solutionStageStore.
 *
 * Runs for real against PGlite behind db.js (testUtils/pglitePool): the
 * approval migrations build the table, the approvals store and
 * solutionStageStore run their own SQL, and approvalService decides. Only
 * outbound fan-out (trigger bus, project feed, bells) is swapped on its module
 * object, to record it.
 *
 * Pinned:
 *   - four-eyes: the requester cannot decide in the single, panel and staged
 *     shapes, through canDecide or through decide itself;
 *   - another seat approves → the deployment is 'approved'; a reject →
 *     'rejected'; a withdraw → 'cancelled';
 *   - an overdue deployment row is swept by expireOverduePendingApprovals
 *     (source <> 'run') and its deployment recorded as cancelled;
 *   - no run is ever looked up, closed or resumed;
 *   - approval.requested / approval.decided reach the project feed and never
 *     the trigger bus.
 *
 * Run: cd server && node --test automation/approvalService.deployment.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const automationStore = require('../stores/automationStore');
const solutionStageStore = require('../stores/solutionStageStore');
const approvalService = require('./approvalService');
const approvalEvents = require('./approvalEvents');
const approvalLifecycle = require('../core/automationRunner/approvalLifecycle');
const { collectParticipants } = require('./approvalStages');

const APPROVAL_MIGRATIONS = [
    'automation-approvals-2026-08',
    'approvals-v2-2026-09',
    'approvals-panel-2026-09',
    'approvals-stages-2026-08',
    'approvals-project-id-2026-09',
    'approvals-deployment-source-2026-10',
];

const SO = 'so';            // the Solution owner, who requests every deploy in v1
const REVIEWER = 'rev1';
const ADMIN = 'admin1';

const { swap, restore } = makeSwaps();
const rec = { dispatches: [], feed: [], runCalls: [], bells: [] };

before(async () => {
    // The two tables the approval migrations alter but do not create.
    await pg.exec(`
        CREATE TABLE automation_runs (id TEXT PRIMARY KEY);
        CREATE TABLE automation_approval_audit (
            id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT, decided_by TEXT,
            decision TEXT NOT NULL, comment TEXT, source TEXT, ts TIMESTAMPTZ NOT NULL DEFAULT NOW());
    `);
    const quiet = swap(console, 'log', () => {});
    try {
        for (const name of APPROVAL_MIGRATIONS) await require(`../migrations/${name}`).up();
    } finally { quiet(); }
    await solutionStageStore.initDB();

    const dispatch = require('./triggerBus/dispatch');
    swap(dispatch, 'dispatchEvent', async (e) => { rec.dispatches.push(e.event); });
    swap(dispatch, 'dispatchOrgScopedEvent', async (_p, event) => { rec.dispatches.push(event); });
    swap(require('../core/projectFeed'), 'emitProjectEvent', async (projectId, ev) => {
        rec.feed.push({ projectId, kind: ev.kind, payload: ev.payload });
    });
    swap(require('./approvalNotify'), 'notifyApproval', async (n) => { rec.bells.push(n); });
    const userStore = require('../stores/userStore');
    swap(userStore, 'getUser', async (id) => ({ id, name: id, groups: '[]' }));
    // A deployment approval has no run: any run lookup is a bug.
    for (const fn of ['getRun', 'updateRun', 'getRunSteps']) {
        swap(automationStore, fn, async (...args) => { rec.runCalls.push([fn, ...args]); return null; });
    }
    // (A resume clears the run's awaiting state through updateRun first, so
    // the swap above also catches a resume without loading the runner.)
});

after(async () => {
    restore();
    await close();
});

beforeEach(() => {
    rec.dispatches.length = 0;
    rec.feed.length = 0;
    rec.bells.length = 0;
});

let seq = 0;

/** An awaiting_approval deployment plus its pending gate, linked both ways. */
async function gate({ shape = 'single', expiresAt = null, rule = 'first', stages: stageList = null } = {}) {
    seq += 1;
    const depId = `dep_${String(seq).padStart(16, '0')}`;
    const stageProjectId = `prd_${seq}`;
    await pg.query(
        `INSERT INTO solution_deployments
            (id, solution_id, stage_project_id, stage, release_id, release_seq, kind, status,
             plan, plan_hash, stage_settings_version, request_key, requested_by)
         VALUES ($1, 'sol1', $2, 'prd', 'rel1', 7, 'deploy', 'awaiting_approval',
                 '{}'::jsonb, 'hash', 1, $3, $4)`,
        [depId, stageProjectId, `rk_${seq}`, SO],
    );
    const seats = [{ userId: SO }, { userId: REVIEWER }];
    const extra = {};
    if (shape === 'panel') Object.assign(extra, { approvers: seats, approvalRule: rule });
    if (shape === 'staged') {
        const stages = stageList || [{ key: 's1', name: 'Release review', approvers: seats, rule }];
        Object.assign(extra, { stages, stageParticipants: collectParticipants(stages), stageKey: 's1',
            approvers: stages[0].approvers, approvalRule: stages[0].rule });
    }
    const approval = await automationStore.createApproval({
        source: 'deployment',
        stepId: 'stage.prd',
        deploymentId: depId,
        organizationId: 'org1',
        projectId: stageProjectId,
        projectTitle: 'Invoices (Production)',
        automationTitle: 'Deploy release 7 of Invoices to Production',
        ownerId: SO,
        requestedBy: SO,
        prompt: 'Deploy release 7?',
        context: { deploymentId: depId, planHash: 'hash', releaseSeq: 7, stageProjectId },
        expiresAt,
        ...extra,
    });
    assert.ok(approval, 'the gate row was created');
    assert.ok(await solutionStageStore.setApprovalId(depId, approval.id));
    return { approval, depId };
}

async function deploymentStatus(depId) {
    const r = await pg.query('SELECT status, error FROM solution_deployments WHERE id = $1', [depId]);
    return r.rows[0];
}

const viewerOf = (userId, { admin = false } = {}) => ({
    userId, groupIds: [], isOrgAdminOfOrg: (orgId) => admin && orgId === 'org1',
});

test('the row carries its deployment, source and sentinel step', async () => {
    const { approval, depId } = await gate();
    assert.strictEqual(approval.source, 'deployment');
    assert.strictEqual(approval.stepId, 'stage.prd');
    assert.strictEqual(approval.deploymentId, depId);
    assert.strictEqual(approval.runId, null);
    assert.strictEqual(approvalService.isRunless(approval), true);
    assert.strictEqual(approvalService.isRunless({ source: 'run' }), false);
    assert.strictEqual(approvalService.isRunless({ source: 'app' }), true);
});

for (const shape of ['single', 'panel', 'staged']) {
    test(`four-eyes (${shape}): the requester cannot decide, even as owner, seat and org admin`, async () => {
        const { approval, depId } = await gate({ shape });
        assert.strictEqual(approvalService.canDecide(approval, viewerOf(SO, { admin: true })), false);
        // Someone else in the right seat still can.
        const other = shape === 'single' ? viewerOf(ADMIN, { admin: true }) : viewerOf(REVIEWER);
        assert.strictEqual(approvalService.canDecide(approval, other), true);

        const { code } = await approvalService.decide({ approval, run: null, deciderId: SO, decision: 'approve' });
        assert.strictEqual(code, 403);
        assert.strictEqual((await automationStore.getApproval(approval.id)).status, 'pending');
        assert.deepStrictEqual(await automationStore.getApprovalVotes(approval.id), [], 'no vote was cast');
        assert.strictEqual((await deploymentStatus(depId)).status, 'awaiting_approval');
    });
}

test('single: an org admin approves and the deployment is approved', async () => {
    const { approval, depId } = await gate();
    const { code, body } = await approvalService.decide({
        approval, run: null, deciderId: ADMIN, decision: 'approve',
    });
    assert.strictEqual(code, 200);
    assert.strictEqual(body.approval.status, 'approved');
    assert.strictEqual((await deploymentStatus(depId)).status, 'approved');
    // The owner hears that someone else decided their deploy.
    assert.ok(rec.bells.some(b => b.recipientIds.includes(SO)));
});

test('panel: another seat approves and the deployment is approved', async () => {
    const { approval, depId } = await gate({ shape: 'panel' });
    const { code, body } = await approvalService.decide({
        approval, run: null, deciderId: REVIEWER, decision: 'approve',
    });
    assert.strictEqual(code, 200);
    assert.strictEqual(body.approval.status, 'approved');
    assert.strictEqual((await deploymentStatus(depId)).status, 'approved');
});

test('staged: another seat of the current stage approves and the deployment is approved', async () => {
    const { approval, depId } = await gate({ shape: 'staged' });
    const { code, body } = await approvalService.decide({
        approval, run: null, deciderId: REVIEWER, decision: 'approve',
    });
    assert.strictEqual(code, 200);
    assert.strictEqual(body.approval.status, 'approved');
    assert.strictEqual((await deploymentStatus(depId)).status, 'approved');
});

test("panel rule 'all' with the requester seated: the other seat's approval is enough", async () => {
    const { approval, depId } = await gate({ shape: 'panel', rule: 'all' });
    assert.strictEqual(approvalService.panelProgress(approval, []).needed, 1, 'the dead seat does not count');
    const { code, body } = await approvalService.decide({
        approval, run: null, deciderId: REVIEWER, decision: 'approve',
    });
    assert.strictEqual(code, 200);
    assert.strictEqual(body.approval.status, 'approved');
    assert.strictEqual((await deploymentStatus(depId)).status, 'approved');
});

test("staged rule 'all': hand-over and reminders skip the requester; the chain can complete", async () => {
    const stages = [
        { key: 's1', name: 'Release review', approvers: [{ userId: SO }, { userId: REVIEWER }], rule: 'all' },
        { key: 's2', name: 'Go-live', approvers: [{ userId: SO }, { userId: ADMIN }], rule: 'all' },
    ];
    const { approval, depId } = await gate({ shape: 'staged', stages });
    assert.deepStrictEqual(await approvalLifecycle.reminderRecipientIds(approval), [REVIEWER]);

    const first = await approvalService.decide({ approval, run: null, deciderId: REVIEWER, decision: 'approve' });
    assert.strictEqual(first.code, 200);
    const handOver = rec.bells.find(b => /Your approval is needed/.test(b.title));
    assert.ok(handOver, 'the next stage was told');
    assert.deepStrictEqual(handOver.recipientIds, [ADMIN], 'never the requester');

    const atS2 = await automationStore.getApproval(approval.id);
    assert.strictEqual(atS2.stage, 's2');
    assert.deepStrictEqual(await approvalLifecycle.reminderRecipientIds(atS2), [ADMIN]);

    const second = await approvalService.decide({ approval: atS2, run: null, deciderId: ADMIN, decision: 'approve' });
    assert.strictEqual(second.code, 200);
    assert.strictEqual(second.body.approval.status, 'approved');
    assert.strictEqual((await deploymentStatus(depId)).status, 'approved');
});

test('reminder on an unstaged deployment row reaches the org admins, never the requester', async () => {
    // The users table is userStore's (its own DDL, booted on require).
    await require('../stores/userStore').initDB();
    await pg.query(`INSERT INTO users (id, username, "organizationId", role, "orgRole") VALUES
        ($1, $1, 'org1', 'user', 'org_admin'), ($2, $2, 'org1', 'user', 'org_admin'),
        ('member1', 'member1', 'org1', 'user', 'member'), ('admin_other', 'admin_other', 'org2', 'user', 'org_admin')
        ON CONFLICT (id) DO NOTHING`, [ADMIN, SO]);
    const { approval } = await gate();
    assert.deepStrictEqual(await approvalLifecycle.reminderRecipientIds(approval), [ADMIN]);
    // Control: a non-deployment row with nobody assigned still falls back to its owner.
    assert.deepStrictEqual(
        await approvalLifecycle.reminderRecipientIds({ ...approval, source: 'app' }), [SO]);
});

test('a reject leads to a rejected deployment', async () => {
    const { approval, depId } = await gate({ shape: 'panel' });
    const { code, body } = await approvalService.decide({
        approval, run: null, deciderId: REVIEWER, decision: 'reject', reason: 'Not this week.',
    });
    assert.strictEqual(code, 200);
    assert.strictEqual(body.approval.status, 'rejected');
    assert.strictEqual((await deploymentStatus(depId)).status, 'rejected');
});

test('a withdraw cancels the deployment', async () => {
    const { approval, depId } = await gate();
    const { code } = await approvalService.withdraw({ approval, deciderId: SO, reason: 'Wrong release.' });
    assert.strictEqual(code, 200);
    const dep = await deploymentStatus(depId);
    assert.strictEqual(dep.status, 'cancelled');
    assert.deepStrictEqual(dep.error, { code: 'approval_cancelled' });
});

test('an overdue deployment gate is swept by the run-less expiry and recorded as cancelled', async () => {
    const { approval, depId } = await gate({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    // A run row's deadline is the run reaper's business, never this sweep's.
    const runRow = await automationStore.createApproval({
        runId: null, stepId: 's1', ownerId: 'x', source: 'run',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await approvalLifecycle.expireOverdueAppApprovals();
    assert.strictEqual((await automationStore.getApproval(approval.id)).status, 'expired');
    assert.strictEqual((await automationStore.getApproval(runRow.id)).status, 'pending');
    const dep = await deploymentStatus(depId);
    assert.strictEqual(dep.status, 'cancelled');
    assert.deepStrictEqual(dep.error, { code: 'approval_expired' });
    const bell = rec.bells.find(b => b.approval.id === approval.id);
    assert.match(bell.message, /deployment was cancelled/);
});

test('a decide after the deadline flips the gate and cancels the deployment', async () => {
    const { approval, depId } = await gate({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const { code } = await approvalService.decide({ approval, run: null, deciderId: ADMIN, decision: 'approve' });
    assert.strictEqual(code, 410);
    assert.strictEqual((await deploymentStatus(depId)).status, 'cancelled');
});

test('events: the feed hears requested and decided; the trigger bus never does', async () => {
    const { approval } = await gate();
    approvalEvents.dispatchApprovalRequested(approval);
    await approvalService.decide({ approval, run: null, deciderId: ADMIN, decision: 'approve' });
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(rec.dispatches, [], 'no approval.requested / approval.decided trigger dispatch');
    const kinds = rec.feed.filter(f => f.payload.approvalId === approval.id).map(f => f.kind);
    assert.deepStrictEqual(kinds, ['approval.requested', 'approval.decided']);
    assert.strictEqual(rec.feed[0].projectId, approval.projectId);
});

test('events: an app approval still reaches the trigger bus (control)', async () => {
    approvalEvents.dispatchApprovalRequested({ id: 'apr_app', source: 'app', status: 'pending', organizationId: 'org1', ownerId: 'u' });
    approvalEvents.dispatchApprovalDecided({ id: 'apr_app', source: 'app', status: 'approved', organizationId: 'org1', ownerId: 'u' });
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(rec.dispatches, ['approval.requested', 'approval.decided']);
});

test('no run was ever looked up, closed or resumed', () => {
    assert.deepStrictEqual(rec.runCalls, []);
});

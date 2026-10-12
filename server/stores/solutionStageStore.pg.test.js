/**
 * solutionStageStore against a real Postgres (@electric-sql/pglite): the
 * store's own DDL (applySolutionStageSchema) and its factories over a
 * `{ query, tx }` facade, with projectStore's own schema and factory next to
 * it. No module is replaced.
 *
 * Pinned:
 *   - createStages is idempotent per stage, needs an organisation, fixes the
 *     Dev kind, runs as the Dev owner, and starts new parts active on UAT only;
 *   - admission is exclusive per stage: an awaiting row refuses a new one with
 *     approval_pending, an active row with stage_busy; a request_key replays;
 *   - the settings CAS; one winner for a claim and for a lease reclaim;
 *   - recordDeploymentDecision moves only an awaiting row and maps a 23505 to
 *     cancelled (stage_busy_at_approval); reconcileAwaitingApprovals applies
 *     decided approvals and gives up on a request that was never made;
 *   - detachStage refuses while busy, removes the stage rows, and the stage
 *     can be created again;
 *   - steering values go live only through applySteeringValues, and
 *     variableValuesFor answers typed applied values of declared names;
 *   - bindings, the journal, the history page and managedPayloadFor.
 *
 * Run: cd server && node --test stores/solutionStageStore.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const { makeProjectStore, applyProjectSchema } = require('./projectStore');
const { makeSolutionStageStore, applySolutionStageSchema } = require('./solutionStageStore');
const { pgliteDb } = require('../testUtils/pgliteDb');

const runDdl = (pg) => async (_tag, statements) => {
    for (const stmt of statements) await pg.exec(typeof stmt === 'string' ? stmt : stmt.sql);
};

// blueprintStore's stamp table, ref ledger and release table, reduced to what this store reads.
const BLUEPRINT_TABLES = `
    CREATE TABLE project_releases (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, manifest JSONB NOT NULL);
    CREATE TABLE project_solution_entities (
        project_id TEXT NOT NULL, ref TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
        install_hash TEXT NOT NULL DEFAULT 'h', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, ref));
    CREATE TABLE solution_part_refs (
        solution_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, ref TEXT NOT NULL,
        PRIMARY KEY (solution_id, kind, entity_id));
`;

let pg;
let projects;
let store;
let dev;
let uat;
let prd;

function facadeFor(db) {
    return {
        run: db.query,
        getOne: async (sql, params) => (await db.query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await db.query(sql, params)).rows,
        getClient: async () => ({ query: db.query, release() {} }),
    };
}

let keySeq = 0;
/** An admission row for a stage; `over` replaces any field. */
function depRow(stage, over = {}) {
    keySeq += 1;
    return {
        solutionId: stage.solutionId, stageProjectId: stage.projectId, stage: stage.stage,
        releaseId: 'rel_1', releaseSeq: 1, kind: 'deploy', status: 'queued',
        plan: { steps: 1 }, planHash: 'hash', stageSettingsVersion: stage.settingsVersion,
        requestKey: `req-${keySeq}`, requestedBy: 'alice', ...over,
    };
}

/** A raw deployment row, bypassing admission (for states admission never makes). */
async function rawDeployment(id, stageProjectId, status, extra = '') {
    await pg.query(
        `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status, plan,
                                           plan_hash, stage_settings_version, request_key, requested_by ${extra ? ', approval_id, created_at' : ''})
         VALUES ($1, 'sol', $2, 'uat', 'rel_1', 'deploy', $3, '{}'::jsonb, 'h', 1, $1, 'alice' ${extra})`,
        [id, stageProjectId, status],
    );
}

/** A pipeline release of the Dev project whose manifest declares `variables`. */
async function release(id, variables) {
    await pg.query(
        `INSERT INTO project_releases (id, project_id, manifest) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (id) DO UPDATE SET manifest = EXCLUDED.manifest`,
        [id, dev.id, JSON.stringify({ schemaVersion: 2, solution: { variables } })],
    );
}

const status = async (id) => (await pg.query('SELECT status, error FROM solution_deployments WHERE id = $1', [id])).rows[0];

before(async () => {
    pg = new PGlite();
    await applyProjectSchema({ exec: (sql) => pg.exec(sql), runDdl: runDdl(pg) });
    await applySolutionStageSchema({ runDdl: runDdl(pg) });
    await pg.exec(BLUEPRINT_TABLES);
    const { db } = pgliteDb(pg);
    projects = makeProjectStore(facadeFor(db));
    store = makeSolutionStageStore(db, { projectStore: projects });
    dev = await projects.createProject({ name: 'Invoices', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
});

after(async () => { await pg.close(); });

// ── Stages ───────────────────────────────────────────────────────────

test('the schema applies a second time without an error', async () => {
    await applySolutionStageSchema({ runDdl: runDdl(pg) });
});

test('createStages makes UAT and PRD, idempotently, running as the Dev owner', async () => {
    // A legacy Dev whose kind the backfill only guessed.
    await pg.query('UPDATE projects SET kind = NULL, kind_guessed = TRUE WHERE id = $1', [dev.id]);
    const first = await store.createStages({ devProject: dev, stages: ['prd', 'uat'], actorId: 'alice' });
    assert.deepStrictEqual(first.map((s) => [s.stage, s.created]), [['uat', true], ['prd', true]]);
    [uat, prd] = first;
    assert.strictEqual(uat.runAsUserId, 'alice');
    assert.strictEqual(uat.organizationId, 'org1');
    assert.strictEqual(uat.newPartsActive, true);
    assert.strictEqual(prd.newPartsActive, false);
    assert.strictEqual(uat.settingsVersion, 1);
    const devRow = (await pg.query('SELECT kind, kind_guessed FROM projects WHERE id = $1', [dev.id])).rows[0];
    assert.deepStrictEqual(devRow, { kind: 'solution', kind_guessed: false });
    const uatProject = await projects.getProject(uat.projectId);
    assert.strictEqual(uatProject.name, 'Invoices (UAT)');
    assert.strictEqual(uatProject.stageOf, dev.id);
    assert.strictEqual((await projects.getProject(prd.projectId)).name, 'Invoices (Production)');

    const again = await store.createStages({ devProject: dev.id, stages: ['uat', 'prd'], actorId: 'bob' });
    assert.deepStrictEqual(again.map((s) => [s.projectId, s.created]), [[uat.projectId, false], [prd.projectId, false]]);
    assert.strictEqual((await store.listStages(dev.id)).length, 2);
    assert.strictEqual((await store.getStageFor(dev.id, 'prd')).projectId, prd.projectId);
});

test('createStages refuses a Solution without an organisation, a workspace and a stage', async () => {
    const loose = await projects.createProject({ name: 'Loose', ownerId: 'alice', kind: 'solution' });
    await assert.rejects(store.createStages({ devProject: loose, stages: ['uat'], actorId: 'alice' }),
        (e) => e.status === 409 && e.code === 'stages_need_org' && e.expose === true);
    const ws = await projects.createProject({ name: 'Team', ownerId: 'alice', organizationId: 'org1' });
    await assert.rejects(store.createStages({ devProject: ws, stages: ['uat'], actorId: 'alice' }), (e) => e.code === 'not_a_solution');
    await assert.rejects(store.createStages({ devProject: uat.projectId, stages: ['uat'], actorId: 'alice' }), (e) => e.code === 'stage_project');
    await assert.rejects(store.createStages({ devProject: dev, stages: ['dev'], actorId: 'alice' }), (e) => e.code === 'stage_invalid');
    assert.strictEqual((await pg.query('SELECT COUNT(*)::int AS n FROM projects WHERE stage_of = $1', [loose.id])).rows[0].n, 0);
});

test('createStages corrects a guessed kind, but not over chats a Solution cannot hold', async () => {
    // The backfill guessed 'workspace'; an explicit workspace stays refused (above).
    const guessed = await projects.createProject({ name: 'Guessed', ownerId: 'alice', organizationId: 'org1' });
    await pg.query(`UPDATE projects SET kind = 'workspace', kind_guessed = TRUE WHERE id = $1`, [guessed.id]);
    await pg.exec('CREATE TABLE IF NOT EXISTS project_chats (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)');
    await pg.query(`INSERT INTO project_chats (id, project_id) VALUES ('chat_1', $1)`, [guessed.id]);
    await assert.rejects(store.createStages({ devProject: guessed, stages: ['uat'], actorId: 'alice' }),
        (e) => e.status === 409 && e.code === 'kind_holds_other_content' && e.details.teamChats === 1);
    assert.strictEqual((await pg.query('SELECT COUNT(*)::int AS n FROM projects WHERE stage_of = $1', [guessed.id])).rows[0].n, 0);

    await pg.query('DELETE FROM project_chats WHERE project_id = $1', [guessed.id]);
    const [made] = await store.createStages({ devProject: guessed, stages: ['uat'], actorId: 'alice' });
    assert.strictEqual(made.created, true);
    const row = (await pg.query('SELECT kind, kind_guessed FROM projects WHERE id = $1', [guessed.id])).rows[0];
    assert.deepStrictEqual(row, { kind: 'solution', kind_guessed: false });
    await store.detachStage(made.projectId, 'alice');
});

test('the settings write is a compare-and-swap on settings_version', async () => {
    const next = await store.updateStageSettings(prd.projectId, 1, { requiresApproval: true, approvalPolicy: { stages: [] } });
    assert.strictEqual(next.settingsVersion, 2);
    assert.strictEqual(next.requiresApproval, true);
    assert.deepStrictEqual(next.approvalPolicy, { stages: [] });
    await assert.rejects(store.updateStageSettings(prd.projectId, 1, { requiresApproval: false }),
        (e) => e.status === 409 && e.code === 'settings_stale' && e.details.settingsVersion === 2);
    await assert.rejects(store.updateStageSettings(prd.projectId, 2, { runAsUserId: 'mallory' }), (e) => e.code === 'unknown_field');
    await assert.rejects(store.updateStageSettings('nope', 1, {}), (e) => e.status === 404);
    prd = await store.getStage(prd.projectId);
});

// ── Admission ────────────────────────────────────────────────────────

test('admission is exclusive: an awaiting row refuses with approval_pending, an active one with stage_busy', async () => {
    const waiting = await store.insertDeployment(depRow(prd, { status: 'awaiting_approval' }));
    assert.strictEqual(waiting.replayed, false);
    assert.match(waiting.id, /^dep_[0-9a-f]{16}$/);
    await assert.rejects(store.insertDeployment(depRow(prd, { status: 'queued' })),
        (e) => e.status === 409 && e.code === 'approval_pending' && e.details.deploymentId === waiting.id);
    assert.ok(await store.closeAwaiting(waiting.id, 'alice'));

    const running = await store.insertDeployment(depRow(prd, { status: 'queued' }));
    await assert.rejects(store.insertDeployment(depRow(prd, { status: 'awaiting_approval' })),
        (e) => e.status === 409 && e.code === 'stage_busy' && e.details.deploymentId === running.id);
    // Another stage is not held up.
    const other = await store.insertDeployment(depRow(uat));
    assert.ok(await store.isActiveDeployment(running.id, prd.projectId));
    assert.strictEqual(await store.isActiveDeployment(running.id, uat.projectId), false);
    await store.transitionDeployment(running.id, ['queued'], 'cancelled');
    await store.transitionDeployment(other.id, ['queued'], 'cancelled');
    assert.strictEqual(await store.isActiveDeployment(running.id, prd.projectId), false);
});

test('the same request_key replays the existing row, even while the stage is busy', async () => {
    const row = depRow(uat);
    const first = await store.insertDeployment(row);
    const replay = await store.insertDeployment({ ...row, planHash: 'other' });
    assert.strictEqual(replay.replayed, true);
    assert.strictEqual(replay.id, first.id);
    assert.strictEqual(replay.planHash, 'hash');
    await store.transitionDeployment(first.id, ['queued'], 'cancelled');
    await assert.rejects(store.insertDeployment(depRow(uat, { status: 'preparing' })), TypeError);
});

test('admission refuses a stage that was detached in the meantime', async () => {
    const [extra] = await store.createStages({ devProject: dev, stages: ['uat'], actorId: 'alice' });
    // A second Solution, so the detach does not touch this file's UAT.
    const other = await projects.createProject({ name: 'Other', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    const [stage] = await store.createStages({ devProject: other, stages: ['prd'], actorId: 'alice' });
    await store.detachStage(stage.projectId, 'alice');
    await assert.rejects(store.insertDeployment(depRow(stage)), (e) => e.status === 404 && e.code === 'stage_not_found');
    // The wrong Solution or stage for a live stage is refused too.
    await assert.rejects(store.insertDeployment(depRow(extra, { solutionId: other.id })), (e) => e.code === 'stage_not_found');
    await assert.rejects(store.insertDeployment(depRow(extra, { stage: 'prd' })), (e) => e.code === 'stage_not_found');
});

test('a settings deployment needs no release; a deploy does', async () => {
    const settings = await store.insertDeployment(depRow(prd, { kind: 'settings', releaseId: null, settingsPatch: { requiresApproval: false } }));
    assert.deepStrictEqual(settings.settingsPatch, { requiresApproval: false });
    await store.transitionDeployment(settings.id, ['queued'], 'cancelled');
    await assert.rejects(store.insertDeployment(depRow(prd, { releaseId: null })), (e) => e.code === '23514');
});

// ── Claim, lease, transitions, journal ───────────────────────────────

test('two workers claim one row: one wins; an expired lease is reclaimed by one replica', async () => {
    const dep = await store.insertDeployment(depRow(uat));
    const [a, b] = await Promise.all([
        store.claimDeployment(dep.id, 'w1', 60_000),
        store.claimDeployment(dep.id, 'w2', 60_000),
    ]);
    assert.strictEqual([a, b].filter(Boolean).length, 1);
    const winner = (a || b);
    assert.strictEqual(winner.status, 'preparing');
    assert.ok(winner.startedAt);
    // A live lease is not reclaimable, and only its owner beats it.
    assert.strictEqual(await store.reclaimExpired(dep.id, 'w3', 60_000), null);
    assert.strictEqual(await store.heartbeat(dep.id, 'w3'), false);
    assert.strictEqual(await store.heartbeat(dep.id, winner.leaseOwner), true);
    assert.deepStrictEqual((await store.listExpiredLeases(new Date())).map((d) => d.id), []);

    await pg.query(`UPDATE solution_deployments SET lease_expires_at = NOW() - interval '1 minute' WHERE id = $1`, [dep.id]);
    assert.deepStrictEqual((await store.listExpiredLeases(new Date())).map((d) => d.id), [dep.id]);
    const [r1, r2] = await Promise.all([
        store.reclaimExpired(dep.id, 'w3', 60_000),
        store.reclaimExpired(dep.id, 'w4', 60_000),
    ]);
    assert.strictEqual([r1, r2].filter(Boolean).length, 1);
    assert.strictEqual(await store.heartbeat(dep.id, winner.leaseOwner), false, 'the crashed worker lost its lease');

    // A row in flight without a lease is never reclaimed, and nothing moves a
    // row into flight without one.
    await rawDeployment('dep_raw_nolease', 'stage-nolease', 'preparing');
    assert.strictEqual(await store.reclaimExpired('dep_raw_nolease', 'w5', 60_000), null);
    assert.ok(!(await store.listExpiredLeases(new Date())).some((d) => d.id === 'dep_raw_nolease'));
    await rawDeployment('dep_raw_queued', 'stage-nolease-2', 'queued');
    assert.strictEqual(await store.transitionDeployment('dep_raw_queued', ['queued'], 'preparing'), null);
    assert.strictEqual(await store.transitionDeployment('dep_raw_nolease', ['preparing'], 'committing'), null);
    assert.ok(await store.transitionDeployment('dep_raw_nolease', ['preparing'], 'failed'), 'a terminal move needs no lease');
    await store.transitionDeployment('dep_raw_queued', ['queued'], 'cancelled');

    // Transitions are conditional; a terminal one ends the lease.
    assert.strictEqual(await store.transitionDeployment(dep.id, ['queued'], 'committing'), null);
    const committing = await store.transitionDeployment(dep.id, ['preparing'], 'committing');
    assert.strictEqual(committing.status, 'committing');
    const converging = await store.transitionDeployment(dep.id, 'committing', 'converging', { committed: true, report: { parts: 2 } });
    assert.ok(converging.committedAt);
    assert.deepStrictEqual(converging.report, { parts: 2 });
    const done = await store.transitionDeployment(dep.id, ['converging'], 'succeeded');
    assert.ok(done.finishedAt);
    assert.strictEqual(done.leaseOwner, null);
});

test('getDeploymentByRequestKey reads one row by (stage, key) and nothing else', async () => {
    const row = depRow(uat);
    const dep = await store.insertDeployment(row);
    const found = await store.getDeploymentByRequestKey(uat.projectId, row.requestKey);
    assert.strictEqual(found.id, dep.id);
    assert.strictEqual(found.requestKey, row.requestKey);
    assert.strictEqual(await store.getDeploymentByRequestKey(prd.projectId, row.requestKey), null, 'the key is per stage');
    assert.strictEqual(await store.getDeploymentByRequestKey(uat.projectId, 'no-such-key'), null);
    await store.transitionDeployment(dep.id, ['queued'], 'cancelled');
});

test('retryConverge re-leases a succeeded_with_warnings row into converging, and nothing else', async () => {
    const dep = await store.insertDeployment(depRow(prd));
    assert.strictEqual(await store.retryConverge(dep.id, 'w1', 60_000), null, 'a queued row is not retried');
    await store.claimDeployment(dep.id, 'w0', 60_000);
    await store.transitionDeployment(dep.id, ['preparing'], 'committing');
    await store.transitionDeployment(dep.id, ['committing'], 'converging', { committed: true });
    assert.strictEqual(await store.retryConverge(dep.id, 'w1', 60_000), null, 'a running row is not retried');
    const warned = await store.transitionDeployment(dep.id, ['converging'], 'succeeded_with_warnings', { report: { parts: 2 }, error: { code: 'x' } });
    assert.ok(warned.finishedAt);

    const retried = await store.retryConverge(dep.id, 'w1', 60_000);
    assert.strictEqual(retried.status, 'converging');
    assert.strictEqual(retried.leaseOwner, 'w1');
    assert.ok(retried.leaseExpiresAt);
    assert.strictEqual(retried.finishedAt, null);
    assert.strictEqual(retried.error, null);
    assert.deepStrictEqual(retried.report, { parts: 2 }, 'the report stays');
    assert.ok(await store.isActiveDeployment(dep.id, prd.projectId));
    assert.strictEqual(await store.heartbeat(dep.id, 'w1'), true, 'the lease is real');
    assert.strictEqual(await store.retryConverge(dep.id, 'w2', 60_000), null, 'only one retry wins');

    // Another deployment holds the stage: the retry is refused as busy, the row stays terminal.
    await store.transitionDeployment(dep.id, ['converging'], 'succeeded_with_warnings');
    const other = await store.insertDeployment(depRow(prd));
    await assert.rejects(store.retryConverge(dep.id, 'w3', 60_000), (e) => e.status === 409 && e.code === 'stage_busy' && e.details.deploymentId === other.id);
    assert.strictEqual((await status(dep.id)).status, 'succeeded_with_warnings');
    await store.transitionDeployment(other.id, ['queued'], 'cancelled');
});

test('listClaimable lists queued and approved rows, oldest first', async () => {
    const q = await store.insertDeployment(depRow(uat));
    assert.deepStrictEqual((await store.listClaimable(new Date())).map((d) => d.id), [q.id]);
    await store.transitionDeployment(q.id, ['queued'], 'cancelled');
    assert.deepStrictEqual(await store.listClaimable(new Date()), []);
});

test('the journal appends in order and updates one step', async () => {
    const dep = await store.insertDeployment(depRow(uat));
    const s1 = await store.appendStep(dep.id, { phase: 'prepare', action: 'install', ref: 'aut_1', kind: 'automation', before: { version: 3 } });
    const s2 = await store.appendStep(dep.id, { phase: 'commit', action: 'flip', ref: 'aut_1', status: 'done' });
    assert.deepStrictEqual([s1.seq, s2.seq], [1, 2]);
    const upd = await store.updateStep(dep.id, 1, { status: 'done', entityId: 'a1', afterHash: 'h1', detail: { count: 1 } });
    assert.strictEqual(upd.status, 'done');
    assert.deepStrictEqual((await store.listSteps(dep.id)).map((s) => [s.seq, s.phase, s.status]), [[1, 'prepare', 'done'], [2, 'commit', 'done']]);
    assert.deepStrictEqual((await store.listSteps(dep.id, { phase: 'commit' })).map((s) => s.seq), [2]);
    assert.deepStrictEqual((await store.listSteps(dep.id))[0].before, { version: 3 });
    await store.transitionDeployment(dep.id, ['queued'], 'cancelled');
});

test('listDeployments pages the history newest first, without the plan', async () => {
    const page1 = await store.listDeployments(uat.projectId, { limit: 2 });
    assert.strictEqual(page1.length, 2);
    assert.strictEqual(page1[0].plan, undefined);
    const page2 = await store.listDeployments(uat.projectId, { limit: 50, before: page1[1].id });
    assert.ok(page2.length >= 1);
    assert.ok(!page2.some((d) => page1.some((p) => p.id === d.id)));
    assert.deepStrictEqual((await store.getDeployment(page1[0].id)).plan, { steps: 1 });
});

// ── Approvals ────────────────────────────────────────────────────────

test('recordDeploymentDecision moves only an awaiting row', async () => {
    const waiting = await store.insertDeployment(depRow(prd, { status: 'awaiting_approval' }));
    // Before the link, no approval decides the row, not even one naming it.
    assert.strictEqual(await store.recordDeploymentDecision({ id: 'ap_stale', status: 'approved', deploymentId: waiting.id }), null);
    assert.strictEqual(await store.recordDeploymentDecision({ status: 'approved', deploymentId: waiting.id }), null);
    assert.strictEqual((await status(waiting.id)).status, 'awaiting_approval');
    assert.ok(await store.setApprovalId(waiting.id, 'ap_1'));
    assert.strictEqual(await store.recordDeploymentDecision({ status: 'approved', deploymentId: waiting.id }), null, 'an approval without an id');
    assert.strictEqual(await store.setApprovalId(waiting.id, 'ap_2'), false, 'linked once');
    assert.strictEqual(await store.recordDeploymentDecision({ id: 'ap_1', status: 'pending', deploymentId: waiting.id }), null);
    // An approval that is not this row's own does not decide it.
    assert.strictEqual(await store.recordDeploymentDecision({ id: 'ap_x', status: 'approved', deploymentId: waiting.id }), null);
    const approved = await store.recordDeploymentDecision({ id: 'ap_1', status: 'approved', context: { deploymentId: waiting.id } });
    assert.strictEqual(approved.status, 'approved');
    assert.strictEqual(await store.recordDeploymentDecision({ id: 'ap_1', status: 'rejected', deploymentId: waiting.id }), null);
    assert.ok(await store.claimDeployment(waiting.id, 'w1'), 'an approved row is claimable');
    await store.transitionDeployment(waiting.id, ['preparing'], 'failed');

    const second = await store.insertDeployment(depRow(prd, { status: 'awaiting_approval', approvalId: 'ap_3' }));
    const expired = await store.recordDeploymentDecision({ id: 'ap_3', status: 'expired' });
    assert.strictEqual(expired.id, second.id);
    assert.strictEqual(expired.status, 'cancelled');
    assert.deepStrictEqual(expired.error, { code: 'approval_expired' });
});

test('an approval landing on a busy stage cancels the row (23505 → stage_busy_at_approval)', async () => {
    const waiting = await store.insertDeployment(depRow(prd, { status: 'awaiting_approval', approvalId: 'ap_busy' }));
    // A state admission never makes: an active row next to the open one.
    await rawDeployment('dep_raw_active', prd.projectId, 'preparing');
    const moved = await store.recordDeploymentDecision({ id: 'ap_busy', status: 'approved', deploymentId: waiting.id });
    assert.strictEqual(moved.status, 'cancelled');
    assert.deepStrictEqual(moved.error, { code: 'stage_busy_at_approval' });
    await pg.query(`UPDATE solution_deployments SET status = 'failed' WHERE id = 'dep_raw_active'`);
});

test('reconcileAwaitingApprovals applies decided approvals and gives up on a request never made', async () => {
    await rawDeployment('dep_r1', 'stage-r1', 'awaiting_approval', `, 'ap_r1', NOW()`);
    await rawDeployment('dep_r2', 'stage-r2', 'awaiting_approval', `, 'ap_r2', NOW()`);
    await rawDeployment('dep_r3', 'stage-r3', 'awaiting_approval', `, NULL, NOW() - interval '2 minutes'`);
    await rawDeployment('dep_r4', 'stage-r4', 'awaiting_approval', `, NULL, NOW()`);
    await rawDeployment('dep_r5', 'stage-r5', 'awaiting_approval', `, 'ap_gone', NOW()`);
    const approvals = { ap_r1: { id: 'ap_r1', status: 'rejected' }, ap_r2: { id: 'ap_r2', status: 'pending' } };
    const out = await store.reconcileAwaitingApprovals({ getApproval: async (id) => approvals[id] || null });
    assert.deepStrictEqual(out, { checked: 5, applied: 2, cancelled: 1 });
    assert.strictEqual((await status('dep_r1')).status, 'rejected');
    assert.strictEqual((await status('dep_r2')).status, 'awaiting_approval');
    assert.deepStrictEqual(await status('dep_r3'), { status: 'cancelled', error: { code: 'approval_request_failed' } });
    assert.strictEqual((await status('dep_r4')).status, 'awaiting_approval');
    assert.strictEqual((await status('dep_r5')).status, 'cancelled');
    await pg.query(`UPDATE solution_deployments SET status = 'cancelled' WHERE id IN ('dep_r2', 'dep_r4')`);
});

// ── Variables and bindings ───────────────────────────────────────────

const DECLS = [
    { name: 'greeting', type: 'text' },
    { name: 'api_base', type: 'url', steering: true },
    { name: 'retries', type: 'number' },
    { name: 'strict', type: 'boolean' },
];

test('steering values go live only through applySteeringValues', async () => {
    await store.replaceVariables(dev.id, DECLS);
    // The stage runs a release that carries the same declarations.
    await release('rel_1', DECLS);
    await release('rel_2', DECLS);
    await store.setCurrentRelease(null, { stageProjectId: uat.projectId, releaseId: 'rel_1', releaseSeq: 1 });
    await assert.rejects(store.replaceVariables(dev.id, [{ name: 'Bad-Name' }]), (e) => e.code === 'variable_name_invalid');
    assert.deepStrictEqual((await store.listVariables(dev.id)).map((v) => v.name), ['greeting', 'api_base', 'retries', 'strict']);

    const res = await store.setVariableValues(uat.projectId, { greeting: 'hi', api_base: 'https://a.example' }, 'alice', { steeringNames: ['api_base'] });
    assert.deepStrictEqual(res, { written: 2, pending: true });
    assert.strictEqual((await store.getStage(uat.projectId)).bindingsPending, true);
    assert.deepStrictEqual(await store.variableValuesFor(uat.projectId), { greeting: 'hi' });

    const applied = await pg.transaction((t) => store.applySteeringValues({ query: (s, p) => t.query(s, p) }, uat.projectId));
    assert.strictEqual(applied, 1);
    assert.deepStrictEqual(await store.variableValuesFor(uat.projectId), { greeting: 'hi', api_base: 'https://a.example' });

    // A later steering edit stays a draft; the applied value keeps running.
    await store.setVariableValues(uat.projectId, { api_base: 'https://b.example' }, 'alice', { steeringNames: ['api_base'] });
    assert.strictEqual((await store.variableValuesFor(uat.projectId)).api_base, 'https://a.example');
    const listed = (await store.listVariableValues(uat.projectId)).find((v) => v.name === 'api_base');
    assert.deepStrictEqual([listed.value, listed.appliedValue], ['https://b.example', 'https://a.example']);

    // The commit's pointer move clears the pending mark and keeps the previous release.
    const moved = await store.setCurrentRelease(null, { stageProjectId: uat.projectId, releaseId: 'rel_2', releaseSeq: 2, expectedReleaseId: 'rel_1' });
    assert.deepStrictEqual([moved.currentReleaseId, moved.previousReleaseId, moved.currentReleaseSeq, moved.bindingsPending], ['rel_2', 'rel_1', 2, false]);
    const redeploy = await store.setCurrentRelease(null, { stageProjectId: uat.projectId, releaseId: 'rel_2', releaseSeq: 2 });
    assert.strictEqual(redeploy.previousReleaseId, 'rel_1', 'a redeploy keeps the previous release');
    assert.strictEqual(await store.setCurrentRelease(null, { stageProjectId: uat.projectId, releaseId: 'rel_3', expectedReleaseId: 'rel_1' }), null);
});

test('clearing a steering value is a draft too: the applied value runs until the commit', async () => {
    await store.setVariableValues(uat.projectId, { api_base: null }, 'alice', { steeringNames: ['api_base'] });
    assert.strictEqual((await store.variableValuesFor(uat.projectId)).api_base, 'https://a.example');
    const listed = (await store.listVariableValues(uat.projectId)).find((v) => v.name === 'api_base');
    assert.deepStrictEqual([listed.value, listed.appliedValue], [null, 'https://a.example']);
    assert.strictEqual((await store.getStage(uat.projectId)).bindingsPending, true);

    await pg.transaction((t) => store.applySteeringValues({ query: (s, p) => t.query(s, p) }, uat.projectId));
    assert.strictEqual((await store.variableValuesFor(uat.projectId)).api_base, undefined);
    assert.strictEqual((await store.listVariableValues(uat.projectId)).some((v) => v.name === 'api_base'), false);

    // A steering draft that never went live simply goes.
    await store.setVariableValues(uat.projectId, { api_base: 'https://c.example' }, 'alice', { steeringNames: ['api_base'] });
    await store.setVariableValues(uat.projectId, { api_base: null }, 'alice', { steeringNames: ['api_base'] });
    assert.strictEqual((await store.listVariableValues(uat.projectId)).some((v) => v.name === 'api_base'), false);
});

test('a stage write is steering for a url/email or marked declaration, whatever the caller passes', async () => {
    await store.replaceVariables(dev.id, [...DECLS, { name: 'notify_to', type: 'email' }, { name: 'route', type: 'text', steering: true }]);
    const res = await store.setVariableValues(uat.projectId, { api_base: 'https://d.example', notify_to: 'ops@example.org', route: 'r1' }, 'alice');
    assert.strictEqual(res.pending, true);
    const values = await store.variableValuesFor(uat.projectId);
    assert.strictEqual(values.api_base, undefined);
    const rows = await store.listVariableValues(uat.projectId);
    assert.deepStrictEqual(rows.filter((v) => v.appliedValue !== null).map((v) => v.name), ['greeting']);
    // Dev itself is not gated: its values run at once.
    await store.setVariableValues(dev.id, { api_base: 'https://dev.example' }, 'alice');
    assert.strictEqual((await store.variableValuesFor(dev.id)).api_base, 'https://dev.example');
    await store.setVariableValues(dev.id, { api_base: null }, 'alice');
    await store.setVariableValues(uat.projectId, { api_base: null, notify_to: null, route: null }, 'alice');
    await store.replaceVariables(dev.id, DECLS);
});

test('a stage reads the declarations of the release it runs, not the live Dev table', async () => {
    await store.setVariableValues(uat.projectId, { retries: '5' }, 'alice');
    assert.deepStrictEqual(await store.variableValuesFor(uat.projectId), { greeting: 'hi', retries: 5 });
    // Dev drops `greeting` and retypes `retries`: the stage does not notice until a deploy.
    await store.replaceVariables(dev.id, [{ name: 'retries', type: 'boolean' }]);
    assert.deepStrictEqual(await store.variableValuesFor(uat.projectId), { greeting: 'hi', retries: 5 });
    // The deploy of a release that carries the change moves it.
    await release('rel_3', [{ name: 'retries', type: 'boolean' }]);
    await store.setCurrentRelease(null, { stageProjectId: uat.projectId, releaseId: 'rel_3', releaseSeq: 3 });
    assert.deepStrictEqual(await store.variableValuesFor(uat.projectId), {});
    // A stage that runs no release has no declarations.
    assert.deepStrictEqual(await store.variableValuesFor(prd.projectId), {});
    // Back to the state the later tests expect.
    await store.setCurrentRelease(null, { stageProjectId: uat.projectId, releaseId: 'rel_2', releaseSeq: 2 });
    await store.replaceVariables(dev.id, DECLS);
});

test('variableValuesFor answers typed applied values of declared names only', async () => {
    await store.setVariableValues(dev.id, [
        { name: 'retries', value: '3' }, { name: 'strict', value: 'true' }, { name: 'undeclared', value: 'x' },
    ], 'alice');
    assert.deepStrictEqual(await store.variableValuesFor(dev.id), { retries: 3, strict: true });
    const project = await projects.createProject({ name: 'Plain', ownerId: 'alice' });
    assert.deepStrictEqual(await store.variableValuesFor(project.id), {});
    // A null deletes the value; the in-process memo follows the write.
    await store.setVariableValues(dev.id, { strict: null }, 'alice');
    assert.deepStrictEqual(await store.variableValuesFor(dev.id), { retries: 3 });
});

test('bindings: upsert, a null deletes, and the pending mark', async () => {
    const rows = await store.upsertBindings(uat.projectId, [
        { slot: 'connection:cn_1', kind: 'connection', value: { connectionId: 'c1', allowedHosts: ['api.example'] } },
        { slot: 'slug:web_1', kind: 'webpage_slug', value: { slug: 'invoices-uat' } },
    ], 'alice');
    assert.deepStrictEqual(rows.map((r) => r.slot), ['connection:cn_1', 'slug:web_1']);
    await assert.rejects(store.upsertBindings(uat.projectId, [{ slot: 'x', kind: 'nonsense', value: {} }], 'alice'), (e) => e.code === 'binding_invalid');
    const after = await store.upsertBindings(uat.projectId, [{ slot: 'slug:web_1', value: null }], 'alice');
    assert.deepStrictEqual(after.map((r) => r.slot), ['connection:cn_1']);
    assert.ok(await store.setBindingsPending(uat.projectId, true));
    assert.strictEqual((await store.getStage(uat.projectId)).bindingsPending, true);
});

test('part options round-trip', async () => {
    await store.setPartOption(dev.id, { ref: 'kb_1', kind: 'knowledge_base', options: { contentMode: 'carry' } }, 'alice');
    assert.deepStrictEqual((await store.getPartOptions(dev.id, { ref: 'kb_1' })).options, { contentMode: 'carry' });
    assert.strictEqual((await store.getPartOptions(dev.id)).length, 1);
    assert.strictEqual(await store.getPartOptions(dev.id, { ref: 'kb_9' }), null);
});

test('managedPayloadFor names the Solution, the stage, the release and the Dev part', async () => {
    await pg.query(`INSERT INTO project_solution_entities (project_id, ref, kind, entity_id) VALUES ($1, 'aut_1', 'automation', 'a-uat'),
                                                                                                     ($1, 'kb_1', 'knowledge_base', 'kb-uat')`, [uat.projectId]);
    await pg.query(`INSERT INTO solution_part_refs (solution_id, kind, entity_id, ref) VALUES ($1, 'automation', 'a-dev', 'aut_1')`, [dev.id]);
    assert.deepStrictEqual(await store.managedPayloadFor({ projectId: uat.projectId, kind: 'automation', entityId: 'a-uat' }), {
        solutionId: dev.id, solutionName: 'Invoices', stage: 'uat', releaseSeq: 2, devRef: { kind: 'automation', id: 'a-dev' },
    });
    assert.strictEqual((await store.managedPayloadFor({ projectId: uat.projectId, kind: 'app', entityId: 'x' })).devRef, null);
    assert.strictEqual(await store.managedPayloadFor({ projectId: dev.id, kind: 'automation', entityId: 'a-dev' }), null);
    assert.strictEqual(await store.managedPayloadFor({ projectId: null, kind: 'automation', entityId: 'a' }), null);
    assert.deepStrictEqual(await store.kbStageInfo('kb-uat'), { stageProjectId: uat.projectId, solutionId: dev.id, ref: 'kb_1', contentMode: 'carry' });
    assert.strictEqual(await store.kbStageInfo('kb-elsewhere'), null);
});

test('managedPayloadFor tolerates a missing ref ledger (devRef null)', async () => {
    await pg.exec('ALTER TABLE solution_part_refs RENAME TO solution_part_refs_away');
    try {
        const got = await store.managedPayloadFor({ projectId: uat.projectId, kind: 'automation', entityId: 'a-uat' });
        assert.strictEqual(got.devRef, null);
        assert.strictEqual(got.stage, 'uat');
    } finally {
        await pg.exec('ALTER TABLE solution_part_refs_away RENAME TO solution_part_refs');
    }
});

test('runAsStagesFor lists the stages a user runs or owns', async () => {
    assert.deepStrictEqual((await store.runAsStagesFor('alice')).map((s) => s.stage).sort(), ['prd', 'uat']);
    assert.deepStrictEqual(await store.runAsStagesFor('bob'), []);
});

// ── Pause and detach ─────────────────────────────────────────────────

test('pause remembers the parts that were on and bumps the settings version', async () => {
    const before = await store.getStage(uat.projectId);
    const paused = await store.setPausedState(uat.projectId, { automations: ['a-uat'] });
    assert.deepStrictEqual([paused.enabled, paused.pausedState, paused.settingsVersion], [false, { automations: ['a-uat'] }, before.settingsVersion + 1]);
    await assert.rejects(store.setPausedState(uat.projectId, null, { expectedVersion: before.settingsVersion }), (e) => e.code === 'settings_stale');
    const resumed = await store.setPausedState(uat.projectId, null);
    assert.deepStrictEqual([resumed.enabled, resumed.pausedState], [true, null]);
});

test('detachStage refuses while busy, removes the stage rows, and the stage can be created again', async () => {
    const dep = await store.insertDeployment(depRow(uat));
    await assert.rejects(store.detachStage(uat.projectId, 'alice'), (e) => e.status === 409 && e.code === 'stage_busy' && e.details.deploymentId === dep.id);
    await store.transitionDeployment(dep.id, ['queued'], 'cancelled');

    const out = await store.detachStage(uat.projectId, 'alice');
    assert.deepStrictEqual(out, { projectId: uat.projectId, solutionId: dev.id, stage: 'uat' });
    const count = async (table) => (await pg.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE project_id = $1`, [uat.projectId])).rows[0].n;
    assert.deepStrictEqual(
        [await count('solution_stages'), await count('solution_bindings'), await count('solution_variable_values'), await count('project_solution_entities')],
        [0, 0, 0, 0],
    );
    const project = await projects.getProject(uat.projectId);
    assert.deepStrictEqual([project.stage, project.stageOf], [null, null]);
    assert.ok((await store.listDeployments(uat.projectId)).length > 0, 'the history stays');
    await assert.rejects(store.detachStage(uat.projectId, 'alice'), (e) => e.status === 404);

    const [fresh] = await store.createStages({ devProject: dev, stages: ['uat'], actorId: 'alice' });
    assert.strictEqual(fresh.created, true);
    assert.notStrictEqual(fresh.projectId, uat.projectId);
    assert.strictEqual(fresh.settingsVersion, 1);
});

test('removeStageRows deletes the stage row, bindings, values and stamps on the caller\'s transaction, and keeps the history', async () => {
    const [stage] = await store.createStages({ devProject: dev, stages: ['uat'], actorId: 'alice' });
    const dep = await store.insertDeployment(depRow(stage, { kind: 'remove', releaseId: null, status: 'queued' }));
    await store.upsertBindings(stage.projectId, [{ slot: 'table:t1', kind: 'table', value: { datatableId: 'x' } }], 'alice');
    await pg.query(`INSERT INTO solution_variable_values (project_id, name, value, applied_value, updated_by) VALUES ($1, 'v', '"a"'::jsonb, '"a"'::jsonb, 'alice')`, [stage.projectId]);
    const count = async (table) => (await pg.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE project_id = $1`, [stage.projectId])).rows[0].n;
    assert.strictEqual(await count('solution_bindings'), 1);
    assert.strictEqual(await count('solution_variable_values'), 1);

    // Rolled back with the caller's transaction: the helper opens none of its own.
    const { db } = pgliteDb(pg);
    await assert.rejects(db.tx(async (client) => {
        assert.strictEqual(await store.removeStageRows(client, stage.projectId), true);
        throw new Error('roll back');
    }), /roll back/);
    assert.strictEqual(await count('solution_stages'), 1);
    assert.strictEqual(await count('solution_bindings'), 1);

    // The removal's own deployment is active and does not stop it (detachStage would refuse here).
    assert.strictEqual(await db.tx((client) => store.removeStageRows(client, stage.projectId)), true);
    assert.deepStrictEqual(
        [await count('solution_stages'), await count('solution_bindings'), await count('solution_variable_values'), await count('project_solution_entities')],
        [0, 0, 0, 0],
    );
    assert.strictEqual((await store.getDeployment(dep.id)).id, dep.id, 'the history stays');
    assert.strictEqual(await db.tx((client) => store.removeStageRows(client, stage.projectId)), false, 'nothing left to delete');
});

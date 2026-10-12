/**
 * The deployment runner (design 6.4, 6.5, 6.7, D9) over a REAL
 * solutionStageStore (PGlite, its own DDL, no module replaced) and injected
 * phases, so every claim, lease, transition and admission lock is the store's.
 *
 * Pinned:
 *   - admission: only the Solution owner who is the run-as user; a changed
 *     plan is 409 plan_stale {plan}; a missing acknowledgement, an
 *     eligibility refusal and any other blocking finding refuse; the same
 *     request key replays; a queued row is kicked and runs prepare → commit →
 *     converge; PRD with the gate on is `awaiting_approval` + approvalGate;
 *   - an approved row is planned again: a different hash fails it with
 *     plan_stale_after_approval before anything is written;
 *   - an error before the commit landed: `compensating` (still holding the
 *     capability), compensate, then `failed` with a code and no stack;
 *   - a crash is decided from the row: preparing / committing (also a
 *     redeploy, whose target equals the stage's release already) compensate;
 *     converging converges again;
 *   - settings and remove deployments run through their own phases;
 *   - tick reconciles awaiting approvals with the injected getApproval.
 *
 * Run: cd server && node --test projects/stages/runner.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeSolutionStageStore, applySolutionStageSchema } = require('../../stores/solutionStageStore');
const { makeRunner, missingAcknowledgements, errorOf } = require('./runner');

let pg;
let store;
let seq = 0;

before(async () => {
    pg = new PGlite();
    await applySolutionStageSchema({ runDdl: async (_t, statements) => { for (const s of statements) await pg.exec(s); } });
    store = makeSolutionStageStore(pgliteDb(pg).db, { projectStore: {} });
});
after(async () => { await pg.close(); });

/** A fresh stage per test, so no test sees another's lock. */
let STAGE;
beforeEach(async () => {
    seq += 1;
    STAGE = { projectId: `p_uat_${seq}`, solutionId: `p_dev_${seq}` };
    await pg.query(
        `INSERT INTO solution_stages (project_id, solution_id, stage, organization_id, run_as_user_id, created_by, current_release_id)
         VALUES ($1, $2, 'uat', 'org1', 'so', 'so', 'rel_1'), ($3, $2, 'prd', 'org1', 'so', 'so', 'rel_1')`,
        [STAGE.projectId, STAGE.solutionId, `p_prd_${seq}`],
    );
    STAGE.prdId = `p_prd_${seq}`;
});

const PLAN = (over = {}) => ({ kind: 'deploy', release: { id: 'rel_2', seq: 2 }, parts: [], blocking: [], acknowledgementsRequired: [], settingsVersion: 1, planHash: 'sha256:plan', ...over });
const statusOf = async (id) => (await store.getDeployment(id)).status;

/** A runner whose phases record into `log` and move the row as the real ones do. */
function runner(log, over = {}) {
    return makeRunner({
        solutionStageStore: store,
        workerId: 'w1',
        heartbeatMs: 10_000,
        solutionOwnerOf: async () => 'so',
        plan: async (input) => { log.push(['plan', input.kind]); return over.plan ? over.plan(input) : PLAN({ kind: input.kind }); },
        approvalGate: { request: async ({ deployment }) => { log.push(['approval', deployment.id]); await store.setApprovalId(deployment.id, `apr_${deployment.id}`); } },
        prepare: async ({ deployment }) => { log.push(['prepare', await statusOf(deployment.id)]); if (over.prepareThrows) throw over.prepareThrows; return { prepared: true }; },
        commit: async ({ deployment, prepared }) => {
            log.push(['commit', await statusOf(deployment.id), prepared.prepared]);
            if (over.commitThrows) throw over.commitThrows;
            return store.transitionDeployment(deployment.id, ['committing'], 'converging', { committed: true });
        },
        commitSettings: async ({ deployment }) => { log.push(['commitSettings']); return store.transitionDeployment(deployment.id, ['committing'], 'converging', { committed: true }); },
        converge: async ({ deployment }) => {
            log.push(['converge', await statusOf(deployment.id)]);
            return { deployment: await store.transitionDeployment(deployment.id, ['converging'], 'succeeded', { report: { warnings: [] } }) };
        },
        compensate: async ({ deployment }) => { log.push(['compensate', await statusOf(deployment.id)]); return { undone: 1, failed: 0, skipped: 0 }; },
        removeStage: {
            prepareRemove: async () => { log.push(['prepareRemove']); },
            commitRemove: async ({ deployment }) => { log.push(['commitRemove']); return store.transitionDeployment(deployment.id, ['committing'], 'converging', { committed: true }); },
            finishRemove: async ({ deployment }) => { log.push(['finishRemove']); return { deployment: await store.transitionDeployment(deployment.id, ['converging'], 'succeeded', {}) }; },
        },
        schedule: (fn) => { log.push(['kick']); over.kicked = fn; },
        getApproval: async (id) => ({ id, status: over.approvalStatus || 'pending' }),
        ...(over.deps || {}),
    });
}

const admitArgs = (over = {}) => ({ solutionId: STAGE.solutionId, stage: 'uat', releaseId: 'rel_2', kind: 'deploy', planHash: 'sha256:plan',
    requestKey: `rk_${seq}_${Math.random()}`, acknowledgements: [], actor: 'so', ...over });

test('admission refuses who is not the owner and run-as, a changed plan, a missing acknowledgement and a blocked plan', async () => {
    const log = [];
    await assert.rejects(runner(log).admit(admitArgs({ actor: 'editor' })), { status: 403, code: 'solution_owner_only' });
    await assert.rejects(runner(log, { deps: { solutionOwnerOf: async () => 'other' } }).admit(admitArgs({ actor: 'other' })), { code: 'run_as_mismatch' });
    await assert.rejects(runner(log).admit(admitArgs({ planHash: 'sha256:old' })), (err) => {
        assert.strictEqual(err.code, 'plan_stale');
        assert.strictEqual(err.details.plan.planHash, 'sha256:plan', 'the fresh plan travels with the refusal');
        return true;
    });
    const acked = runner(log, { plan: () => PLAN({ acknowledgementsRequired: [{ code: 'schema.retire_column', ref: 'dt_1' }] }) });
    await assert.rejects(acked.admit(admitArgs()), (err) => err.code === 'acknowledgement_missing' && err.details.missing[0].ref === 'dt_1');
    await assert.rejects(runner(log, { plan: () => PLAN({ blocking: [{ code: 'release_not_in_uat', severity: 'blocking' }] }) }).admit(admitArgs()), { code: 'release_not_in_uat' });
    await assert.rejects(runner(log, { plan: () => PLAN({ blocking: [{ code: 'binding.missing', severity: 'blocking' }] }) }).admit(admitArgs()), { code: 'plan_blocked' });
    await assert.rejects(runner(log).admit(admitArgs({ stage: 'nope' })), { status: 404 });
    const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM solution_deployments WHERE stage_project_id = $1', [STAGE.projectId]);
    assert.strictEqual(rows[0].n, 0, 'nothing was admitted');
});

test('a queued deployment is kicked and runs prepare, commit and converge; the same request key replays', async () => {
    const log = [];
    const over = {};
    const r = runner(log, over);
    const args = admitArgs();
    const { deployment, replayed } = await r.admit(args);
    assert.strictEqual(replayed, false);
    assert.strictEqual(deployment.status, 'queued');
    assert.deepStrictEqual(deployment.fromReleaseId, 'rel_1');
    const again = await r.admit(args);
    assert.strictEqual(again.replayed, true);
    assert.strictEqual(again.deployment.id, deployment.id);
    await assert.rejects(r.admit(admitArgs()), { code: 'stage_busy' }, 'a concurrent admission is refused');

    over.kicked();
    for (let i = 0; i < 50 && await statusOf(deployment.id) !== 'succeeded'; i++) await new Promise(res => setTimeout(res, 5));
    assert.strictEqual(await statusOf(deployment.id), 'succeeded');
    assert.deepStrictEqual(log.filter(e => ['prepare', 'commit', 'converge'].includes(e[0])),
        [['prepare', 'preparing'], ['commit', 'committing', true], ['converge', 'converging']]);
    const row = await store.getDeployment(deployment.id);
    assert.ok(row.committedAt && row.finishedAt && !row.leaseOwner);
});

test('PRD with the gate on waits for approval; a second request is refused; a changed plan fails the approved row', async () => {
    await pg.query('UPDATE solution_stages SET requires_approval = TRUE WHERE project_id = $1', [STAGE.prdId]);
    const log = [];
    const over = {};
    const r = runner(log, over);
    const { deployment } = await r.admit(admitArgs({ stage: 'prd' }));
    assert.strictEqual(deployment.status, 'awaiting_approval');
    assert.deepStrictEqual(log.filter(e => e[0] === 'approval'), [['approval', deployment.id]]);
    assert.ok(!log.some(e => e[0] === 'kick'));
    await assert.rejects(r.admit(admitArgs({ stage: 'prd' })), { code: 'approval_pending' });

    over.approvalStatus = 'approved';
    await r.reconcile();
    assert.strictEqual(await statusOf(deployment.id), 'approved');

    const changed = runner(log, { plan: () => PLAN({ planHash: 'sha256:other' }) });
    await changed.runOne(deployment.id);
    const row = await store.getDeployment(deployment.id);
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.error.code, 'plan_stale_after_approval');
    assert.ok(!log.some(e => e[0] === 'prepare'), 'nothing was prepared');
});

test('an approved row whose plan still matches runs', async () => {
    await pg.query('UPDATE solution_stages SET requires_approval = TRUE WHERE project_id = $1', [STAGE.prdId]);
    const log = [];
    const over = { approvalStatus: 'approved' };
    const r = runner(log, over);
    const { deployment } = await r.admit(admitArgs({ stage: 'prd' }));
    const out = await r.tick();
    assert.strictEqual(out.reconciled.applied, 1);
    assert.strictEqual(out.ran, 1);
    assert.strictEqual(await statusOf(deployment.id), 'succeeded');
    assert.deepStrictEqual(log.filter(e => e[0] === 'plan').length, 2, 'planned at admission and again after approval');
});

test('a prepare error compensates while the row is compensating, then fails it with a code and no stack', async () => {
    const log = [];
    const err = Object.assign(new Error('Nothing changed in UAT.'), { status: 409, code: 'prepare_blocked', expose: true,
        details: { findings: [{ code: 'binding.missing', ref: 'aut_1', message: 'x' }] } });
    const r = runner(log, { prepareThrows: err });
    const { deployment } = await r.admit(admitArgs());
    await r.runOne(deployment.id);
    const row = await store.getDeployment(deployment.id);
    assert.strictEqual(row.status, 'failed');
    assert.deepStrictEqual(row.error, { code: 'prepare_blocked', message: 'Nothing changed in UAT.', findings: [{ code: 'binding.missing', ref: 'aut_1' }] });
    assert.deepStrictEqual(log.find(e => e[0] === 'compensate'), ['compensate', 'compensating']);
    assert.deepStrictEqual(row.report, { compensation: { undone: 1, failed: 0, skipped: 0 } });
});

test('a commit error compensates too, and an unexposed error never leaks its message', async () => {
    const log = [];
    const r = runner(log, { commitThrows: new Error('duplicate key value violates "secret"') });
    const { deployment } = await r.admit(admitArgs());
    await r.runOne(deployment.id);
    const row = await store.getDeployment(deployment.id);
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.error.code, 'deployment_failed');
    assert.ok(!JSON.stringify(row.error).includes('secret'));
    assert.deepStrictEqual(log.find(e => e[0] === 'compensate'), ['compensate', 'compensating']);
});

/** An in-flight row whose lease has run out, as a crashed worker leaves it. */
async function crashed(status, kind = 'deploy', committed = false) {
    const id = `dep_crash_${seq}_${status}`;
    await pg.query(
        `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status, plan, plan_hash,
            stage_settings_version, request_key, requested_by, lease_owner, lease_expires_at, committed_at)
         VALUES ($1, $2, $3, 'uat', 'rel_1', $4, $5, '{}'::jsonb, 'h', 1, $1, 'so', 'dead', NOW() - INTERVAL '1 minute', $6)`,
        [id, STAGE.solutionId, STAGE.projectId, kind, status, committed ? new Date() : null],
    );
    return id;
}

test('a crash in preparing compensates and fails the row', async () => {
    const log = [];
    const id = await crashed('preparing');
    await runner(log).resumeStale();
    assert.strictEqual(await statusOf(id), 'failed');
    assert.strictEqual((await store.getDeployment(id)).error.code, 'worker_lost');
    assert.deepStrictEqual(log.find(e => e[0] === 'compensate'), ['compensate', 'compensating']);
});

test('a crashed REDEPLOY in committing is compensated, never converged (its target equals the stage release)', async () => {
    const log = [];
    const id = await crashed('committing', 'redeploy');
    await runner(log).resumeStale();
    assert.strictEqual(await statusOf(id), 'failed');
    assert.ok(log.some(e => e[0] === 'compensate'));
    assert.ok(!log.some(e => e[0] === 'converge'));
});

test('a crash after the commit converges again', async () => {
    const log = [];
    const id = await crashed('converging', 'deploy', true);
    await runner(log).resumeStale();
    assert.strictEqual(await statusOf(id), 'succeeded');
    assert.deepStrictEqual(log.filter(e => e[0] === 'converge'), [['converge', 'converging']]);
    assert.ok(!log.some(e => e[0] === 'compensate'));
});

test('a live lease is not taken over', async () => {
    const log = [];
    const id = `dep_live_${seq}`;
    await pg.query(
        `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status, plan, plan_hash,
            stage_settings_version, request_key, requested_by, lease_owner, lease_expires_at)
         VALUES ($1, $2, $3, 'uat', 'rel_1', 'deploy', 'preparing', '{}'::jsonb, 'h', 1, $1, 'so', 'other', NOW() + INTERVAL '1 minute')`,
        [id, STAGE.solutionId, STAGE.projectId],
    );
    await runner(log).resumeStale();
    assert.strictEqual(await statusOf(id), 'preparing');
});

test('settings and remove deployments run through their own phases', async () => {
    const log = [];
    const r = runner(log, { plan: (input) => PLAN({ kind: input.kind, release: null, ...(input.kind === 'remove' ? { deleteData: input.deleteData === true } : {}) }) });
    const settings = await r.admit(admitArgs({ kind: 'settings', releaseId: null, settingsPatch: { requiresApproval: false } }));
    await r.runOne(settings.deployment.id);
    assert.strictEqual(await statusOf(settings.deployment.id), 'succeeded');
    assert.deepStrictEqual((await store.getDeployment(settings.deployment.id)).settingsPatch, { requiresApproval: false });
    const removal = await r.admit(admitArgs({ kind: 'remove', releaseId: null, actor: 'admin', settingsPatch: { deleteData: true } }));
    await r.runOne(removal.deployment.id);
    assert.strictEqual(await statusOf(removal.deployment.id), 'succeeded');
    assert.deepStrictEqual((await store.getDeployment(removal.deployment.id)).settingsPatch, { deleteData: true }, 'the stored flag comes from the plan');
    assert.deepStrictEqual(log.filter(e => /Remove|commitSettings/.test(e[0])).map(e => e[0]),
        ['commitSettings', 'prepareRemove', 'commitRemove', 'finishRemove']);
});

test('deleteData is part of the plan: planned with the flag, refused when the plan does not carry it, never taken from the raw request', async () => {
    const log = [];
    const seen = [];
    const withFlag = runner(log, { plan: (input) => { seen.push(input); return PLAN({ kind: input.kind, release: null, deleteData: input.deleteData === true }); } });
    const plain = await withFlag.admit(admitArgs({ kind: 'remove', releaseId: null, actor: 'admin', settingsPatch: null }));
    assert.strictEqual(seen[0].deleteData, false);
    assert.strictEqual(plain.deployment.settingsPatch, null);
    await pg.query(`UPDATE solution_deployments SET status = 'failed' WHERE id = $1`, [plain.deployment.id]);

    // a plan that cannot carry the flag (it was reviewed without it) never reaches the row
    const blind = runner(log, { plan: (input) => PLAN({ kind: input.kind, release: null }) });
    await assert.rejects(blind.admit(admitArgs({ kind: 'remove', releaseId: null, actor: 'admin', settingsPatch: { deleteData: true } })),
        { status: 409, code: 'plan_stale' });
    // the flag asked for AND carried by the plan is the one stored
    const flagged = await withFlag.admit(admitArgs({ kind: 'remove', releaseId: null, actor: 'admin', settingsPatch: { deleteData: true } }));
    assert.strictEqual(seen.at(-1).deleteData, true);
    assert.deepStrictEqual(flagged.deployment.settingsPatch, { deleteData: true });
    assert.strictEqual(flagged.deployment.plan.deleteData, true);
});

test('the same request key replays after the first deployment ran, though the plan hash has moved on', async () => {
    const log = [];
    let moved = false;
    const r = runner(log, { plan: (input) => PLAN({ kind: input.kind, planHash: moved ? 'sha256:after' : 'sha256:plan' }) });
    const args = admitArgs({ requestKey: `rk_replay_${seq}` });
    const first = await r.admit(args);
    await r.runOne(first.deployment.id);
    assert.strictEqual(await statusOf(first.deployment.id), 'succeeded');
    moved = true;
    const again = await r.admit(args);
    assert.strictEqual(again.replayed, true);
    assert.strictEqual(again.deployment.id, first.deployment.id);
    assert.strictEqual(again.deployment.status, 'succeeded');
    // a new key still meets the changed plan
    await assert.rejects(r.admit(admitArgs()), { code: 'plan_stale' });
});

/** A remove row whose commit began deleting, as a crash or a failing store leaves it. */
async function removing(id, stepStatus) {
    await pg.query(
        `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status, plan, plan_hash,
            stage_settings_version, request_key, requested_by, lease_owner, lease_expires_at)
         VALUES ($1, $2, $3, 'uat', NULL, 'remove', 'committing', '{}'::jsonb, 'h', 1, $1, 'so', 'dead', NOW() - INTERVAL '1 minute')`,
        [id, STAGE.solutionId, STAGE.projectId],
    );
    if (stepStatus) await store.appendStep(id, { phase: 'commit', action: 'remove_part', ref: 'aut_1', kind: 'automation', status: stepStatus });
}

test('a crashed remove that began deleting is finished forward, never compensated', async () => {
    const log = [];
    const id = `dep_rm_crash_${seq}`;
    await removing(id, 'pending');
    await runner(log, { deps: { removeStage: {
        removeStarted: async ({ deployment }) => (await store.listSteps(deployment.id, { phase: 'commit' })).length > 0,
        commitRemove: async ({ deployment }) => { log.push(['commitRemove']); return store.transitionDeployment(deployment.id, ['committing'], 'converging', { committed: true }); },
        finishRemove: async ({ deployment }) => { log.push(['finishRemove']); return { deployment: await store.transitionDeployment(deployment.id, ['converging'], 'succeeded', {}) }; },
    } } }).resumeStale();
    assert.strictEqual(await statusOf(id), 'succeeded');
    assert.deepStrictEqual(log.map(e => e[0]), ['commitRemove', 'finishRemove']);
});

test('a remove that fails after deleting says so and is not compensated; one that deleted nothing is', async () => {
    const log = [];
    const r = runner(log, { deps: { removeStage: {
        prepareRemove: async () => {},
        removeStarted: async () => true,
        commitRemove: async () => { throw new Error('store down'); },
    } } });
    const { deployment } = await r.admit(admitArgs({ kind: 'remove', releaseId: null, actor: 'admin' }));
    await r.runOne(deployment.id);
    const row = await store.getDeployment(deployment.id);
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.error.code, 'remove_incomplete');
    assert.ok(!/Nothing changed/.test(row.error.message));
    assert.ok(!log.some(e => e[0] === 'compensate'));

    const log2 = [];
    const r2 = runner(log2, { deps: { removeStage: {
        prepareRemove: async () => {},
        removeStarted: async () => false,
        commitRemove: async () => { throw new Error('guard'); },
    } } });
    const second = await r2.admit(admitArgs({ kind: 'remove', releaseId: null, actor: 'admin' }));
    await r2.runOne(second.deployment.id);
    assert.strictEqual((await store.getDeployment(second.deployment.id)).error.code, 'deployment_failed');
    assert.ok(log2.some(e => e[0] === 'compensate'));
});

test('missingAcknowledgements and errorOf', () => {
    assert.deepStrictEqual(missingAcknowledgements([{ code: 'drift', ref: 'aut_1' }, { code: 'stage.remove' }],
        [{ code: 'drift', ref: 'aut_1' }, 'stage.remove']), []);
    assert.deepStrictEqual(missingAcknowledgements([{ code: 'drift', ref: 'aut_1' }], [{ code: 'drift', ref: 'aut_2' }]), [{ code: 'drift', ref: 'aut_1' }]);
    const e = errorOf(Object.assign(new Error('x'), { code: 'plan_stale', expose: true, details: { ref: 'aut_1', why: 'version_changed' } }));
    assert.deepStrictEqual(e, { code: 'plan_stale', message: 'x', ref: 'aut_1', why: 'version_changed' });
});

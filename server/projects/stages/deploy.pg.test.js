/**
 * The deploy engine end to end, against a REAL Postgres (@electric-sql/pglite
 * behind db.js's pool, testUtils/pglitePool.js): projectStore,
 * blueprintStore, solutionStageStore, automationStore and the datatable
 * stores run their own schema and SQL, and the runner drives the real plan,
 * prepare, commit, converge, compensate and removeStage. No module is
 * replaced; only outbound side effects (feed, subscriptions, schedules,
 * notifications) and the checks that read other subsystems (the go-live
 * verdict, readiness, the stage graph) are injected through `deps`.
 *
 * Pinned (design 6.4-6.8):
 *   - Dev → UAT → PRD (approval) → rollback, end to end; a rollback revives a
 *     retired part with the same id; the stagePayload round trip equals the
 *     stamp's install_hash for every kind the stage holds;
 *   - the crash matrix: a worker that dies after prepare, in the middle of the
 *     commit or after it, and a REDEPLOY that dies in `committing`, which is
 *     compensated (never converged, though its target equals the stage's
 *     release already);
 *   - plan_stale when settings_version moves; one stage_busy of two concurrent
 *     admissions; an approval request next to a running redeploy is refused;
 *   - a live run during prepare still sees the old notificationSettings;
 *   - an unrelated org table edit made during the deployment is kept;
 *   - an automation switched off by its stage operator stays off across a
 *     redeploy, and on once switched on again;
 *   - a reference row write after the deploy is refused;
 *   - a retired required column lets inserts succeed;
 *   - a `settings` deployment changes the gate only after approval;
 *   - removeStage tears the stage down and the stage can be created again;
 *   - an expired approval releases the stage's open slot.
 *
 * Run: cd server && node --test projects/stages/deploy.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
// Page files go to the local-disk object storage under server/data/storage (gitignored), never a real bucket.
delete process.env.RUSTFS_ENDPOINT;
delete process.env.RUSTFS_ACCESS_KEY;
delete process.env.RUSTFS_SECRET_KEY;

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const userStore = require('../../stores/userStore');
const projectStore = require('../../stores/projectStore');
const blueprintStore = require('../../stores/blueprintStore');
const solutionStageStore = require('../../stores/solutionStageStore');
const automationStore = require('../../stores/automationStore');
const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const queryCompiler = require('../../core/dataEngine/queryCompiler');
const { hashReferenceRows } = require('./referenceRows');
const { readStagePayload, hashPayload } = require('./stagePayload');
const { hashOf } = require('./model');
const { plan } = require('./plan');
const { makeRunner } = require('./runner');
const { prepare } = require('./prepare');
const { commit } = require('./commit');
const goLive = require('../../automation/goLive');
const { definitionForRun } = require('../../core/automationRunner/definitionForRun');

const SO = 'so-deploy-pg';
const ORG = 'org_deploy';
const SCOPE = datatableStore.orgScope(ORG);
const feed = [];

// ── The checks and side effects that belong to other subsystems ─────────────

const goLiveDeps = {
    syncAppEventSubscription: async () => {}, syncSchedules: async () => {}, ensureFormPages: null,
    ensureAnswersTable: async () => ({ answers: null, usage: [] }), syncDatatableUsage: async () => {},
    syncKbSources: async () => {}, wakeComplianceReview: () => {}, revokeRemoteSubscriptions: async () => {},
    validate: { validateDefinition: () => ({ ok: true, warnings: [] }) }, agentsFor: async () => null,
    kbFindingsFor: async () => [], topicClassifierFor: async () => null, isManagedAutomation: async () => true,
};
const DEPS = {
    checkBeforeLiveCore: async () => ({ ok: true, warnings: [] }),
    aiActState: undefined,
    readiness: async () => [],
    stageCompleteness: async () => [],
    goLiveDeps,
    revokeRemoteSubscriptions: async () => {},
    emitProjectEvent: async (projectId, event) => { feed.push({ projectId, kind: event.kind, payload: event.payload }); },
    sleep: async () => {},
    approvalDeps: {
        validateStages: async (chain) => chain, groupMemberIds: async () => [],
        approvalEvents: { dispatchApprovalRequested: () => {} }, notifyApproval: async () => {}, panelRecipientIds: async () => [],
    },
    schedule: () => {},
    teardown: null,
};
/**
 * The real plan, with what the plan of a `remove` must carry (requested `deleteData`, in the hash and with
 * its own acknowledgement). plan.js / model.planHash own this; the wrapper stands in until they do, and
 * every other kind passes through untouched.
 */
async function planWithDeleteData(input, deps) {
    const p = await plan(input, deps);
    if (input.kind !== 'remove') return p;
    const deleteData = input.deleteData === true;
    return {
        ...p, deleteData,
        acknowledgementsRequired: [...p.acknowledgementsRequired, ...(deleteData ? [{ code: 'stage.delete_data' }] : [])],
        planHash: hashOf({ base: p.planHash, deleteData }),
    };
}
const runner = makeRunner({ ...Object.fromEntries(Object.entries(DEPS).filter(([, v]) => v !== null)), plan: planWithDeleteData });

// ── Fixtures ────────────────────────────────────────────────────────────────

const automation = (ref, label, extra = {}) => ({
    ref, kind: 'automation', title: `Automation ${ref}`, description: '',
    definition: { trigger: { kind: 'manual', id: 't' }, steps: [{ id: 's1', type: 'note', text: label }], ...extra },
});
const LABEL = { id: 'fld_label01', key: 'label', name: 'Label', type: 'text', required: true };
const AMOUNT = { id: 'fld_amount1', key: 'amount', name: 'Amount', type: 'number' };
const NOTE = { id: 'fld_note001', key: 'note', name: 'Note', type: 'text' };
const table = (ref, key, columns) => ({ ref, key, name: key, description: '', rowScope: 'all', columns });
const refRows = (ref, rows) => ({ ref, kind: 'reference_rows', sourceEntityId: `dev_${ref}`, payload: { rows }, contentHash: hashReferenceRows(rows) });

let cutSeq = 0;
/** A pipeline release of `dev` with these entities (and reference-row payloads). */
async function release(dev, entities, { payloads = [] } = {}) {
    cutSeq += 1;
    const out = await blueprintStore.cutPipelineRelease({
        projectId: dev.id, createdBy: SO, requestKey: `cut_${cutSeq}`,
        manifest: { schemaVersion: 2, channel: 'pipeline', solution: { key: `sol_${dev.id}`, name: dev.name, entities, slots: [], variables: [] } },
        contentHash: hashOf({ entities, cutSeq }), gate: { blocked: false, findings: [] }, payloads,
    });
    return out.release;
}

/** A Dev Solution with its UAT and PRD stages. */
async function solution(name) {
    const dev = await projectStore.createProject({ name, ownerId: SO, organizationId: ORG, kind: 'solution' });
    const [uat, prd] = await solutionStageStore.createStages({ devProject: dev, stages: ['uat', 'prd'], actorId: SO });
    return { dev, uat, prd };
}

let keySeq = 0;
/** Plan, then admit exactly that plan (every acknowledgement given). */
async function admit(sol, stageName, releaseId, opts = {}) {
    const { kind = 'deploy', settingsPatch = null, actor = SO } = opts;
    const stage = await solutionStageStore.getStageFor(sol.dev.id, stageName);
    const p = await planWithDeleteData({ stageProjectId: stage.projectId, releaseId, kind,
        settingsPatch: kind === 'settings' ? settingsPatch : null, deleteData: kind === 'remove' && !!(settingsPatch && settingsPatch.deleteData) }, DEPS);
    keySeq += 1;
    return runner.admit({
        solutionId: sol.dev.id, stage: stageName, releaseId, kind, planHash: p.planHash, requestKey: opts.requestKey || `rk_${keySeq}`,
        acknowledgements: p.acknowledgementsRequired, actor, settingsPatch,
    });
}

/** Admit and run to the end. */
async function deploy(sol, stageName, releaseId, opts = {}) {
    const { deployment } = await admit(sol, stageName, releaseId, opts);
    return runner.runOne(deployment.id);
}

const stageOf = (sol, name) => solutionStageStore.getStageFor(sol.dev.id, name);
const stampsOf = async (projectId) => blueprintStore.listStamps(projectId);
const automationIn = async (projectId, ref) => {
    const st = (await stampsOf(projectId)).get(ref);
    return st ? automationStore.getAutomation(st.entityId) : null;
};
const approve = async (deploymentId, status = 'approved') => {
    const row = await solutionStageStore.getDeployment(deploymentId);
    await pg.query('UPDATE automation_approvals SET status = $2 WHERE id = $1', [row.approvalId, status]);
    return solutionStageStore.recordDeploymentDecision({ id: row.approvalId, status, deploymentId });
};
/** The worker died: its lease is in the past. */
const expireLease = (id) => pg.query(`UPDATE solution_deployments SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id]);

/** Wait for userStore's load-time init and its default groups and roles (PGlite is ONE session). */
async function settleUserStore() {
    await userStore.initDB();
    for (let i = 0; i < 500; i++) {
        const r = await pg.query(`SELECT (SELECT COUNT(*)::int FROM roles WHERE id = 'agent_editor') + (SELECT COUNT(*)::int FROM groups WHERE id = 'users') AS n`);
        if (Number(r.rows[0].n) === 2) return;
        await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    throw new Error('userStore never finished seeding');
}

before(async () => {
    await settleUserStore();
    await projectStore.initDB();
    await blueprintStore.initDB();
    await solutionStageStore.initDB();
    await datatableStore.initDB();
    await automationStore.initDB();
    for (const store of ['agentStore', 'skillStore', 'knowledgeBases', 'documentStore', 'studioAppStore']) {
        await require(`../../stores/${store}`).initDB();
    }
    await require('../../stores/webpage/schema').initDB();
    await require('../../stores/storageStore').init();
    await pg.query('INSERT INTO organizations (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [ORG]);
    await userStore.createUser({ id: SO, username: SO, passwordHash: 'x', organizationId: ORG, orgRole: 'admin' });
});
after(async () => {
    fs.rmSync(path.resolve(__dirname, '..', '..', 'data', 'storage', 'users', SO), { recursive: true, force: true });
    await close();
});

// ── End to end ──────────────────────────────────────────────────────────────

test('Dev → UAT → PRD (approval) → rollback; a rollback revives a retired part; stamps round-trip', async () => {
    const sol = await solution('Invoices');
    const r1 = await release(sol.dev, {
        automations: [automation('aut_1', 'v1'), automation('aut_2', 'only in R1')],
        datatables: [table('dt_1', 'prices', [LABEL, AMOUNT])],
    }, { payloads: [refRows('dt_1', [{ id: 'r1', values: { fld_label01: 'A', fld_amount1: 1 } }])] });

    const uatRun = await deploy(sol, 'uat', r1.id);
    assert.strictEqual(uatRun.status, 'succeeded', JSON.stringify(uatRun.error));
    const uat = await stageOf(sol, 'uat');
    assert.strictEqual(uat.currentReleaseId, r1.id);
    const a1 = await automationIn(uat.projectId, 'aut_1');
    assert.strictEqual(a1.projectId, uat.projectId);
    assert.strictEqual(a1.userId, SO, 'owned by the run-as user');
    assert.ok(a1.liveVersion != null, 'live');
    assert.strictEqual(a1.isActive, true, 'UAT switches new parts on');

    // The round trip: every stamp's install_hash is what the stored part hashes to now.
    for (const st of (await stampsOf(uat.projectId)).values()) {
        assert.strictEqual(hashPayload(await readStagePayload(st.kind, st.entityId)), st.installHash, `${st.kind} ${st.ref}`);
    }
    // A plan of the same release now calls everything unchanged.
    const again = await plan({ stageProjectId: uat.projectId, releaseId: r1.id, kind: 'redeploy' }, DEPS);
    assert.deepStrictEqual([...new Set(again.parts.map(p => p.action))], ['unchanged']);

    // PRD, behind the gate.
    const prd0 = await stageOf(sol, 'prd');
    await solutionStageStore.updateStageSettings(prd0.projectId, prd0.settingsVersion,
        { requiresApproval: true, approvalPolicy: { stages: [{ key: 's1', name: 'Release', approvers: [{ userId: 'reviewer' }] }] } });
    const { deployment: toPrd } = await admit(sol, 'prd', r1.id);
    assert.strictEqual(toPrd.status, 'awaiting_approval');
    assert.ok((await solutionStageStore.getDeployment(toPrd.id)).approvalId, 'the approval was opened');
    assert.strictEqual(await runner.runOne(toPrd.id), null, 'nothing runs before the decision');
    await approve(toPrd.id);
    const prdRun = await runner.runOne(toPrd.id);
    assert.strictEqual(prdRun.status, 'succeeded', JSON.stringify(prdRun.error));
    const prdA1 = await automationIn(prd0.projectId, 'aut_1');
    assert.strictEqual(prdA1.isActive, false, 'PRD keeps new parts off');
    assert.ok(prdA1.liveVersion != null);

    // R2 retires aut_2 everywhere.
    const r2 = await release(sol.dev, {
        automations: [automation('aut_1', 'v2')],
        datatables: [table('dt_1', 'prices', [LABEL, AMOUNT])],
    }, { payloads: [refRows('dt_1', [{ id: 'r1', values: { fld_label01: 'A', fld_amount1: 1 } }])] });
    assert.strictEqual((await deploy(sol, 'uat', r2.id)).status, 'succeeded');
    const { deployment: r2Prd } = await admit(sol, 'prd', r2.id);
    await approve(r2Prd.id);
    assert.strictEqual((await runner.runOne(r2Prd.id)).status, 'succeeded');
    const retired = (await stampsOf(prd0.projectId)).get('aut_2');
    assert.ok(retired.retiredAt, 'aut_2 is retired in PRD');

    // Roll PRD back to R1 (no approval for a rollback unless asked for).
    const back = await deploy(sol, 'prd', r1.id, { kind: 'rollback' });
    assert.strictEqual(back.status, 'succeeded', JSON.stringify(back.error));
    const revived = (await stampsOf(prd0.projectId)).get('aut_2');
    assert.strictEqual(revived.retiredAt, null);
    assert.strictEqual(revived.entityId, retired.entityId, 'the same part, revived');
    const prd = await stageOf(sol, 'prd');
    assert.deepStrictEqual([prd.currentReleaseId, prd.previousReleaseId], [r1.id, r2.id]);
    assert.deepStrictEqual((await automationIn(prd.projectId, 'aut_1')).liveDefinition.steps[0].text, 'v1');
    assert.ok(feed.some(e => e.kind === 'deployment.succeeded' && e.projectId === prd.projectId));
});

// ── Crashes ─────────────────────────────────────────────────────────────────

const NOTIFY_OLD = { onError: { recipients: [{ type: 'owner' }] }, tag: 'old' };
const NOTIFY_NEW = { onError: { recipients: [{ type: 'owner' }] }, tag: 'new' };
const R1_ENTITIES = () => ({ automations: [automation('aut_1', 'v1', { notificationSettings: NOTIFY_OLD })] });
const R2_ENTITIES = () => ({ automations: [automation('aut_1', 'v2', { notificationSettings: NOTIFY_NEW }), automation('aut_3', 'new in R2')] });

/** Admit, claim as a worker that will die, and prepare. */
async function claimAndPrepare(sol, stageName, releaseId, kind = 'deploy') {
    const { deployment } = await admit(sol, stageName, releaseId, { kind });
    const row = await solutionStageStore.claimDeployment(deployment.id, 'doomed-worker', 120_000);
    const stage = await solutionStageStore.getStage(row.stageProjectId);
    const prepared = await prepare({ deployment: row, stage, plan: row.plan }, DEPS);
    return { row, stage, prepared };
}
const createdIn = async (deploymentId, ref) => (await solutionStageStore.listSteps(deploymentId, { phase: 'prepare' }))
    .find(st => st.action === 'create' && st.ref === ref)?.entityId || null;

test('a worker dies after prepare: compensated, the stage as it was; a live run meanwhile saw the old settings', async () => {
    const sol = await solution('Crash after prepare');
    const r1 = await release(sol.dev, R1_ENTITIES());
    assert.strictEqual((await deploy(sol, 'uat', r1.id)).status, 'succeeded');
    const r2 = await release(sol.dev, R2_ENTITIES());
    const { row, stage } = await claimAndPrepare(sol, 'uat', r2.id);

    const a1 = await automationIn(stage.projectId, 'aut_1');
    assert.strictEqual(a1.definition.steps[0].text, 'v2', 'the working copy is the incoming release');
    assert.strictEqual(a1.liveDefinition.steps[0].text, 'v1', 'the live copy is not');
    const forRun = definitionForRun(a1, { mode: 'live', managed: true });
    assert.deepStrictEqual(forRun.definition.notificationSettings, NOTIFY_OLD, 'a live run reads the live settings (D17)');
    const aut3 = await createdIn(row.id, 'aut_3');
    assert.ok(await automationStore.getAutomation(aut3), 'the new part exists, never live');

    await expireLease(row.id);
    await runner.resumeStale();
    const failed = await solutionStageStore.getDeployment(row.id);
    assert.deepStrictEqual([failed.status, failed.error.code], ['failed', 'worker_lost']);
    assert.strictEqual(await automationStore.getAutomation(aut3), null, 'the part this deployment created is gone');
    const reset = await automationIn(stage.projectId, 'aut_1');
    assert.strictEqual(reset.definition.steps[0].text, 'v1', 'the working copy is back to live');
    assert.strictEqual((await stageOf(sol, 'uat')).currentReleaseId, r1.id);
});

test('a worker dies in the middle of the commit: rolled back, then compensated', async () => {
    const sol = await solution('Crash mid commit');
    const r1 = await release(sol.dev, R1_ENTITIES());
    assert.strictEqual((await deploy(sol, 'uat', r1.id)).status, 'succeeded');
    const stampsBefore = await stampsOf((await stageOf(sol, 'uat')).projectId);
    const r2 = await release(sol.dev, R2_ENTITIES());
    const { row, stage, prepared } = await claimAndPrepare(sol, 'uat', r2.id);
    await solutionStageStore.transitionDeployment(row.id, ['preparing'], 'committing');
    const crash = new Error('the process died');
    await assert.rejects(commit({ deployment: row, stage, prepared }, { ...DEPS, beforeTables: async () => { throw crash; } }), /process died/);
    assert.strictEqual((await solutionStageStore.getDeployment(row.id)).status, 'committing', 'the commit never committed');
    assert.strictEqual((await stageOf(sol, 'uat')).currentReleaseId, r1.id);
    assert.strictEqual((await automationIn(stage.projectId, 'aut_1')).liveDefinition.steps[0].text, 'v1', 'the flip rolled back');
    assert.deepStrictEqual([...(await stampsOf(stage.projectId)).keys()], [...stampsBefore.keys()]);

    await expireLease(row.id);
    await runner.resumeStale();
    assert.strictEqual((await solutionStageStore.getDeployment(row.id)).status, 'failed');
    assert.strictEqual(await automationStore.getAutomation(await createdIn(row.id, 'aut_3')), null);
});

test('a worker dies after the commit: the next one converges', async () => {
    const sol = await solution('Crash after commit');
    const r1 = await release(sol.dev, R1_ENTITIES());
    assert.strictEqual((await deploy(sol, 'uat', r1.id)).status, 'succeeded');
    const r2 = await release(sol.dev, R2_ENTITIES());
    const { row, stage, prepared } = await claimAndPrepare(sol, 'uat', r2.id);
    await solutionStageStore.transitionDeployment(row.id, ['preparing'], 'committing');
    await commit({ deployment: row, stage, prepared }, DEPS);
    assert.strictEqual((await solutionStageStore.getDeployment(row.id)).status, 'converging');
    await expireLease(row.id);
    await runner.resumeStale();
    assert.strictEqual((await solutionStageStore.getDeployment(row.id)).status, 'succeeded');
    assert.strictEqual((await stageOf(sol, 'uat')).currentReleaseId, r2.id);
    assert.strictEqual((await automationIn(stage.projectId, 'aut_1')).liveDefinition.steps[0].text, 'v2');
});

test('a REDEPLOY that dies in committing is compensated, never converged', async () => {
    const sol = await solution('Crash redeploy');
    const r1 = await release(sol.dev, R1_ENTITIES());
    assert.strictEqual((await deploy(sol, 'uat', r1.id)).status, 'succeeded');
    const { row } = await claimAndPrepare(sol, 'uat', r1.id, 'redeploy');
    await solutionStageStore.transitionDeployment(row.id, ['preparing'], 'committing');
    // The stage pointer already equals the redeploy's target: only the row can say it never committed.
    assert.strictEqual((await stageOf(sol, 'uat')).currentReleaseId, row.releaseId);
    await expireLease(row.id);
    await runner.resumeStale();
    const out = await solutionStageStore.getDeployment(row.id);
    assert.deepStrictEqual([out.status, out.committedAt], ['failed', null]);
    const steps = await solutionStageStore.listSteps(row.id);
    assert.ok(!steps.some(st => st.phase === 'converge'));
});

// ── Concurrency and staleness ───────────────────────────────────────────────

test('a settings_version change between admission and commit is plan_stale', async () => {
    const sol = await solution('Settings moved');
    const r1 = await release(sol.dev, R1_ENTITIES());
    assert.strictEqual((await deploy(sol, 'uat', r1.id)).status, 'succeeded');
    const r2 = await release(sol.dev, R2_ENTITIES());
    const { deployment } = await admit(sol, 'uat', r2.id);
    const uat = await stageOf(sol, 'uat');
    await solutionStageStore.updateStageSettings(uat.projectId, uat.settingsVersion, { newPartsActive: false });
    const out = await runner.runOne(deployment.id);
    assert.deepStrictEqual([out.status, out.error.code], ['failed', 'plan_stale']);
    assert.strictEqual(await automationStore.getAutomation(await createdIn(deployment.id, 'aut_3')), null, 'compensated');
    assert.strictEqual((await stageOf(sol, 'uat')).currentReleaseId, r1.id);
});

test('two concurrent admissions: one stage_busy; an approval request next to a running redeploy is refused', async () => {
    const sol = await solution('Busy');
    const r1 = await release(sol.dev, R1_ENTITIES());
    // Both requests planned against the same free stage; the exclusive insert decides. (PGlite is one
    // session, so the two admissions run one after the other here; in Postgres the advisory lock orders them.)
    const uat = await stageOf(sol, 'uat');
    const p = await plan({ stageProjectId: uat.projectId, releaseId: r1.id, kind: 'deploy' }, DEPS);
    const request = (key) => runner.admit({ solutionId: sol.dev.id, stage: 'uat', releaseId: r1.id, kind: 'deploy', planHash: p.planHash,
        requestKey: key, acknowledgements: p.acknowledgementsRequired, actor: SO });
    const { deployment: queued } = await request(`busy_a_${keySeq}`);
    await assert.rejects(request(`busy_b_${keySeq}`), (err) => err.code === 'stage_busy' && err.details.deploymentId === queued.id);
    assert.strictEqual((await runner.runOne(queued.id)).status, 'succeeded');
    assert.strictEqual((await deploy(sol, 'prd', r1.id)).status, 'succeeded');

    const { deployment: redeploy } = await admit(sol, 'prd', r1.id, { kind: 'redeploy' });
    await solutionStageStore.claimDeployment(redeploy.id, 'busy-worker', 120_000);
    const prd = await stageOf(sol, 'prd');
    await solutionStageStore.updateStageSettings(prd.projectId, prd.settingsVersion,
        { requiresApproval: true, approvalPolicy: { stages: [{ key: 's1', name: 'Release', approvers: [{ userId: 'reviewer' }] }] } });
    await assert.rejects(admit(sol, 'prd', r1.id, { kind: 'redeploy' }), { code: 'stage_busy' });
});

test('an unrelated org table edit made during the deployment is kept', async () => {
    const sol = await solution('Unrelated edit');
    const r1 = await release(sol.dev, { datatables: [table('dt_1', 'stock', [LABEL])] });
    assert.strictEqual((await deploy(sol, 'uat', r1.id)).status, 'succeeded');
    const mine = await datatableStore.createDatatable({ scope: SCOPE, ownerUserId: SO, key: `mine_${Date.now()}`, name: 'Mine', fields: [NOTE] });

    const r2 = await release(sol.dev, { datatables: [table('dt_1', 'stock', [LABEL, AMOUNT])] });
    const { row, stage, prepared } = await claimAndPrepare(sol, 'uat', r2.id);
    // Somebody edits their own org table after the deployment read the model.
    const { model } = await datatableStore.getModel(SCOPE);
    const next = JSON.parse(JSON.stringify(model));
    next.tables.find(t => t.id === mine.id).fields.push({ id: 'fld_theirs1', key: 'theirs', name: 'Theirs', type: 'text' });
    assert.strictEqual((await datatableStore.saveModel(SCOPE, next)).ok, true);

    await solutionStageStore.transitionDeployment(row.id, ['preparing'], 'committing');
    await commit({ deployment: row, stage, prepared }, DEPS);
    const after = await datatableStore.getModel(SCOPE);
    const tableId = (await stampsOf(stage.projectId)).get('dt_1').entityId;
    assert.deepStrictEqual(after.model.tables.find(t => t.id === mine.id).fields.map(f => f.key), ['note', 'theirs']);
    assert.deepStrictEqual(after.model.tables.find(t => t.id === tableId).fields.map(f => f.key), ['label', 'amount']);
});

// ── On/off, reference rows, retired columns ─────────────────────────────────

test('an automation switched off and on by its operator keeps that state across deploys', async () => {
    const sol = await solution('Toggle');
    const r1 = await release(sol.dev, R1_ENTITIES());
    assert.strictEqual((await deploy(sol, 'uat', r1.id)).status, 'succeeded');
    const uat = await stageOf(sol, 'uat');
    await goLive.deactivateCore({ automation: await automationIn(uat.projectId, 'aut_1'), actorId: SO, deps: goLiveDeps });
    assert.strictEqual((await deploy(sol, 'uat', r1.id, { kind: 'redeploy' })).status, 'succeeded');
    assert.strictEqual((await automationIn(uat.projectId, 'aut_1')).isActive, false, 'a redeploy does not switch it back on');

    const on = await goLive.activateCore({ automation: await automationIn(uat.projectId, 'aut_1'), actorId: SO, organizationId: ORG, deps: goLiveDeps });
    assert.strictEqual(on.ok, true, JSON.stringify(on));
    const r2 = await release(sol.dev, R2_ENTITIES());
    assert.strictEqual((await deploy(sol, 'uat', r2.id)).status, 'succeeded');
    const a1 = await automationIn(uat.projectId, 'aut_1');
    assert.strictEqual(a1.isActive, true, 'and a deploy does not switch it off');
    assert.strictEqual(a1.liveDefinition.steps[0].text, 'v2');
});

test('reference rows arrive with the deploy, and a row write afterwards is refused', async () => {
    const sol = await solution('Reference rows');
    const rows = [{ id: 'r1', values: { fld_label01: 'A', fld_amount1: 1 } }, { id: 'r2', values: { fld_label01: 'B', fld_amount1: 2 } }];
    const r1 = await release(sol.dev, { datatables: [table('dt_1', 'rates', [LABEL, AMOUNT])] }, { payloads: [refRows('dt_1', rows)] });
    assert.strictEqual((await deploy(sol, 'uat', r1.id)).status, 'succeeded');
    const tableId = (await stampsOf((await stageOf(sol, 'uat')).projectId)).get('dt_1').entityId;
    const meta = await datatableStore.getTableMeta(SCOPE, tableId);
    assert.strictEqual(meta.rowsLocked, true);
    const physical = await pg.query(`SELECT id, label FROM "${datatableDbStore.schemaNameFor('org', ORG)}"."${meta.key}" ORDER BY id`);
    assert.deepStrictEqual(physical.rows.map(r => [r.id, r.label]), [['r1', 'A'], ['r2', 'B']]);
    assert.throws(() => queryCompiler.compileInsert(meta, { label: 'C' }, { dialect: 'pg' }), (err) => err.status === 409 && /managed_part/.test(err.code || err.errorClass));
    assert.strictEqual((await datatableStore.getDatatable(tableId, SCOPE)).isReference, true);
});

test('a retired required column lets inserts succeed and keeps its data', async () => {
    const sol = await solution('Retire');
    const r1 = await release(sol.dev, { datatables: [table('dt_2', 'orders', [LABEL, NOTE])] });
    assert.strictEqual((await deploy(sol, 'uat', r1.id)).status, 'succeeded');
    const tableId = (await stampsOf((await stageOf(sol, 'uat')).projectId)).get('dt_2').entityId;
    const key = (await datatableStore.getTableMeta(SCOPE, tableId)).key;
    const schema = datatableDbStore.schemaNameFor('org', ORG);
    await pg.query(`INSERT INTO "${schema}"."${key}" (id, label, note) VALUES ('o1', 'kept', 'n')`);
    await assert.rejects(pg.query(`INSERT INTO "${schema}"."${key}" (id, note) VALUES ('o0', 'n')`), /null value/);

    const r2 = await release(sol.dev, { datatables: [table('dt_2', 'orders', [NOTE])] });
    assert.strictEqual((await deploy(sol, 'uat', r2.id)).status, 'succeeded');
    await pg.query(`INSERT INTO "${schema}"."${key}" (id, note) VALUES ('o2', 'without a label')`);
    const meta = await datatableStore.getTableMeta(SCOPE, tableId);
    assert.deepStrictEqual(meta.fields.map(f => f.key), ['note']);
    const retired = meta.retired_fields.find(r => r.id === LABEL.id);
    assert.strictEqual(retired.notNull, true, 'the relaxed constraint is recorded for an unretire');
    const kept = await pg.query(`SELECT "${retired.key}" AS label FROM "${schema}"."${key}" WHERE id = 'o1'`);
    assert.strictEqual(kept.rows[0].label, 'kept');
});

// ── Settings, removal, expiry ───────────────────────────────────────────────

const GATE = { requiresApproval: true, approvalPolicy: { stages: [{ key: 's1', name: 'Release', approvers: [{ userId: 'reviewer' }] }] } };

test('a settings deployment changes the PRD gate only after approval', async () => {
    const sol = await solution('Gate change');
    const prd = await stageOf(sol, 'prd');
    await solutionStageStore.updateStageSettings(prd.projectId, prd.settingsVersion, GATE);
    const { deployment } = await admit(sol, 'prd', null, { kind: 'settings', settingsPatch: { requiresApproval: false } });
    assert.strictEqual(deployment.status, 'awaiting_approval');
    assert.strictEqual((await stageOf(sol, 'prd')).requiresApproval, true, 'not before the decision');
    await approve(deployment.id);
    assert.strictEqual((await runner.runOne(deployment.id)).status, 'succeeded');
    assert.strictEqual((await stageOf(sol, 'prd')).requiresApproval, false);
});

test('an expired approval releases the open slot', async () => {
    const sol = await solution('Expiry');
    const r1 = await release(sol.dev, R1_ENTITIES());
    assert.strictEqual((await deploy(sol, 'uat', r1.id)).status, 'succeeded');
    const prd = await stageOf(sol, 'prd');
    await solutionStageStore.updateStageSettings(prd.projectId, prd.settingsVersion, GATE);
    const { deployment } = await admit(sol, 'prd', r1.id);
    await assert.rejects(admit(sol, 'prd', r1.id), { code: 'approval_pending' });
    const { approvalId } = await solutionStageStore.getDeployment(deployment.id);
    await pg.query(`UPDATE automation_approvals SET status = 'expired' WHERE id = $1`, [approvalId]);
    const out = await runner.reconcile();
    assert.strictEqual(out.applied, 1);
    assert.strictEqual((await solutionStageStore.getDeployment(deployment.id)).status, 'cancelled');
    const next = await admit(sol, 'prd', r1.id);
    assert.strictEqual(next.deployment.status, 'awaiting_approval');
});

test('removeStage tears the stage down, and the stage can be created again', async () => {
    const sol = await solution('Removal');
    const r1 = await release(sol.dev, { ...R1_ENTITIES(), datatables: [table('dt_1', 'bye', [LABEL])] });
    assert.strictEqual((await deploy(sol, 'uat', r1.id)).status, 'succeeded');
    const uat = await stageOf(sol, 'uat');
    const stamps = await stampsOf(uat.projectId);
    const out = await deploy(sol, 'uat', null, { kind: 'remove', settingsPatch: { deleteData: true } });
    assert.strictEqual(out.status, 'succeeded', JSON.stringify(out.error || out.report));
    assert.strictEqual(await stageOf(sol, 'uat'), null);
    assert.strictEqual(await projectStore.getProject(uat.projectId), null, 'the stage project is gone');
    assert.strictEqual(await automationStore.getAutomation(stamps.get('aut_1').entityId), null);
    assert.strictEqual(await datatableStore.getTableMeta(SCOPE, stamps.get('dt_1').entityId), null, 'its table went with deleteData');
    assert.strictEqual((await stampsOf(uat.projectId)).size, 0);

    const [again] = await solutionStageStore.createStages({ devProject: sol.dev, stages: ['uat'], actorId: SO });
    assert.strictEqual(again.created, true);
    assert.notStrictEqual(again.projectId, uat.projectId);
});

test('a retried POST with the same request key gets the existing deployment, after it ran and the real plan moved on', async () => {
    const sol = await solution('Replay');
    const r1 = await release(sol.dev, R1_ENTITIES());
    const first = await admit(sol, 'uat', r1.id, { requestKey: `replay_${Date.now()}` });
    assert.strictEqual((await runner.runOne(first.deployment.id)).status, 'succeeded');
    const uat = await stageOf(sol, 'uat');
    const moved = await plan({ stageProjectId: uat.projectId, releaseId: r1.id, kind: 'deploy' }, DEPS);
    assert.notStrictEqual(moved.planHash, first.deployment.planHash, 'the plan changed once the release was deployed');
    const again = await runner.admit({ solutionId: sol.dev.id, stage: 'uat', releaseId: r1.id, kind: 'deploy',
        planHash: first.deployment.planHash, requestKey: first.deployment.requestKey, acknowledgements: [], actor: SO });
    assert.strictEqual(again.replayed, true);
    assert.strictEqual(again.deployment.id, first.deployment.id);
});

test('the stagePayload round trip equals install_hash for every kind', async () => {
    const { emptyDefinition } = require('../../appStudio/componentSpecs');
    const sol = await solution('Every kind');
    const r1 = await release(sol.dev, {
        automations: [automation('aut_1', 'v1'),
            { ref: 'aut_b', kind: 'block', title: 'A block', description: '', definition: { trigger: { kind: 'manual', id: 't' }, steps: [{ id: 'b1', type: 'note', text: 'b' }] } }],
        datatables: [table('dt_1', 'kinds', [LABEL])],
        // Entities as a pipeline capture reads them from Dev's stores, the stores' own defaults included.
        knowledgeBases: [{ ref: 'kb_1', name: 'Handbook', description: 'Policies', icon: null, usageContexts: ['agent', 'direct_chat'] }],
        documents: [{ ref: 'doc_1', name: 'Invoice', kind: 'template', doc_type: 'document', description: '', body_html: '<p>Dear {{name}}</p>', css: '', settings: {} }],
        skills: [{ ref: 'skl_1', name: 'Tone', description: 'How we write', instructions: 'Be kind', icon: '⚡', knowledge_base_ids: [{ $ref: 'kb_1' }] }],
        agents: [{ ref: 'agt_1', name: 'Helper', description: '', systemPrompt: 'Help people', model: null, starterPrompts: [],
            threadsEnabled: true, copyEnabled: true, workspaceEnabled: false,
            config: { knowledge_base_ids: [{ $ref: 'kb_1' }], attachedSkillIds: [{ $ref: 'skl_1' }] },
            persona: { mode: 'free', freeText: 'Help people', who: '', does: [], doesNot: [], language: null,
                tone: { chips: [], text: '' }, unknown: { automationId: null, mode: 'honest' } } }],
        webpages: [{ ref: 'web_1', name: 'Portal', description: '', instructions: '', files: { html: '<p>Portal</p>', css: 'p{}', js: '' },
            bridgeGrants: { automations: [{ automationId: { $ref: 'aut_1' } }], tables: [{ datatableId: { $ref: 'dt_1' }, mode: 'read', columns: [] }] },
            knowledgeBaseIds: [{ $ref: 'kb_1' }] }],
        apps: [{ ref: 'app_1', name: 'Desk', description: '', icon: null, accentColor: emptyDefinition('Desk').theme.primary, definition: emptyDefinition('Desk') }],
    });
    const out = await deploy(sol, 'uat', r1.id);
    assert.strictEqual(out.status, 'succeeded', JSON.stringify(out.error || out.report));
    const uat = await stageOf(sol, 'uat');
    const stamps = await stampsOf(uat.projectId);
    assert.deepStrictEqual([...new Set([...stamps.values()].map(st => st.kind))].sort(),
        ['agent', 'app', 'automation', 'datatable', 'document', 'knowledge_base', 'skill', 'webpage']);
    for (const st of stamps.values()) {
        assert.strictEqual(hashPayload(await readStagePayload(st.kind, st.entityId)), st.installHash, `${st.kind} ${st.ref}`);
    }
    const again = await plan({ stageProjectId: uat.projectId, releaseId: r1.id, kind: 'redeploy' }, DEPS);
    assert.deepStrictEqual(again.parts.filter(p => p.action !== 'unchanged').map(p => [p.ref, p.action]), []);
});

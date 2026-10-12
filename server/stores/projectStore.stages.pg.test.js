/**
 * Solution stages on the projects table (design 1.1 A, D5), against a real
 * Postgres (@electric-sql/pglite): the store's own applyProjectSchema and
 * makeProjectStore, with the managed-write guard built over the same database
 * (makeManagedParts), so nothing is mocked.
 *
 * Pinned:
 *   - the schema applies twice; the pair CHECK refuses half a stage, a stage
 *     that is not a Solution and a third kind of stage; one UAT per Solution;
 *   - the 'solution' listing hides stage rows, the access path (no kind) keeps
 *     them, so a stage member still reaches what is published to the stage;
 *     `onlyStages` lists just the stage rows;
 *   - updateProject refuses a knowledgeBaseIds change on a stage (409
 *     managed_part) unless a deployment's capability is passed, and never
 *     writes stage / stage_of;
 *   - setProjectKind and handOverProject refuse a stage and a Dev with stages;
 *   - a detach through one store instance is seen by a second one on the
 *     refusal path, although its cache still says "stage".
 *
 * Run: cd server && node --test stores/projectStore.stages.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const { makeProjectStore, applyProjectSchema } = require('./projectStore');
const { makeSolutionStageStore, applySolutionStageSchema } = require('./solutionStageStore');
const { makeManagedParts } = require('./lib/managedParts');
const { pgliteDb } = require('../testUtils/pgliteDb');

/** The slice of db.js projectStore uses, over one PGlite connection. */
function facadeFor(pg) {
    const { db } = pgliteDb(pg);
    return {
        run: db.query,
        getOne: async (sql, params) => (await db.query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await db.query(sql, params)).rows,
        getClient: async () => ({ query: db.query, release() {} }),
    };
}

const runDdl = (pg) => async (_tag, statements) => {
    for (const stmt of statements) await pg.exec(typeof stmt === 'string' ? stmt : stmt.sql);
};

async function applySchema(pg) {
    await applyProjectSchema({ exec: (sql) => pg.exec(sql), runDdl: runDdl(pg) });
    await applySolutionStageSchema({ runDdl: runDdl(pg) });
}

/** A project store with its own cache and its own guard, as one replica has. */
function replica(pg) {
    let store = null;
    const stages = makeSolutionStageStore(pgliteDb(pg).db, { projectStore: { createStageProject: (...a) => store.createStageProject(...a), detachStage: (...a) => store.detachStage(...a) } });
    const managedParts = makeManagedParts({
        stageOfProject: (id) => store.stageOfProject(id),
        stageOfProjectFresh: (id) => store.stageOfProjectFresh(id),
        isActiveDeployment: (d, p, c) => stages.isActiveDeployment(d, p, c),
    });
    store = makeProjectStore(facadeFor(pg), { managedParts });
    return { store, stages };
}

let pg;
let A;
let B;
let dev;
let uat;

before(async () => {
    pg = new PGlite();
    await applySchema(pg);
    A = replica(pg);
    B = replica(pg);
    dev = await A.store.createProject({ name: 'Invoices', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    uat = await A.store.createStageProject(null, { devProject: dev, stage: 'uat', ownerId: 'alice' });
    await A.store.shareProject(uat.id, 'user', 'bob', 'editor');
});

after(async () => { await pg.close(); });

// ── Schema ───────────────────────────────────────────────────────────

test('the schema applies a second time, and the pair check is there once', async () => {
    await applySchema(pg);
    const cols = await pg.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name IN ('stage', 'stage_of') ORDER BY column_name`,
    );
    assert.deepStrictEqual(cols.rows.map((r) => r.column_name), ['stage', 'stage_of']);
    const chk = await pg.query(`SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'projects_stage_pair_chk'`);
    assert.strictEqual(chk.rows[0].n, 1);
});

test('the database refuses half a stage, a workspace stage and a third stage kind', async () => {
    const insert = (id, kind, stage, stageOf) => pg.query(
        'INSERT INTO projects (id, name, owner_id, kind, stage, stage_of) VALUES ($1, $1, $2, $3, $4, $5)',
        [id, 'alice', kind, stage, stageOf],
    );
    await assert.rejects(insert('x1', 'solution', 'uat', null), (e) => e.code === '23514');
    await assert.rejects(insert('x2', 'solution', null, dev.id), (e) => e.code === '23514');
    await assert.rejects(insert('x3', 'workspace', 'uat', dev.id), (e) => e.code === '23514');
    await assert.rejects(insert('x4', 'solution', 'dev', dev.id), (e) => e.code === '23514');
    // One UAT per Solution.
    await assert.rejects(insert('x5', 'solution', 'uat', dev.id), (e) => e.code === '23505');
});

test('a stage project is a Solution named after its Dev, in the same organisation', async () => {
    const got = await A.store.getProject(uat.id);
    assert.strictEqual(got.name, 'Invoices (UAT)');
    assert.strictEqual(got.kind, 'solution');
    assert.strictEqual(got.organizationId, 'org1');
    assert.strictEqual(got.stage, 'uat');
    assert.strictEqual(got.stageOf, dev.id);
    assert.strictEqual((await A.store.getProject(dev.id)).stage, null);
    assert.deepStrictEqual(await A.store.stageOfProject(uat.id), { solutionId: dev.id, stage: 'uat', projectId: uat.id });
    assert.strictEqual(await A.store.stageOfProject(dev.id), null);
    assert.strictEqual(await A.store.stageOfProject('no-such-project'), null);
});

// ── Listings ─────────────────────────────────────────────────────────

test("the 'solution' listing hides stages; without a kind they stay (the access path)", async () => {
    const solutions = await A.store.listUserProjects('alice', [], { kind: 'solution' });
    assert.deepStrictEqual(solutions.map((p) => p.id), [dev.id]);
    const all = await A.store.listUserProjects('alice', []);
    assert.ok(all.some((p) => p.id === uat.id), 'the owner still reaches the stage');
    // A stage member who is no Dev member: no Solution in the listing, but
    // the stage on the access path (apps published to the stage stay readable).
    assert.deepStrictEqual(await A.store.listUserProjects('bob', [], { kind: 'solution' }), []);
    assert.deepStrictEqual((await A.store.listUserProjects('bob', [])).map((p) => p.id), [uat.id]);
    // Workspaces never held stages.
    assert.deepStrictEqual(await A.store.listUserProjects('bob', [], { kind: 'workspace' }), []);
});

test('onlyStages lists just the stage rows a user can reach', async () => {
    assert.deepStrictEqual((await A.store.listUserProjects('bob', [], { kind: 'solution', onlyStages: true })).map((p) => p.id), [uat.id]);
    assert.deepStrictEqual((await A.store.listUserProjects('alice', [], { kind: 'solution', onlyStages: true })).map((p) => p.id), [uat.id]);
    assert.deepStrictEqual(await A.store.listUserProjects('carol', [], { kind: 'solution', onlyStages: true }), []);
    await assert.rejects(A.store.listUserProjects('bob', [], { onlyStages: true }), TypeError);
});

// ── updateProject ────────────────────────────────────────────────────

test('updateProject refuses a knowledgeBaseIds change on a stage with 409 managed_part', async () => {
    await assert.rejects(A.store.updateProject(uat.id, { knowledgeBaseIds: ['kb1'] }), (err) => {
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.code, 'managed_part');
        assert.strictEqual(err.errorClass, 'managed_part');
        assert.strictEqual(err.expose, true);
        assert.deepStrictEqual(err.details, { solutionId: dev.id, stage: 'uat' });
        return true;
    });
    assert.deepStrictEqual((await A.store.getProject(uat.id)).knowledgeBaseIds, []);
    // The same array (the settings form PUTs the whole form) is no change.
    const same = await A.store.updateProject(uat.id, { knowledgeBaseIds: [], description: 'Acceptance' });
    assert.strictEqual(same.description, 'Acceptance');
    // On Dev it is an ordinary setting.
    assert.deepStrictEqual((await A.store.updateProject(dev.id, { knowledgeBaseIds: ['kb1'] })).knowledgeBaseIds, ['kb1']);
});

test("updateProject takes knowledgeBaseIds on a stage with an active deployment's capability, never another's", async () => {
    const other = await A.store.createProject({ name: 'Other', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    const otherUat = await A.store.createStageProject(null, { devProject: other, stage: 'uat', ownerId: 'alice' });
    const insertDep = (id, stageProjectId, status) => pg.query(
        `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status, plan, plan_hash,
                                           stage_settings_version, request_key, requested_by)
         VALUES ($1, 's', $2, 'uat', 'rel_1', 'deploy', $3, '{}'::jsonb, 'h', 1, $1, 'alice')`,
        [id, stageProjectId, status],
    );
    await insertDep('dep_other', otherUat.id, 'committing');
    await insertDep('dep_done', uat.id, 'succeeded');
    // Another stage's deployment, or a finished one, is no capability here.
    await assert.rejects(A.store.updateProject(uat.id, { knowledgeBaseIds: ['kb2'] }, { managedWrite: { deploymentId: 'dep_other' } }),
        (e) => e.code === 'managed_part');
    await assert.rejects(A.store.updateProject(uat.id, { knowledgeBaseIds: ['kb2'] }, { managedWrite: { deploymentId: 'dep_done' } }),
        (e) => e.code === 'managed_part');
    await insertDep('dep_live', uat.id, 'committing');
    const ok = await A.store.updateProject(uat.id, { knowledgeBaseIds: ['kb2'] }, { managedWrite: { deploymentId: 'dep_live' } });
    assert.deepStrictEqual(ok.knowledgeBaseIds, ['kb2']);
    await pg.query(`UPDATE solution_deployments SET status = 'succeeded' WHERE id IN ('dep_live', 'dep_other')`);
});

test('updateProject never writes stage or stage_of', async () => {
    const got = await A.store.updateProject(uat.id, { stage: null, stageOf: null, stage_of: null, name: 'Invoices (UAT)' });
    assert.strictEqual(got.stage, 'uat');
    assert.strictEqual(got.stageOf, dev.id);
});

// ── Kind and hand-over ───────────────────────────────────────────────

test('setProjectKind refuses a stage and a Dev with stages', async () => {
    await pg.query('UPDATE projects SET kind_guessed = TRUE WHERE id IN ($1, $2)', [dev.id, uat.id]);
    await assert.rejects(A.store.setProjectKind(uat.id, 'workspace'), (e) => e.status === 409 && e.code === 'stage_project');
    await assert.rejects(A.store.setProjectKind(dev.id, 'workspace'), (e) => e.status === 409 && e.code === 'solution_has_stages');
    const rows = await pg.query('SELECT kind FROM projects WHERE id IN ($1, $2)', [dev.id, uat.id]);
    assert.ok(rows.rows.every((r) => r.kind === 'solution'));
    await pg.query('UPDATE projects SET kind_guessed = FALSE WHERE id IN ($1, $2)', [dev.id, uat.id]);
});

test('handOverProject refuses a stage and a Dev with stages', async () => {
    await A.store.shareProject(dev.id, 'user', 'dave', 'editor');
    await assert.rejects(A.store.handOverProject(uat.id, 'alice'), (e) => e.status === 409 && e.code === 'stage_project');
    await assert.rejects(A.store.handOverProject(dev.id, 'alice'), (e) => e.status === 409 && e.code === 'solution_has_stages');
    assert.strictEqual((await A.store.getProject(dev.id)).ownerId, 'alice');
    // A plain project still changes hands.
    const plain = await A.store.createProject({ name: 'Plain', ownerId: 'alice' });
    await A.store.shareProject(plain.id, 'user', 'dave', 'editor');
    assert.strictEqual(await A.store.handOverProject(plain.id, 'alice'), 'dave');
});

test('setInstalledVersion records a positive version and clears anything else', async () => {
    assert.strictEqual(await A.store.setInstalledVersion(dev.id, 3), true);
    assert.strictEqual((await A.store.getProject(dev.id)).installedVersion, 3);
    await A.store.setInstalledVersion(dev.id, 0);
    assert.strictEqual((await A.store.getProject(dev.id)).installedVersion, null);
    assert.strictEqual(await A.store.setInstalledVersion('no-such-project', 2), false);
});

// ── Detach across replicas ───────────────────────────────────────────

test('a detach on one replica is seen by another on the refusal path', async () => {
    // Replica B has the stage cached as a stage.
    assert.ok(await B.store.stageOfProject(uat.id));
    assert.strictEqual(await A.store.detachStage(uat.id, { actorId: 'alice' }), true);
    // B's cache still says stage (positive answers live 10 s) ...
    assert.ok(await B.store.stageOfProject(uat.id));
    // ... but a write it would refuse re-reads first, and goes through.
    const got = await B.store.updateProject(uat.id, { knowledgeBaseIds: ['kb3'] });
    assert.deepStrictEqual(got.knowledgeBaseIds, ['kb3']);
    assert.strictEqual(await B.store.stageOfProjectFresh(uat.id), null);
    // The refusal path's re-read refreshed B's cache too.
    assert.strictEqual(await B.store.stageOfProject(uat.id), null);
    const row = await A.store.getProject(uat.id);
    assert.strictEqual(row.stage, null);
    assert.strictEqual(row.stageOf, null);
    const act = await pg.query(`SELECT actor_id, details FROM project_activity WHERE project_id = $1 AND action = 'stage_detached'`, [uat.id]);
    assert.strictEqual(act.rows.length, 1);
    assert.deepStrictEqual(act.rows[0].details, { stage: 'uat', solutionId: dev.id });
    // Detaching twice is a no-op, and the stage can be created again.
    assert.strictEqual(await A.store.detachStage(uat.id), false);
    const again = await A.store.createStageProject(null, { devProject: dev, stage: 'uat', ownerId: 'alice' });
    assert.strictEqual((await B.store.stageOfProject(again.id)).stage, 'uat');
});

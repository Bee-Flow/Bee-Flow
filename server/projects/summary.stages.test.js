/**
 * The stages in the Solutions overview (projects/summary.js): per Solution
 * `stages`, and the top-level `operatedStages` for a stage-only operator.
 *
 *   - stagesForSolutions runs its one query against a REAL Postgres (pglite)
 *     with the stage store's own schema: UAT first, the latest deployment's
 *     status, `pending` while a deployment runs or waits for an approval, no
 *     entry for a Solution without stages, and nothing outside the ids it is
 *     handed;
 *   - summarizeProjects attaches them, says `stages: null` and names the gap
 *     when the read fails (null is not "no stages"), and leaves the key out
 *     when the caller did not ask;
 *   - operatedStagesOf lists the stage rows whose Dev the person cannot see,
 *     named after the stage, and nothing else.
 *
 * The other tallies of summarizeProjects are served by plain doubles through
 * its `io` option, so no store (and no database) outside pglite is touched.
 *
 * Run: cd server && node --test projects/summary.stages.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const { makeProjectStore, applyProjectSchema } = require('../stores/projectStore');
const { makeSolutionStageStore, applySolutionStageSchema } = require('../stores/solutionStageStore');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { summarizeProjects, stagesForSolutions, operatedStagesOf } = require('./summary');

const runDdl = (pg) => async (_tag, statements) => {
    for (const stmt of statements) await pg.exec(typeof stmt === 'string' ? stmt : stmt.sql);
};
const facadeFor = (db) => ({
    run: db.query,
    getOne: async (sql, params) => (await db.query(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await db.query(sql, params)).rows,
    getClient: async () => ({ query: db.query, release() {} }),
});

let pg;
let projects;
let store;
let dev;
let lone;
let other;
let uat;
let prd;
const query = (sql, params) => pg.query(sql, params);
// The tallies that are not the subject here: empty answers.
const io = {
    countMembers: async () => ({ bySection: new Map(), failed: [] }),
    runCounts: async () => new Map(),
    blueprints: async () => [],
    installedVersions: async () => new Map(),
};

const admit = (stage, key, status = 'queued') => store.insertDeployment({
    solutionId: stage.solutionId, stageProjectId: stage.projectId, stage: stage.stage, releaseId: 'r', releaseSeq: 1, kind: 'deploy',
    status, plan: {}, planHash: 'h', stageSettingsVersion: 1, requestKey: key, requestedBy: 'alice',
});
const settle = (id, status) => pg.query(`UPDATE solution_deployments SET status = $2, finished_at = NOW() WHERE id = $1`, [id, status]);

before(async () => {
    pg = new PGlite();
    await applyProjectSchema({ exec: (sql) => pg.exec(sql), runDdl: runDdl(pg) });
    await applySolutionStageSchema({ runDdl: runDdl(pg) });
    const { db } = pgliteDb(pg);
    projects = makeProjectStore(facadeFor(db));
    store = makeSolutionStageStore(db, { projectStore: projects });
    dev = await projects.createProject({ name: 'Invoices', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    lone = await projects.createProject({ name: 'Plain', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    other = await projects.createProject({ name: 'Elsewhere', ownerId: 'bob', organizationId: 'org1', kind: 'solution' });
    [uat, prd] = await store.createStages({ devProject: dev, stages: ['prd', 'uat'], actorId: 'alice' });
    await store.createStages({ devProject: other, stages: ['uat'], actorId: 'bob' });
});
after(async () => { await pg.close(); });

test('stagesForSolutions: UAT first, the latest deployment\'s status, pending while one is running or waiting', async () => {
    const empty = await stagesForSolutions([dev.id], { query });
    assert.deepStrictEqual(empty.get(dev.id), [
        { stage: 'uat', projectId: uat.projectId, currentReleaseSeq: null, lastDeploymentStatus: null, pending: false },
        { stage: 'prd', projectId: prd.projectId, currentReleaseSeq: null, lastDeploymentStatus: null, pending: false },
    ]);

    const first = await admit(uat, 'k1');
    await settle(first.id, 'succeeded');
    await store.setCurrentRelease(null, { stageProjectId: uat.projectId, releaseId: 'r', releaseSeq: 4 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const waiting = await admit(prd, 'k2', 'awaiting_approval');
    const got = (await stagesForSolutions([dev.id], { query })).get(dev.id);
    assert.deepStrictEqual(got.map(s => [s.stage, s.currentReleaseSeq, s.lastDeploymentStatus, s.pending]), [
        ['uat', 4, 'succeeded', false], ['prd', null, 'awaiting_approval', true],
    ]);
    await store.closeAwaiting(waiting.id, 'alice');
    const running = await admit(uat, 'k3');
    assert.strictEqual((await stagesForSolutions([dev.id], { query })).get(dev.id)[0].pending, true, 'a queued row holds the stage');
    await settle(running.id, 'failed');
    const after = (await stagesForSolutions([dev.id], { query })).get(dev.id);
    assert.deepStrictEqual(after.map(s => [s.lastDeploymentStatus, s.pending]), [['failed', false], ['cancelled', false]]);
});

test('stagesForSolutions: a Solution without stages has no entry, and only the ids it is handed are read', async () => {
    const map = await stagesForSolutions([lone.id, dev.id], { query });
    assert.strictEqual(map.has(lone.id), false);
    assert.strictEqual(map.has(other.id), false, 'a Solution nobody asked about stays out');
    assert.deepStrictEqual([...(await stagesForSolutions([], { query })).keys()], []);
    assert.deepStrictEqual([...(await stagesForSolutions([null, 5, ''], { query })).keys()], []);
});

test('summarizeProjects puts the stages on the card, in the order of the rows', async () => {
    const rows = [
        { id: dev.id, name: 'Invoices', ownerId: 'alice', permission: 'owner', knowledgeBaseIds: [] },
        { id: lone.id, name: 'Plain', ownerId: 'alice', permission: 'owner', knowledgeBaseIds: [] },
    ];
    const asked = [];
    const out = await summarizeProjects(rows, { io, stagesFor: async (ids) => { asked.push(ids); return stagesForSolutions(ids, { query }); } });
    assert.deepStrictEqual(asked, [[dev.id, lone.id]], 'exactly the authorised ids');
    const byId = Object.fromEntries(out.projects.map(p => [p.id, p]));
    assert.deepStrictEqual(byId[dev.id].stages.map(s => s.stage), ['uat', 'prd']);
    assert.deepStrictEqual(byId[lone.id].stages, [], 'a Solution without stages: an empty list, not null');
    assert.ok(!byId[dev.id].unavailable.includes('stages'));
    assert.ok(!out.unavailable.includes('stages'));
});

test('a failed stage read is null and named, per card and for the screen; no stagesFor leaves the key out', async () => {
    const rows = [{ id: dev.id, name: 'Invoices', ownerId: 'alice', permission: 'owner', knowledgeBaseIds: [] }];
    const failed = await summarizeProjects(rows, { io, stagesFor: async () => { throw new Error('solution_stages is down'); } });
    assert.strictEqual(failed.projects[0].stages, null);
    assert.ok(failed.projects[0].unavailable.includes('stages'));
    assert.ok(failed.unavailable.includes('stages'));
    assert.strictEqual(failed.projects[0].complete, false);

    const silent = await summarizeProjects(rows, { io });
    assert.ok(!('stages' in silent.projects[0]));
    assert.ok(!silent.projects[0].unavailable.includes('stages'));
});

test('operatedStagesOf: stage rows whose Dev the person cannot see, named after the stage', () => {
    const list = [
        { id: 's1', name: 'Invoices (UAT)', stage: 'uat', stageOf: 'devA', permission: 'editor' },
        { id: 's2', name: 'Invoices (Production)', stage: 'prd', stageOf: 'devA', permission: 'viewer' },
        { id: 's3', name: 'Mine (UAT)', stage: 'uat', stageOf: 'devMine', permission: 'owner' },
        { id: 'plain', name: 'Not a stage', stage: null, stageOf: null },
        { id: 'broken', name: 'x', stage: 'qa', stageOf: 'devA' },
        null,
    ];
    assert.deepStrictEqual(operatedStagesOf(list, new Set(['devMine'])), [
        { solutionId: 'devA', solutionName: 'Invoices', stage: 'uat', projectId: 's1', role: 'editor' },
        { solutionId: 'devA', solutionName: 'Invoices', stage: 'prd', projectId: 's2', role: 'viewer' },
    ]);
    assert.deepStrictEqual(operatedStagesOf(list, ['devA', 'devMine']), [], 'the Dev is visible: the card carries the stages');
    assert.deepStrictEqual(operatedStagesOf(undefined, []), []);
    assert.strictEqual(operatedStagesOf([{ id: 's', name: 'Odd', stage: 'uat', stageOf: 'd' }], [])[0].role, 'viewer');
});

test('the real project store lists exactly the stage rows a stage-only member reaches', async () => {
    await projects.shareProject(uat.projectId, 'user', 'carol', 'editor');
    const stageRows = await projects.listUserProjects('carol', [], { kind: 'solution', onlyStages: true });
    const operated = operatedStagesOf(stageRows, new Set());
    assert.deepStrictEqual(operated.map(o => [o.solutionId, o.solutionName, o.stage, o.role]), [[dev.id, 'Invoices', 'uat', 'editor']]);
    assert.deepStrictEqual(await projects.listUserProjects('carol', [], { kind: 'solution' }), [], 'carol sees no Solution');
    // The owner of Dev reaches the stages too; with the Dev visible they are not "operated".
    const mine = await projects.listUserProjects('alice', [], { kind: 'solution', onlyStages: true });
    assert.deepStrictEqual(operatedStagesOf(mine, new Set([dev.id, lone.id])), []);
});

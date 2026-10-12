/**
 * projects/projectTeardown.js — the one order a project delete may take, for
 * the delete route and for account erasure alike. Dependencies are injected
 * (no module mocking, no database).
 *
 * Proven:
 *   - co-edited state is folded back BEFORE the soft references are detached
 *     and before the row is deleted; the files base goes only AFTER the row;
 *   - a detacher, the fold-back or the files base failing does not stop the
 *     delete, and is logged with ids only;
 *   - a refused delete (a chat shared into the project in between) is thrown
 *     to the caller and keeps the files base;
 *   - a project without a files base is not asked to remove one;
 *   - a Solution stage, or a Dev project with stages, is refused (409
 *     solution_has_stages) before anything is folded back or detached, unless
 *     the stage's own active `remove` deployment asks; that capability then
 *     reaches the detachers. The stage reads run for real at the end, against
 *     pglite behind db.js (testUtils/pglitePool.js).
 *
 * Run: cd server && node --test projects/projectTeardown.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { makeProjectTeardown, readStageBinding, isActiveRemoval } = require('./projectTeardown');

const NO_STAGE = async () => ({ stageOf: null, hasStages: false });

function harness({
    project = { id: 'p1', filesKbId: 'kb1', name: 'Launch' }, deleteThrows = null, failing = [],
    stageBinding = NO_STAGE, isActiveRemoval: activeRemoval = async () => false,
} = {}) {
    const calls = [];
    const warned = [];
    const fail = (what) => { if (failing.includes(what)) throw new Error(`${what} down`); };
    const teardown = makeProjectTeardown({
        store: {
            getProject: async (id) => { calls.push(['getProject', id]); return project; },
            deleteProject: async (id) => {
                calls.push(['deleteProject', id]);
                if (deleteThrows) throw deleteThrows;
                return true;
            },
        },
        lifecycle: { beforeProjectDeleted: async (id) => { calls.push(['foldBack', id]); fail('foldBack'); return 2; } },
        membership: {
            detachableKinds: () => [
                { section: 'notebooks', clearProject: async (id) => { calls.push(['detach:notebooks', id]); fail('notebooks'); } },
                { section: 'automations', clearProject: async (id, ctx) => { calls.push(['detach:automations', id, ...(ctx?.managedWrite ? [ctx.managedWrite] : [])]); } },
            ],
        },
        removeFilesKb: async (p) => { calls.push(['removeFilesKb', p.id]); fail('files'); return true; },
        log: { warn: (...args) => warned.push(args.join(' ')) },
        stageBinding,
        isActiveRemoval: activeRemoval,
    });
    return { teardown, calls, warned };
}

test('fold back, detach, delete, then the files base: in that order', async () => {
    const h = harness();
    assert.strictEqual(await h.teardown.deleteProject('p1'), true);
    assert.deepStrictEqual(h.calls, [
        ['foldBack', 'p1'],
        ['detach:notebooks', 'p1'],
        ['detach:automations', 'p1'],
        ['getProject', 'p1'],
        ['deleteProject', 'p1'],
        ['removeFilesKb', 'p1'],
    ]);
    assert.deepStrictEqual(h.warned, []);
});

test('a failing step is logged with ids only and never stops the delete', async () => {
    const h = harness({ failing: ['foldBack', 'notebooks', 'files'] });
    assert.strictEqual(await h.teardown.deleteProject('p1'), true);
    assert.ok(h.calls.some(([c]) => c === 'deleteProject'));
    assert.ok(h.calls.some(([c]) => c === 'detach:automations'), 'the next detacher still runs');
    assert.strictEqual(h.warned.length, 3);
    for (const line of h.warned) assert.doesNotMatch(line, /Launch/, 'no project name in the log');
});

test('a refused delete is thrown to the caller and keeps the files base', async () => {
    const refusal = Object.assign(new Error('violates check constraint "shared_needs_project"'), { code: '23514' });
    const h = harness({ deleteThrows: refusal });
    await assert.rejects(h.teardown.deleteProject('p1'), refusal);
    assert.ok(!h.calls.some(([c]) => c === 'removeFilesKb'));
});

test('a project without a files base is not asked to remove one; no id deletes nothing', async () => {
    const h = harness({ project: { id: 'p1', filesKbId: null } });
    await h.teardown.deleteProject('p1');
    assert.ok(!h.calls.some(([c]) => c === 'removeFilesKb'));
    const none = harness();
    assert.strictEqual(await none.teardown.deleteProject(''), false);
    assert.deepStrictEqual(none.calls, []);
});

// ── Solution stages ──────────────────────────────────────────────────

const isHasStages = (err) => err?.status === 409 && err.code === 'solution_has_stages' && err.expose === true;

test('a stage project is refused before anything is folded back, detached or deleted', async () => {
    const h = harness({ stageBinding: async () => ({ stageOf: 'p-dev', hasStages: false }) });
    await assert.rejects(h.teardown.deleteProject('p-uat'), (e) => isHasStages(e) && e.details.solutionId === 'p-dev');
    assert.deepStrictEqual(h.calls, []);
});

test('a Dev project with stages is refused, whatever removal it names', async () => {
    const h = harness({ stageBinding: async () => ({ stageOf: null, hasStages: true }), isActiveRemoval: async () => true });
    await assert.rejects(h.teardown.deleteProject('p-dev', { removal: { deploymentId: 'dep-rm' } }), isHasStages);
    assert.deepStrictEqual(h.calls, []);
});

test('a stage goes only under its own active remove deployment, which the detachers then carry', async () => {
    const asked = [];
    const removal = { deploymentId: 'dep-rm' };
    const refused = harness({
        stageBinding: async () => ({ stageOf: 'p-dev', hasStages: false }),
        isActiveRemoval: async (d, p) => { asked.push([d, p]); return false; },
    });
    await assert.rejects(refused.teardown.deleteProject('p-uat', { removal }), isHasStages, 'not an active removal of this stage');
    assert.deepStrictEqual(asked, [['dep-rm', 'p-uat']]);
    assert.deepStrictEqual(refused.calls, []);

    const allowed = harness({ stageBinding: async () => ({ stageOf: 'p-dev', hasStages: false }), isActiveRemoval: async () => true });
    assert.strictEqual(await allowed.teardown.deleteProject('p-uat', { removal }), true);
    assert.deepStrictEqual(allowed.calls.find(([c]) => c === 'detach:automations'), ['detach:automations', 'p-uat', removal]);
    assert.ok(allowed.calls.some(([c]) => c === 'deleteProject'));
});

// ── The stage reads, for real ────────────────────────────────────────

const { usePglitePool } = require('../testUtils/pglitePool');

let pool;
let dev;
let uat;
let removeDeployment;
let deployDeployment;

before(async () => {
    pool = usePglitePool();
    const projectStore = require('../stores/projectStore');
    const stages = require('../stores/solutionStageStore');
    await projectStore.initDB();
    await stages.initDB();
    dev = await projectStore.createProject({ name: 'Invoices', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    const created = await stages.createStages({ devProject: dev, stages: ['uat', 'prd'], actorId: 'alice' });
    uat = created.find((s) => s.stage === 'uat');
    const prd = created.find((s) => s.stage === 'prd');
    removeDeployment = await stages.insertDeployment({
        solutionId: dev.id, stageProjectId: uat.projectId, stage: 'uat', kind: 'remove', status: 'queued',
        plan: {}, planHash: 'h', stageSettingsVersion: 1, requestKey: 'rm-1', requestedBy: 'alice',
    });
    deployDeployment = await stages.insertDeployment({
        solutionId: dev.id, stageProjectId: prd.projectId, stage: 'prd', kind: 'deploy', releaseId: 'rel-1', status: 'queued',
        plan: {}, planHash: 'h', stageSettingsVersion: 1, requestKey: 'dep-1', requestedBy: 'alice',
    });
});

after(async () => { if (pool) await pool.close(); });

test('the stage reads: a stage, a Dev with stages, and an ordinary project', async () => {
    assert.deepStrictEqual(await readStageBinding(uat.projectId), { stageOf: dev.id, hasStages: false });
    assert.deepStrictEqual(await readStageBinding(dev.id), { stageOf: null, hasStages: true });
    assert.deepStrictEqual(await readStageBinding('no-such-project'), { stageOf: null, hasStages: false });
});

test('only an active remove deployment of exactly that stage is a removal capability', async () => {
    assert.strictEqual(await isActiveRemoval(removeDeployment.id, uat.projectId), true);
    assert.strictEqual(await isActiveRemoval(removeDeployment.id, dev.id), false, 'another project');
    assert.strictEqual(await isActiveRemoval(deployDeployment.id, deployDeployment.stageProjectId), false, 'a deploy is no removal');
    assert.strictEqual(await isActiveRemoval('dep-unknown', uat.projectId), false);
});

test('torn down for real: refused without the removal, allowed with it', async () => {
    const calls = [];
    const teardown = makeProjectTeardown({
        lifecycle: { beforeProjectDeleted: async (id) => { calls.push(['foldBack', id]); } },
        membership: { detachableKinds: () => [] },
        removeFilesKb: async () => true,
        log: { warn() {} },
    });
    await assert.rejects(teardown.deleteProject(uat.projectId), isHasStages);
    await assert.rejects(teardown.deleteProject(dev.id), isHasStages);
    await assert.rejects(teardown.deleteProject(uat.projectId, { removal: { deploymentId: deployDeployment.id } }), isHasStages);
    assert.deepStrictEqual(calls, []);

    assert.strictEqual(await teardown.deleteProject(uat.projectId, { removal: { deploymentId: removeDeployment.id } }), true);
    assert.deepStrictEqual(calls, [['foldBack', uat.projectId]]);
    assert.strictEqual(await require('../stores/projectStore').getProject(uat.projectId), null);
});

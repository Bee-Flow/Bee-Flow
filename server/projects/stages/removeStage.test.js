/**
 * The `remove` deployment kind (design 6.8), with every store injected.
 *
 * Pinned:
 *   - prepare switches every automation off through deactivateCore and
 *     unpublishes apps, pages and agents, journaled with what was on;
 *   - the commit deletes the parts with the deployment's capability; tables
 *     and knowledge bases go with their data only with `deleteData`, and a
 *     kept table loses the stage's reference-row lock; then ONE transaction
 *     removes the stage's rows and moves the deployment to `converging`;
 *   - the commit is the point of no return: each delete is journaled `pending` first, a repeated commit
 *     tolerates parts that are already gone, `removeStarted` tells the runner not to compensate, and
 *     `deleteData` is read from the PLAN only, never from the raw settings patch;
 *   - finish tears the project down with `{ removal: { deploymentId } }` and
 *     closes the deployment; a teardown that fails is a warning.
 *
 * The stores are injected; the transaction that removes the stage's rows is a
 * real one on PGlite (the boot ladder's schema, testUtils/pgliteTemplate.js),
 * recorded, so its lock-then-delete order is pinned on statements that ran.
 *
 * Run: cd server && node --test projects/stages/removeStage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { insertRow } = require('../../testUtils/pgliteSeed');
const { prepareRemove, commitRemove, finishRemove, removeStarted, deletesData } = require('./removeStage');

const pg = ladderPglite();
test.after(() => pg.close());

const STAGE_TABLES = ['solution_bindings', 'solution_variable_values', 'project_solution_entities', 'solution_stages'];
/** Stage rows of the removed stage (p_prd) and of another one (p_uat). */
async function seedStageRows() {
    await pg.exec(`TRUNCATE ${STAGE_TABLES.join(', ')} CASCADE`);
    for (const [projectId, stage] of [['p_prd', 'prd'], ['p_uat', 'uat']]) {
        const by = { updated_by: 'so' };
        await insertRow(pg, 'solution_stages', { project_id: projectId, solution_id: 'p_dev', stage, organization_id: 'org1', run_as_user_id: 'so', created_by: 'so' });
        await insertRow(pg, 'solution_bindings', { project_id: projectId, slot: 'mail', kind: 'connection', value: {}, ...by });
        await insertRow(pg, 'solution_variable_values', { project_id: projectId, name: 'region', value: { v: 'eu' }, ...by });
        await insertRow(pg, 'project_solution_entities', { project_id: projectId, ref: 'aut_1', kind: 'automation', entity_id: `${projectId}-aut`, install_hash: 'h' });
    }
}
/** How many rows each stage table holds per project. */
async function stageRows() {
    const out = {};
    for (const t of STAGE_TABLES) {
        const { rows } = await pg.query(`SELECT project_id, count(*)::int AS n FROM ${t} GROUP BY project_id ORDER BY project_id`);
        out[t] = Object.fromEntries(rows.map((r) => [r.project_id, r.n]));
    }
    return out;
}

const STAGE = { projectId: 'p_prd', solutionId: 'p_dev', stage: 'prd', organizationId: 'org1', runAsUserId: 'so' };
const MW = { deploymentId: 'dep_rm' };

const STAMPS = [
    { ref: 'aut_1', kind: 'automation', entityId: 'u-aut-1' },
    { ref: 'aut_2', kind: 'automation', entityId: 'u-aut-2' },
    { ref: 'app_1', kind: 'app', entityId: 'u-app-1' },
    { ref: 'web_1', kind: 'webpage', entityId: 'u-web-1' },
    { ref: 'agt_1', kind: 'agent', entityId: 'u-agt-1' },
    { ref: 'dt_1', kind: 'datatable', entityId: 'tbl_1' },
    { ref: 'kb_1', kind: 'knowledge_base', entityId: 'kb-1' },
    { ref: 'aut_old', kind: 'automation', entityId: 'u-old', retiredAt: '2026-09-01' },
];

function harness() {
    const log = [];
    const journal = [];
    let client = null;
    const deps = {
        // A real transaction on the one PGlite session; every statement is recorded.
        withTransaction: (fn) => pg.transaction(async (tx) => {
            client = {
                query: async (sql, params) => {
                    log.push(['sql', String(sql).trim().split(/\s+/).slice(0, 3).join(' '), params && params[0]]);
                    const r = await (params ? tx.query(sql, params) : tx.query(sql));
                    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
                },
            };
            return fn(client);
        }),
        blueprintStore: { listStamps: async () => new Map(STAMPS.map(s => [s.ref, s])) },
        solutionStageStore: {
            appendStep: async (id, step) => { journal.push(step); return { seq: journal.length }; },
            updateStep: async (id, seq, patch) => { Object.assign(journal[seq - 1], patch); },
            listSteps: async (id, { phase } = {}) => journal.filter(j => !phase || j.phase === phase),
            transitionDeployment: async (id, from, to, patch, opts) => { log.push(['status', from, to, patch.committed === true || patch.report, !!(opts && opts.client === client)]); return { id, status: to }; },
        },
        automationStore: {
            getAutomation: async (id) => ({ id, isActive: id === 'u-aut-1' }),
            deleteAutomation: async (id, opts) => { log.push(['delete', 'automation', id, opts.managedWrite]); },
        },
        studioAppStore: {
            getStudioApp: async (id) => ({ id, isPublished: true }),
            setStudioAppAudience: async (id, owner, a) => { log.push(['unpublish', 'app', id, a.isPublished, a.managedWrite]); },
            deleteStudioApp: async (id, owner, opts) => { log.push(['delete', 'app', id, opts.managedWrite]); },
        },
        webpageStore: {
            getWebpageRaw: async (id) => ({ id, isPublished: false }),
            deleteWebpage: async (id, owner, opts) => { log.push(['delete', 'webpage', id, opts.managedWrite]); },
        },
        agentStore: {
            getAgent: async (id) => ({ id, is_published: true }),
            setAgentPublished: async (id, on) => { log.push(['unpublish', 'agent', id, on]); },
            deleteAgent: async (id, owner, opts) => { log.push(['delete', 'agent', id, opts.managedWrite]); },
        },
        datatableStore: {
            orgScope: (id) => ({ kind: 'org', id }),
            setReferenceFlag: async (id, scope, on, opts) => { log.push(['reference_flag', id, on, opts.managedWrite]); },
        },
        datatableDbStore: { dropDatatable: async (id, scope, opts) => { log.push(['delete', 'datatable', id, opts.managedWrite]); } },
        kbStore: { deleteKB: async (id, opts) => { log.push(['delete', 'knowledge_base', id, opts.managedWrite]); } },
        goLive: { deactivateCore: async ({ automation, actorId }) => { log.push(['deactivate', automation.id, actorId]); return { ok: true }; } },
        teardown: { deleteProject: async (id, opts) => { log.push(['teardown', id, opts.removal]); return true; } },
        emitProjectEvent: async (projectId, event) => { log.push(['feed', projectId, event.payload.kind]); },
    };
    return { log, journal, deps };
}

test('prepare switches the stage off and journals what was on', async () => {
    const h = harness();
    const out = await prepareRemove({ deployment: { id: 'dep_rm' }, stage: STAGE }, h.deps);
    assert.deepStrictEqual(h.log, [
        ['deactivate', 'u-aut-1', 'so'],
        ['unpublish', 'app', 'u-app-1', false, MW],
        ['unpublish', 'agent', 'u-agt-1', false],
    ]);
    assert.strictEqual(out.switchedOff, 3);
    assert.deepStrictEqual(h.journal.map(j => [j.phase, j.action, j.ref, j.status, j.before]), [
        ['prepare', 'deactivate', 'aut_1', 'done', { isActive: true }],
        ['prepare', 'unpublish', 'app_1', 'done', { isPublished: true }],
        ['prepare', 'unpublish', 'agt_1', 'done', { isPublished: true }],
    ]);
});

test('the commit deletes the parts with the capability and keeps data without deleteData', async () => {
    const h = harness();
    await seedStageRows();
    await commitRemove({ deployment: { id: 'dep_rm', settingsPatch: null }, stage: STAGE }, h.deps);
    const deletes = h.log.filter(e => e[0] === 'delete').map(e => e[1]);
    assert.deepStrictEqual(deletes, ['automation', 'automation', 'app', 'webpage', 'agent']);
    assert.ok(h.log.filter(e => e[0] === 'delete').every(e => e[3] && e[3].deploymentId === 'dep_rm'));
    assert.deepStrictEqual(h.log.find(e => e[0] === 'reference_flag'), ['reference_flag', 'tbl_1', false, MW], 'a kept table loses the row lock');
    const sql = h.log.filter(e => e[0] === 'sql').map(e => e[1]);
    assert.deepStrictEqual(sql, ['SET LOCAL lock_timeout', "SELECT pg_advisory_xact_lock(hashtext('solution_stage:' ||",
        'DELETE FROM solution_bindings', 'DELETE FROM solution_variable_values', 'DELETE FROM project_solution_entities',
        'DELETE FROM solution_stages']);
    assert.ok(h.log.filter(e => e[0] === 'sql').slice(1).every(e => e[2] === 'p_prd'), 'the lock and every delete name the removed stage');
    const rows = await stageRows();
    for (const t of STAGE_TABLES) assert.deepStrictEqual(rows[t], { p_uat: 1 }, `${t}: the stage's rows are gone, another stage's stay`);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'status'), ['status', ['committing'], 'converging', true, true], 'the move to converging rides the same transaction');
    assert.deepStrictEqual(h.journal.filter(j => j.detail && j.detail.action === 'detach').map(j => j.ref), ['dt_1', 'kb_1']);
    assert.ok(h.journal.filter(j => j.phase === 'commit').every(j => j.status === 'done'));
    assert.ok(!h.journal.some(j => j.ref === 'aut_old'), 'a retired part was already gone from the release');
});

test('a move to converging that fails takes the row deletes back with it', async () => {
    const h = harness();
    await seedStageRows();
    h.deps.solutionStageStore.transitionDeployment = async () => { throw new Error('deployment moved on'); };
    await assert.rejects(commitRemove({ deployment: { id: 'dep_rm' }, stage: STAGE }, h.deps), /deployment moved on/);
    const rows = await stageRows();
    for (const t of STAGE_TABLES) assert.deepStrictEqual(rows[t], { p_prd: 1, p_uat: 1 }, `${t} is rolled back`);
});

test('with deleteData in the plan the tables and knowledge bases go with their data', async () => {
    assert.strictEqual(deletesData({ plan: { deleteData: true } }), true);
    assert.strictEqual(deletesData({ settingsPatch: { deleteData: true } }), false, 'a raw request flag drops nothing');

    const raw = harness();
    await commitRemove({ deployment: { id: 'dep_rm', settingsPatch: { deleteData: true } }, stage: STAGE }, raw.deps);
    assert.ok(!raw.log.some(e => e[0] === 'delete' && (e[1] === 'datatable' || e[1] === 'knowledge_base')));

    const h = harness();
    await commitRemove({ deployment: { id: 'dep_rm', plan: { deleteData: true } }, stage: STAGE }, h.deps);
    const deletes = h.log.filter(e => e[0] === 'delete').map(e => e[1]);
    assert.ok(deletes.includes('datatable') && deletes.includes('knowledge_base'));
    assert.ok(!h.log.some(e => e[0] === 'reference_flag'));
});

test('finish tears the stage project down with the removal capability', async () => {
    const h = harness();
    const out = await finishRemove({ deployment: { id: 'dep_rm', requestedBy: 'so' }, stage: STAGE }, h.deps);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'teardown'), ['teardown', 'p_prd', MW]);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'feed'), ['feed', 'p_dev', 'remove']);
    assert.strictEqual(h.log.find(e => e[0] === 'status')[2], 'succeeded');
    assert.deepStrictEqual(out.report.warnings, []);

    const failing = harness();
    failing.deps.teardown = { deleteProject: async () => { throw Object.assign(new Error('x'), { code: 'solution_has_stages' }); } };
    const bad = await finishRemove({ deployment: { id: 'dep_rm' }, stage: STAGE }, failing.deps);
    assert.deepStrictEqual(bad.report.warnings, [{ task: 'teardown', ref: null, code: 'solution_has_stages' }]);
    assert.strictEqual(failing.log.find(e => e[0] === 'status')[2], 'succeeded_with_warnings');
});

test('a commit that stops part way leaves a trace the runner reads, and a repeat finishes it', async () => {
    const h = harness();
    await seedStageRows();
    let calls = 0;
    h.deps.studioAppStore.deleteStudioApp = async (id, owner, opts) => { calls += 1; if (calls === 1) throw new Error('store down'); h.log.push(['delete', 'app', id, opts.managedWrite]); };
    assert.strictEqual(await removeStarted({ deployment: { id: 'dep_rm' } }, h.deps), false);
    await assert.rejects(commitRemove({ deployment: { id: 'dep_rm' }, stage: STAGE }, h.deps), /store down/);
    assert.deepStrictEqual(h.log.filter(e => e[0] === 'delete').map(e => e[2]), ['u-aut-1', 'u-aut-2'], 'the automations went before the app failed');
    assert.strictEqual(await removeStarted({ deployment: { id: 'dep_rm' } }, h.deps), true, 'something was deleted: no compensation');
    assert.strictEqual(h.journal.at(-1).status, 'failed');
    assert.ok(!h.log.some(e => e[0] === 'status'), 'the deployment did not move to converging');
    assert.deepStrictEqual((await stageRows()).solution_stages, { p_prd: 1, p_uat: 1 }, 'and the stage rows are still there');

    // the repeat: parts that are gone count as removed
    h.deps.automationStore.deleteAutomation = async () => { throw Object.assign(new Error('gone'), { status: 404 }); };
    await commitRemove({ deployment: { id: 'dep_rm' }, stage: STAGE }, h.deps);
    assert.ok(h.log.some(e => e[0] === 'delete' && e[1] === 'app'));
    assert.strictEqual(h.log.find(e => e[0] === 'status')[2], 'converging');
    assert.deepStrictEqual((await stageRows()).solution_stages, { p_uat: 1 });
});

test('a removal whose first delete is refused deleted nothing, so it is still compensated', async () => {
    const h = harness();
    h.deps.automationStore.deleteAutomation = async () => { throw Object.assign(new Error('managed'), { status: 409, code: 'managed_part' }); };
    await assert.rejects(commitRemove({ deployment: { id: 'dep_rm' }, stage: STAGE }, h.deps), { code: 'managed_part' });
    assert.strictEqual(await removeStarted({ deployment: { id: 'dep_rm' } }, h.deps), false);
});

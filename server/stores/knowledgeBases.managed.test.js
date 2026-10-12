/**
 * Knowledge bases in a Solution stage (design 5.2, 5.3), against a real
 * Postgres (@electric-sql/pglite behind db.js, testUtils/pglitePool.js): the
 * real knowledge-base store, projectStore and solutionStageStore. The stamp
 * table and the ref ledger belong to blueprintStore and are reduced here to
 * the columns the stage store reads.
 *
 * Pinned:
 *   - a managed base's metadata and its deletion change only through a deploy
 *     (409 managed_part), judged on what changes; publish and audience stay
 *     the stage's own;
 *   - in shell mode its documents stay the stage's own; in carry mode adding
 *     or removing a document needs the deploy's capability too;
 *   - GET /api/kb/:id carries `managed`, and the DELETE refuses before it
 *     purges anything.
 *
 * Run: cd server && node --test stores/knowledgeBases.managed.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const projectStore = require('./projectStore');
const solutionStageStore = require('./solutionStageStore');
const kb = require('./knowledgeBases');
const userStore = require('./userStore');
const h = require('../core/http/routeHarness');

const { swap, restore } = makeSwaps();

const BLUEPRINT_TABLES = `
    CREATE TABLE IF NOT EXISTS project_solution_entities (
        project_id TEXT NOT NULL, ref TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
        install_hash TEXT NOT NULL DEFAULT 'h', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, ref));
    CREATE TABLE IF NOT EXISTS solution_part_refs (
        solution_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, ref TEXT NOT NULL,
        PRIMARY KEY (solution_id, kind, entity_id));
`;

const ALICE = { id: 'alice', organizationId: 'org1', role: 'user', email: 'alice@example.test' };
const isManaged = (err) => err?.status === 409 && err.code === 'managed_part' && err.details?.stage === 'uat';

let dev;
let uat;
let deployment;
let shellKb;
let carryKb;
let plainKb;
let api;

const cap = () => ({ deploymentId: deployment.id });
const addDoc = (kbId, title, extra = {}) => kb.createDocument('alice', kbId, title, 'text', `mem://${title}`, `hash-${title}`, 0, null, null, extra);

before(async () => {
    swap(userStore, 'getUser', async (id) => ({ id, organizationId: 'org1', orgRole: 'member', groups: [] }));
    await projectStore.initDB();
    await solutionStageStore.initDB();
    await kb.initDB();
    await pg.exec(BLUEPRINT_TABLES);

    dev = await projectStore.createProject({ name: 'Invoices', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    [uat] = await solutionStageStore.createStages({ devProject: dev, stages: ['uat'], actorId: 'alice' });
    deployment = await solutionStageStore.insertDeployment({
        solutionId: dev.id, stageProjectId: uat.projectId, stage: 'uat', kind: 'deploy', releaseId: 'rel-1',
        status: 'queued', plan: {}, planHash: 'h1', stageSettingsVersion: 1, requestKey: 'k1', requestedBy: 'alice',
    });

    shellKb = await kb.createKB('alice', 'Stage handbook', '', 'org1');
    carryKb = await kb.createKB('alice', 'Price list', '', 'org1');
    plainKb = await kb.createKB('alice', 'Loose notes', '', 'org1');
    // Shell: listed on the stage project. Carry: stamped into it, with the
    // Solution's part option saying its content travels.
    await pg.query(`UPDATE projects SET knowledge_base_ids = jsonb_build_array($1::text) WHERE id = $2`, [shellKb.id, uat.projectId]);
    await pg.query(`INSERT INTO project_solution_entities (project_id, ref, kind, entity_id) VALUES ($1, 'kb_1', 'knowledge_base', $2)`,
        [uat.projectId, carryKb.id]);
    await pg.query(`INSERT INTO solution_part_refs (solution_id, kind, entity_id, ref) VALUES ($1, 'knowledge_base', 'kb-in-dev', 'kb_1')`, [dev.id]);
    await solutionStageStore.setPartOption(dev.id, { ref: 'kb_1', kind: 'knowledge_base', options: { contentMode: 'carry' } }, 'alice');

    h.openGates();
    api = h.serve('/api/kb', require('../routes/knowledgeBases/detail'), { user: ALICE });
});

after(async () => {
    restore();
    if (api) await api.close();
    await close();
});

test('a managed base\'s metadata changes through a deploy; an unchanged save goes through', async () => {
    await assert.rejects(kb.updateKB(shellKb.id, { name: 'Renamed on the stage' }), isManaged);
    await assert.rejects(kb.updateKB(carryKb.id, { description: 'Edited' }), isManaged);
    await assert.rejects(kb.updateKB(shellKb.id, { usageContexts: ['agent'] }), isManaged);

    // The settings form sends everything back; nothing differs, nothing is refused.
    const same = await kb.updateKB(shellKb.id, { name: shellKb.name, description: '', categoryId: null, organizationId: 'org1' });
    assert.strictEqual(same.name, 'Stage handbook');

    const deployed = await kb.updateKB(shellKb.id, { name: 'Stage handbook v2' }, { managedWrite: cap() });
    assert.strictEqual(deployed.name, 'Stage handbook v2');

    // An ordinary base is untouched by any of it.
    assert.strictEqual((await kb.updateKB(plainKb.id, { name: 'Loose notes 2' })).name, 'Loose notes 2');
});

test('publish and audience stay the stage\'s own, shell or carry', async () => {
    assert.strictEqual((await kb.setPublished(shellKb.id, true, ['g1'])).is_published, true);
    assert.strictEqual((await kb.setPublished(carryKb.id, true)).is_published, true);
});

test('shell: the stage adds and removes its own documents', async () => {
    const doc = await addDoc(shellKb.id, 'shell-1');
    assert.ok(doc?.id);
    assert.strictEqual(await kb.deleteDocument(doc.id), true);
});

test('carry: a document arrives and leaves only through a deploy', async () => {
    await assert.rejects(addDoc(carryKb.id, 'carry-refused'), isManaged);
    await assert.rejects(
        kb.recordDuplicate('alice', carryKb.id, 'dup', 'text', 'mem://dup', 'hash-x', '00000000-0000-4000-8000-000000000000'),
        isManaged,
    );
    const doc = await addDoc(carryKb.id, 'carry-1', { managedWrite: cap() });
    assert.ok(doc?.id);
    await assert.rejects(kb.deleteDocument(doc.id), isManaged);
    assert.ok(await kb.getDocument(doc.id), 'refused before the snapshot or the delete');
    // A reingest rewrites content: refused too, allowed for the deploy.
    await assert.rejects(kb.replaceDocumentContent(doc.id, { contentHash: 'h2' }), isManaged);
    assert.ok(await kb.replaceDocumentContent(doc.id, { contentHash: 'h2', managedWrite: cap() }));
    assert.strictEqual(await kb.deleteDocument(doc.id, { managedWrite: cap() }), true);
    assert.strictEqual(await kb.getDocument(doc.id), null);
});

test('a deployment of ANOTHER stage project is no capability here', async () => {
    const [prd] = await solutionStageStore.createStages({ devProject: dev, stages: ['prd'], actorId: 'alice' });
    const other = await solutionStageStore.insertDeployment({
        solutionId: dev.id, stageProjectId: prd.projectId, stage: 'prd', kind: 'deploy', releaseId: 'rel-1',
        status: 'queued', plan: {}, planHash: 'h1', stageSettingsVersion: 1, requestKey: 'k-prd', requestedBy: 'alice',
    });
    await assert.rejects(addDoc(carryKb.id, 'carry-wrong-cap', { managedWrite: { deploymentId: other.id } }), isManaged);
});

test('GET /api/kb/:id carries `managed`', async () => {
    const carry = await api.call('GET', `/api/kb/${carryKb.id}`);
    assert.strictEqual(carry.status, 200, carry.text);
    assert.deepStrictEqual(carry.body.managed, {
        solutionId: dev.id, solutionName: 'Invoices', stage: 'uat', releaseSeq: null,
        devRef: { kind: 'knowledge_base', id: 'kb-in-dev' },
    });
    const shell = await api.call('GET', `/api/kb/${shellKb.id}`);
    assert.strictEqual(shell.body.managed.stage, 'uat');
    assert.strictEqual(shell.body.managed.devRef, null, 'listed, not stamped: no Dev part behind it');
    const plain = await api.call('GET', `/api/kb/${plainKb.id}`);
    assert.strictEqual(plain.status, 200, plain.text);
    assert.strictEqual(plain.body.managed, null);
});

test('a managed base is deleted only by a deploy; the route refuses before it purges anything', async () => {
    const doc = await addDoc(shellKb.id, 'shell-kept');
    const res = await api.call('DELETE', `/api/kb/${shellKb.id}?confirm=1`);
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body.code, 'managed_part');
    assert.ok(await kb.getKB(shellKb.id));
    assert.ok(await kb.getDocument(doc.id), 'its documents are still there');

    await assert.rejects(kb.deleteKB(carryKb.id), isManaged);
    assert.strictEqual(await kb.deleteKB(carryKb.id, { managedWrite: cap() }), true);
    assert.strictEqual(await kb.getKB(carryKb.id), null);
});

'use strict';

/**
 * Document templates filed into a Solution (D21) and the managed-part lock on
 * them (design 5.3), against a REAL Postgres (@electric-sql/pglite behind
 * db.js's pool, testUtils/pglitePool.js): the document store, the project store
 * and the Solution stage store run their own schema and SQL, with no module
 * mocking.
 *
 * Pinned:
 *   - filing through `solution_project_id` is the owner's act, for a template,
 *     section or designed document (never a page), in the document's own
 *     organisation; listing, counting and detaching follow that column only;
 *   - filing into a stage project is a managed write;
 *   - on a template a stage manages, an update, a restore, a named version, a
 *     version delete and an archive are refused (409 managed_part), while a
 *     sharing change passes;
 *   - createVersionRow writes a revision an automation can pin without moving the
 *     document's current revision; writeManagedTemplate creates and updates a
 *     stage's template with the deploy's capability;
 *   - PATCH /api/studio-documents/:id answers 409 with `code: 'managed_part'`.
 *
 * Run: cd server && node --test stores/document/solutionTemplates.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const projectStore = require('../projectStore');
const solutionStageStore = require('../solutionStageStore');
const documentStore = require('../documentStore');
const templates = require('./solutionTemplates');

// House style needs the organisation settings; these documents opt out of it.
const PLAIN = { houseStyle: false };
let dev;
let uat;
let otherOrgProject;

async function refused(promise, message) {
    await assert.rejects(promise, (err) => {
        assert.strictEqual(err.status, 409, message);
        assert.strictEqual(err.code, 'managed_part', message);
        assert.strictEqual(err.errorClass, 'managed_part', message);
        assert.strictEqual(err.details.stage, 'uat');
        return true;
    }, message);
}

async function activeDeployment() {
    const id = `dep-${crypto.randomUUID()}`;
    await pg.query(
        `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status, plan,
                                           plan_hash, stage_settings_version, request_key, requested_by)
         VALUES ($1, $2, $3, 'uat', 'rel_1', 'deploy', 'preparing', '{}'::jsonb, 'h', 1, $1, 'alice')`,
        [id, dev.id, uat.projectId],
    );
    return { deploymentId: id };
}
const finish = (managedWrite) => pg.query(`UPDATE solution_deployments SET status = 'succeeded' WHERE id = $1`, [managedWrite.deploymentId]);

const make = (userId, extra = {}) => documentStore.createDocument({
    userId, name: 'Offer', kind: 'template', bodyHtml: '<p>v1</p>', css: '.a{}', settings: PLAIN, ...extra,
});
const docRow = async (id) => (await pg.query('SELECT * FROM studio_documents WHERE id = $1', [id])).rows[0];

/** A template with three revisions (v1 baseline, v2, v3), filed into UAT by a deploy. */
async function managedTemplate() {
    const doc = await make('alice');
    const v2 = await documentStore.updateDocument(doc.id, 'alice', { bodyHtml: '<p>v2</p>', source: 'named' });
    const v3 = await documentStore.updateDocument(doc.id, 'alice', { bodyHtml: '<p>v3</p>', source: 'named' });
    const managedWrite = await activeDeployment();
    assert.strictEqual(await templates.setTemplateSolution(doc.id, 'alice', uat.projectId, { managedWrite }), true);
    await finish(managedWrite);
    return { doc, v2, v3 };
}

before(async () => {
    await pg.exec(`
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT);
        INSERT INTO users VALUES ('alice','org1'), ('bob','org1'), ('olga','org2');
    `);
    await projectStore.initDB();
    await solutionStageStore.initDB();
    await documentStore.initDB();
    dev = await projectStore.createProject({ name: 'Quotes', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    otherOrgProject = await projectStore.createProject({ name: 'Elsewhere', ownerId: 'olga', organizationId: 'org2', kind: 'solution' });
    [uat] = await solutionStageStore.createStages({ devProject: dev, stages: ['uat'], actorId: 'alice' });
});

after(async () => { await close(); });

// ── Filing ───────────────────────────────────────────────────────────

test('the filing column carries a partial index', async () => {
    const { rows } = await pg.query(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'studio_documents' AND indexname = 'idx_studio_documents_solution'`);
    assert.match(rows[0].indexdef, /WHERE \(solution_project_id IS NOT NULL\)/);
});

test('the owner files a template into a Solution; it lists, counts and leaves project content alone', async () => {
    const doc = await make('alice');
    assert.strictEqual(await templates.setTemplateSolution(doc.id, 'alice', dev.id), true);
    const cards = await templates.listSolutionTemplates(dev.id);
    const card = cards.find((c) => c.id === doc.id);
    assert.strictEqual(card.solutionProjectId, dev.id);
    assert.strictEqual(card.kind, 'template');
    assert.ok(!('bodyHtml' in card), 'a card never carries the slots');
    assert.ok((await templates.countSolutionTemplates([dev.id, 'nothing'])).get(dev.id) >= 1);
    assert.strictEqual((await templates.countSolutionTemplates([dev.id])).get('nothing'), undefined);
    assert.strictEqual((await docRow(doc.id)).project_id, null, 'filing a template never makes it project content');
    assert.deepStrictEqual(await documentStore.listProjectDocuments(dev.id), []);

    assert.strictEqual(await templates.clearTemplateSolution(doc.id, 'some-other-project'), false, 'scoped to the project');
    assert.strictEqual(await templates.clearTemplateSolution(doc.id, dev.id, 'bob'), false, 'with a user, only the owner');
    assert.strictEqual(await templates.clearTemplateSolution(doc.id, dev.id, 'alice'), true);
    assert.strictEqual((await docRow(doc.id)).solution_project_id, null);
});

test('nobody files a template they do not own, a page, or into another organisation', async () => {
    const doc = await make('alice');
    assert.strictEqual(await templates.setTemplateSolution(doc.id, 'bob', dev.id), false);
    assert.strictEqual(await templates.setTemplateSolution(doc.id, 'alice', otherOrgProject.id), false);
    assert.strictEqual(await templates.setTemplateSolution(doc.id, 'alice', 'no-such-project'), false);
    const page = await make('alice', { kind: 'document', docType: 'page', bodyHtml: '<p>hi</p>' });
    assert.strictEqual(await templates.setTemplateSolution(page.id, 'alice', dev.id), false);
});

test('a project delete detaches its templates and deletes none', async () => {
    const a = await make('alice');
    const b = await make('alice', { kind: 'section' });
    await templates.setTemplateSolution(a.id, 'alice', dev.id);
    await templates.setTemplateSolution(b.id, 'alice', dev.id);
    assert.ok(await templates.clearSolutionFromTemplates(dev.id) >= 2);
    assert.deepStrictEqual(await templates.listSolutionTemplates(dev.id), []);
    assert.ok(await docRow(a.id));
});

test('filing into a stage project needs the deploy capability', async () => {
    const doc = await make('alice');
    await refused(templates.setTemplateSolution(doc.id, 'alice', uat.projectId));
    assert.strictEqual((await docRow(doc.id)).solution_project_id, null);
});

// ── The lock on a managed template ───────────────────────────────────

test('a managed template refuses an update and keeps its content; a sharing change passes', async () => {
    const { doc, v3 } = await managedTemplate();
    await refused(documentStore.updateDocument(doc.id, 'alice', { name: 'Renamed' }));
    await refused(documentStore.updateDocument(doc.id, 'alice', { bodyHtml: '<p>edited</p>' }));
    const row = await docRow(doc.id);
    assert.strictEqual(row.body_html, '<p>v3</p>');
    assert.strictEqual(row.version_id, v3.versionId);

    // The editor resends what it loaded: unchanged values are not a change.
    const same = await documentStore.updateDocument(doc.id, 'alice', { name: 'Offer', bodyHtml: '<p>v3</p>' });
    assert.strictEqual(same.versionId, v3.versionId);
    const shared = await documentStore.updateDocument(doc.id, 'alice', { visibility: 'team' });
    assert.strictEqual(shared.visibility, 'team');
});

test('restore, a named version, a version delete and an archive are refused on a managed template', async () => {
    const { doc, v2 } = await managedTemplate();
    await refused(documentStore.restoreVersion(doc.id, 'alice', doc.versionId));
    await refused(documentStore.createNamedVersion(doc.id, 'alice', 'Milestone'));
    await refused(documentStore.deleteVersion(doc.id, 'alice', v2.versionId));
    await refused(documentStore.deleteDocument(doc.id, 'alice'));
    const row = await docRow(doc.id);
    assert.strictEqual(row.body_html, '<p>v3</p>');
    assert.strictEqual(row.archived, false);
    const { rows } = await pg.query('SELECT id FROM studio_document_versions WHERE id = $1', [v2.versionId]);
    assert.strictEqual(rows.length, 1, 'the revision stays');
});

test('someone who may not archive or file a managed template learns nothing about its Solution', async () => {
    const { doc } = await managedTemplate();
    assert.strictEqual(await documentStore.deleteDocument(doc.id, 'bob'), false, 'not found, not managed_part');
    assert.strictEqual(await templates.setTemplateSolution(doc.id, 'bob', dev.id), false);
    assert.strictEqual((await docRow(doc.id)).archived, false);
    assert.strictEqual(await templates.managedOf('no-such-document'), null);
});

test('an unmanaged template still restores and deletes versions', async () => {
    const doc = await make('alice');
    const v2 = await documentStore.updateDocument(doc.id, 'alice', { bodyHtml: '<p>v2</p>', source: 'named' });
    await documentStore.updateDocument(doc.id, 'alice', { bodyHtml: '<p>v3</p>', source: 'named' });
    assert.strictEqual(await documentStore.deleteVersion(doc.id, 'alice', v2.versionId), true);
    const restored = await documentStore.restoreVersion(doc.id, 'alice', doc.versionId);
    assert.strictEqual(restored.current.bodyHtml, '<p>v1</p>');
});

// ── Writes a deploy makes ────────────────────────────────────────────

test('createVersionRow writes a pinnable revision without moving the current one', async () => {
    const { doc, v3 } = await managedTemplate();
    await refused(templates.createVersionRow(doc.id, { bodyHtml: '<p>release</p>' }));

    const managedWrite = await activeDeployment();
    const vid = await templates.createVersionRow(doc.id,
        { bodyHtml: '<p>release</p>', css: '.r{}', settings: { houseStyle: false, sampleValues: { a: 1 } }, summary: 'Release 4' },
        { managedWrite });
    await finish(managedWrite);
    assert.ok(vid);
    const row = await docRow(doc.id);
    assert.strictEqual(row.version_id, v3.versionId, 'the current revision does not move');
    assert.strictEqual(row.body_html, '<p>v3</p>');

    const pinned = await documentStore.getDocumentVersion(doc.id, 'alice', vid);
    assert.strictEqual(pinned.bodyHtml, '<p>release</p>');
    assert.strictEqual(pinned.css, '.r{}');
    assert.strictEqual(pinned.settings.sampleValues, undefined, 'a template carries no sample values');
    const { rows } = await pg.query('SELECT source, summary FROM studio_document_versions WHERE id = $1', [vid]);
    assert.deepStrictEqual(rows[0], { source: 'import', summary: 'Release 4' });

    assert.strictEqual(await templates.createVersionRow('no-such-document', { bodyHtml: '' }), null);
});

test('writeManagedTemplate creates and updates a stage template with the capability only', async () => {
    const fields = { name: 'Invoice', docType: 'invoice', kind: 'template', bodyHtml: '<p>r1</p>', css: '', settings: PLAIN };
    const client = { query: (sql, params) => pg.query(sql, params) };
    await refused(templates.writeManagedTemplate(client, { ownerId: 'alice', orgId: 'org1', projectId: uat.projectId, fields }));

    const managedWrite = await activeDeployment();
    const created = await templates.writeManagedTemplate(client,
        { ownerId: 'alice', orgId: 'org1', projectId: uat.projectId, fields: { ...fields, folderId: 'f1', visibility: 'team' } },
        { managedWrite });
    assert.strictEqual(created.created, true);
    let row = await docRow(created.id);
    assert.strictEqual(row.solution_project_id, uat.projectId);
    assert.strictEqual(row.project_id, null);
    assert.strictEqual(row.visibility, 'private', 'sharing is never taken from a release');
    assert.strictEqual(row.folder_id, null);
    assert.strictEqual(row.version_id, created.versionId);

    const updated = await templates.writeManagedTemplate(client,
        { id: created.id, ownerId: 'alice', projectId: uat.projectId, fields: { ...fields, bodyHtml: '<p>r2</p>' } },
        { managedWrite });
    await finish(managedWrite);
    row = await docRow(created.id);
    assert.strictEqual(row.body_html, '<p>r2</p>');
    assert.strictEqual(row.version_id, updated.versionId);
    const page = { ...fields, docType: 'page' };
    const again = await activeDeployment();
    await assert.rejects(templates.writeManagedTemplate(client,
        { ownerId: 'alice', projectId: uat.projectId, fields: page }, { managedWrite: again }),
    (err) => err.status === 422);
    await finish(again);
});

// ── The route ────────────────────────────────────────────────────────

test('PATCH /api/studio-documents/:id answers 409 with code managed_part, and GET says managed', async () => {
    const { doc, v3 } = await managedTemplate();
    const h = require('../../core/http/routeHarness');
    h.openGates({ hasPermission: async () => false });
    const api = h.serve('/api/studio-documents', require('../../routes/studioDocuments'));
    try {
        const user = { id: 'alice', organizationId: 'org1' };
        const res = await api.call('PATCH', `/api/studio-documents/${doc.id}`,
            { user, body: { expectedVersionId: v3.versionId, name: 'Renamed' } });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.code, 'managed_part');
        assert.strictEqual(res.body.details.stage, 'uat');

        const got = await api.call('GET', `/api/studio-documents/${doc.id}`, { user });
        assert.strictEqual(got.status, 200);
        assert.strictEqual(got.body.document.managed.stage, 'uat');
        assert.strictEqual(got.body.document.managed.solutionId, dev.id);
        assert.strictEqual(got.body.document.editable, false);
    } finally {
        await api.close();
    }
});

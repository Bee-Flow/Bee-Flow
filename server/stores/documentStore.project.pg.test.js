'use strict';

/**
 * Documents as project content, against a REAL Postgres (@electric-sql/pglite
 * behind db.js's pool, testUtils/pglitePool.js): the store runs its own schema
 * init and SQL, with no module mocking. Only the project ROLE is a fixture,
 * swapped on the lookup the store asks (stores/lib/projectRole.js).
 *
 * What a project changes about a document, and what it must not:
 *
 *   - filing is the OWNER's act, into a project of the document's own
 *     organisation, and only for a plain document (templates and sections have
 *     their own team sharing);
 *   - any member reads a filed document; an editor or the project owner edits
 *     its content; a viewer and a stranger read nothing more than before;
 *   - the owner-only things stay the owner's: kind, sharing, folder,
 *     categories, and archiving;
 *   - taking it out is scoped to one project, and a project delete detaches
 *     instead of deleting.
 *
 * Run: cd server && node --test stores/documentStore.project.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const store = require('./documentStore');
const projectRole = require('./lib/projectRole');

// Who holds which role where. The owner of a project is 'owner'.
const ROLES = {
    p1: { alice: 'owner', bob: 'editor', vic: 'viewer' },
    p2: { alice: 'owner', bob: 'owner' },
    pOther: { alice: 'owner' },
};

const { swap, restore } = makeSwaps();

before(async () => {
    await pg.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT);
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');
        INSERT INTO users VALUES ('alice','org1'), ('bob','org1'), ('vic','org1'), ('eve','org1'), ('olga','org2');
        INSERT INTO projects VALUES ('p1','alice','org1'), ('p2','alice','org1'), ('pOther','olga','org2');
    `);
    await store.initDB();
    swap(projectRole.lookup, 'roleOf', async (userId, projectId) => ROLES[projectId]?.[userId] || null);
});

after(async () => {
    restore();
    await close();
});

// A house style needs the organisation settings table; these documents opt out
// of it so the test is about access, not letterheads.
const PLAIN = { houseStyle: false };
const make = (userId, extra = {}) => store.createDocument({
    userId, name: 'Plan', bodyHtml: '<p>v1</p>', css: '.a{}', settings: PLAIN, ...extra,
});

// ═══ Filing ══════════════════════════════════════════════════════════

test('the owner files their own document into a project of their organisation', async () => {
    const doc = await make('alice');
    assert.strictEqual(doc.projectId, null, 'a new document is private');
    assert.strictEqual(await store.setDocumentProject(doc.id, 'alice', 'p1'), true);
    const cards = await store.listProjectDocuments('p1');
    const card = cards.find(c => c.id === doc.id);
    assert.deepStrictEqual(Object.keys(card).sort(),
        ['createdAt', 'docType', 'id', 'kind', 'name', 'projectId', 'updatedAt', 'updatedBy', 'userId']);
    assert.strictEqual(card.userId, 'alice');
    assert.strictEqual(card.projectId, 'p1');
    assert.ok(!('bodyHtml' in card) && !('css' in card), 'a card never carries the slots');
});

test('nobody files a document they do not own, even an editor of the project', async () => {
    const doc = await make('alice');
    assert.strictEqual(await store.setDocumentProject(doc.id, 'bob', 'p1'), false);
    assert.strictEqual((await store.getDocument(doc.id, 'alice')).projectId, null);
});

test('a document is never filed into a project of another organisation', async () => {
    const doc = await make('alice');
    assert.strictEqual(await store.setDocumentProject(doc.id, 'alice', 'pOther'), false);
    assert.strictEqual(await store.setDocumentProject(doc.id, 'alice', 'no-such-project'), false);
});

test('templates, sections and archived documents are not project content', async () => {
    const template = await make('alice', { kind: 'template' });
    assert.strictEqual(await store.setDocumentProject(template.id, 'alice', 'p1'), false);
    const gone = await make('alice');
    assert.strictEqual(await store.deleteDocument(gone.id, { userId: 'alice' }), true);
    assert.strictEqual(await store.setDocumentProject(gone.id, 'alice', 'p1'), false);
});

// ═══ Reading ═════════════════════════════════════════════════════════

test('every member reads a filed document and learns their role; a stranger does not', async () => {
    const doc = await make('alice');
    assert.strictEqual(await store.getDocument(doc.id, 'vic'), null, 'not filed: still private');
    await store.setDocumentProject(doc.id, 'alice', 'p1');

    const own = await store.getDocument(doc.id, 'alice');
    assert.strictEqual(own.projectRole, undefined, 'the owner reads it as their own');
    assert.strictEqual((await store.getDocument(doc.id, 'bob')).projectRole, 'editor');
    const asViewer = await store.getDocument(doc.id, 'vic');
    assert.strictEqual(asViewer.projectRole, 'viewer');
    assert.strictEqual(asViewer.bodyHtml, '<p>v1</p>');
    assert.strictEqual(await store.getDocument(doc.id, 'eve'), null, 'same organisation, not a member');
    assert.strictEqual(await store.getDocument(doc.id, 'olga'), null);
    assert.strictEqual((await store.listVersions(doc.id, 'vic')).versions.length, 1, 'a viewer reads the history');
    assert.strictEqual(await store.listVersions(doc.id, 'eve'), null, 'a stranger reads none of it');
});

test('an archived document disappears for the members and from the listing', async () => {
    const doc = await make('alice');
    await store.setDocumentProject(doc.id, 'alice', 'p1');
    const counted = (await store.countProjectDocuments(['p1'])).get('p1');
    assert.strictEqual(await store.deleteDocument(doc.id, { userId: 'alice' }), true);
    assert.strictEqual(await store.getDocument(doc.id, 'vic'), null);
    assert.ok(!(await store.listProjectDocuments('p1', { limit: 200 })).some(c => c.id === doc.id));
    assert.strictEqual((await store.countProjectDocuments(['p1'])).get('p1') || 0, counted - 1);
});

// ═══ Writing ═════════════════════════════════════════════════════════

test('a project editor edits the content and a new revision is written', async () => {
    const doc = await make('alice');
    await store.setDocumentProject(doc.id, 'alice', 'p1');
    const updated = await store.updateDocument(doc.id, { userId: 'bob' },
        { bodyHtml: '<p>v2 by bob</p>', expectedVersionId: doc.versionId });
    assert.ok(updated, 'the edit went through');
    assert.strictEqual(updated.bodyHtml, '<p>v2 by bob</p>');
    assert.notStrictEqual(updated.versionId, doc.versionId);
    assert.strictEqual(updated.userId, 'alice', 'it stays the owner\'s document');
    const { versions } = await store.listVersions(doc.id, 'alice');
    assert.strictEqual(versions.length, 2);
    assert.strictEqual(versions[0].createdBy, 'bob', 'the editor is the author of the new version');
    assert.deepStrictEqual(versions[0].contributors, [{ userId: 'bob', kind: 'user' }]);
    assert.strictEqual(updated.updatedBy, 'bob', 'and the last editor of the document');
});

test('the project owner edits too, and a restore by an editor works like an edit', async () => {
    const doc = await make('bob', { name: 'Bob\'s' });
    await store.setDocumentProject(doc.id, 'bob', 'p1');
    const byOwner = await store.updateDocument(doc.id, { userId: 'alice' }, { name: 'Renamed by the project owner' });
    assert.strictEqual(byOwner.name, 'Renamed by the project owner');
    const restored = await store.restoreVersion(doc.id, { userId: 'alice' }, doc.versionId, { expectedVersionId: byOwner.versionId });
    assert.strictEqual(restored.current.name, 'Bob\'s');
    assert.strictEqual(restored.version.source, 'restore');
    assert.strictEqual(restored.version.restoredFrom, doc.versionId);
});

test('a viewer and a stranger cannot edit or restore, and nothing is written', async () => {
    const doc = await make('alice');
    await store.setDocumentProject(doc.id, 'alice', 'p1');
    assert.strictEqual(await store.updateDocument(doc.id, { userId: 'vic' }, { bodyHtml: '<p>no</p>' }), null);
    assert.strictEqual(await store.updateDocument(doc.id, { userId: 'eve' }, { bodyHtml: '<p>no</p>' }), null);
    assert.strictEqual(await store.restoreVersion(doc.id, { userId: 'vic' }, doc.versionId, { expectedVersionId: doc.versionId }), null);
    assert.strictEqual(await store.createNamedVersion(doc.id, { userId: 'vic' }, 'Mine now'), null);
    assert.strictEqual(await store.nameVersion(doc.id, { userId: 'vic' }, 'current', 'Mine now'), null);
    const still = await store.getDocument(doc.id, 'alice');
    assert.strictEqual(still.bodyHtml, '<p>v1</p>');
    assert.strictEqual(still.versionId, doc.versionId);
});

test('an editor cannot change what only the owner decides', async () => {
    const doc = await make('alice');
    await store.setDocumentProject(doc.id, 'alice', 'p1');
    const changes = [
        { kind: 'template' },
        { kind: 'template', visibility: 'team' },
        { categories: ['mine'] },
        { folderId: 'any-folder' },
    ];
    for (const change of changes) {
        await assert.rejects(store.updateDocument(doc.id, { userId: 'bob' }, change),
            (e) => e.status === 403 && e.errorClass === 'document_owner_only', JSON.stringify(change));
    }
    assert.strictEqual((await store.getDocument(doc.id, 'alice')).versionId, doc.versionId, 'nothing written');
    // Sending those fields back UNCHANGED (the editor saves the whole document)
    // is not a change and is accepted.
    const same = await store.updateDocument(doc.id, { userId: 'bob' },
        { kind: 'document', visibility: 'private', categories: [], bodyHtml: '<p>fine</p>' });
    assert.strictEqual(same.bodyHtml, '<p>fine</p>');
});

test('archiving stays with the owner', async () => {
    const doc = await make('alice');
    await store.setDocumentProject(doc.id, 'alice', 'p1');
    assert.strictEqual(await store.deleteDocument(doc.id, { userId: 'bob' }), false, 'an editor');
    assert.strictEqual(await store.deleteDocument(doc.id, { userId: 'alice', isAdmin: false }), true, 'the owner');
});

test('an edit after the document left the project is refused', async () => {
    const doc = await make('alice');
    await store.setDocumentProject(doc.id, 'alice', 'p1');
    assert.strictEqual(await store.detachDocumentFromProject(doc.id, 'p1', 'alice'), true);
    assert.strictEqual(await store.updateDocument(doc.id, { userId: 'bob' }, { bodyHtml: '<p>late</p>' }), null);
    assert.strictEqual(await store.getDocument(doc.id, 'bob'), null);
});

test('an old revision reads with the document\'s filing of today, not of then', async () => {
    const doc = await make('alice');
    await store.setDocumentProject(doc.id, 'alice', 'p1');
    const edited = await store.updateDocument(doc.id, { userId: 'bob' }, { bodyHtml: '<p>v2</p>' });
    const old = await store.getDocumentVersion(doc.id, 'vic', edited.versionId);
    assert.strictEqual(old.bodyHtml, '<p>v2</p>');
    assert.strictEqual(old.projectRole, 'viewer', 'a member reads the history');
    await store.detachDocumentFromProject(doc.id, 'p1', 'alice');
    assert.strictEqual(await store.getDocumentVersion(doc.id, 'vic', edited.versionId), null, 'and loses it with the document');
    assert.strictEqual((await store.getDocumentVersion(doc.id, 'alice', edited.versionId)).projectId, null,
        'the snapshot taken while it was filed does not put it back in the project');
});

// ═══ Taking it out, and deleting the project ═════════════════════════

test('taking a document out is scoped to one project and to the owner unless null', async () => {
    const doc = await make('alice');
    await store.setDocumentProject(doc.id, 'alice', 'p1');
    assert.strictEqual(await store.detachDocumentFromProject(doc.id, 'p2', 'alice'), false, 'not in p2');
    assert.strictEqual(await store.detachDocumentFromProject(doc.id, 'p1', 'bob'), false, 'not bob\'s');
    assert.strictEqual(await store.detachDocumentFromProject(doc.id, 'p1', null), true, 'the project owner\'s removal');
    const after = await store.getDocument(doc.id, 'alice');
    assert.strictEqual(after.projectId, null);
    assert.strictEqual(after.archived, false, 'taken out, never deleted');
});

test('deleting a project detaches its documents and counts are per project', async () => {
    const a = await make('alice');
    const b = await make('alice');
    await store.setDocumentProject(a.id, 'alice', 'p2');
    await store.setDocumentProject(b.id, 'alice', 'p2');
    const counts = await store.countProjectDocuments(['p2', 'pOther', '', null]);
    assert.strictEqual(counts.get('p2'), 2);
    assert.strictEqual(counts.has('pOther'), false, 'absent means none');
    assert.strictEqual(await store.clearProjectFromDocuments('p2'), 2);
    assert.deepStrictEqual(await store.listProjectDocuments('p2'), []);
    assert.strictEqual((await store.getDocument(a.id, 'alice')).projectId, null);
    assert.deepStrictEqual(await store.countProjectDocuments([]), new Map());
});

// ═══ Creating straight into a project ════════════════════════════════

test('a document can be created straight into a project of the same organisation', async () => {
    const doc = await make('bob', { projectId: 'p1' });
    assert.strictEqual(doc.projectId, 'p1');
    assert.strictEqual((await store.getDocument(doc.id, 'vic')).projectRole, 'viewer');
});

test('creating into a foreign, missing or template target is refused and writes nothing', async () => {
    const before = (await pg.query('SELECT COUNT(*)::int AS n FROM studio_documents')).rows[0].n;
    await assert.rejects(make('alice', { projectId: 'pOther' }),
        (e) => e.status === 409 && e.errorClass === 'project_org_mismatch');
    await assert.rejects(make('alice', { projectId: 'missing' }),
        (e) => e.status === 404 && e.errorClass === 'project_not_found');
    await assert.rejects(make('alice', { projectId: 'p1', kind: 'template' }), (e) => e.status === 422);
    const afterCount = (await pg.query('SELECT COUNT(*)::int AS n FROM studio_documents')).rows[0].n;
    assert.strictEqual(afterCount, before);
});

test('the library list stays the owner\'s: a colleague\'s project document is not in it', async () => {
    const doc = await make('alice', { projectId: 'p1', name: 'Only in the project' });
    const bobs = await store.listDocuments('bob', { limit: 200 });
    assert.ok(!bobs.some(d => d.id === doc.id));
    const alices = await store.listDocuments('alice', { limit: 200 });
    assert.strictEqual(alices.find(d => d.id === doc.id).projectId, 'p1');
});

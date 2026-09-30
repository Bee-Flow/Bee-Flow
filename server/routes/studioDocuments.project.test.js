'use strict';

/**
 * A document filed into a collaborative project, through /api/studio-documents.
 *
 * The store decides who may read and edit (stores/documentStore.project.pg.test.js
 * proves that against a real Postgres); this proves what the ROUTES make of its
 * answer: `editable` and `deletable` for the editor screen, a 403 with a
 * sentence for a project viewer who tries to change the document, and a 403
 * for a member who tries to delete a colleague's document, where a stranger
 * still gets the 404 that hides the document exists.
 *
 * The real router behind a real express app (core/http/routeHarness.js): the
 * database is recorded, the session gates are session-only, and the store's
 * functions are swapped on the module object the router calls at request time
 * (testUtils/swaps.js). No module mocking.
 *
 * Run: cd server && node --test routes/studioDocuments.project.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');
const { makeSwaps } = require('../testUtils/swaps');

h.recordDb();
h.openGates({ hasPermission: async () => false });
const documentStore = require('../stores/documentStore');
const router = require('./studioDocuments');

const api = h.serve('/api/studio-documents', router);
test.after(api.close);

const DOC = { id: 'd1', userId: 'owner', name: 'Launch plan', docType: 'report', kind: 'document', visibility: 'private',
    bodyHtml: '<p>v1</p>', css: '', settings: {}, versionId: 'v1', projectId: 'p1', archived: false };
const MEMBERS = { editor: 'editor', viewer: 'viewer', powner: 'owner' };
const as = (id) => ({ id, organizationId: 'org1' });

const calls = { update: [], delete: [], restore: [], create: [] };
const { swap, restore } = makeSwaps();
test.before(() => {
    swap(documentStore, 'getDocument', async (id, context) => {
        const userId = typeof context === 'string' ? context : context?.userId;
        if (id !== DOC.id) return null;
        if (userId === DOC.userId) return structuredClone(DOC);
        const role = MEMBERS[userId];
        return role ? { ...structuredClone(DOC), projectRole: role } : null;
    });
    swap(documentStore, 'updateDocument', async (id, context, updates) => {
        calls.update.push({ id, userId: context.userId, updates });
        return { ...DOC, ...updates, versionId: 'v2' };
    });
    swap(documentStore, 'deleteDocument', async (id, context) => {
        calls.delete.push({ id, userId: context.userId });
        return id === DOC.id && context.userId === DOC.userId;
    });
    swap(documentStore, 'createDocument', async (input) => {
        calls.create.push(input);
        return { ...input, id: 'copy1', versionId: 'c1', projectId: input.projectId || null };
    });
    swap(documentStore, 'restoreVersion', async (id, context, versionId) => {
        calls.restore.push({ id, userId: context.userId, versionId });
        return { current: { ...DOC, versionId: 'v3' }, version: { id: 'v3', source: 'restore', restoredFrom: versionId } };
    });
});
test.after(restore);
test.beforeEach(() => { calls.update.length = 0; calls.delete.length = 0; calls.restore.length = 0; calls.create.length = 0; });

test('the editor screen learns what this reader may do', async () => {
    const owner = await api.call('GET', '/api/studio-documents/d1', { user: as('owner') });
    assert.strictEqual(owner.status, 200);
    assert.strictEqual(owner.body.document.editable, true);
    assert.strictEqual(owner.body.document.deletable, true);

    const editor = await api.call('GET', '/api/studio-documents/d1', { user: as('editor') });
    assert.strictEqual(editor.body.document.editable, true, 'a project editor edits the content');
    assert.strictEqual(editor.body.document.deletable, false, 'but only the owner archives it');
    assert.strictEqual(editor.body.document.projectRole, 'editor');

    const projectOwner = await api.call('GET', '/api/studio-documents/d1', { user: as('powner') });
    assert.strictEqual(projectOwner.body.document.editable, true);
    assert.strictEqual(projectOwner.body.document.deletable, false);

    const viewer = await api.call('GET', '/api/studio-documents/d1', { user: as('viewer') });
    assert.strictEqual(viewer.status, 200, 'a viewer reads it');
    assert.strictEqual(viewer.body.document.editable, false);
    assert.strictEqual(viewer.body.document.deletable, false);

    assert.strictEqual((await api.call('GET', '/api/studio-documents/d1', { user: as('stranger') })).status, 404);
    assert.strictEqual((await api.call('GET', '/api/studio-documents/d1', { user: null })).status, 401);
});

test('a project viewer who tries to save is told why, and nothing is written', async () => {
    const res = await api.call('PATCH', '/api/studio-documents/d1', { user: as('viewer'), body: { bodyHtml: '<p>no</p>', expectedVersionId: 'v1' } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'document_read_only');
    assert.match(res.body.error, /editors/);
    assert.deepStrictEqual(calls.update, []);
});

test('a project editor saves through the store, as themselves', async () => {
    const res = await api.call('PATCH', '/api/studio-documents/d1', { user: as('editor'), body: { bodyHtml: '<p>v2</p>', expectedVersionId: 'v1' } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.document.bodyHtml, '<p>v2</p>');
    assert.deepStrictEqual(calls.update.map(c => c.userId), ['editor']);
});

test('a stranger still gets a 404 on a save, never a hint that the document exists', async () => {
    const res = await api.call('PATCH', '/api/studio-documents/d1', { user: as('stranger'), body: { bodyHtml: 'x', expectedVersionId: 'v1' } });
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(calls.update, []);
});

test('deleting: the owner may; a member is told only the owner can; a stranger gets 404', async () => {
    const member = await api.call('DELETE', '/api/studio-documents/d1', { user: as('editor') });
    assert.strictEqual(member.status, 403);
    assert.strictEqual(member.body.code, 'document_owner_only');
    const projectOwner = await api.call('DELETE', '/api/studio-documents/d1', { user: as('powner') });
    assert.strictEqual(projectOwner.status, 403, 'owning the project is not owning the document');
    assert.strictEqual((await api.call('DELETE', '/api/studio-documents/d1', { user: as('stranger') })).status, 404);
    assert.strictEqual((await api.call('DELETE', '/api/studio-documents/d1', { user: as('owner') })).status, 200);
});

test('restoring a revision is an edit: refused for a viewer, done for an editor', async () => {
    const viewer = await api.call('POST', '/api/studio-documents/d1/versions/v0/restore', { user: as('viewer'), body: { expectedVersionId: 'v1' } });
    assert.strictEqual(viewer.status, 403);
    assert.strictEqual(viewer.body.code, 'document_read_only');
    assert.deepStrictEqual(calls.restore, []);
    const editor = await api.call('POST', '/api/studio-documents/d1/versions/v0/restore', { user: as('editor'), body: { expectedVersionId: 'v1' } });
    assert.strictEqual(editor.status, 200);
    assert.deepStrictEqual(calls.restore.map(c => c.userId), ['editor']);
    assert.strictEqual(editor.body.current.versionId, 'v3');
    assert.strictEqual(editor.body.version.restoredFrom, 'v0');
});

test('a copy of a project document is the copier\'s own private document, never filed into the project', async () => {
    // A viewer may read the document, so may copy it; the copy must not become
    // project content (that takes the editor role), and nothing of the source
    // row beyond its content travels along.
    const viewer = await api.call('POST', '/api/studio-documents/d1/duplicate', { user: as('viewer'), body: { kind: 'document' } });
    assert.strictEqual(viewer.status, 201, viewer.text);
    const [copy] = calls.create;
    assert.strictEqual(copy.userId, 'viewer');
    assert.strictEqual(copy.projectId, undefined, 'not filed into the source project');
    assert.strictEqual(copy.projectRole, undefined);
    assert.strictEqual(copy.visibility, 'private');
    assert.strictEqual(copy.folderId, null);
    assert.deepStrictEqual(copy.categories, [], "the owner's library filing stays theirs");
    assert.deepStrictEqual(Object.keys(copy).sort(), ['bodyHtml', 'categories', 'css', 'description', 'docType', 'folderId', 'kind', 'name', 'settings', 'userId', 'visibility']);
    assert.strictEqual(copy.bodyHtml, '<p>v1</p>');
    assert.deepStrictEqual(copy.settings.source, { documentId: 'd1', versionId: 'v1' });
    assert.strictEqual(viewer.body.document.projectId, null);
});

test('"Save a copy as template" works on a project document: the template is not filed into the project', async () => {
    const owner = await api.call('POST', '/api/studio-documents/d1/duplicate', { user: as('owner'), body: { kind: 'template', name: 'Plan template' } });
    assert.strictEqual(owner.status, 201, owner.text);
    assert.strictEqual(calls.create[0].kind, 'template');
    assert.strictEqual(calls.create[0].projectId, undefined, 'a template cannot be filed into a project (the store refuses with 422)');
    assert.strictEqual(calls.create[0].name, 'Plan template');
});

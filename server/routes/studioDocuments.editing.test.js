'use strict';

/**
 * Saving a document through PATCH /api/studio-documents/:id: what a client may
 * not decide about the revision it writes, a stale save merged or answered
 * with the parts to choose from, a live page refused instead of overwritten,
 * and the project change feed told about edits and renames. Plus the library
 * list's totals and the archive's way back.
 *
 * The real router behind a real express app (core/http/routeHarness.js), with
 * the store's and the feed helper's functions swapped on their module objects
 * (testUtils/swaps.js). No module mocking.
 *
 * Run: cd server && node --test routes/studioDocuments.editing.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');
const { makeSwaps } = require('../testUtils/swaps');

h.recordDb();
h.openGates({ hasPermission: async () => false });
const documentStore = require('../stores/documentStore');
const documentFeed = require('../core/documents/documentFeed');
const router = require('./studioDocuments');

const api = h.serve('/api/studio-documents', router);
test.after(api.close);

const DOC = { id: 'd1', userId: 'owner', name: 'Plan', docType: 'report', kind: 'document', visibility: 'private',
    bodyHtml: '<p>one</p>', css: '', settings: {}, versionId: 'v1', projectId: 'p1', archived: false };
const PAGE = { ...DOC, id: 'pg1', docType: 'page', settings: { houseStyle: false }, bodyHtml: '<h1>Minutes</h1><ul data-type="taskList"><li data-type="taskItem" data-checked="true">Done</li></ul>' };
const as = (id) => ({ id, organizationId: 'org1' });

const seen = { updates: [], feed: [], renamed: [], unarchive: [], kept: [] };
let live = false;
let updateImpl = null;
const { swap, restore } = makeSwaps();
test.before(() => {
    swap(documentStore, 'getDocument', async (id, context) => {
        const userId = typeof context === 'string' ? context : context?.userId;
        const base = id === 'd1' ? DOC : id === 'pg1' ? PAGE : null;
        if (!base) return null;
        if (userId === 'owner') return structuredClone(base);
        return userId === 'editor' ? { ...structuredClone(base), projectRole: 'editor' } : null;
    });
    swap(documentStore, 'updateDocument', async (id, context, updates) => {
        seen.updates.push({ id, userId: context.userId, updates });
        if (updateImpl) return updateImpl(id, context, updates);
        return { ...DOC, ...updates, versionId: 'v2' };
    });
    swap(documentStore, 'listDocumentsPage', async (_ctx, options) => ({ documents: [{ id: 'd1', userId: 'owner', updatedBy: 'editor', name: 'Plan', archived: options.archived }], total: 41 }));
    swap(documentStore, 'keepConflictCopy', async (id, context, html) => { seen.kept.push([id, context.userId, html]); return `conflict-${seen.kept.length}`; });
    swap(documentStore, 'unarchiveDocument', async (id, context) => { seen.unarchive.push([id, context.userId]); return id === 'd1' && context.userId === 'owner'; });
    swap(documentFeed, 'liveCollabFor', async (doc) => (live && doc.docType === 'page' ? {} : null));
    swap(documentFeed, 'recordContentChange', async (doc, change) => { seen.feed.push([doc.id, change.source, change.versionId, change.stats]); });
    swap(documentFeed, 'recordRenamed', async (doc, actorId) => { seen.renamed.push([doc.id, actorId]); });
});
test.after(restore);
test.beforeEach(() => { seen.updates.length = 0; seen.feed.length = 0; seen.renamed.length = 0; seen.unarchive.length = 0; seen.kept.length = 0; live = false; updateImpl = null; });

test('a client cannot say where its revision came from or who made it', async () => {
    const res = await api.call('PATCH', '/api/studio-documents/d1', { user: as('editor'), body: {
        bodyHtml: '<p>one two</p>', expectedVersionId: 'v1', source: 'named', contributors: [{ userId: 'owner', kind: 'ai' }], restoredFrom: 'v0',
    } });
    assert.strictEqual(res.status, 200, res.text);
    const { updates } = seen.updates[0];
    assert.strictEqual(updates.source, 'autosave');
    assert.strictEqual(updates.contributors, undefined);
    assert.strictEqual(updates.restoredFrom, undefined);
    assert.strictEqual(updates.mergeWith, undefined, 'no merge unless asked for');
});

test('a save tells the project feed what it changed, and a rename is its own entry', async () => {
    await api.call('PATCH', '/api/studio-documents/d1', { user: as('editor'), body: { bodyHtml: '<p>one two three</p>', name: 'Plan B', expectedVersionId: 'v1' } });
    assert.deepStrictEqual(seen.feed, [['d1', 'autosave', 'v2', { wordsAdded: 2, wordsRemoved: 0, blocksChanged: 1 }]]);
    assert.deepStrictEqual(seen.renamed, [['d1', 'editor']]);
});

test('asking for a merge hands the store the section merge, and the merge result reaches the editor', async () => {
    updateImpl = async (_id, _ctx, updates) => {
        assert.strictEqual(typeof updates.mergeWith, 'function');
        return { ...DOC, bodyHtml: '<p>merged</p>', versionId: 'v3', merge: { merged: true, fromOthers: ['pricing'], othersOutsideSections: false } };
    };
    const res = await api.call('PATCH', '/api/studio-documents/d1', { user: as('editor'), body: { bodyHtml: '<p>mine</p>', expectedVersionId: 'v0', merge: true } });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.document.merge, { merged: true, fromOthers: ['pricing'], othersOutsideSections: false });
});

test('a conflicting stale save answers 409 with the parts to choose from', async () => {
    updateImpl = async () => {
        throw Object.assign(new Error('This document changed while you were editing.'), {
            status: 409, errorClass: 'document_conflict',
            conflict: { currentVersionId: 'v5', parts: [{ kind: 'conflict', key: 'pricing/0', label: 'Pricing', base: 'b', mine: 'm', theirs: 't' }] },
        });
    };
    const res = await api.call('PATCH', '/api/studio-documents/d1', { user: as('editor'), body: { bodyHtml: '<p>mine</p>', expectedVersionId: 'v0', merge: true } });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'document_conflict');
    assert.strictEqual(res.body.conflict.currentVersionId, 'v5');
    assert.strictEqual(res.body.conflict.parts[0].label, 'Pricing');
    assert.deepStrictEqual(seen.feed, [], 'nothing was saved, nothing is reported');
});

test('a body save to a page edited live is refused, never written over it; a rename still works', async () => {
    live = true;
    const res = await api.call('PATCH', '/api/studio-documents/pg1', { user: as('editor'), body: { bodyHtml: '<p>stale tab</p>', expectedVersionId: 'v1' } });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'document_live');
    assert.deepStrictEqual(seen.updates, []);
    assert.deepStrictEqual(seen.kept, [['pg1', 'editor', '<p>stale tab</p>']], 'the refused text is kept as a conflict version');
    assert.strictEqual(res.body.conflictVersionId, 'conflict-1', 'and the page is told which one');
    const rename = await api.call('PATCH', '/api/studio-documents/pg1', { user: as('editor'), body: { name: 'Minutes', expectedVersionId: 'v1' } });
    assert.strictEqual(rename.status, 200);
});

test('a page that went live between the check and the write: the store refuses, the text is kept all the same', async () => {
    updateImpl = async () => {
        throw Object.assign(new Error('This page is being edited live.'), { status: 409, errorClass: 'document_live' });
    };
    const res = await api.call('PATCH', '/api/studio-documents/pg1', { user: as('editor'), body: { bodyHtml: '<p>typed solo</p>', expectedVersionId: 'v1' } });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'document_live');
    assert.strictEqual(res.body.conflictVersionId, 'conflict-1');
    assert.deepStrictEqual(seen.kept, [['pg1', 'editor', '<p>typed solo</p>']]);
    assert.deepStrictEqual(seen.feed, [], 'nothing was saved, nothing is reported');
});

test('an unchanged save reports nothing to the feed', async () => {
    updateImpl = async () => ({ ...DOC });
    await api.call('PATCH', '/api/studio-documents/d1', { user: as('owner'), body: { bodyHtml: '<p>one</p>', expectedVersionId: 'v1' } });
    assert.deepStrictEqual(seen.feed, []);
});

test('the library list answers a total and the people it names; the archive view is asked for explicitly', async () => {
    const res = await api.call('GET', '/api/studio-documents?limit=30&offset=30&archived=1', { user: as('owner') });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.total, 41);
    assert.strictEqual(res.body.documents[0].archived, true);
    assert.deepStrictEqual(Object.keys(res.body.people).sort(), [], 'names come from the user store, which has nobody here');
});

test('unarchive: the owner brings a document back; anybody else gets 404', async () => {
    assert.strictEqual((await api.call('POST', '/api/studio-documents/d1/unarchive', { user: as('owner') })).status, 200);
    assert.strictEqual((await api.call('POST', '/api/studio-documents/d1/unarchive', { user: as('editor') })).status, 404);
    assert.deepStrictEqual(seen.unarchive, [['d1', 'owner'], ['d1', 'editor']]);
});

test('a page previews and prints with the page sheet, its body sanitised by the composer', async () => {
    const res = await api.call('GET', '/api/studio-documents/pg1/preview', { user: as('editor') });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(res.text, /ul\[data-type="taskList"\]/, 'the page sheet is the document\'s sheet');
    assert.match(res.text, /<h1>Minutes<\/h1>/);
    const designed = await api.call('GET', '/api/studio-documents/d1/preview', { user: as('owner') });
    assert.doesNotMatch(designed.text, /ul\[data-type="taskList"\]/, 'a designed document keeps its own sheet');
});

'use strict';

/**
 * Notebooks in the Documents library (studioDocuments/notebooks.js): filing a
 * notebook is its owner's and sits behind the notebook gates; the library asks
 * the same gates whether to list notebooks at all.
 *
 * Run: cd server && node --test routes/studioDocuments/notebooks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');
const { makeNotebookLibraryRouter } = require('./notebooks');

const filings = [];
let gateOpen = true;
/** owner's notebooks by id: whether each is archived */
const owned = new Map();
const calls = [];
const router = makeNotebookLibraryRouter({
    library: {
        async setNotebookArchived(userId, id, archived) {
            if (userId !== 'owner' || !owned.has(id)) return null;
            if (!archived && !owned.get(id)) return null;
            owned.set(id, archived);
            calls.push(['archived', id, archived]);
            return { id, name: 'Research', folderId: null, categories: [], updatedAt: '2026-11-20T00:00:00.000Z' };
        },
        async ownNotebookState(userId, id) {
            return userId === 'owner' && owned.has(id) ? { archived: owned.get(id) } : null;
        },
        async setNotebookFiling(userId, id, filing, assertFolder) {
            if (id !== 'nb1' || userId !== 'owner') return null;
            if (filing.folderId) await assertFolder(filing.folderId, userId);
            filings.push([userId, id, filing]);
            return { folderId: filing.folderId ?? null, categories: filing.categories || [] };
        },
    },
    documents: {
        async assertFolder(folderId) {
            if (folderId !== 'f1') throw Object.assign(new Error('Folder not found'), { status: 404 });
        },
    },
    lifecycle: {
        async beforeDelete(kind, id, userId) { calls.push(['beforeDelete', kind, id, userId]); },
        async dropTaskLinks(kind, id) { calls.push(['dropTaskLinks', kind, id]); },
        async deleteForGood(id, userId) { calls.push(['deleteForGood', id, userId]); owned.delete(id); return { deleted: true, sources: 2, kbs: 1 }; },
        forgetTokens(id) { calls.push(['forgetTokens', id]); },
    },
    gate: (req, res, next) => (gateOpen ? next() : res.status(403).json({ error: 'Notebooks are not available to you.', code: 'notebooks_unavailable' })),
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })),
});
const api = h.serve('/api/studio-documents', router);
test.after(api.close);
test.beforeEach(() => { filings.length = 0; gateOpen = true; calls.length = 0; owned.clear(); owned.set('nb1', false); });

const file = (user, body, id = 'nb1') => api.call('PATCH', `/api/studio-documents/notebooks/${id}/filing`, { user: user && { id: user, organizationId: 'org1' }, body });

test('the owner files a notebook in a folder and under categories', async () => {
    const res = await file('owner', { folderId: 'f1', categories: ['Acme'] });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { folderId: 'f1', categories: ['Acme'] });
    assert.deepStrictEqual(filings, [['owner', 'nb1', { folderId: 'f1', categories: ['Acme'] }]]);
});

test('back to the root folder is a null folder', async () => {
    const res = await file('owner', { folderId: null });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.folderId, null);
});

test('somebody who does not own it, or a notebook that is not there, is a 404', async () => {
    assert.strictEqual((await file('colleague', { categories: ['x'] })).status, 404);
    assert.strictEqual((await file('owner', { categories: ['x'] }, 'nope')).status, 404);
});

test('a folder that is not yours is refused', async () => {
    const res = await file('owner', { folderId: 'someone-elses' });
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(filings, []);
});

test('a malformed body is a 400 and writes nothing', async () => {
    assert.strictEqual((await file('owner', { categories: 'Acme' })).status, 400);
    assert.strictEqual((await file('owner', { categories: Array.from({ length: 31 }, (_, i) => `c${i}`) })).status, 400);
    assert.deepStrictEqual(filings, []);
});

test('the notebook gates come first, and are the library\'s question too', async () => {
    gateOpen = false;
    const res = await file('owner', { categories: ['Acme'] });
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(filings, []);
    assert.strictEqual((await file(null, { categories: ['Acme'] })).status, 401);
});

test('notebooksVisible answers the gates as a yes or no, never throws', async () => {
    const req = { session: { user: { id: 'owner' } } };
    assert.strictEqual(await router.notebooksVisible(req), true);
    gateOpen = false;
    assert.strictEqual(await router.notebooksVisible(req), false);
    const broken = makeNotebookLibraryRouter({ gate: () => { throw new Error('entitlements down'); } });
    assert.strictEqual(await broken.notebooksVisible(req), false);
});

const as = (user) => user && { id: user, organizationId: 'org1' };
const archive = (user, id = 'nb1') => api.call('POST', `/api/studio-documents/notebooks/${id}/archive`, { user: as(user), body: {} });
const restore = (user, id = 'nb1') => api.call('POST', `/api/studio-documents/notebooks/${id}/unarchive`, { user: as(user), body: {} });
const remove = (user, id = 'nb1') => api.call('DELETE', `/api/studio-documents/notebooks/${id}`, { user: as(user) });

test('the owner archives a notebook: co-editing folded back first, task links dropped after', async () => {
    const res = await archive('owner');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { success: true });
    assert.deepStrictEqual(calls, [['beforeDelete', 'notebook', 'nb1', 'owner'], ['archived', 'nb1', true], ['dropTaskLinks', 'notebook', 'nb1']]);
    assert.strictEqual(owned.get('nb1'), true);
});

test('only the owner archives or restores; anybody else gets the notebook\'s 404', async () => {
    assert.strictEqual((await archive('colleague')).status, 404);
    assert.strictEqual((await archive('owner', 'nope')).status, 404);
    owned.set('nb1', true);
    assert.strictEqual((await restore('colleague')).status, 404);
    assert.strictEqual(owned.get('nb1'), true);
    assert.ok(!calls.some((c) => c[0] === 'dropTaskLinks'));
});

test('restoring brings the notebook back as a library row; a live one is not restored', async () => {
    assert.strictEqual((await restore('owner')).status, 404);
    owned.set('nb1', true);
    const res = await restore('owner');
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.document.id, 'nb1');
    assert.strictEqual(res.body.document.docType, 'notebook');
    assert.strictEqual(res.body.document.archived, false);
    assert.strictEqual(owned.get('nb1'), false);
});

test('a live notebook is never deleted for good: archive it first', async () => {
    const res = await remove('owner');
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'notebook_not_archived');
    assert.ok(!calls.some((c) => c[0] === 'deleteForGood'));
    assert.ok(owned.has('nb1'));
});

test('an archived notebook is deleted for good by its owner, with everything it holds', async () => {
    owned.set('nb1', true);
    assert.strictEqual((await remove('colleague')).status, 404);
    const res = await remove('owner');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(calls, [['deleteForGood', 'nb1', 'owner'], ['forgetTokens', 'nb1']]);
    assert.strictEqual((await remove('owner')).status, 404);
});

test('archive, restore and delete sit behind sign-in and the notebook gates', async () => {
    gateOpen = false;
    assert.strictEqual((await archive('owner')).status, 403);
    assert.strictEqual((await restore('owner')).status, 403);
    assert.strictEqual((await remove('owner')).status, 403);
    gateOpen = true;
    assert.strictEqual((await archive(null)).status, 401);
    assert.deepStrictEqual(calls, []);
});

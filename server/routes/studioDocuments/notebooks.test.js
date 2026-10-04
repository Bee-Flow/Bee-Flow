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
const h = require('../../core/http/routeHarness');
const { makeNotebookLibraryRouter } = require('./notebooks');

const filings = [];
let gateOpen = true;
const router = makeNotebookLibraryRouter({
    library: {
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
    gate: (req, res, next) => (gateOpen ? next() : res.status(403).json({ error: 'Notebooks are not available to you.', code: 'notebooks_unavailable' })),
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })),
});
const api = h.serve('/api/studio-documents', router);
test.after(api.close);
test.beforeEach(() => { filings.length = 0; gateOpen = true; });

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

'use strict';

/**
 * The notebook store's public surface, pinned before the store was split into
 * stores/notebook/*: the exported keys (in order) and one golden round trip
 * over notebooks, sources, versions and project membership against a REAL
 * Postgres (@electric-sql/pglite behind db.js's pool), with no module mocking.
 *
 * Run: cd server && node --test stores/notebookStore.surface.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./notebookStore');

before(async () => {
    await pg.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');
        INSERT INTO projects VALUES ('p1','alice','org1');`);
    await store.initDB();
});

after(close);

test('the barrel exports exactly the keys it always did, in order', () => {
    assert.deepStrictEqual(Object.keys(store), [
        'MAX_CARD_LIMIT', 'createNotebook', 'getNotebooks', 'listNotebookCards', 'buildListCardsQuery',
        'mapNotebookCardRow', 'getNotebook', 'updateNotebook', 'updateNotebookCas', 'touchActivity',
        'attachKnowledgeBaseIfAbsent', 'deleteNotebook',
        'resolveNotebookRole', 'notebookRoleForProjectRole', 'setNotebookProject', 'detachNotebookFromProject',
        'listProjectNotebooks', 'countProjectNotebooks', 'clearProjectFromNotebooks',
        'addSource', 'getSources', 'getSource', 'getSourceContent', 'getSourceStatus', 'countSources',
        'deleteSources', 'reorderSources', 'updateSource', 'claimSourceForRetry', 'deleteSource', 'timeoutStuckSources',
        'VERSION_SOURCES', 'VERSION_NAME_MAX', 'recordVersion', 'latestVersion', 'listVersions', 'createVersion',
        'getVersions', 'getVersion', 'getNotebookVersion', 'nameVersion', 'deleteVersion', 'shouldAutoVersion',
        'contentHash', 'writeCollabContent', 'initDB',
    ]);
    assert.strictEqual(store.MAX_CARD_LIMIT, 200);
    assert.strictEqual(store.VERSION_NAME_MAX, 80);
    assert.ok(Object.isFrozen(store.VERSION_SOURCES));
    assert.match(store.contentHash('<p>x</p>'), /^[0-9a-f]{64}$/);
    assert.strictEqual(store.notebookRoleForProjectRole('owner'), 'editor');
    assert.strictEqual(store.notebookRoleForProjectRole('viewer'), 'viewer');
    assert.strictEqual(store.notebookRoleForProjectRole(null), null);
});

test('notebook CRUD: create, CAS write with Markdown mirror and card fields, read, list, delete', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'Golden', description: 'd', settings: { a: 1 } });
    assert.deepStrictEqual(
        { name: nb.name, description: nb.description, settings: nb.settings, type: nb.type, projectId: nb.projectId, documentContent: nb.documentContent },
        { name: 'Golden', description: 'd', settings: { a: 1 }, type: 'notebook', projectId: null, documentContent: '' });

    assert.deepStrictEqual(await store.updateNotebookCas(nb.id, 'alice', {}), { ok: false, conflict: false, noop: true });
    const w = await store.updateNotebookCas(nb.id, 'alice', { documentContent: '<h1>Title</h1><p>one two three</p>', expectedVersion: 0 });
    assert.deepStrictEqual(w, { ok: true, conflict: false, version: 1 });
    const stale = await store.updateNotebookCas(nb.id, 'alice', { documentContent: '<p>late</p>', expectedVersion: 0 });
    assert.deepStrictEqual(stale, { ok: false, conflict: true, currentVersion: 1 });
    assert.strictEqual(await store.updateNotebook(nb.id, 'mallory', { name: 'x' }), false, 'a stranger cannot write');

    const got = await store.getNotebook(nb.id, 'alice');
    assert.strictEqual(got.role, 'owner');
    assert.strictEqual(got.version, 1);
    assert.strictEqual(got.documentFormat, 'html');
    assert.match(got.documentMd, /^# Title/);
    assert.strictEqual(got.lastEditedBy, 'alice');
    assert.strictEqual(await store.getNotebook(nb.id, 'mallory'), null);
    const row = (await pg.query('SELECT preview, doc_word_count FROM notebooks WHERE id = $1', [nb.id])).rows[0];
    assert.strictEqual(row.doc_word_count, 4);

    const list = await store.getNotebooks('alice');
    assert.ok(list.some(n => n.id === nb.id && n.documentContent.includes('Title')));

    assert.strictEqual(await store.attachKnowledgeBaseIfAbsent(nb.id, 'alice', 'kb1'), 'kb1');
    assert.strictEqual(await store.attachKnowledgeBaseIfAbsent(nb.id, 'alice', 'kb2'), 'kb1', 'the first KB wins');

    assert.strictEqual(await store.deleteNotebook(nb.id, 'mallory'), null);
    const gone = await store.deleteNotebook(nb.id, 'alice');
    assert.strictEqual(gone.id, nb.id);
    assert.strictEqual(await store.getNotebook(nb.id, 'alice'), null);
});

test('sources: add in order, read, reorder, update, retry claim, delete', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'Sources' });
    const a = await store.addSource({ notebookId: nb.id, type: 'text', name: 'A', contentText: 'alpha', wordCount: 1 });
    const b = await store.addSource({ notebookId: nb.id, type: 'url', name: 'B', metadata: { url: 'https://example.test' } });
    assert.strictEqual(await store.countSources(nb.id), 2);
    assert.deepStrictEqual((await store.getSources(nb.id)).map(s => [s.name, s.sortOrder, s.hasContent]), [['A', 1, true], ['B', 2, false]]);
    assert.strictEqual(await store.getSourceContent(a.id), 'alpha');
    assert.deepStrictEqual((await store.getSource(b.id)).metadata, { url: 'https://example.test' });

    await store.reorderSources(nb.id, [b.id, a.id]);
    assert.deepStrictEqual((await store.getSources(nb.id)).map(s => s.name), ['B', 'A']);

    await store.updateSource(a.id, { status: 'error', error: 'boom' });
    assert.strictEqual((await store.getSourceStatus(a.id)), 'error');
    assert.ok(await store.claimSourceForRetry(a.id));
    assert.strictEqual((await store.getSourceStatus(a.id)), 'processing');
    assert.strictEqual(await store.timeoutStuckSources(nb.id, { stuckMinutes: 10 }), 0);

    assert.strictEqual(await store.deleteSource(a.id, 'other-notebook'), null);
    assert.strictEqual((await store.deleteSource(a.id, nb.id)).id, a.id);
    assert.deepStrictEqual((await store.deleteSources([b.id], nb.id)).map(s => s.id), [b.id]);
    assert.strictEqual(await store.countSources(nb.id), 0);
    const activity = (await pg.query('SELECT last_activity_kind FROM notebooks WHERE id = $1', [nb.id])).rows[0];
    assert.strictEqual(activity.last_activity_kind, 'source');
});

test('versions: record, dedupe, name, list, read, delete, auto-version debounce', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'History' });
    assert.strictEqual(await store.shouldAutoVersion(nb.id), true);
    const v1 = await store.recordVersion(nb.id, { html: '<p>one</p>', source: 'checkpoint', createdBy: 'alice' });
    assert.strictEqual(v1.seq, 1);
    assert.strictEqual(v1.deduped, false);
    const again = await store.recordVersion(nb.id, { html: '<p>one</p>', source: 'autosave' });
    assert.strictEqual(again.deduped, true);
    assert.strictEqual(again.id, v1.id);
    const v2 = await store.createVersion(nb.id, '<p>two</p>', 'Manual snapshot', { createdBy: 'alice' });
    assert.ok(v2);
    assert.strictEqual(await store.shouldAutoVersion(nb.id), false);
    assert.strictEqual((await store.latestVersion(nb.id)).seq, 2);

    const named = await store.nameVersion(nb.id, v1.id, '  Final   draft ');
    assert.strictEqual(named.name, 'Final draft');
    const page = await store.listVersions(nb.id);
    assert.deepStrictEqual(page.versions.map(v => v.seq), [2, 1]);
    assert.strictEqual((await store.getNotebookVersion(nb.id, v1.id)).html, '<p>one</p>');
    assert.strictEqual((await store.getVersion(v1.id)).content, '<p>one</p>');
    assert.strictEqual((await store.getVersions(nb.id)).length, 2);
    assert.strictEqual(await store.deleteVersion(v2.id, 'other'), false);
    assert.strictEqual(await store.deleteVersion(v2.id, nb.id), true);
    assert.strictEqual((await store.getVersions(nb.id)).length, 1);
});

test('project membership: file in, role, list, count, detach, clear, co-edit write', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'Shared' });
    assert.strictEqual(await store.setNotebookProject(nb.id, 'bob', 'p1'), false, 'only the owner files it');
    assert.strictEqual(await store.setNotebookProject(nb.id, 'alice', 'p1'), true);
    assert.strictEqual(await store.resolveNotebookRole(nb.id, 'alice'), 'owner');
    assert.strictEqual(await store.resolveNotebookRole(nb.id, 'stranger'), null);
    assert.deepStrictEqual((await store.listProjectNotebooks('p1')).map(c => c.id), [nb.id]);
    assert.deepStrictEqual([...(await store.countProjectNotebooks(['p1', 'p9']))], [['p1', 1]]);

    const collab = await store.writeCollabContent(nb.id, { html: '<p>live text</p>', editedBy: 'bob' });
    assert.ok(collab && typeof collab.version === 'number');
    const after = await store.getNotebook(nb.id, 'alice');
    assert.strictEqual(after.documentContent, '<p>live text</p>');
    assert.strictEqual(after.lastEditedBy, 'bob');
    assert.strictEqual(await store.writeCollabContent('missing', { html: '<p>x</p>' }), null);

    assert.strictEqual(await store.detachNotebookFromProject(nb.id, 'p2'), false, 'scoped to the named project');
    assert.strictEqual(await store.detachNotebookFromProject(nb.id, 'p1'), true);
    await store.setNotebookProject(nb.id, 'alice', 'p1');
    assert.strictEqual(await store.clearProjectFromNotebooks('p1'), 1);
    assert.strictEqual((await store.getNotebook(nb.id, 'alice')).projectId, null);
});

'use strict';

/**
 * Notebooks in a project, against a REAL Postgres (@electric-sql/pglite behind
 * db.js's pool, testUtils/pglitePool.js), with no module mocking.
 *
 *   - the project listing is CARD-shaped: counts and the cached preview, never
 *     the document bodies (it used to ship every notebook's whole document,
 *     twice, on each project page load);
 *   - a notebook can be created straight into a project;
 *   - the project owner can take a colleague's notebook out of THEIR project,
 *     and only out of that one; it is never deleted by that.
 *
 * Run: cd server && node --test stores/notebookStore.project.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./notebookStore');

before(async () => {
    await pg.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');
        INSERT INTO projects VALUES ('p1','alice','org1'), ('p2','alice','org1');`);
    await store.initDB();
});

after(close);

const BODY = '<h1>Findings</h1><p>' + 'The full document body. '.repeat(40) + '</p>';

test('a notebook created into a project is filed there and stamped with its organisation', async () => {
    const nb = await store.createNotebook({ userId: 'bob', name: 'Research', projectId: 'p1', organizationId: 'org1' });
    assert.strictEqual(nb.projectId, 'p1');
    const row = (await pg.query('SELECT project_id, organization_id FROM notebooks WHERE id = $1', [nb.id])).rows[0];
    assert.deepStrictEqual(row, { project_id: 'p1', organization_id: 'org1' });
    // Without a project it is the standalone notebook it always was.
    const plain = await store.createNotebook({ userId: 'bob', name: 'Private' });
    assert.strictEqual(plain.projectId, null);
    assert.strictEqual((await pg.query('SELECT project_id FROM notebooks WHERE id = $1', [plain.id])).rows[0].project_id, null);
});

test('the project listing carries cards, never document bodies', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'Cards', projectId: 'p2', organizationId: 'org1' });
    assert.ok(await store.updateNotebook(nb.id, 'alice', { documentContent: BODY }));
    await store.addSource({ notebookId: nb.id, type: 'text', name: 'Notes', contentText: 'x', wordCount: 3 });

    const cards = await store.listProjectNotebooks('p2');
    const card = cards.find(c => c.id === nb.id);
    assert.ok(card, 'listed');
    for (const heavy of ['documentContent', 'documentMd', 'instructions', 'settings', 'knowledgeBaseIds']) {
        assert.ok(!(heavy in card), `${heavy} is not on a card`);
    }
    // What is one person's own does not travel with the project card either.
    for (const own of ['pinned', 'pinnedAt', 'messageCount']) assert.ok(!(own in card), `${own} is the owner's`);
    assert.strictEqual(card.userId, 'alice', 'whose it is, so the page knows who may remove it');
    assert.strictEqual(card.projectId, 'p2');
    assert.strictEqual(card.sourceCount, 1);
    assert.ok(card.docWordCount > 0);
    assert.ok(card.preview.startsWith('Findings'), 'the cached excerpt, not the body');
    assert.ok(card.preview.length <= 300);
    assert.ok(!JSON.stringify(cards).includes('<h1>'), 'no markup anywhere in the listing');
});

test('the project owner takes a colleague\'s notebook out of their own project only', async () => {
    const nb = await store.createNotebook({ userId: 'bob', name: 'Bob\'s', projectId: 'p1', organizationId: 'org1' });
    assert.strictEqual(await store.detachNotebookFromProject(nb.id, 'p2'), false, 'not filed in p2');
    assert.strictEqual(await store.detachNotebookFromProject(nb.id, 'p1'), true);
    const row = (await pg.query('SELECT user_id, project_id FROM notebooks WHERE id = $1', [nb.id])).rows[0];
    assert.deepStrictEqual(row, { user_id: 'bob', project_id: null }, 'still bob\'s, no longer in the project');
    assert.strictEqual(await store.detachNotebookFromProject(nb.id, 'p1'), false, 'nothing left to take out');
    assert.strictEqual(await store.detachNotebookFromProject('', 'p1'), false);
});

test('the owner\'s own removal is scoped to the project AND to the owner', async () => {
    // Filed in p2 now; a stale removal through p1 must leave it there.
    const nb = await store.createNotebook({ userId: 'carol', name: 'Moved', projectId: 'p2', organizationId: 'org1' });
    assert.strictEqual(await store.detachNotebookFromProject(nb.id, 'p1', 'carol'), false, 'not filed in p1');
    assert.strictEqual((await pg.query('SELECT project_id FROM notebooks WHERE id = $1', [nb.id])).rows[0].project_id, 'p2');
    assert.strictEqual(await store.detachNotebookFromProject(nb.id, 'p2', 'dave'), false, 'not dave\'s notebook');
    assert.strictEqual((await pg.query('SELECT project_id FROM notebooks WHERE id = $1', [nb.id])).rows[0].project_id, 'p2');
    assert.strictEqual(await store.detachNotebookFromProject(nb.id, 'p2', 'carol'), true);
    assert.strictEqual((await pg.query('SELECT project_id FROM notebooks WHERE id = $1', [nb.id])).rows[0].project_id, null);
});

test('a meeting source records which meeting it came from, so the meeting can name the notebook', async () => {
    const { usageForMeeting } = require('../core/meetingNotes/meetingUsage');
    const nb = await store.createNotebook({ userId: 'alice', name: 'Meeting digest' });
    await store.addSource({ notebookId: nb.id, type: 'meeting', name: 'Meeting Note: Kick-off', sourceRefId: 'meet-1', contentText: 'x', wordCount: 1 });
    const row = (await pg.query('SELECT source_ref_id FROM notebook_sources WHERE notebook_id = $1', [nb.id])).rows[0];
    assert.strictEqual(row.source_ref_id, 'meet-1');

    const db = { query: (sql, params) => pg.query(sql, params) };
    const { rows, partial } = await usageForMeeting({ id: 'meet-1', tags: [], ownerId: 'alice' }, { db });
    assert.ok(!partial.includes('notebook'), `notebooks were checked (partial: ${partial})`);
    assert.ok(rows.some(r => r.kind === 'notebook' && r.id === nb.id), 'the notebook that holds the meeting is named');
});

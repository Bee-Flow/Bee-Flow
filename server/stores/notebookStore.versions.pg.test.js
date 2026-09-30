'use strict';

/**
 * Notebook versions, roles and co-editing hooks against a REAL Postgres
 * (@electric-sql/pglite behind db.js's pool, testUtils/pglitePool.js), with no
 * module mocking: the project-role lookup is swapped on its shared object
 * (stores/lib/projectRole.js `lookup`).
 *
 *   - versions written before the uniform model are numbered on boot, oldest
 *     first, and keep source 'legacy';
 *   - recordVersion numbers per notebook, skips an automatic snapshot of
 *     unchanged content, but never skips a named version or a conflict copy;
 *   - the list pages with a cursor until every version was seen;
 *   - pruning spares named and restore versions and one a member last saw;
 *   - a project editor who loses a race gets a conflict (it used to be a 404);
 *   - no single-writer content write lands while a co-editing document exists;
 *   - writeCollabContent refreshes the mirrors and the card fields.
 *
 * Run: cd server && node --test stores/notebookStore.versions.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const projectRole = require('./lib/projectRole');
const store = require('./notebookStore');

const { swap, restore } = makeSwaps();
const ROLES = { 'p1:erin': 'editor', 'p1:vic': 'viewer', 'p1:olga': 'owner' };

before(async () => {
    swap(projectRole.lookup, 'roleOf', async (userId, projectId) => ROLES[`${projectId}:${userId}`] || null);
    // The pre-model shape, with three snapshots in it, so boot has something to number.
    await pg.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY);
        INSERT INTO projects VALUES ('p1');
        CREATE TABLE notebooks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT 'Untitled Notebook',
            description TEXT DEFAULT '', instructions TEXT DEFAULT '', knowledge_base_ids JSONB DEFAULT '[]'::jsonb,
            settings JSONB DEFAULT '{}'::jsonb, document_content TEXT DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        INSERT INTO notebooks (id, user_id) VALUES ('legacy', 'alice');
        CREATE TABLE notebook_versions (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
            content TEXT NOT NULL DEFAULT '', summary TEXT DEFAULT '', content_length INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        INSERT INTO notebook_versions (id, notebook_id, content, summary, created_at) VALUES
            ('old-2', 'legacy', '<p>two</p>', 'Auto-save', NOW() - INTERVAL '2 days'),
            ('old-1', 'legacy', '<p>one</p>', 'Manual snapshot', NOW() - INTERVAL '3 days'),
            ('old-3', 'legacy', '<p>three</p>', 'Before AI edit', NOW() - INTERVAL '1 day');
    `);
    await store.initDB();
});

after(async () => { restore(); await close(); });

test('versions from before the model are numbered oldest first and stay legacy', async () => {
    const { versions } = await store.listVersions('legacy');
    assert.deepStrictEqual(versions.map(v => [v.id, v.seq, v.source]), [
        ['old-3', 3, 'legacy'], ['old-2', 2, 'legacy'], ['old-1', 1, 'legacy'],
    ]);
    assert.strictEqual(versions[2].summary, 'Manual snapshot', 'the old label is still there to show');
    // A new version continues the numbering.
    const v = await store.recordVersion('legacy', { html: '<p>four</p>', source: 'checkpoint', createdBy: 'alice' });
    assert.strictEqual(v.seq, 4);
});

test('recordVersion numbers per notebook, skips unchanged automatic snapshots, names instead of copying', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'V' });
    const a = await store.recordVersion(nb.id, {
        html: '<p>Draft</p>', markdown: 'Draft', source: 'checkpoint',
        contributors: [{ userId: 'alice', kind: 'user' }, { userId: 'alice', kind: 'user' }, { kind: 'user' }, { userId: 'alice', kind: 'ai', note: 'dropped' }],
        stats: { wordsAdded: 1, wordsRemoved: 0, text: 'never stored' },
        createdBy: 'alice',
    });
    assert.strictEqual(a.seq, 1);
    assert.strictEqual(a.deduped, false);
    assert.deepStrictEqual(a.contributors, [{ userId: 'alice', kind: 'user' }, { userId: 'alice', kind: 'ai' }], 'deduplicated, ids only');
    assert.deepStrictEqual(a.stats, { wordsAdded: 1, wordsRemoved: 0 }, 'counts only');

    const again = await store.recordVersion(nb.id, { html: '<p>Draft</p>', source: 'autosave' });
    assert.strictEqual(again.deduped, true);
    assert.strictEqual(again.id, a.id, 'the unchanged state is the version that already exists');

    // Naming the state the newest version holds names THAT version (Studio's
    // rule): a named row is kept for ever, so a copy per request grew without bound.
    const named = await store.recordVersion(nb.id, { html: '<p>Draft</p>', source: 'named', name: '  Sent   to  legal  ' });
    assert.strictEqual(named.deduped, true);
    assert.strictEqual(named.id, a.id);
    assert.strictEqual(named.name, 'Sent to legal');
    const renamed = await store.recordVersion(nb.id, { html: '<p>Draft</p>', source: 'named', name: 'Final' });
    assert.strictEqual(renamed.id, a.id, 'asking again adds no row either');
    assert.strictEqual(renamed.name, 'Final');
    assert.strictEqual((await store.listVersions(nb.id)).versions.length, 1);
    // A state no version holds yet is a named row of its own.
    const moved = await store.recordVersion(nb.id, { html: '<p>Draft 2</p>', source: 'named', name: 'Second' });
    assert.strictEqual(moved.deduped, false);
    assert.strictEqual(moved.seq, 2);
    assert.strictEqual(moved.source, 'named');
    const conflict = await store.recordVersion(nb.id, { html: '<p>Mine</p><script>x()</script>', source: 'conflict' });
    assert.strictEqual(conflict.deduped, false, 'a rescued copy of different content gets its own row');
    assert.strictEqual((await store.getNotebookVersion(nb.id, conflict.id)).html, '<p>Mine</p>', 'sanitised like every document write');
    const same = await store.recordVersion(nb.id, { html: '<p>Mine</p>', source: 'conflict' });
    assert.strictEqual(same.id, conflict.id, 'the same copy twice is one version');

    const full = await store.getNotebookVersion(nb.id, a.id);
    assert.strictEqual(full.html, '<p>Draft</p>');
    assert.strictEqual(full.markdown, 'Draft');
    assert.strictEqual(await store.getNotebookVersion('legacy', a.id), null, 'a foreign id never resolves');

    const bogus = await store.recordVersion(nb.id, { html: '<p>x</p>', source: 'made-up' });
    assert.strictEqual(bogus.source, 'checkpoint', 'an unknown source is a checkpoint');
});

test('the list pages with a cursor until every version was seen', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'Paging' });
    for (let i = 1; i <= 7; i++) await store.recordVersion(nb.id, { html: `<p>${i}</p>`, source: 'checkpoint' });
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
        const page = await store.listVersions(nb.id, { cursor, limit: 3 });
        seen.push(...page.versions.map(v => v.seq));
        cursor = page.nextCursor;
        pages++;
    } while (cursor && pages < 10);
    assert.deepStrictEqual(seen, [7, 6, 5, 4, 3, 2, 1]);
    assert.strictEqual(pages, 3);
    const junk = await store.listVersions(nb.id, { cursor: '1; DROP TABLE x', limit: 2 });
    assert.deepStrictEqual(junk.versions.map(v => v.seq), [7, 6], 'a cursor that is not a number starts at the top');
});

test('naming a version, clearing the name, and pruning that spares protected versions', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'Prune' });
    const keep = await store.recordVersion(nb.id, { html: '<p>first</p>', source: 'checkpoint' });
    const restored = await store.recordVersion(nb.id, { html: '<p>restored</p>', source: 'restore', restoredFrom: keep.id });
    assert.strictEqual(restored.restoredFrom, keep.id);
    const named = await store.nameVersion(nb.id, keep.id, 'Board draft');
    assert.strictEqual(named.name, 'Board draft');
    assert.strictEqual(await store.nameVersion('legacy', keep.id, 'x'), null, 'only this notebook\'s versions');
    for (let i = 0; i < 205; i++) await store.recordVersion(nb.id, { html: `<p>auto ${i}</p>`, source: 'autosave' });
    const count = (await pg.query('SELECT COUNT(*)::int AS n FROM notebook_versions WHERE notebook_id = $1', [nb.id])).rows[0].n;
    assert.strictEqual(count, 202, '200 automatic versions plus the named and the restore one');
    assert.ok(await store.getNotebookVersion(nb.id, keep.id), 'the named version survived');
    assert.ok(await store.getNotebookVersion(nb.id, restored.id), 'the restore survived');
    const cleared = await store.nameVersion(nb.id, keep.id, '   ');
    assert.strictEqual(cleared.name, null, 'an empty name clears it');
});

test('pruning never takes the version a project member last saw', async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS project_item_reads (project_id TEXT NOT NULL, user_id TEXT NOT NULL,
        item_type TEXT NOT NULL, item_id TEXT NOT NULL, seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), seen_version_id TEXT,
        PRIMARY KEY (project_id, user_id, item_type, item_id))`);
    const nb = await store.createNotebook({ userId: 'alice', name: 'Seen' });
    await pg.query('UPDATE notebooks SET project_id = $1 WHERE id = $2', ['p1', nb.id]);
    const seen = await store.recordVersion(nb.id, { html: '<p>what erin saw</p>', source: 'autosave' });
    await pg.query(`INSERT INTO project_item_reads (project_id, user_id, item_type, item_id, seen_version_id)
        VALUES ('p1', 'erin', 'notebook', $1, $2), ('p1', 'vic', 'document', $1, 'not-this-one')`, [nb.id, seen.id]);
    for (let i = 0; i < 202; i++) await store.recordVersion(nb.id, { html: `<p>later ${i}</p>`, source: 'autosave' });
    assert.ok(await store.getNotebookVersion(nb.id, seen.id), 'the version erin last saw survived the cap');
    const count = (await pg.query('SELECT COUNT(*)::int AS n FROM notebook_versions WHERE notebook_id = $1', [nb.id])).rows[0].n;
    assert.strictEqual(count, 201, '200 automatic versions plus the one last seen');
});

test('roles: the owner, a project editor and a viewer each read their own role', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'Shared', projectId: 'p1' });
    assert.strictEqual((await store.getNotebook(nb.id, 'alice')).role, 'owner');
    const asEditor = await store.getNotebook(nb.id, 'erin');
    assert.strictEqual(asEditor.role, 'editor');
    assert.strictEqual(asEditor.projectRole, 'editor');
    assert.strictEqual((await store.getNotebook(nb.id, 'vic')).role, 'viewer');
    const asProjectOwner = await store.getNotebook(nb.id, 'olga');
    assert.strictEqual(asProjectOwner.role, 'editor', 'the project owner edits a colleague\'s notebook, it is not theirs');
    assert.strictEqual(await store.getNotebook(nb.id, 'mallory'), null);
});

test('CAS: a project editor who lost a race gets a conflict, a viewer never writes', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'Race', projectId: 'p1' });
    const first = await store.updateNotebookCas(nb.id, 'alice', { documentContent: '<p>alice</p>', expectedVersion: 0 });
    assert.deepStrictEqual(first, { ok: true, conflict: false, version: 1 });

    const stale = await store.updateNotebookCas(nb.id, 'erin', { documentContent: '<p>erin</p>', expectedVersion: 0 });
    assert.deepStrictEqual(stale, { ok: false, conflict: true, currentVersion: 1 });

    const fresh = await store.updateNotebookCas(nb.id, 'erin', { documentContent: '<p>erin</p>', expectedVersion: 1 });
    assert.strictEqual(fresh.ok, true);
    const row = await store.getNotebook(nb.id, 'alice');
    assert.strictEqual(row.lastEditedBy, 'erin', 'the card knows who edited last');
    assert.ok(row.lastEditedAt);

    const viewer = await store.updateNotebookCas(nb.id, 'vic', { documentContent: '<p>vic</p>', expectedVersion: 2 });
    assert.deepStrictEqual(viewer, { ok: false, conflict: false }, 'a viewer\'s write is not a conflict to retry');
    assert.strictEqual((await store.getNotebook(nb.id, 'alice')).documentContent, '<p>erin</p>');
});

test('a content write while a co-editing document exists is refused, CAS or not; other fields still save', async () => {
    // The co-editing store's table (stores/collabDocStore.js), as much of it as the guard reads.
    await pg.exec('CREATE TABLE IF NOT EXISTS collab_docs (id TEXT PRIMARY KEY, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL)');
    const nb = await store.createNotebook({ userId: 'alice', name: 'Seeding', projectId: 'p1' });
    // A colleague opened it a moment after this save's "is it co-edited?" check:
    // the seed read the row, so a save landing now would never reach the live document.
    await pg.query("INSERT INTO collab_docs (id, resource_kind, resource_id) VALUES ('cd-seed', 'notebook', $1)", [nb.id]);

    const cas = await store.updateNotebookCas(nb.id, 'alice', { documentContent: '<p>solo save</p>', expectedVersion: 0 });
    assert.deepStrictEqual(cas, { ok: false, conflict: true, coEdited: true });
    assert.strictEqual(await store.updateNotebook(nb.id, 'erin', { documentContent: '<p>blind save</p>' }), false);
    let row = await store.getNotebook(nb.id, 'alice');
    assert.strictEqual(row.documentContent, '', 'nothing written behind the live document');
    assert.strictEqual(row.version, 0);
    assert.strictEqual(await store.updateNotebook(nb.id, 'alice', { name: 'Renamed' }), true, 'a rename is not a content write');

    // Folded back into the row: single-writer saves go through again.
    await pg.query('DELETE FROM collab_docs WHERE id = $1', ['cd-seed']);
    const saved = await store.updateNotebookCas(nb.id, 'alice', { documentContent: '<p>solo save</p>', expectedVersion: 0 });
    assert.deepStrictEqual(saved, { ok: true, conflict: false, version: 1 });
    row = await store.getNotebook(nb.id, 'alice');
    assert.strictEqual(row.documentContent, '<p>solo save</p>');
    assert.strictEqual(row.name, 'Renamed');
});

test('writeCollabContent refreshes mirrors, card fields and the CAS counter', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'Live', projectId: 'p1' });
    const r = await store.writeCollabContent(nb.id, {
        html: '<h1>Plan</h1><p>We ship on Friday.</p><script>alert(1)</script>',
        markdown: '# Plan\n\nWe ship on Friday.',
        text: 'Plan We ship on Friday.',
        wordCount: 5,
        editedBy: 'erin',
    });
    assert.deepStrictEqual(r, { version: 1 });
    const row = await store.getNotebook(nb.id, 'alice');
    assert.ok(!/script/.test(row.documentContent), 'sanitised on the way in');
    assert.strictEqual(row.documentMd, '# Plan\n\nWe ship on Friday.');
    assert.strictEqual(row.lastEditedBy, 'erin');
    const card = (await store.listProjectNotebooks('p1')).find(c => c.id === nb.id);
    assert.strictEqual(card.docWordCount, 5);
    assert.strictEqual(card.preview, 'Plan We ship on Friday.');
    assert.strictEqual(card.lastEditedBy, 'erin');
    assert.strictEqual(await store.writeCollabContent('nope', { html: '<p>x</p>' }), null);
});

test('the legacy createVersion entry point still writes a well-formed version', async () => {
    const nb = await store.createNotebook({ userId: 'alice', name: 'Old caller' });
    const v = await store.createVersion(nb.id, '<p>before</p>', 'Before AI edit', { createdBy: 'alice' });
    assert.ok(v.id);
    const meta = (await store.listVersions(nb.id)).versions[0];
    assert.strictEqual(meta.source, 'checkpoint');
    assert.strictEqual(meta.createdBy, 'alice');
    assert.strictEqual(meta.summary, 'Before AI edit');
});

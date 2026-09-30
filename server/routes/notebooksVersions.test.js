/**
 * The notebook version API (routes/notebooksVersions.js) against the REAL
 * notebook store on an in-process Postgres (PGlite, testUtils/pglitePool.js).
 *
 *   - the list pages with a cursor until every version was seen (the old
 *     route stopped at 50 of the 200 it kept) and never carries content;
 *   - one version, and 'current', come with their content;
 *   - naming reads the server's CURRENT state (the old POST took whatever
 *     content and label a client sent, from any member);
 *   - a restore keeps the state it replaces as 'pre_restore', writes the old
 *     state, and records a 'restore' version pointing at its source; a stale
 *     restore is a 409 that changes nothing; while co-editing, the restore
 *     goes through the engine and every open editor follows;
 *   - viewers read, editors write, only the owner deletes, strangers get 404.
 *
 * Run: cd server && node --test routes/notebooksVersions.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const h = require('../core/http/routeHarness');
const projectRole = require('../stores/lib/projectRole');
const store = require('../stores/notebookStore');
const { makeNotebookVersionsRouter } = require('./notebooksVersions');

const { swap, restore } = makeSwaps();
const ROLES = { 'p1:erin': 'editor', 'p1:vic': 'viewer' };
const user = (id) => ({ id, organizationId: 'org1', role: 'user' });

const feed = [];
const fakeFeed = { contentChanged: async (e) => { feed.push(e); } };

/** A co-editing engine that is active for the ids in `live`; `unreadable` ones cannot be read (no key). */
const live = new Map();
const unreadable = new Set();
const edits = [];
const fakeCollab = {
    isActive: async (kind, id) => kind === 'notebook' && live.has(id),
    readHtml: async (kind, id) => {
        if (unreadable.has(id)) throw new Error('Co-editing is unavailable right now because the project encryption key could not be loaded.');
        return live.get(id)?.html ?? null;
    },
    readMarkdown: async (kind, id) => live.get(id)?.markdown ?? null,
    applyServerEdit: async (kind, id, who, edit) => {
        if (!live.has(id)) return { applied: false };
        edits.push({ kind, id, who, edit });
        live.set(id, { html: edit.replaceWith.html, markdown: edit.replaceWith.markdown || null });
        return { applied: true, seq: 7 };
    },
};

const api = h.serve('/api/notebooks', makeNotebookVersionsRouter({ store, collab: fakeCollab, feed: fakeFeed }));
const call = (who, method, path, body) => api.call(method, `/api/notebooks${path}`, { user: user(who), body });

let nb;

before(async () => {
    swap(projectRole.lookup, 'roleOf', async (userId, projectId) => ROLES[`${projectId}:${userId}`] || null);
    await pg.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('p1');`);
    await store.initDB();
});
after(async () => { restore(); await api.close(); await close(); });
beforeEach(async () => {
    feed.length = 0;
    edits.length = 0;
    live.clear();
    unreadable.clear();
    nb = await store.createNotebook({ userId: 'alice', name: 'Plan', projectId: 'p1', organizationId: 'org1' });
});

/** Save `html` as alice and record it as a checkpoint; returns the version. */
async function saveVersion(html) {
    const cur = await store.getNotebook(nb.id, 'alice');
    const w = await store.updateNotebookCas(nb.id, 'alice', { documentContent: html, expectedVersion: cur.version });
    assert.ok(w.ok);
    return store.recordVersion(nb.id, { html, source: 'checkpoint', createdBy: 'alice', contributors: [{ userId: 'alice', kind: 'user' }] });
}

test('the list pages with a cursor, metadata only, to the very first version', async () => {
    for (let i = 1; i <= 5; i++) await saveVersion(`<p>state ${i}</p>`);
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 5; page++) {
        const res = await call('vic', 'GET', `/${nb.id}/versions?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        assert.strictEqual(res.status, 200, res.text);
        for (const v of res.body.versions) {
            assert.deepStrictEqual(Object.keys(v).sort(), ['contributors', 'createdAt', 'createdBy', 'id', 'name', 'pinned', 'restoredFrom', 'seq', 'source', 'stats']);
            seen.push(v.seq);
        }
        cursor = res.body.nextCursor;
        if (!cursor) break;
    }
    assert.deepStrictEqual(seen, [5, 4, 3, 2, 1]);
    const bad = await call('vic', 'GET', `/${nb.id}/versions?cursor=abc`);
    h.assertRefused(assert, bad, 'query.cursor', /nextCursor/);
});

test('one version and the current state come with their content', async () => {
    const v1 = await saveVersion('<h1>One</h1>');
    await saveVersion('<h1>Two</h1>');
    const one = await call('vic', 'GET', `/${nb.id}/versions/${v1.id}`);
    assert.strictEqual(one.status, 200, one.text);
    assert.strictEqual(one.body.version.content.html, '<h1>One</h1>');
    assert.strictEqual(one.body.version.seq, 1);
    const current = await call('vic', 'GET', `/${nb.id}/versions/current`);
    assert.strictEqual(current.body.version.id, 'current');
    assert.strictEqual(current.body.version.content.html, '<h1>Two</h1>');
    assert.strictEqual(current.body.version.documentVersion, 2);

    // While co-edited, 'current' is the live state, not the lagging mirror.
    live.set(nb.id, { html: '<h1>Typing…</h1>', markdown: '# Typing…' });
    const liveNow = await call('vic', 'GET', `/${nb.id}/versions/current`);
    assert.strictEqual(liveNow.body.version.content.html, '<h1>Typing…</h1>');

    const other = await store.createNotebook({ userId: 'alice', name: 'Other' });
    assert.strictEqual((await call('alice', 'GET', `/${other.id}/versions/${v1.id}`)).status, 404, 'a version of another notebook never resolves');
    assert.strictEqual((await call('mallory', 'GET', `/${nb.id}/versions/${v1.id}`)).status, 404);
    assert.strictEqual((await call('mallory', 'GET', `/${nb.id}/versions`)).status, 404);
});

test('naming keeps the server\'s current state under a name; viewers cannot', async () => {
    const v1 = await saveVersion('<p>Draft</p>');
    // The current state moved on since the last version: a named row of its own.
    const cur = await store.getNotebook(nb.id, 'alice');
    assert.ok((await store.updateNotebookCas(nb.id, 'alice', { documentContent: '<p>Ready for review</p>', expectedVersion: cur.version })).ok);
    const res = await call('erin', 'POST', `/${nb.id}/versions`, { name: 'Sent to legal' });
    assert.strictEqual(res.status, 201, res.text);
    assert.notStrictEqual(res.body.version.id, v1.id);
    assert.strictEqual(res.body.version.source, 'named');
    assert.strictEqual(res.body.version.name, 'Sent to legal');
    assert.deepStrictEqual(res.body.version.contributors, [{ userId: 'erin', kind: 'user' }]);
    const full = await store.getNotebookVersion(nb.id, res.body.version.id);
    assert.strictEqual(full.html, '<p>Ready for review</p>');
    assert.deepStrictEqual(feed.map((e) => [e.projectId, e.notebookId, e.source, e.versionId]), [['p1', nb.id, 'named', res.body.version.id]]);

    // Asked again with nothing changed: the same version gets the name, no new copy.
    const again = await call('erin', 'POST', `/${nb.id}/versions`, { name: 'Sent to legal, final' });
    assert.strictEqual(again.status, 201, again.text);
    assert.strictEqual(again.body.version.id, res.body.version.id);
    assert.strictEqual(again.body.version.name, 'Sent to legal, final');
    assert.strictEqual((await store.listVersions(nb.id)).versions.length, 2);

    const viewer = await call('vic', 'POST', `/${nb.id}/versions`, { name: 'Mine' });
    assert.strictEqual(viewer.status, 403);
    assert.strictEqual(viewer.body.code, 'notebook_read_only');
    h.assertRefused(assert, await call('erin', 'POST', `/${nb.id}/versions`, { name: '   ' }), 'body.name', /needs a name/);
    h.assertRefused(assert, await call('erin', 'POST', `/${nb.id}/versions`, { name: 'x'.repeat(81) }), 'body.name', /at most 80/);

    const empty = await store.createNotebook({ userId: 'alice', name: 'Empty' });
    const nothing = await call('alice', 'POST', `/${empty.id}/versions`, { name: 'Nothing' });
    assert.strictEqual(nothing.status, 400);
    assert.strictEqual(nothing.body.code, 'notebook_empty');
});

test('renaming a version, and clearing its name', async () => {
    const v = await saveVersion('<p>x</p>');
    const named = await call('erin', 'PUT', `/${nb.id}/versions/${v.id}/name`, { name: 'Board draft' });
    assert.strictEqual(named.status, 200, named.text);
    assert.strictEqual(named.body.version.name, 'Board draft');
    const cleared = await call('erin', 'PUT', `/${nb.id}/versions/${v.id}/name`, { name: null });
    assert.strictEqual(cleared.body.version.name, null);
    assert.strictEqual((await call('vic', 'PUT', `/${nb.id}/versions/${v.id}/name`, { name: 'x' })).status, 403);
    assert.strictEqual((await call('erin', 'PUT', `/${nb.id}/versions/nope/name`, { name: 'x' })).status, 404);
    assert.strictEqual(feed.length, 1, 'naming is news, clearing a name is not');
});

test('a restore keeps what it replaces, writes the old state and says where it came from', async () => {
    const v1 = await saveVersion('<p>First draft</p>');
    await saveVersion('<p>Second draft</p>');
    const before = await store.getNotebook(nb.id, 'alice');

    const res = await call('erin', 'POST', `/${nb.id}/versions/${v1.id}/restore`, { expectedVersion: before.version });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.version.source, 'restore');
    assert.strictEqual(res.body.version.restoredFrom, v1.id);
    assert.strictEqual(res.body.current.html, '<p>First draft</p>');
    assert.strictEqual(res.body.current.version, before.version + 1, 'the counter the page resyncs on');
    assert.strictEqual(res.body.current.live, false);

    const after = await store.getNotebook(nb.id, 'alice');
    assert.strictEqual(after.documentContent, '<p>First draft</p>');
    assert.strictEqual(after.lastEditedBy, 'erin');
    // The replaced state is still one click away: it WAS the latest version,
    // so the pre_restore snapshot is that version rather than a duplicate.
    const pre = await store.getNotebookVersion(nb.id, res.body.current.preRestoreVersionId);
    assert.strictEqual(pre.html, '<p>Second draft</p>');
    assert.deepStrictEqual(feed.map((e) => [e.source, e.versionId]), [['restore', res.body.version.id]]);
});

test('an unsaved state is kept as pre_restore before it is replaced', async () => {
    const v1 = await saveVersion('<p>Kept</p>');
    const cur = await store.getNotebook(nb.id, 'alice');
    await store.updateNotebookCas(nb.id, 'alice', { documentContent: '<p>Typed since</p>', expectedVersion: cur.version });
    const res = await call('alice', 'POST', `/${nb.id}/versions/${v1.id}/restore`, {});
    assert.strictEqual(res.status, 200, res.text);
    const pre = await store.getNotebookVersion(nb.id, res.body.current.preRestoreVersionId);
    assert.strictEqual(pre.source, 'pre_restore');
    assert.strictEqual(pre.html, '<p>Typed since</p>');
});

test('a stale restore is a 409 and changes nothing', async () => {
    const v1 = await saveVersion('<p>Old</p>');
    await saveVersion('<p>New</p>');
    const res = await call('erin', 'POST', `/${nb.id}/versions/${v1.id}/restore`, { expectedVersion: 0 });
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body.code, 'version_conflict');
    assert.strictEqual(res.body.details.currentVersion, 2);
    assert.strictEqual((await store.getNotebook(nb.id, 'alice')).documentContent, '<p>New</p>');
    assert.ok(!(await store.listVersions(nb.id)).versions.some((v) => v.source === 'restore'));
    assert.strictEqual((await call('vic', 'POST', `/${nb.id}/versions/${v1.id}/restore`, {})).status, 403);
    assert.strictEqual((await call('erin', 'POST', `/${nb.id}/versions/current/restore`, {})).status, 400);
});

test('while co-editing, a restore goes through the engine and every open editor follows', async () => {
    const v1 = await saveVersion('<p>Agreed text</p>');
    live.set(nb.id, { html: '<p>Everyone typing</p>', markdown: 'Everyone typing' });
    const rowBefore = await store.getNotebook(nb.id, 'alice');
    const res = await call('erin', 'POST', `/${nb.id}/versions/${v1.id}/restore`, {});
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.current.live, true);
    assert.strictEqual(res.body.current.version, null, 'the engine owns the counter now');
    assert.strictEqual(edits.length, 1);
    assert.deepStrictEqual(edits[0].who, { origin: 'restore', actorId: 'erin', recordVersions: false });
    assert.strictEqual(edits[0].edit.replaceWith.html, '<p>Agreed text</p>');
    assert.strictEqual((await store.getNotebook(nb.id, 'alice')).version, rowBefore.version, 'no whole-document write on the row');
    const pre = await store.getNotebookVersion(nb.id, res.body.current.preRestoreVersionId);
    assert.strictEqual(pre.html, '<p>Everyone typing</p>', 'the live state, not the lagging mirror, is what was kept');
});

test('a co-edited notebook whose live document cannot be read is not restored onto its mirror', async () => {
    const v1 = await saveVersion('<p>Agreed text</p>');
    live.set(nb.id, { html: '<p>Everyone typing</p>', markdown: 'Everyone typing' });
    unreadable.add(nb.id);
    const rowBefore = await store.getNotebook(nb.id, 'alice');
    const { versions: before } = await store.listVersions(nb.id, { limit: 50 });

    const res = await call('erin', 'POST', `/${nb.id}/versions/${v1.id}/restore`, {});
    assert.strictEqual(res.status, 503, res.text);
    assert.strictEqual(res.body.code, 'restore_unavailable');
    // The row write used to succeed here and be reported as a restore, then the
    // engine's next materialisation silently put the live state back.
    const rowAfter = await store.getNotebook(nb.id, 'alice');
    assert.strictEqual(rowAfter.version, rowBefore.version, 'the row was not written');
    assert.strictEqual(rowAfter.documentContent, rowBefore.documentContent);
    assert.strictEqual(edits.length, 0);
    assert.strictEqual((await store.listVersions(nb.id, { limit: 50 })).versions.length, before.length, 'no pre_restore or restore version');
    assert.strictEqual(feed.length, 0, 'and nothing in the change feed');
});

test('text the page could not save is kept as a conflict version; viewers and strangers cannot', async () => {
    const res = await call('erin', 'POST', `/${nb.id}/versions/kept`, { html: '<p>Typed after the conflict</p>' });
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.body.version.source, 'conflict');
    assert.deepStrictEqual(res.body.version.contributors, [{ userId: 'erin', kind: 'user' }]);
    const kept = await store.getNotebookVersion(nb.id, res.body.version.id);
    assert.strictEqual(kept.html, '<p>Typed after the conflict</p>');
    assert.strictEqual((await store.getNotebook(nb.id, 'alice')).documentContent, '', 'the document itself is untouched');

    assert.strictEqual((await call('vic', 'POST', `/${nb.id}/versions/kept`, { html: '<p>x</p>' })).status, 403);
    assert.strictEqual((await call('zed', 'POST', `/${nb.id}/versions/kept`, { html: '<p>x</p>' })).status, 404);
    h.assertRefused(assert, await call('erin', 'POST', `/${nb.id}/versions/kept`, { html: '  ' }), 'body.html', /text to keep/);
});

test('only the owner deletes a version', async () => {
    const v = await saveVersion('<p>x</p>');
    const editor = await call('erin', 'DELETE', `/${nb.id}/versions/${v.id}`);
    assert.strictEqual(editor.status, 403);
    assert.strictEqual(editor.body.code, 'notebook_owner_only');
    assert.strictEqual((await call('alice', 'DELETE', `/${nb.id}/versions/${v.id}`)).status, 200);
    assert.strictEqual((await call('alice', 'DELETE', `/${nb.id}/versions/${v.id}`)).status, 404);
});

test('version writes share one per-person budget: past it, 429 and nothing stored', async () => {
    const { perUserRateLimit } = require('../utils/perUserRateLimit');
    const tight = h.serve('/api/notebooks', makeNotebookVersionsRouter({
        store, collab: fakeCollab, feed: fakeFeed, writeLimiter: perUserRateLimit({ windowMs: 60_000, max: 2 }),
    }));
    try {
        const post = (who, path, body) => tight.call('POST', `/api/notebooks/${nb.id}${path}`, { user: user(who), body });
        assert.strictEqual((await post('erin', '/versions/kept', { html: '<p>one</p>' })).status, 201);
        assert.strictEqual((await post('erin', '/versions/kept', { html: '<p>two</p>' })).status, 201);
        const before = (await store.listVersions(nb.id)).versions.length;
        const third = await post('erin', '/versions/kept', { html: '<p>three</p>' });
        assert.strictEqual(third.status, 429);
        assert.strictEqual((await post('erin', '/versions/abc/restore', {})).status, 429, 'restore draws on the same budget');
        assert.strictEqual((await store.listVersions(nb.id)).versions.length, before, 'the refused writes stored nothing');
        // Per person: a colleague's budget is their own, and a stranger still reads 404, not 429.
        assert.strictEqual((await post('alice', '/versions/kept', { html: '<p>alice</p>' })).status, 201);
        assert.strictEqual((await post('zed', '/versions/kept', { html: '<p>x</p>' })).status, 404);
    } finally {
        await tight.close();
    }
});

test('kept text is capped at the size a co-edited document may reach', async () => {
    const { defaultLimits } = require('../core/collab/limits');
    const max = defaultLimits().maxDocBytes;
    const over = `<p>${'x'.repeat(max)}</p>`;
    const before = (await store.listVersions(nb.id)).versions.length;
    h.assertRefused(assert, await call('erin', 'POST', `/${nb.id}/versions/kept`, { html: over }), 'body.html', /at most \d+ MB/);
    assert.strictEqual((await store.listVersions(nb.id)).versions.length, before);
});

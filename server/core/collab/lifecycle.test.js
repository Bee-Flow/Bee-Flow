/**
 * What happens to a co-edited document besides typing (core/collab/lifecycle.js):
 * materialisation, checkpoints (versions + change feed + compliance scan +
 * `doc.edited`), compaction, server-side edits (AI, restore, system), fresh
 * reads, and detaching — over the real store (PGlite), sealing and hub, with
 * the owners' hooks as recording stand-ins (collab.testkit).
 *
 * Run: cd server && node --test core/collab/lifecycle.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');
const { collabWorld, docText, typeInto, until } = require('./collab.testkit');
const { toContributors } = require('./lifecycle');

let w;
test.beforeEach(async () => { w = await collabWorld({ limits: { compactCount: 5, retentionGraceMs: 0 } }); });
test.afterEach(async () => { await w.close(); });

/** Open a notebook's document as ann and return a synced client copy. */
async function openNotebook(id, extra = {}) {
    w.addResource('notebook', id, extra);
    const { docId } = await w.collab.openDoc({ projectId: 'p1', userId: 'ann', role: 'editor', kind: 'notebook', resourceId: id });
    const doc = new Y.Doc();
    const s = await w.collab.sync({ projectId: 'p1', docId, sv: '', role: 'editor' });
    Y.applyUpdate(doc, Buffer.from(s.update, 'base64'), 'remote');
    return { docId, doc };
}

/** Type as `userId` and post it like the updates route does. */
async function type(docId, doc, userId, index, at, text) {
    const out = [];
    const on = (u, origin) => { if (origin !== 'remote') out.push(u); };
    doc.on('update', on);
    typeInto(doc, index, at, text);
    doc.off('update', on);
    return w.collab.applyClientUpdates({
        projectId: 'p1', docId, userId, clientId: doc.clientID, updates: out.map((u) => Buffer.from(u).toString('base64')),
    });
}

const ago = (docId, column, minutes) => w.pg.query(`UPDATE collab_docs SET ${column} = NOW() - ($2::int * INTERVAL '1 minute') WHERE id = $1`, [docId, minutes]);
const row = async (docId) => w.store.getDoc(docId);

test('toContributors: people and the AI, never the import', () => {
    assert.deepStrictEqual(toContributors([
        { userId: null, origin: 'import', agentId: null },
        { userId: 'ann', origin: 'user', agentId: null },
        { userId: 'ann', origin: 'ai', agentId: 'ag1' },
        { userId: 'ann', origin: 'user', agentId: null },
        { userId: 'bob', origin: 'restore', agentId: null },
        { userId: null, origin: 'system', agentId: null },
    ]), [
        { userId: 'ann', kind: 'user' },
        { userId: 'ann', kind: 'ai', agentId: 'ag1' },
        { userId: 'bob', kind: 'user' },
    ]);
});

test('materialise after a pause, then one checkpoint per session with contributors and stats', async () => {
    const { docId, doc } = await openNotebook('nb-1', { html: '<p>Intro</p>' });
    await type(docId, doc, 'ann', 0, 5, ' and plan');
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(doc));
    await type(docId, bob, 'bob', 1, 0, 'Budget line');

    // Still typing: nothing to do yet.
    assert.deepStrictEqual(await w.collab.processDoc(await row(docId)), { materialised: false, checkpoint: false, compacted: false });

    await ago(docId, 'last_edit_at', 1);
    let done = await w.collab.processDoc(await row(docId));
    assert.strictEqual(done.materialised, true);
    assert.strictEqual(done.checkpoint, false, 'a one-minute pause is not the end of a session');
    assert.strictEqual(w.mirrors.at(-1).markdown, 'Intro and plan\n\nBudget line');
    assert.strictEqual(w.mirrors.at(-1).editedBy, 'bob');
    assert.strictEqual((await row(docId)).materializedSeq, 3);

    await ago(docId, 'last_edit_at', 6);
    done = await w.collab.processDoc(await row(docId));
    assert.strictEqual(done.checkpoint, true);
    const [version] = w.versions;
    assert.strictEqual(version.source, 'checkpoint');
    assert.deepStrictEqual(version.contributors, [{ userId: 'ann', kind: 'user' }, { userId: 'bob', kind: 'user' }]);
    assert.strictEqual(version.markdown, 'Intro and plan\n\nBudget line');
    assert.ok(version.stats && version.stats.wordsAdded >= 3, 'stats against the imported state');

    assert.deepStrictEqual(w.feed, [{
        projectId: 'p1', itemType: 'notebook', itemId: 'nb-1', contributors: version.contributors, stats: version.stats,
        versionId: version.versionId, source: 'checkpoint',
    }]);
    assert.strictEqual(w.scans[0].subjectKind, 'notebook_document');
    assert.strictEqual(w.scans[0].text, 'Intro and plan\nBudget line');
    const edited = w.events.find((e) => e.kind === 'doc.edited');
    assert.strictEqual(edited.targetType, 'notebook');
    assert.strictEqual(edited.targetId, 'nb-1');
    assert.strictEqual(edited.payload.fromSeq, 1);
    assert.strictEqual(edited.payload.toSeq, 3);
    assert.ok(!JSON.stringify(w.events).includes('Budget'), 'events carry ids and counts, never content');

    // Nothing new: no second version.
    await w.collab.processDoc(await row(docId));
    assert.strictEqual(w.versions.length, 1);
    assert.strictEqual((await row(docId)).sessionStartedAt, null);
});

test('continuous editing still checkpoints every 30 minutes', async () => {
    const { docId, doc } = await openNotebook('nb-long');
    await type(docId, doc, 'ann', 0, 0, 'still typing');
    await ago(docId, 'session_started_at', 31);
    const done = await w.collab.processDoc(await row(docId));
    assert.strictEqual(done.checkpoint, true);
    assert.strictEqual(w.versions.length, 1);
});

test('compaction folds the log; late readers still get everything, or a resync', async () => {
    const { docId, doc } = await openNotebook('nb-big', { html: '<p>A</p>' });
    for (let i = 0; i < 8; i += 1) await type(docId, doc, 'ann', 0, 1, `${i}`);
    await ago(docId, 'last_edit_at', 6);
    await w.pg.query("UPDATE collab_doc_updates SET created_at = NOW() - INTERVAL '1 hour' WHERE doc_id = $1", [docId]);
    const done = await w.collab.processDoc(await row(docId));
    assert.strictEqual(done.checkpoint, true);
    assert.strictEqual(done.compacted, true);
    const after = await row(docId);
    assert.strictEqual(after.snapshotSeq, 9);
    assert.strictEqual(after.retainedFrom, 10, 'folded rows removed');
    assert.strictEqual(after.pendingCount, 0);
    const rows = await w.pg.query('SELECT COUNT(*)::int AS n FROM collab_doc_updates WHERE doc_id = $1', [docId]);
    assert.strictEqual(rows.rows[0].n, 0);
    const snap = await w.pg.query('SELECT snapshot FROM collab_docs WHERE id = $1', [docId]);
    assert.strictEqual(Buffer.from(snap.rows[0].snapshot)[0], 0x01, 'the snapshot is sealed');

    const fresh = new Y.Doc();
    const s = await w.collab.sync({ projectId: 'p1', docId, sv: '', role: 'viewer' });
    Y.applyUpdate(fresh, Buffer.from(s.update, 'base64'));
    assert.strictEqual(docText(fresh), docText(doc));
    assert.strictEqual(s.seq, 9);

    // A stream that asks to start from before the snapshot is told to resync.
    const frames = [];
    const stream = { send: (k, d) => { frames.push({ k, d }); return true; }, onClose() {}, onDrain() {} };
    await w.collab.attachStream({ stream, projectId: 'p1', userId: 'ann', docId, docSince: 2 });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(frames[0], { k: 'doc.joined', d: { docId } }, 'the client learns its stream is attached');
    assert.deepStrictEqual(frames.find((f) => f.k === 'doc.resync'), { k: 'doc.resync', d: { docId, reason: 'behind_retention' } });
});

test('reads render the live state; not co-edited reads null', async () => {
    const { docId, doc } = await openNotebook('nb-read', { html: '<p>One</p>' });
    await type(docId, doc, 'ann', 1, 0, 'Two');
    assert.strictEqual(await w.collab.readMarkdown('notebook', 'nb-read'), 'One\n\nTwo', 'before any materialisation');
    assert.strictEqual(w.resources.get('notebook:nb-read').markdown, 'One\n\nTwo', 'the lagging mirror was brought up to date');
    assert.strictEqual((await row(docId)).materializedSeq, 2);
    assert.strictEqual(await w.collab.readHtml('notebook', 'nb-read'), '<p>One</p><p>Two</p>');
    assert.strictEqual(await w.collab.isActive('notebook', 'nb-read'), true);
    w.addResource('notebook', 'nb-solo');
    assert.strictEqual(await w.collab.readMarkdown('notebook', 'nb-solo'), null);
    assert.strictEqual(await w.collab.isActive('notebook', 'nb-solo'), false);
});

test('an AI edit merges with typing in flight, is attributed, and keeps the state before it', async () => {
    const { docId, doc } = await openNotebook('nb-ai', { html: '<p>Hello</p><p>Old summary</p>' });
    await type(docId, doc, 'ann', 0, 5, ' world');
    // bob has not seen the AI edit yet and keeps typing.
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(doc));

    const frames = [];
    const stream = { send: (k, d) => { frames.push({ k, d }); return true; }, onClose() {}, onDrain() {} };
    await w.collab.attachStream({ stream, projectId: 'p1', userId: 'val', docId, docSince: 2 });

    const r = await w.collab.applyServerEdit('notebook', 'nb-ai', { origin: 'ai', actorId: 'ann', agentId: 'ag1' },
        { replaceWith: { markdown: 'Hello world\n\nNew summary' } });
    assert.strictEqual(r.applied, true);
    assert.strictEqual(r.changed, true);
    await type(docId, bob, 'bob', 0, 0, 'Hi! ');

    const merged = new Y.Doc();
    Y.applyUpdate(merged, Buffer.from((await w.collab.sync({ projectId: 'p1', docId, sv: '', role: 'editor' })).update, 'base64'));
    assert.strictEqual(docText(merged), 'Hi! Hello world\n\nNew summary');

    assert.deepStrictEqual(w.versions.map((v) => v.source), ['checkpoint', 'ai']);
    assert.deepStrictEqual(w.versions[1].contributors, [{ userId: 'ann', kind: 'ai', agentId: 'ag1' }]);
    assert.strictEqual(w.versions[1].versionId, r.versionId);
    assert.strictEqual(w.mirrors.at(-1).markdown, 'Hello world\n\nNew summary', 'the mirror is written right away');
    const stored = await w.pg.query('SELECT origin, user_id, agent_id FROM collab_doc_updates WHERE doc_id = $1 AND seq = $2', [docId, r.seq]);
    assert.deepStrictEqual(stored.rows[0], { origin: 'ai', user_id: 'ann', agent_id: 'ag1' });
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(frames.some((f) => f.k === 'doc.update' && f.d.by.includes('ai:ag1')), 'open editors see the AI edit live');
});

test('an edit rebased onto an older state is refused as stale, so typing after that state is never undone', async () => {
    const { docId, doc } = await openNotebook('nb-stale', { html: '<p>One</p>' });
    const read = await w.collab.read('notebook', 'nb-stale');
    // bob types after the writer read the document…
    await type(docId, doc, 'bob', 0, 3, ' two');
    // …so the writer's text, computed from that read, would take " two" out again.
    const stale = await w.collab.applyServerEdit('notebook', 'nb-stale', { origin: 'ai', actorId: 'ann' },
        { replaceWith: { markdown: 'One!' }, expectSeq: read.seq });
    assert.deepStrictEqual(stale, { applied: false, stale: true, seq: read.seq + 1 });
    assert.strictEqual(await w.collab.readMarkdown('notebook', 'nb-stale'), 'One two', 'nothing was written');
    assert.strictEqual(w.versions.length, 0, 'and no version either');

    const fresh = await w.collab.applyServerEdit('notebook', 'nb-stale', { origin: 'ai', actorId: 'ann' },
        { replaceWith: { markdown: 'One two!' }, expectSeq: read.seq + 1 });
    assert.strictEqual(fresh.applied, true);
    assert.strictEqual(await w.collab.readMarkdown('notebook', 'nb-stale'), 'One two!');
});

test('append, restore and system writes; no document means not applied', async () => {
    assert.deepStrictEqual(await w.collab.applyServerEdit('notebook', 'nb-none', { origin: 'system' }, { append: { markdown: 'x' } }), { applied: false });
    const { docId } = await openNotebook('nb-edits', { html: '<p>First</p>' });

    const sys = await w.collab.applyServerEdit('notebook', 'nb-edits', { origin: 'system' }, { append: { markdown: 'Form answer' } });
    assert.strictEqual(sys.applied, true);
    assert.strictEqual(await w.collab.readMarkdown('notebook', 'nb-edits'), 'First\n\nForm answer');
    assert.strictEqual(w.versions.length, 0, 'a system write keeps no versions of its own');

    const restored = await w.collab.applyServerEdit('notebook', 'nb-edits', { origin: 'restore', actorId: 'bob', restoredFrom: 'v-old' },
        { replaceWith: { html: '<p>First</p>' } });
    assert.strictEqual(restored.applied, true);
    assert.deepStrictEqual(w.versions.map((v) => v.source), ['pre_restore', 'restore']);
    assert.strictEqual(w.versions[1].restoredFrom, 'v-old');
    assert.deepStrictEqual(w.versions[1].contributors, [{ userId: 'bob', kind: 'user' }]);
    assert.ok(w.events.some((e) => e.kind === 'doc.restored' && e.payload.restoredFrom === 'v-old'));

    const noop = await w.collab.applyServerEdit('notebook', 'nb-edits', { origin: 'ai', actorId: 'ann' }, { replaceWith: { markdown: 'First' } });
    assert.deepStrictEqual({ applied: noop.applied, changed: noop.changed }, { applied: true, changed: false });

    await assert.rejects(w.collab.applyServerEdit('notebook', 'nb-edits', { origin: 'user' }, { append: { markdown: 'x' } }), /origin must be one of/);
    await assert.rejects(w.collab.applyServerEdit('notebook', 'nb-edits', { origin: 'ai' }, {}), /replaceWith or append/);
    assert.ok(docId);
});

test('detach: back into the resource with a version; filed elsewhere, only what was never written back goes in', async () => {
    const { docId, doc } = await openNotebook('nb-detach', { html: '<p>Keep me</p>' });
    await type(docId, doc, 'ann', 0, 7, ' please');
    const frames = [];
    const stream = { send: (k, d) => { frames.push({ k, d }); return true; }, onClose() {}, onDrain() {} };
    await w.collab.attachStream({ stream, projectId: 'p1', userId: 'val', docId, docSince: 2 });
    w.resources.get('notebook:nb-detach').projectId = null;   // the owner took it out of the project

    assert.strictEqual(await w.collab.isActive('notebook', 'nb-detach'), false, 'folded back on the next question');
    assert.strictEqual(w.mirrors.at(-1).markdown, 'Keep me please');
    assert.strictEqual(w.versions.at(-1).source, 'checkpoint');
    assert.strictEqual(await w.store.getDoc(docId), null);
    assert.deepStrictEqual(frames.at(-1), { k: 'doc.closed', d: { docId, reason: 'detached' } });
    assert.ok(w.transients.some((t) => t.kind === 'doc.closed' && t.docId === docId));

    // Filed into another project before its fold-back: the typing that
    // never reached the notebook would be lost with the state, and there is
    // one document per resource, so nobody co-edited it since. It goes in.
    const moved = await openNotebook('nb-moved', { html: '<p>Draft</p>' });
    await type(moved.docId, moved.doc, 'ann', 0, 5, ' two');
    w.resources.get('notebook:nb-moved').projectId = 'p2';
    await w.collab.processDoc(await row(moved.docId));
    assert.strictEqual(w.resources.get('notebook:nb-moved').markdown, 'Draft two', 'the unwritten edits were written back, not deleted');
    assert.strictEqual(await w.store.getDoc(moved.docId), null);

    // Its mirror current: the resource is left alone.
    const current = await openNotebook('nb-current', { html: '<p>Kept</p>' });
    await type(current.docId, current.doc, 'ann', 0, 4, ' as is');
    assert.strictEqual(await w.collab.readMarkdown('notebook', 'nb-current'), 'Kept as is', 'mirror brought up to date');
    const mirrorsBefore = w.mirrors.length;
    w.resources.get('notebook:nb-current').projectId = 'p2';
    await w.collab.processDoc(await row(current.docId));
    assert.strictEqual(w.mirrors.length, mirrorsBefore, 'nothing written into a resource another project holds now');
    assert.strictEqual(await w.store.getDoc(current.docId), null);
});

test('switched off: no longer active, folded back so single-writer saves see current content', async () => {
    const { docId, doc } = await openNotebook('nb-off', { html: '<p>x</p>' });
    await type(docId, doc, 'ann', 0, 1, 'y');
    w.settings.enabled = false;
    assert.strictEqual(await w.collab.isActive('notebook', 'nb-off'), false);
    assert.strictEqual(w.resources.get('notebook:nb-off').markdown, 'xy');
    assert.strictEqual(await w.store.getDoc(docId), null);
});

test('no key: a detach keeps the state and the document stays active', async () => {
    const { docId, doc } = await openNotebook('nb-key', { html: '<p>x</p>' });
    await type(docId, doc, 'ann', 0, 1, 'z');
    w.resources.get('notebook:nb-key').projectId = null;
    w.failKeys(true);
    try {
        assert.strictEqual(await w.collab.isActive('notebook', 'nb-key'), true, 'no single-writer save may overwrite unsaved state');
        assert.ok(await w.store.getDoc(docId));
    } finally {
        w.failKeys(false);
    }
});

test('switching an organisation off folds all its documents back', async () => {
    const a = await openNotebook('nb-org-a', { html: '<p>a</p>' });
    await type(a.docId, a.doc, 'ann', 0, 1, '1');
    await w.addProject('p3', { organizationId: 'org2' });
    w.addResource('notebook', 'nb-org-b', { projectId: 'p3', html: '<p>b</p>' });
    const other = await w.collab.openDoc({ projectId: 'p3', userId: 'ann', role: 'editor', kind: 'notebook', resourceId: 'nb-org-b' });
    const r = await w.collab.detachOrganisation('org1');
    assert.deepStrictEqual(r, { detached: 1, failed: 0 });
    assert.strictEqual(w.resources.get('notebook:nb-org-a').markdown, 'a1');
    assert.strictEqual(await w.store.getDoc(a.docId), null);
    assert.ok(await w.store.getDoc(other.docId), 'another organisation is untouched');
});

test('a project about to be deleted: each of its documents folded back into its own row, others untouched', async () => {
    const a = await openNotebook('nb-proj-a', { html: '<p>a</p>' });
    await type(a.docId, a.doc, 'ann', 0, 1, '1');
    w.addResource('notebook', 'nb-proj-b', { projectId: 'p2', html: '<p>b</p>' });
    const other = await w.collab.openDoc({ projectId: 'p2', userId: 'ann', role: 'editor', kind: 'notebook', resourceId: 'nb-proj-b' });

    const r = await w.collab.detachProject('p1');
    assert.deepStrictEqual(r, { detached: 1, failed: 0 });
    assert.strictEqual(w.resources.get('notebook:nb-proj-a').markdown, 'a1', 'the typing reached the notebook');
    assert.strictEqual(w.versions.at(-1).source, 'checkpoint');
    assert.strictEqual(await w.store.getDoc(a.docId), null);
    assert.ok(await w.store.getDoc(other.docId), 'another project is untouched');
});

test('a deleted resource: its sealed state is dropped unopened, even without a key', async () => {
    const { docId, doc } = await openNotebook('nb-gone', { html: '<p>x</p>' });
    await type(docId, doc, 'ann', 0, 1, 'y');
    w.resources.delete('notebook:nb-gone');   // the notebook row was deleted
    const mirrorsBefore = w.mirrors.length;
    w.failKeys(true);
    try {
        assert.deepStrictEqual(await w.collab.detach('notebook', 'nb-gone', { reason: 'deleted' }), { detached: 1 });
    } finally {
        w.failKeys(false);
    }
    assert.strictEqual(await w.store.getDoc(docId), null, 'nothing of a deleted notebook is kept');
    assert.strictEqual(w.mirrors.length, mirrorsBefore, 'nothing written back');
});

// ── Nothing acknowledged is lost, nothing stale overwrites ─────────────────

test('the job finds a session idle past sessionIdleMs with the co-editing defaults', async () => {
    // index.js handed the store `sessionIdleMs` while it read `idleMs`: NULL
    // in SQL, so an idle session was only checkpointed 30 minutes after it
    // started instead of 5 minutes after the last edit.
    const { docId, doc } = await openNotebook('nb-idle', { html: '<p>a</p>' });
    await type(docId, doc, 'ann', 0, 1, 'b');
    await w.pg.query(
        `UPDATE collab_docs SET materialized_seq = update_seq, pending_count = 0,
                last_edit_at = NOW() - INTERVAL '10 minutes', session_started_at = NOW() - INTERVAL '12 minutes'
          WHERE id = $1`, [docId],
    );
    assert.ok((await w.collab.listWork()).some((d) => d.id === docId), 'listed for its checkpoint');
    const done = await w.collab.processDoc(await row(docId));
    assert.strictEqual(done.checkpoint, true);
});

test('a detach never deletes an update acknowledged while it folds back', async () => {
    const { docId, doc } = await openNotebook('nb-fence', { html: '<p>abc</p>' });
    await type(docId, doc, 'ann', 0, 3, '1');
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(doc));
    const res = w.collab._ctx.resources;
    const writeMirror = res.writeMirror;
    let colleague = null;
    // A colleague's batch lands while the project's documents are folded back.
    res.writeMirror = async (...args) => {
        if (!colleague) colleague = type(docId, bob, 'bob', 0, 4, '2').then((ok) => ({ ok }), (err) => ({ err }));
        await colleague;
        return writeMirror(...args);
    };
    try {
        assert.deepStrictEqual(await w.collab.detachProject('p1'), { detached: 1, failed: 0 });
    } finally {
        res.writeMirror = writeMirror;
    }
    const { ok, err } = await colleague;
    assert.strictEqual(ok, undefined, 'never acknowledged, so never lost');
    assert.strictEqual(err.status, 503);
    assert.strictEqual(err.code, 'COLLAB_CLOSING', 'the client retries, then sees the document closed');
    assert.strictEqual(w.resources.get('notebook:nb-fence').markdown, 'abc1');
    assert.strictEqual(await w.store.getDoc(docId), null);
});

test('a fold-back that fails opens the document to edits again', async () => {
    const { docId, doc } = await openNotebook('nb-refold', { html: '<p>abc</p>' });
    await type(docId, doc, 'ann', 0, 3, '1');
    w.refuse.add('nb-refold');
    assert.deepStrictEqual(await w.collab.detachProject('p1'), { detached: 0, failed: 1 });
    assert.ok(await w.store.getDoc(docId), 'kept: it was not written back');
    assert.ok((await type(docId, doc, 'ann', 0, 4, '2')).seq, 'typing goes on');
});

test('an older state never overwrites a newer mirror', async () => {
    const { docId, doc } = await openNotebook('nb-race', { html: '<p>One</p>' });
    await type(docId, doc, 'ann', 1, 0, 'Two');
    const { store } = w;
    const { authorsBetween, claimMirror } = store;
    let releaseReader;
    const readerHeld = new Promise((r) => { releaseReader = r; });
    let held = false;
    // The reader loaded seq 2 and stalls inside its mirror write; it is let
    // go only once the AI edit (seq 3) is waiting to write its own.
    store.authorsBetween = async (...a) => { if (!held) { held = true; await readerHeld; } return authorsBetween(...a); };
    store.claimMirror = async (...a) => {
        const c = await claimMirror(...a);
        if (c && c.busy) releaseReader();
        return c;
    };
    try {
        const reading = w.collab.read('notebook', 'nb-race');
        await until(() => held);
        const edit = await w.collab.applyServerEdit('notebook', 'nb-race', { origin: 'ai', actorId: 'ann', agentId: 'ag1' },
            { append: { markdown: 'AI line' } });
        assert.strictEqual(edit.changed, true);
        await reading;
    } finally {
        store.authorsBetween = authorsBetween;
        store.claimMirror = claimMirror;
    }
    assert.strictEqual(w.resources.get('notebook:nb-race').markdown, 'One\n\nTwo\n\nAI line', 'the stale write came first, the newer one last');
    const r = await row(docId);
    assert.strictEqual(r.materializedSeq, r.updateSeq, 'and materialized_seq says what the row holds');
});

test('a checkpoint of a state loaded before a server edit stands down: the AI version stays the current one', async () => {
    const { docId, doc } = await openNotebook('nb-late', { html: '<p>One</p>' });
    await type(docId, doc, 'ann', 1, 0, 'Two');
    await w.collab.readMarkdown('notebook', 'nb-late');
    await ago(docId, 'last_edit_at', 6);
    const { claimMirror } = w.store;
    let edited = false;
    // The job loaded seq 2 and is about to close its session; an AI edit on
    // another replica appends seq 3 and records its version first.
    w.store.claimMirror = async (...a) => {
        if (!edited) {
            edited = true;
            await w.collab.applyServerEdit('notebook', 'nb-late', { origin: 'ai', actorId: 'ann', agentId: 'ag1' }, { append: { markdown: 'AI line' } });
        }
        return claimMirror(...a);
    };
    let done;
    try {
        done = await w.collab.processDoc(await row(docId));
    } finally {
        w.store.claimMirror = claimMirror;
    }
    assert.ok(edited);
    assert.strictEqual(done.checkpoint, false, 'the older state records nothing');
    assert.deepStrictEqual(w.versions.map((v) => v.source), ['checkpoint', 'ai']);
    assert.strictEqual(w.versions.at(-1).markdown, 'One\n\nTwo\n\nAI line', 'the newest version is the AI edit');
    assert.strictEqual(w.feed.length, 2, 'and no third change-feed entry for the stale state');
    assert.strictEqual(w.resources.get('notebook:nb-late').markdown, 'One\n\nTwo\n\nAI line');
    const r = await row(docId);
    assert.strictEqual(r.checkpointSeq, r.updateSeq);
});

/** Open a project page's document as ann and return a synced client copy. */
async function openPage(id, extra = {}) {
    w.addResource('document', id, extra);
    const { docId } = await w.collab.openDoc({ projectId: 'p1', userId: 'ann', role: 'editor', kind: 'document', resourceId: id });
    const doc = new Y.Doc();
    const s = await w.collab.sync({ projectId: 'p1', docId, sv: '', role: 'editor' });
    Y.applyUpdate(doc, Buffer.from(s.update, 'base64'), 'remote');
    return { docId, doc };
}

test('an archived page whose fold-back failed: the job folds the typing into its row later, never deletes it unopened', async () => {
    const { docId, doc } = await openPage('pg-archived', { html: '<p>Kept</p>' });
    await type(docId, doc, 'ann', 0, 4, ' and typed');
    // Archived while its fold-back failed (the delete route goes on): the row
    // is archived, the live state still holds the unmaterialised typing.
    const frames = [];
    const stream = { send: (k, d) => { frames.push({ k, d }); return true; }, onClose() {}, onDrain() {} };
    await w.collab.attachStream({ stream, projectId: 'p1', userId: 'val', docId, docSince: 2 });
    Object.assign(w.resources.get('document:pg-archived'), { supported: false, archived: true });

    const done = await w.collab.processDoc(await row(docId), { now: Date.now() + 10 * 60_000 });
    assert.deepStrictEqual(done, { detached: true });
    assert.strictEqual(w.resources.get('document:pg-archived').html, '<p>Kept and typed</p>', 'the typing is in the row, for an unarchive');
    assert.ok(w.versions.some((v) => v.id === 'pg-archived' && v.source === 'checkpoint'), 'and in its history');
    assert.strictEqual(await w.store.getDoc(docId), null);
    assert.deepStrictEqual(frames.filter((f) => f.k === 'doc.closed').map((f) => f.d.reason), ['deleted'], 'its editors are told it is gone');
    await assert.rejects(w.collab.openDoc({ projectId: 'p1', userId: 'ann', role: 'editor', kind: 'document', resourceId: 'pg-archived' }),
        (e) => e.status === 404, 'an archived page is not opened live again');
});

test('a page never grows past its owner\'s body cap: the edit that would is refused, the page keeps working', async () => {
    await w.close();
    w = await collabWorld({ limits: { compactCount: 5, retentionGraceMs: 0 }, contentCaps: { document: 2000 } });
    const { docId, doc } = await openPage('pg-cap', { html: '<p>Top</p>' });
    await type(docId, doc, 'ann', 0, 3, 'x'.repeat(900));
    await type(docId, doc, 'ann', 1, 0, 'y'.repeat(900));
    const before = (await row(docId)).updateSeq;
    await assert.rejects(type(docId, doc, 'ann', 2, 0, 'z'.repeat(300)), (e) => e.status === 413 && e.code === 'DOC_TOO_LARGE');
    assert.strictEqual((await row(docId)).updateSeq, before, 'nothing stored');

    // An edit that fits still goes in, measured when the estimate is close.
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Buffer.from((await w.collab.sync({ projectId: 'p1', docId, sv: '', role: 'editor' })).update, 'base64'));
    await type(docId, fresh, 'ann', 0, 0, 'w'.repeat(100));
    await w.collab.processDoc(await row(docId), { now: Date.now() + 10 * 60_000 });
    assert.ok(Buffer.byteLength(w.resources.get('document:pg-cap').html) <= 2000, 'the owner could store every mirror');
    assert.strictEqual((await row(docId)).materializedSeq, (await row(docId)).updateSeq);

    // An AI edit that would pass the cap is refused the same way.
    await assert.rejects(w.collab.applyServerEdit('document', 'pg-cap', { origin: 'ai', actorId: 'ann' }, { append: { markdown: 'q'.repeat(400) } }),
        (e) => e.code === 'DOC_TOO_LARGE');
});

test('an owner that refuses the content: the job still checkpoints and compacts, puts it off, and a detach keeps the state', async () => {
    const { docId, doc } = await openNotebook('nb-refused', { html: '<p>Start</p>' });
    await type(docId, doc, 'ann', 0, 5, ' more');
    w.refuse.add('nb-refused');
    await ago(docId, 'last_edit_at', 6);
    const done = await w.collab.processDoc(await row(docId));
    assert.deepStrictEqual(done, { materialised: false, checkpoint: true, compacted: true, mirrorRefused: true });
    assert.ok(w.events.some((e) => e.kind === 'doc.edited' && e.payload.docId === docId), 'the session was still closed');
    assert.ok(!(await w.collab.listWork()).some((d) => d.id === docId), 'put off: it cannot crowd out the rest');

    // Moved out while the owner refuses: nothing is deleted, it stays live.
    w.resources.get('notebook:nb-refused').projectId = null;
    assert.strictEqual(await w.collab.isActive('notebook', 'nb-refused'), true);
    assert.ok(await w.store.getDoc(docId));
    w.refuse.delete('nb-refused');
    assert.strictEqual(await w.collab.isActive('notebook', 'nb-refused'), false);
    assert.strictEqual(w.resources.get('notebook:nb-refused').markdown, 'Start more');
    assert.strictEqual(await w.store.getDoc(docId), null);
});

test('switched off: open editors are told to fall back to single-writer saves, never that access was revoked', async () => {
    const { docId, doc } = await openNotebook('nb-frame', { html: '<p>x</p>' });
    await type(docId, doc, 'ann', 0, 1, 'y');
    const frames = [];
    const stream = { send: (k, d) => { frames.push({ k, d }); return true; }, onClose() {}, onDrain() {} };
    await w.collab.attachStream({ stream, projectId: 'p1', userId: 'val', docId, docSince: 2 });
    w.settings.enabled = false;
    await w.collab.detachOrganisation('org1');
    assert.deepStrictEqual(frames.at(-1), { k: 'doc.closed', d: { docId, reason: 'detached', cause: 'disabled' } });
    const late = [];
    await w.collab.attachStream({ stream: { ...stream, send: (k, d) => { late.push({ k, d }); return true; } }, projectId: 'p1', userId: 'val', docId });
    assert.deepStrictEqual(late, [{ k: 'doc.closed', d: { docId, reason: 'detached', cause: 'disabled' } }]);
});

test('switching an organisation off folds back every page of documents, past one that cannot be folded back', async () => {
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
        const { docId, doc } = await openNotebook(`nb-page-${i}`, { html: `<p>n${i}</p>` });
        await type(docId, doc, 'ann', 0, 2, '!');
        ids.push(docId);
    }
    w.refuse.add('nb-page-1');
    assert.deepStrictEqual(await w.collab.detachOrganisation('org1', { batch: 2 }), { detached: 4, failed: 1 });
    const left = (await w.pg.query('SELECT resource_id FROM collab_docs')).rows.map((r) => r.resource_id);
    assert.deepStrictEqual(left, ['nb-page-1'], 'only the one the owner refused is kept');
    assert.strictEqual(w.resources.get('notebook:nb-page-4').markdown, 'n4!');
});

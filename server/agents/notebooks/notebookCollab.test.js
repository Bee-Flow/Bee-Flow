/**
 * A server-side notebook edit while colleagues type (agents/notebooks/notebookCollab.js),
 * against the real co-editing engine over PGlite (core/collab/collab.testkit).
 *
 *   - an edit computed from an older read (`base`) carries only its own change
 *     onto the live document: a colleague's typing since that read stays in
 *     every editor (it used to replace the whole document with the writer's
 *     copy, which still held the text as it was when the AI turn began);
 *   - a change to a block a colleague changed meanwhile writes nothing and
 *     comes back as a conflict, which a caller keeps as a proposal;
 *   - typing that lands between the read and the write makes the engine
 *     refuse the stale rebase, and the edit is read and rebased again;
 *   - a whole document composed from an earlier read (notebook_write) goes in
 *     only while nothing was typed since that read's update (`expectSeq`);
 *   - a co-edited notebook the engine cannot read is reported as active but
 *     not live, so no writer takes the stored mirror for the document.
 *
 * Run: cd server && node --test agents/notebooks/notebookCollab.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');
const { collabWorld, typeInto } = require('../../core/collab/collab.testkit');
const notebookCollab = require('./notebookCollab');

let w;
test.beforeEach(async () => { w = await collabWorld(); });
test.afterEach(async () => { await w.close(); });

const AI = { origin: 'ai', actorId: 'ann' };

/** A co-edited notebook and bob's synced editor on it. */
async function coEdited(id, html) {
    w.addResource('notebook', id, { html });
    const { docId } = await w.collab.openDoc({ projectId: 'p1', userId: 'bob', role: 'editor', kind: 'notebook', resourceId: id });
    const bob = new Y.Doc();
    const synced = await w.collab.sync({ projectId: 'p1', docId, sv: '', role: 'editor' });
    Y.applyUpdate(bob, Buffer.from(synced.update, 'base64'), 'remote');
    /** bob types `text` into paragraph `index` at `at`, as the updates route posts it */
    const type = (index, at, text) => {
        const sent = [];
        const keep = (u, origin) => { if (origin !== 'remote') sent.push(Buffer.from(u).toString('base64')); };
        bob.on('update', keep);
        typeInto(bob, index, at, text);
        bob.off('update', keep);
        return w.collab.applyClientUpdates({ projectId: 'p1', docId, userId: 'bob', clientId: bob.clientID, updates: sent });
    };
    return { type };
}

const live = (id) => w.collab.readMarkdown('notebook', id);

test('an AI edit from an older read keeps what a colleague typed since', async () => {
    const base = '<p>Intro old.</p><p>Para two.</p><p>Para five by team.</p>';
    const { type } = await coEdited('nb-keep', base);
    // The AI turn read `base` and is thinking; bob edits paragraph 3 and adds a closing one.
    await type(2, 17, ', EDITED BY B');
    await type(3, 0, 'Closing paragraph by B.');
    const aiDocument = '<p>Intro rewritten by AI.</p><p>Para two.</p><p>Para five by team.</p>';

    const r = await notebookCollab.applyEdit('nb-keep', AI, { html: aiDocument, base: { html: base } }, w.collab);
    assert.strictEqual(r.applied, true);
    assert.strictEqual(await live('nb-keep'),
        'Intro rewritten by AI.\n\nPara two.\n\nPara five by team, EDITED BY B.\n\nClosing paragraph by B.');
});

test('the AI editing a paragraph a colleague changed meanwhile writes nothing: a conflict', async () => {
    const base = '<p>Intro old.</p><p>Para two.</p>';
    const { type } = await coEdited('nb-clash', base);
    await type(0, 10, ' Bob was here.');
    const before = await live('nb-clash');

    const r = await notebookCollab.applyEdit('nb-clash', AI, { html: '<p>Intro by AI.</p><p>Para two.</p>', base: { html: base } }, w.collab);
    assert.deepStrictEqual(r, { applied: false, conflict: true });
    assert.strictEqual(await live('nb-clash'), before, 'bob\'s text is untouched');
});

test('typing between the read and the write: the stale rebase is refused, read again and rebased', async () => {
    const base = '<p>One.</p><p>Two.</p>';
    const { type } = await coEdited('nb-race', base);
    let reads = 0;
    const racing = {
        ...w.collab,
        // bob types right after the writer's first read of the live document
        read: async (kind, id) => {
            const r = await w.collab.read(kind, id);
            if (++reads === 1) await type(1, 4, ' And three.');
            return r;
        },
    };
    const r = await notebookCollab.applyEdit('nb-race', AI, { html: '<p>One, by AI.</p><p>Two.</p>', base: { html: base } }, racing);
    assert.strictEqual(r.applied, true);
    assert.strictEqual(reads, 2, 'the first rebase was refused as stale and made again');
    assert.strictEqual(await live('nb-race'), 'One, by AI.\n\nTwo. And three.');
});

test('a whole-document write (a restore) still replaces the document', async () => {
    await coEdited('nb-restore', '<p>Now.</p>');
    const r = await notebookCollab.applyEdit('nb-restore', { origin: 'restore', actorId: 'ann' }, { html: '<p>Then.</p>' }, w.collab);
    assert.strictEqual(r.applied, true);
    assert.strictEqual(await live('nb-restore'), 'Then.');
});

test('a whole document composed from an earlier read goes in only while nobody typed since that read', async () => {
    const { type } = await coEdited('nb-whole', '<p>Intro.</p><p>Budget line.</p>');
    const read = await notebookCollab.readCurrentContent({ id: 'nb-whole' }, w.collab);
    assert.ok(Number.isInteger(read.seq), 'a live read says which update it was made at');
    await type(1, 12, ' Anna typed this.');
    const stale = await notebookCollab.applyEdit('nb-whole', AI, { markdown: 'Rewritten.\n\nBudget line.', expectSeq: read.seq }, w.collab);
    assert.strictEqual(stale.applied, false);
    assert.strictEqual(stale.stale, true);
    assert.strictEqual(await live('nb-whole'), 'Intro.\n\nBudget line. Anna typed this.', 'nothing written over the typing');

    const again = await notebookCollab.readCurrentContent({ id: 'nb-whole' }, w.collab);
    const ok = await notebookCollab.applyEdit('nb-whole', AI, { markdown: 'Rewritten.\n\nBudget line. Anna typed this.', expectSeq: again.seq }, w.collab);
    assert.strictEqual(ok.applied, true);
    assert.strictEqual(await live('nb-whole'), 'Rewritten.\n\nBudget line. Anna typed this.');
});

test('a co-edited notebook the engine cannot read is active but not live', async () => {
    await coEdited('nb-locked', '<p>Live text.</p>');
    w.failKeys();
    const current = await notebookCollab.readCurrentContent({ id: 'nb-locked', documentContent: '<p>stale mirror</p>', documentMd: 'stale mirror' }, w.collab);
    assert.deepStrictEqual(current, { html: '<p>stale mirror</p>', markdown: 'stale mirror', live: false, active: true, seq: null });
    w.failKeys(false);
    const fresh = await notebookCollab.readCurrentContent({ id: 'nb-locked', documentContent: '<p>stale mirror</p>', documentMd: null }, w.collab);
    assert.deepStrictEqual({ markdown: fresh.markdown, live: fresh.live, active: fresh.active }, { markdown: 'Live text.', live: true, active: true });
});

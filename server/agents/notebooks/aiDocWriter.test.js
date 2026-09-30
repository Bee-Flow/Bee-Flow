/**
 * The notebook chat's AI document writes (agents/notebooks/aiDocWriter.js).
 *
 * Co-edited: over the real co-editing engine (core/collab/collab.testkit, PGlite).
 * The model edits the copy it read at the start of the turn; a colleague who
 * types in the tens of seconds the turn takes keeps their text (the whole
 * AI document used to replace the live one, taking it out of every editor),
 * a chained second edit in the same turn keeps it too, and an edit to the
 * paragraph the colleague changed is kept as a proposal instead of written.
 *
 * Single-writer: compare-and-set over the version the page loaded, as before.
 *
 * Run: cd server && node --test agents/notebooks/aiDocWriter.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');
const { collabWorld, typeInto } = require('../../core/collab/collab.testkit');
const { makeAiDocWriter } = require('./aiDocWriter');

let w;
test.beforeEach(async () => { w = await collabWorld(); });
test.afterEach(async () => { await w.close(); });

/** An in-memory notebook row with the store calls the writer makes. */
function memoryStore(row) {
    const versions = [];
    return {
        versions,
        row,
        getNotebook: async () => ({ ...row }),
        recordVersion: async (_id, v) => { versions.push(v); return { id: `v${versions.length}`, deduped: false }; },
        updateNotebookCas: async (_id, _user, { documentContent, expectedVersion }) => {
            if (expectedVersion !== row.version) return { ok: false, conflict: true, currentVersion: row.version };
            row.documentContent = documentContent;
            row.version += 1;
            return { ok: true, version: row.version };
        },
    };
}

/** bob's editor on a co-edited notebook: `type(block, at, text)` posts his typing. */
async function bobOn(id, html) {
    w.addResource('notebook', id, { html });
    const { docId } = await w.collab.openDoc({ projectId: 'p1', userId: 'bob', role: 'editor', kind: 'notebook', resourceId: id });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from((await w.collab.sync({ projectId: 'p1', docId, sv: '', role: 'editor' })).update, 'base64'), 'remote');
    return (block, at, text) => {
        const updates = [];
        const keep = (u, origin) => { if (origin !== 'remote') updates.push(Buffer.from(u).toString('base64')); };
        doc.on('update', keep);
        typeInto(doc, block, at, text);
        doc.off('update', keep);
        return w.collab.applyClientUpdates({ projectId: 'p1', docId, userId: 'bob', clientId: doc.clientID, updates });
    };
}

const TURN_START = '<p>Intro old.</p><p>Para five by team.</p>';

test('co-edited: a colleague\'s typing during the turn survives the AI\'s edit, and its chained second edit', async () => {
    const type = await bobOn('nb-1', TURN_START);
    const store = memoryStore({ id: 'nb-1', version: 4, documentContent: TURN_START });
    const writer = makeAiDocWriter({ notebookId: 'nb-1', userId: 'ann', baseHtml: TURN_START, expectedVersion: 4, store, collab: () => w.collab });

    // While the model thinks, bob edits paragraph 2 and adds a closing paragraph.
    await type(1, 17, ', EDITED BY B');
    await type(2, 0, 'Closing paragraph by B.');
    const first = await writer.write('<p>Intro rewritten by AI.</p><p>Para five by team.</p>', 'Intro rewritten by AI.\n\nPara five by team.');
    assert.deepStrictEqual({ ok: first.ok, live: first.live }, { ok: true, live: true });
    assert.strictEqual(await w.collab.readMarkdown('notebook', 'nb-1'),
        'Intro rewritten by AI.\n\nPara five by team, EDITED BY B.\n\nClosing paragraph by B.');
    assert.match(first.html, /EDITED BY B/, 'the answer carries the merged document, for the AI version');

    // The model chains a second edit on ITS copy (which never saw bob's text).
    const second = await writer.write('<p>Intro rewritten by AI.</p><p>Para five by team.</p><p>Summary by AI.</p>', null, { snapshot: false });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(await w.collab.readMarkdown('notebook', 'nb-1'),
        'Intro rewritten by AI.\n\nPara five by team, EDITED BY B.\n\nClosing paragraph by B.\n\nSummary by AI.');
    assert.strictEqual(store.row.documentContent, TURN_START, 'the row was never written behind the engine');
    assert.deepStrictEqual(store.versions.map((v) => v.source), ['checkpoint'], 'one undo point before the turn\'s first AI write');
    assert.match(store.versions[0].html, /EDITED BY B/, 'taken from the live document');
});

test('co-edited: the AI rewriting the paragraph a colleague changed is kept as a proposal, not written', async () => {
    const type = await bobOn('nb-2', TURN_START);
    const store = memoryStore({ id: 'nb-2', version: 1, documentContent: TURN_START });
    const writer = makeAiDocWriter({ notebookId: 'nb-2', userId: 'ann', baseHtml: TURN_START, expectedVersion: 1, store, collab: () => w.collab });
    await type(0, 10, ' Bob was here.');

    const r = await writer.write('<p>Intro by AI.</p><p>Para five by team.</p>', 'Intro by AI.\n\nPara five by team.');
    assert.deepStrictEqual(r, { ok: false, conflict: true });
    assert.strictEqual(await w.collab.readMarkdown('notebook', 'nb-2'), 'Intro old. Bob was here.\n\nPara five by team.');
    assert.deepStrictEqual(store.versions.map((v) => v.source), ['checkpoint', 'conflict'],
        'the live state kept as a checkpoint, the AI\'s text as a proposal');
    assert.strictEqual(store.versions[1].html, '<p>Intro by AI.</p><p>Para five by team.</p>');
});

test('single-writer: compare-and-set over the loaded version; a newer save by someone else is a conflict', async () => {
    const store = memoryStore({ id: 'nb-3', version: 2, documentContent: TURN_START });
    const writer = makeAiDocWriter({ notebookId: 'nb-3', userId: 'ann', baseHtml: TURN_START, expectedVersion: 2, store, collab: () => w.collab });
    assert.deepStrictEqual(await writer.write('<p>AI one.</p>', 'AI one.'), { ok: true, version: 3 });
    assert.deepStrictEqual(await writer.write('<p>AI two.</p>', 'AI two.', { snapshot: false }), { ok: true, version: 4 }, 'chained edits follow the version');
    store.row.documentContent = '<p>Someone else.</p>';
    store.row.version = 9;
    assert.deepStrictEqual(await writer.write('<p>AI three.</p>', 'AI three.', { snapshot: false }), { ok: false, conflict: true });
    assert.strictEqual(store.row.documentContent, '<p>Someone else.</p>');
    assert.deepStrictEqual(store.versions.map((v) => v.source), ['checkpoint', 'conflict']);
});

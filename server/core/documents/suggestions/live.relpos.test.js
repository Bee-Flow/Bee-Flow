'use strict';

/**
 * A suggestion on a page edited live finds its passage by relative position,
 * end to end: the real co-editing server (core/collab over PGlite, the
 * collab test kit) with the REAL editor bundle and suggestion engine.
 *
 * The page holds the same paragraph twice. The AI proposes a change to the
 * FIRST one; a colleague then deletes the paragraphs around it, so the
 * suggestion's blockIndex points at the OTHER copy and its text matches both.
 * Only the relative position, made against the live fragment when the
 * suggestion was proposed and resolved against it when it is accepted, can
 * tell them apart.
 *
 * Skipped when the editor bundle has no suggestion engine (rebuild with
 * `npm run build:editor-collab`).
 *
 * Run: cd server && node --test core/documents/suggestions/live.relpos.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');
const bundle = require('../../markdown/editorCollab.cjs');
const { collabWorld } = require('../../collab/collab.testkit');
const { makeConverter } = require('../../collab/convert');
const { engine } = require('./engine');
const { makeSuggestionApplier } = require('./apply');

const hasEngine = typeof bundle.anchorsForFragment === 'function' && typeof bundle.applyHunks === 'function';
const BODY = '<p>Intro.</p><p>Dup text.</p><p>Middle.</p><p>Dup text.</p>';

let w;
test.beforeEach(async () => { w = await collabWorld({ converter: makeConverter() }); });
test.afterEach(async () => { await w.close(); });

/** Open a page's live document as ann and return a synced client copy. */
async function openPage(id, html) {
    w.addResource('document', id, { html });
    const { docId } = await w.collab.openDoc({ projectId: 'p1', userId: 'ann', role: 'editor', kind: 'document', resourceId: id });
    const doc = new Y.Doc();
    const s = await w.collab.sync({ projectId: 'p1', docId, sv: '', role: 'editor' });
    Y.applyUpdate(doc, Buffer.from(s.update, 'base64'), 'remote');
    return { docId, doc };
}

/** bob deletes the paragraphs around the duplicates, as the editor would: the smallest change. */
async function peerDeletesAround(docId, doc) {
    const fragment = doc.getXmlFragment(bundle.FRAGMENT_NAME);
    const cache = bundle.createYCache();
    const seen = bundle.fragmentToAst(fragment, cache);
    const out = [];
    const on = (u, origin) => { if (origin !== 'remote') out.push(u); };
    doc.on('update', on);
    bundle.syncDocToFragment(fragment, { ...seen, content: [seen.content[1], seen.content[3]] }, cache);
    doc.off('update', on);
    await w.collab.applyClientUpdates({
        projectId: 'p1', docId, userId: 'bob', clientId: doc.clientID, updates: out.map((u) => Buffer.from(u).toString('base64')),
    });
}

/** A one-document suggestion store in memory. */
function memoryStore(rows) {
    return {
        get: async (id) => rows.find((r) => r.id === id) || null,
        setStatus: async (ids, status) => { for (const r of rows) if (ids.includes(r.id)) r.status = status; return ids; },
        countOpen: async () => rows.filter((r) => r.status === 'open').length,
    };
}

test('accepting applies to the paragraph the AI meant, though a colleague moved it and its twin took its place', { skip: !hasEngine && 'editor bundle predates the suggestion engine' }, async () => {
    const eng = engine();
    const { docId, doc } = await openPage('pg-dup', BODY);

    // Proposed against the live state, anchored into the live fragment.
    const hunks = await w.collab.withFragment('document', 'pg-dup', ({ html, fragment }) => {
        const proposed = html.replace('<p>Dup text.</p>', '<p>Dup text, rewritten by the AI.</p>');
        return eng.anchorsForFragment(fragment, eng.hunksFrom(eng.htmlToAst(html), eng.htmlToAst(proposed)).hunks);
    });
    assert.strictEqual(hunks.length, 1);
    assert.strictEqual(hunks[0].anchor.blockIndex, 1);
    assert.ok(hunks[0].anchor.relStart, 'the anchor carries a relative position into the live fragment');

    await peerDeletesAround(docId, doc);
    assert.strictEqual(await w.collab.readHtml('document', 'pg-dup'), '<p>Dup text.</p><p>Dup text.</p>');

    // The fallbacks alone would pick the wrong twin: blockIndex 1 is now the second copy.
    const blind = await w.collab.withFragment('document', 'pg-dup', ({ html }) => eng.astToHtml(eng.applyHunks(eng.htmlToAst(html), hunks, null).doc));
    assert.strictEqual(blind, '<p>Dup text.</p><p>Dup text, rewritten by the AI.</p>');

    const rows = [{ id: 's1', batchId: 'b1', targetId: 'pg-dup', status: 'open', ...hunks[0] }];
    const applier = makeSuggestionApplier({
        store: memoryStore(rows),
        documents: { updateDocument: async () => { throw new Error('a live page is never written by revision'); } },
        liveCollabFor: async () => w.collab,
        announce: async () => {},
    });
    const out = await applier.accept({ doc: { id: 'pg-dup', docType: 'page', projectId: 'p1', versionId: 'v1' }, ids: ['s1'], actor: { userId: 'ann' } });

    assert.deepStrictEqual(out.accepted, ['s1']);
    assert.deepStrictEqual(out.stale, []);
    assert.strictEqual(await w.collab.readHtml('document', 'pg-dup'), '<p>Dup text, rewritten by the AI.</p><p>Dup text.</p>');
});

test('withFragment: null for a page that is not co-edited, and the state is opened once per call', async () => {
    w.addResource('document', 'pg-solo', { html: '<p>Alone</p>' });
    assert.strictEqual(await w.collab.withFragment('document', 'pg-solo', () => 'never'), null);

    await openPage('pg-live', '<p>One</p>');
    const seen = await w.collab.withFragment('document', 'pg-live', ({ html, seq, fragment, ydoc }) => ({ html, seq, same: fragment.doc === ydoc }));
    assert.deepStrictEqual(seen, { html: '<p>One</p>', seq: seen.seq, same: true });
    assert.ok(Number.isInteger(seen.seq));
});

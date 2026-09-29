/**
 * The second hop: what a chunk row cannot say about itself.
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────
 * `kb_chunks` holds the passage. `documents` holds what the passage is OF —
 * its kind, a meeting's own date, the table rows a block covers. Retrieval
 * selected from `kb_chunks` alone and never joined the two, so an ingest could
 * store a meeting's date perfectly and the citation still had nothing to say:
 * `kind` fell back to whatever the CALLER had passed as a default on every
 * path, which is why the meeting and datatable branches in the client were
 * unreachable code that looked maintained.
 *
 * The rule that keeps this from becoming a restyle: only the kinds the client
 * draws its own glyph for are allowed through. An 'upload' has no glyph of its
 * own, and letting the column decide would quietly change chips that render
 * correctly today.
 *
 * Run: cd server && node --test --test-force-exit core/kb/localKBIngest.facts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { enrichWithDocumentFacts } = require('./localKBIngest');
const { toCitation } = require('./citation');

/** A connection that answers the one query this function asks. */
function client(docs, calls = {}) {
    calls.queries = calls.queries || [];
    return {
        query: async (sql, params) => {
            calls.queries.push({ sql, params });
            if (calls.throws) throw new Error(calls.throws);
            return { rows: docs };
        },
        release: () => { calls.released = true; },
    };
}

/** `documents.id` is a uuid column, so a chunk points at one in text form. */
const DOC = '4f1c0b2e-9a44-4d2f-8b7a-1c0e2d3f4a5b';

const chunk = (over = {}) => ({
    id: 1, title: 'Producten', content: 'naam: Kaars', score: 0.4, document_id: DOC.toUpperCase(), ...over,
});

test('a table block learns which rows it covers, and cites them', async () => {
    const rows = [chunk()];
    await enrichWithDocumentFacts(rows, {
        client: client([{ doc_id: DOC, source_type: 'datatable', metadata: { rowStart: 1, rowEnd: 50 } }]),
    });
    const c = toCitation(rows[0]);
    assert.strictEqual(c.rowStart, 1);
    assert.strictEqual(c.rowEnd, 50);
    assert.strictEqual(c.kind, 'datatable');
});

test('a meeting note learns the day it was held', async () => {
    const rows = [chunk({ title: 'Salesoverleg' })];
    await enrichWithDocumentFacts(rows, {
        client: client([{ doc_id: DOC, source_type: 'meeting', metadata: { meetingDate: '2026-07-22T09:00:00.000Z' } }]),
    });
    assert.strictEqual(toCitation(rows[0]).occurredAt, '2026-07-22T09:00:00.000Z');
});

test('the document id is matched case-insensitively', async () => {
    // `document_id` is text in kb_chunks and uuid in documents, and the two
    // disagree on case often enough that an exact match finds nothing.
    const rows = [chunk({ document_id: DOC.toUpperCase() })];
    const calls = {};
    await enrichWithDocumentFacts(rows, { client: client([{ doc_id: DOC, source_type: 'meeting', metadata: {} }], calls) });
    assert.deepStrictEqual(calls.queries[0].params, [[DOC]]);
    assert.strictEqual(rows[0].kind, 'meeting');
});

test('a document_id that is not a uuid is skipped rather than scanned for', async () => {
    // The lookup is a primary-key match; anything that cannot be one gets no
    // extra detail, which is the same as before this existed.
    const calls = {};
    const rows = [chunk({ document_id: 'doc-1' })];
    await enrichWithDocumentFacts(rows, { client: client([], calls) });
    assert.deepStrictEqual(calls.queries, []);
});

test('only the kinds the client can draw are allowed to override', async () => {
    // 'upload' and 'text' have no glyph of their own. Letting them through
    // would restyle every chip in the product to make three of them work.
    for (const source_type of ['upload', 'text', 'url_import', 'nextcloud', null]) {
        const rows = [chunk()];
        await enrichWithDocumentFacts(rows, { client: client([{ doc_id: DOC, source_type, metadata: {} }]) });
        assert.strictEqual(rows[0].kind, undefined, String(source_type));
        assert.strictEqual(toCitation(rows[0]).kind, 'kb_chunk', 'the caller`s default still wins');
    }
});

test('metadata that arrived as a JSON string is read the same way', async () => {
    const rows = [chunk()];
    await enrichWithDocumentFacts(rows, {
        client: client([{ doc_id: DOC, source_type: 'datatable', metadata: '{"rowStart":51,"rowEnd":100}' }]),
    });
    assert.strictEqual(toCitation(rows[0]).rowStart, 51);
});

test('REGRESSION: a document with nothing extra leaves the citation exactly as it was', async () => {
    // Every document ingested before any of this existed.
    const rows = [chunk({ page_start: 12, title: 'Personeelshandboek' })];
    const before = toCitation(rows[0]);
    await enrichWithDocumentFacts(rows, { client: client([{ doc_id: DOC, source_type: 'upload', metadata: {} }]) });
    assert.deepStrictEqual(toCitation(rows[0]), before);
});

test('a lookup that fails leaves the answer standing', async () => {
    // The document facts are a bonus on top of a citation that already works.
    // Losing the connection must cost the extra detail, never the citation.
    const rows = [chunk()];
    const before = toCitation(rows[0]);
    const calls = { throws: 'connection terminated' };
    await enrichWithDocumentFacts(rows, { client: client([], calls) });
    assert.deepStrictEqual(toCitation(rows[0]), before);
});

test('a passage whose document has been deleted is left alone', async () => {
    const rows = [chunk(), chunk({ id: 2, document_id: '00000000-0000-4000-8000-000000000000' })];
    await enrichWithDocumentFacts(rows, {
        client: client([{ doc_id: DOC, source_type: 'meeting', metadata: { meetingDate: '2026-07-22T09:00:00.000Z' } }]),
    });
    assert.strictEqual(rows[1].kind, undefined);
    assert.strictEqual(rows[1].occurred_at, undefined);
});

test('rows with no document id ask the database nothing at all', async () => {
    const calls = {};
    const rows = [{ id: 1, content: 'x' }];
    await enrichWithDocumentFacts(rows, { client: client([], calls) });
    assert.deepStrictEqual(calls.queries, []);
    assert.deepStrictEqual(await enrichWithDocumentFacts([], { client: client([], calls) }), []);
    assert.deepStrictEqual(await enrichWithDocumentFacts(null, { client: client([], calls) }), null);
});

test('a borrowed connection is not released out from under its owner', async () => {
    const calls = {};
    await enrichWithDocumentFacts([chunk()], { client: client([], calls) });
    assert.notStrictEqual(calls.released, true);
});

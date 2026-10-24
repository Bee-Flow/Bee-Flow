/**
 * The round loop that cleans up the embeddings of a source before the source row falls.
 *
 * The danger lies not in an error but in the SILENCE: `documents.source_id` cascades, so every document
 * that the loop skips disappears from the table AND keeps its vectors in the search service. Nothing breaks,
 * no error is reported, and the text remains searchable. Hence two things are pinned here: that the loop
 * goes beyond the first page of 200, and that it says `complete: false` as soon as that did NOT succeed,
 * because that is the only signal on which a caller may leave the source row in place.
 *
 * Without a database: `kbStore` and `deleteDocumentChunks` come in as parameters, so the doubles here are
 * the real calling shape.
 *
 * Run: cd server && node --test --test-force-exit core/kb/purgeSourceDocuments.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { purgeSourceDocuments, PAGE } = require('./purgeSourceDocuments');

/**
 * A double that behaves like the real stack: `deleteDocumentChunks` removes the document row (that is
 * what kbStore.deleteDocument does inside it), so the next round no longer sees it. Without that behaviour
 * a broken loop would spin forever instead of turning red.
 */
function harness({ docs = [], failOn = new Set(), listLimit = true } = {}) {
    const state = { docs: [...docs], listCalls: [], chunkDeletes: [] };
    const kbStore = {
        listDocuments: async (kbId, opts = {}) => {
            state.listCalls.push({ kbId, ...opts });
            const sourceId = (opts.filters || {}).sourceId;
            const rows = state.docs.filter(d => d.kbId === kbId && d.sourceId === sourceId);
            return listLimit ? rows.slice(0, opts.limit) : rows;
        },
    };
    const deleteDocumentChunks = async (kbId, docId, tenantId, opts) => {
        state.chunkDeletes.push({ kbId, docId, tenantId, opts });
        if (failOn.has(docId)) throw new Error(`search-service refused ${docId}`);
        state.docs = state.docs.filter(d => d.id !== docId);
    };
    return { state, kbStore, deleteDocumentChunks };
}

function docsFor(n, { kbId = 'kb-1', sourceId = 'src-1' } = {}) {
    return Array.from({ length: n }, (_, i) => ({ id: `doc-${i + 1}`, kbId, sourceId }));
}

test('DE 201e KOMT ER OOK AF — één pagina van 200 is niet genoeg', async () => {
    // The bug that this closed: one listDocuments with limit 200 and then an unconditional
    // remove. Document 201 then went along in the FK cascade WITHOUT its chunks ever having been cleaned up.
    const h = harness({ docs: docsFor(201) });
    const out = await purgeSourceDocuments({
        kbStore: h.kbStore, deleteDocumentChunks: h.deleteDocumentChunks,
        kbId: 'kb-1', sourceId: 'src-1', tenantId: 'owner-1',
    });
    assert.strictEqual(out.deleted, 201);
    assert.strictEqual(out.complete, true);
    assert.deepStrictEqual(out.errors, []);
    assert.strictEqual(h.state.chunkDeletes.length, 201, 'elk document is langs de chunk-opruiming geweest');
    assert.ok(h.state.chunkDeletes.some(c => c.docId === 'doc-201'), 'juist de 201e is de rij die vroeger bleef staan');
    assert.strictEqual(h.state.docs.length, 0);
    // 200 + 1 + de lege ronde die "klaar" bewijst.
    assert.strictEqual(h.state.listCalls.length, 3);
    assert.ok(h.state.listCalls.every(c => c.limit === PAGE), 'elke ronde vraagt een volle pagina op');
});

test('elk document gaat met skipSnapshot weg — een bron-gedreven verwijdering schrijft geen audit-kopie', async () => {
    const h = harness({ docs: docsFor(2) });
    await purgeSourceDocuments({
        kbStore: h.kbStore, deleteDocumentChunks: h.deleteDocumentChunks,
        kbId: 'kb-1', sourceId: 'src-1', tenantId: 'owner-1',
    });
    assert.ok(h.state.chunkDeletes.every(c => c.opts && c.opts.skipSnapshot === true));
    assert.ok(h.state.chunkDeletes.every(c => c.tenantId === 'owner-1'), 'de tenant gaat mee, anders wist de search-service niets');
});

test('documenten van een ANDERE bron blijven staan', async () => {
    const h = harness({ docs: [...docsFor(2), { id: 'vreemd', kbId: 'kb-1', sourceId: 'src-2' }] });
    const out = await purgeSourceDocuments({
        kbStore: h.kbStore, deleteDocumentChunks: h.deleteDocumentChunks,
        kbId: 'kb-1', sourceId: 'src-1', tenantId: 'owner-1',
    });
    assert.strictEqual(out.deleted, 2);
    assert.deepStrictEqual(h.state.docs.map(d => d.id), ['vreemd']);
});

test('een bron zonder documenten is klaar, niet stuk', async () => {
    const h = harness({ docs: [] });
    const out = await purgeSourceDocuments({
        kbStore: h.kbStore, deleteDocumentChunks: h.deleteDocumentChunks,
        kbId: 'kb-1', sourceId: 'src-1', tenantId: 'owner-1',
    });
    assert.deepStrictEqual(out, { deleted: 0, errors: [], complete: true });
    assert.strictEqual(h.state.listCalls.length, 1);
});

test('EEN DOCUMENT DAT NIET WEG WIL MAAKT `complete` ONWAAR — en de lus draait geen rondjes', async () => {
    // The document stays in the fixture, so a loop without a "nothing-came-off" exit
    // would go on here forever.
    const h = harness({ docs: docsFor(3), failOn: new Set(['doc-2']) });
    const out = await purgeSourceDocuments({
        kbStore: h.kbStore, deleteDocumentChunks: h.deleteDocumentChunks,
        kbId: 'kb-1', sourceId: 'src-1', tenantId: 'owner-1',
    });
    assert.strictEqual(out.complete, false, 'er staat nog een document met chunks — dit mag NOOIT klaar heten');
    assert.strictEqual(out.deleted, 2);
    // Two rounds have attempted the same document; `errors` counts DOCUMENTS, not attempts,
    // otherwise a client reads six refusals of one document as six broken documents.
    assert.strictEqual(out.errors.length, 1);
    assert.strictEqual(out.errors[0].documentId, 'doc-2');
    assert.deepStrictEqual(h.state.docs.map(d => d.id), ['doc-2']);
    assert.ok(h.state.listCalls.length <= 3, 'de tweede ronde haalde niets weg en de lus stopte');
});

test('de rondenlimiet op laten gaan is GEEN klaar, ook zonder één enkele fout', async () => {
    // The silent variant: nothing went wrong, there is only work left over. If that gave
    // `complete: true`, the caller would remove the source row and let the rest disappear via the
    // FK cascade, with vectors and all.
    const h = harness({ docs: docsFor(5) });
    const out = await purgeSourceDocuments({
        kbStore: h.kbStore, deleteDocumentChunks: h.deleteDocumentChunks,
        kbId: 'kb-1', sourceId: 'src-1', tenantId: 'owner-1',
        pageSize: 2, maxRounds: 1,
    });
    assert.strictEqual(out.complete, false);
    assert.strictEqual(out.deleted, 2);
    assert.deepStrictEqual(out.errors, [], 'geen fout — en tóch niet klaar');
    assert.strictEqual(h.state.docs.length, 3);
});

test('een lijst die niets teruggeeft (null) is leeg, geen crash', async () => {
    const out = await purgeSourceDocuments({
        kbStore: { listDocuments: async () => null },
        deleteDocumentChunks: async () => {},
        kbId: 'kb-1', sourceId: 'src-1', tenantId: 'owner-1',
    });
    assert.deepStrictEqual(out, { deleted: 0, errors: [], complete: true });
});

test('zonder store of zonder opruimfunctie gooit hij — hij meldt zich nooit klaar', async () => {
    // Fail-closed: an empty-and-done answer would let the caller remove the source while
    // not a single chunk has been touched.
    await assert.rejects(
        () => purgeSourceDocuments({ deleteDocumentChunks: async () => {}, kbId: 'kb-1', sourceId: 'src-1' }),
        /kbStore\.listDocuments is required/,
    );
    await assert.rejects(
        () => purgeSourceDocuments({ kbStore: { listDocuments: async () => [] }, kbId: 'kb-1', sourceId: 'src-1' }),
        /deleteDocumentChunks is required/,
    );
});

test('een lege bron-id of kennisbank-id gooit — het is geen "alles"', async () => {
    // `buildDocumentFilters` adds `source_id = ?` only for a TRUTHY sourceId; an empty id would
    // therefore catch EVERY document of the knowledge base and report the caller "done", after which
    // he removes the source row.
    const kbStore = { listDocuments: async () => [{ id: 'd1' }] };
    const deleteDocumentChunks = async () => {};
    for (const bad of [undefined, null, '', '   ', 42]) {
        await assert.rejects(
            () => purgeSourceDocuments({ kbStore, deleteDocumentChunks, kbId: 'kb-1', sourceId: bad, tenantId: 'owner-1' }),
            /sourceId is required/,
            `sourceId ${JSON.stringify(bad)} moet weigeren`,
        );
        await assert.rejects(
            () => purgeSourceDocuments({ kbStore, deleteDocumentChunks, kbId: bad, sourceId: 'src-1', tenantId: 'owner-1' }),
            /kbId is required/,
            `kbId ${JSON.stringify(bad)} moet weigeren`,
        );
    }
});

test('een document dat elke ronde weigert staat één keer in errors', async () => {
    // The loop lists again from the start after every round, so a refusing document comes back. Six identical
    // lines about the same document would let a client count as if six documents are broken.
    let round = 0;
    const kbStore = {
        listDocuments: async () => (round++ < 3 ? [{ id: 'goed-' + round }, { id: 'stug' }] : []),
    };
    const out = await purgeSourceDocuments({
        kbStore,
        deleteDocumentChunks: async (_kb, docId) => { if (docId === 'stug') throw new Error('nee'); },
        kbId: 'kb-1', sourceId: 'src-1', tenantId: 'owner-1',
    });
    assert.deepStrictEqual(out.errors.map(e => e.documentId), ['stug']);
    assert.strictEqual(out.deleted, 3);
});

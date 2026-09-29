/**
 * De rondenlus die de embeddings van een bron opruimt vóórdat de bronrij valt.
 *
 * Het gevaar zit niet in een fout maar in de STILTE: `documents.source_id`
 * cascadeert, dus elk document dat de lus overslaat verdwijnt uit de tabel én
 * houdt zijn vectoren in de search-service. Er gaat niets stuk, er komt geen
 * foutmelding, en de tekst blijft doorzoekbaar. Vandaar dat hier twee dingen
 * gepind staan: dat de lus voorbij de eerste pagina van 200 komt, en dat hij
 * `complete: false` zegt zodra dat NIET is gelukt — want dat is het enige
 * signaal waarop een aanroeper de bronrij mag laten staan.
 *
 * Zonder database: `kbStore` en `deleteDocumentChunks` komen als parameters
 * binnen, dus de dubbels hier zijn de echte aanroepvorm.
 *
 * Run: cd server && node --test --test-force-exit core/kb/purgeSourceDocuments.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { purgeSourceDocuments, PAGE } = require('./purgeSourceDocuments');

/**
 * Een dubbel die zich gedraagt zoals de echte stack: `deleteDocumentChunks`
 * haalt de documentrij weg (dat doet kbStore.deleteDocument erin), dus de
 * volgende ronde ziet hem niet meer. Zonder dat gedrag zou een kapotte lus
 * eeuwig doordraaien in plaats van rood te worden.
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
    // De bug die dit dichtte: één listDocuments met limit 200 en daarna een
    // onvoorwaardelijke remove. Document 201 ging dan mee in de FK-cascade
    // zónder dat zijn chunks ooit waren opgeruimd.
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
    // Het document blijft in de fixture staan, dus een lus zonder
    // "niets-kwam-eraf"-uitgang zou hier eeuwig doorgaan.
    const h = harness({ docs: docsFor(3), failOn: new Set(['doc-2']) });
    const out = await purgeSourceDocuments({
        kbStore: h.kbStore, deleteDocumentChunks: h.deleteDocumentChunks,
        kbId: 'kb-1', sourceId: 'src-1', tenantId: 'owner-1',
    });
    assert.strictEqual(out.complete, false, 'er staat nog een document met chunks — dit mag NOOIT klaar heten');
    assert.strictEqual(out.deleted, 2);
    // Twee ronden hebben hetzelfde document geprobeerd; `errors` telt
    // DOCUMENTEN, niet pogingen — anders leest een client zes weigeringen van
    // één document als zes stukke documenten.
    assert.strictEqual(out.errors.length, 1);
    assert.strictEqual(out.errors[0].documentId, 'doc-2');
    assert.deepStrictEqual(h.state.docs.map(d => d.id), ['doc-2']);
    assert.ok(h.state.listCalls.length <= 3, 'de tweede ronde haalde niets weg en de lus stopte');
});

test('de rondenlimiet op laten gaan is GEEN klaar, ook zonder één enkele fout', async () => {
    // De stille variant: niets ging mis, er is alleen nog werk over. Als dat
    // `complete: true` opleverde zou de aanroeper de bronrij weghalen en de
    // rest via de FK-cascade laten verdwijnen — mét vectoren.
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
    // Fail-closed: een lege-en-klaar teruggave zou de aanroeper de bron laten
    // weghalen terwijl er geen enkele chunk is aangeraakt.
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
    // `buildDocumentFilters` hangt `source_id = ?` alleen aan een TRUTHY
    // sourceId; een lege id zou dus élk document van de kennisbank pakken en
    // de aanroeper daarna "klaar" melden, waarna hij de bronrij weghaalt.
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
    // De lus lijst na elke ronde opnieuw vanaf het begin, dus een weigerend
    // document komt terug. Zes identieke regels over hetzelfde document zou
    // een client laten tellen alsof er zes documenten stuk zijn.
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

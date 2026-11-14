/**
 * Source cards for the knowledge-base passages a direct chat puts into its
 * prompt without a tool call (attached bases, project bases), and how they are
 * kept with the stored answer.
 *
 * The passages went into the prompt and no `kb_sources` event went out, so the
 * answer showed no sources at all. The turn-level check (one event for an
 * attached base with a matching document, through the real prompt assembly)
 * is in promptAssembly.kb.test.js; this file pins `emitKbSources` itself and
 * the way to the stored row: the cards land on the turn's collector, a
 * kb_search result joins them (a passage once), and the assistant row carries
 * them as `kbSources`, the name the agent runtime stores and both clients read.
 *
 * Run: cd server && node --test routes/ai/directChat/promptContext.kbSources.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { emitKbSources } = require('./promptContext');
const { emitToolResultEvents } = require('../../../usecases/ai/directChat/toolResultEvents');
const { buildAssistantRow } = require('../../../usecases/ai/directChat/finalizeRows');
const { CITATION_FIELDS } = require('../../../core/kb/citation');

// A document id that is not a uuid: the "kept original" lookup has nothing to ask the database.
const PRICE_PASSAGE = {
    title: 'Prijslijst 2026.pdf',
    content: '## Tarieven\nHet abonnement Plus kost 41 euro per maand.',
    score: 0.83,
    source_uri: 'Prijslijst 2026.pdf',
    document_id: 'doc-1',
    chunk_id: 'chunk-1',
    page_start: 2,
    kb_id: 'kb-1',
};

function recorder() {
    /** @type {Array<{ event: string, data: any }>} */
    const events = [];
    return { events, send: (/** @type {string} */ event, /** @type {any} */ data) => { events.push({ event, data }); } };
}

/** @param {Record<string, unknown>} t */
function assistantRow(t) {
    return buildAssistantRow(/** @type {any} */ ({
        fullContent: 'Plus kost 41 euro per maand.', modelId: 'm', resolvedTier: 'standard', modelTier: 'standard',
        tokenisationInfo: null, memoryUsed: [], thinkingParts: [], thinkingContent: '', convId: null,
        generatedImages: [], generatedAudio: [], generatedFiles: [], collectedEmailDrafts: [], collectedCalendarDrafts: [],
        collectedMapEmbeds: [], collectedToolHistory: [], sessionSkills: [],
        ...t,
    }));
}

test('the passages become one kb_sources event in the shared citation shape, and the turn keeps the same cards', async () => {
    const { events, send } = recorder();
    /** @type {any[]} */
    const kbSources = [];
    await emitKbSources({ send, kbSources }, [PRICE_PASSAGE]);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, 'kb_sources');
    const { sources } = events[0].data;
    assert.strictEqual(sources.length, 1);
    const [card] = sources;
    assert.strictEqual(card.title, 'Prijslijst 2026.pdf');
    assert.strictEqual(card.documentId, 'doc-1');
    assert.strictEqual(card.chunkId, 'chunk-1');
    assert.strictEqual(card.kbId, 'kb-1');
    assert.strictEqual(card.page, 2);
    assert.strictEqual(card.kind, 'kb_chunk');
    assert.match(card.content, /41 euro per maand/);
    for (const k of Object.keys(card)) assert.ok(CITATION_FIELDS.includes(k) || k === 'preview', `unexpected field ${k}`);
    assert.deepStrictEqual(kbSources, sources);
});

test('no passages: no event, nothing kept', async () => {
    const { events, send } = recorder();
    /** @type {any[]} */
    const kbSources = [];
    await emitKbSources({ send, kbSources }, []);
    assert.deepStrictEqual(events, []);
    assert.deepStrictEqual(kbSources, []);
});

test('the same passage from a project base and an attached base is kept once', async () => {
    const { events, send } = recorder();
    /** @type {any[]} */
    const kbSources = [];
    await emitKbSources({ send, kbSources }, [PRICE_PASSAGE]);
    await emitKbSources({ send, kbSources }, [PRICE_PASSAGE]);
    assert.strictEqual(events.length, 2, 'each search sends its own cards; the client merges them');
    assert.strictEqual(kbSources.length, 1);
});

test('the stored answer carries the cards; a kb_search result adds only the passages not cited yet', async () => {
    /** @type {any[]} */
    const kbSources = [];
    await emitKbSources({ kbSources }, [PRICE_PASSAGE]);
    const { events, send } = recorder();
    const turn = { send, kbSources, collectedEmailDrafts: [], collectedCalendarDrafts: [], generatedAudio: [], generatedFiles: [] };
    const again = { ...kbSources[0] };
    const other = { title: 'Voorwaarden.pdf', chunkId: 'chunk-9', content: 'Opzeggen kan per maand.' };
    emitToolResultEvents(/** @type {any} */ (turn), [{ _toolName: 'kb_search', _toolResult: { _action: 'kb_sources', _sources: [again, other] } }], { streamed: true });

    assert.strictEqual(events.filter(e => e.event === 'kb_sources').length, 1, 'the tool event still goes out');
    assert.deepStrictEqual(turn.kbSources.map(s => s.chunkId), ['chunk-1', 'chunk-9'], 'a passage is stored once');
    assert.deepStrictEqual(assistantRow({ kbSources: turn.kbSources }).kbSources.map((/** @type {any} */ s) => s.chunkId), ['chunk-1', 'chunk-9']);
    assert.ok(!('kbSources' in assistantRow({ kbSources: [] })), 'no sources, no field');
});

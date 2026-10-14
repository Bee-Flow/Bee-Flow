/**
 * The golden behaviour of the local KB pipeline, pinned before it was split
 * into chunking / schema / ingest / search modules behind the
 * `localKBIngest` barrel.
 *
 * Every collaborator is swapped ON its shared module object (testUtils/swaps)
 * BEFORE the barrel is required, so the destructured copies the modules take
 * at load time are the fakes. What is pinned: the SQL each path sends (in
 * order), the embedder / reranker / relation-hop calls, the cost log, and the
 * rows a search hands back. A pure move must leave every one of them as is.
 *
 * Run: cd server && node --test core/kb/localKBIngest.characterisation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../../testUtils/swaps');

const db = require('../../db');
// With MASTER_ENCRYPTION_KEY set (scripts/run-tests.mjs sets it; a bare
// `node --test` does not) configStore re-encrypts legacy plaintext secrets at
// module load: a background initDB whose CREATE TABLE config goes through
// db.exec's schema queue and reaches the swapped pool.connect later, inside
// whichever trace is being recorded. That is the store's boot chore, not this
// pipeline's, so load the store without the key. The check is synchronous on
// the first line of the call, so the key is back before anything else runs.
const masterKey = process.env.MASTER_ENCRYPTION_KEY;
delete process.env.MASTER_ENCRYPTION_KEY;
const configStore = require('../../stores/configStore');
if (masterKey !== undefined) process.env.MASTER_ENCRYPTION_KEY = masterKey;
const metrics = require('../../telemetry/metrics');
const serviceAuth = require('../serviceAuth');
const embedDispatch = require('../embed/dispatch');
const embeddingMigration = require('./embeddingMigration');
const relationHop = require('./relationHop');
const llamaCppRerank = require('../rerank/llamaCppRerank');
const cpuCrossEncoder = require('../rerank/cpuCrossEncoder');
const azureServiceCosts = require('../llm/azureServiceCosts');
const azureServiceUsageStore = require('../../stores/azureServiceUsageStore');

const { swap, restore } = makeSwaps();
test.after(restore);

// ── The recorder ─────────────────────────────────────────────────────
let TRACE = [];
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const CONFIG = {};
const DOC_UUID = '11111111-2222-3333-4444-555555555555';

function respond(sql, params) {
    const s = norm(sql);
    if (s.startsWith('DELETE FROM kb_chunks c')) return { rows: [], rowCount: 7 };
    if (s.includes('vec_score')) {
        return { rows: [
            { id: 1, title: 'Handboek', content: '## Salaris schalen\nDe tabel met schalen.', source_uri: 'u1', document_id: DOC_UUID, chunk_id: 0, page_start: 3, vec_score: 0.9 },
            { id: 2, title: 'Handboek', content: 'Inhoud', source_uri: 'u1', document_id: 'orphan', chunk_id: 4, page_start: null, vec_score: 0.8 },
            { id: 3, title: null, content: 'ruis', source_uri: null, document_id: DOC_UUID, chunk_id: 9, page_start: null, vec_score: 0.2 },
        ] };
    }
    if (s.includes('fts_score')) {
        if (String(params[0]).includes(' AND ')) return { rows: [] };
        return { rows: [
            { id: 4, title: 'Lijst', content: 'Inhoudsopgave salaris', source_uri: 'u2', document_id: DOC_UUID, chunk_id: 1, chunk_type: 'toc', page_start: 1, fts_score: 0.5 },
            { id: 1, title: 'Handboek', content: '## Salaris schalen\nDe tabel met schalen.', source_uri: 'u1', document_id: DOC_UUID, chunk_id: 0, chunk_type: 'content', page_start: 3, fts_score: 0.4 },
        ] };
    }
    if (s.startsWith('SELECT id::text FROM documents')) return { rows: [{ id: DOC_UUID.toUpperCase() }] };
    if (s.startsWith('SELECT DISTINCT ON')) {
        return { rows: [
            { id: 5, title: 'Handboek', content: 'buur', source_uri: 'u1', document_id: DOC_UUID, chunk_id: 2 },
            { id: 6, title: 'Weg', content: 'wees', source_uri: 'u9', document_id: 'gone', chunk_id: 1 },
        ] };
    }
    if (s.includes('FROM documents d')) {
        return { rows: [{ doc_id: DOC_UUID, source_type: 'meeting', metadata: JSON.stringify({ meetingDate: '2026-01-02', rowStart: 1 }) }] };
    }
    if (s.startsWith('SELECT content FROM kb_chunks')) return { rows: [{ content: 'a' }, { content: 'b' }] };
    return { rows: [], rowCount: 0 };
}

function fakeClient(tag) {
    return {
        async query(sql, params) {
            TRACE.push({ via: tag, sql: norm(sql), params: params === undefined ? null : params });
            return respond(sql, params);
        },
        release() { TRACE.push({ via: tag, release: true }); },
    };
}

swap(db, 'exec', async (sql) => { TRACE.push({ via: 'exec', sql: norm(sql) }); });
swap(db, 'getAll', async (sql) => {
    TRACE.push({ via: 'getAll', sql: norm(sql) });
    if (norm(sql).includes('atttypmod')) return [{ typmod: 3 }];
    return [];
});
swap(db, 'getClient', async () => fakeClient('client'));
swap(db.pool, 'connect', async () => fakeClient('pool'));
swap(configStore, 'getConfig', async (k) => { TRACE.push({ via: 'getConfig', k }); return CONFIG[k]; });
swap(configStore, 'getSecret', async (k) => { TRACE.push({ via: 'getSecret', k }); return CONFIG[k]; });
swap(metrics, 'recordSidecarCall', (m) => { TRACE.push({ via: 'sidecar', service: m.service, status: m.status }); });
swap(serviceAuth, 'getServiceHeaders', () => ({ 'x-service': 'k' }));
swap(embedDispatch, 'dispatchEmbedTexts', async (texts, opts) => {
    TRACE.push({ via: 'embed', n: texts.length, opts: opts || null });
    return { vectors: texts.map((_, i) => [0.1, 0.2, i]), source: 'provider' };
});
swap(embeddingMigration, 'ensureKbEmbeddingsCurrent', async (o) => { TRACE.push({ via: 'migrate', o }); });
swap(relationHop, 'expandRelations', async (rows, o) => { TRACE.push({ via: 'hop', ids: rows.map(r => r.id), o }); });
swap(llamaCppRerank, 'isEnabled', async () => !!CONFIG.__llama);
swap(llamaCppRerank, 'rerankLlamaCpp', async (q, docs, k) => { TRACE.push({ via: 'llama', q, docs, k }); return CONFIG.__llama; });
swap(cpuCrossEncoder, 'rerankCpu', async (q, docs, k) => { TRACE.push({ via: 'cpu', q, docs, k }); return CONFIG.__cpu || []; });
swap(azureServiceCosts, 'computeEmbeddingCost', (t) => { TRACE.push({ via: 'cost', t }); return 0; });
swap(azureServiceUsageStore, 'logAzureServiceUsage', async (u) => { TRACE.push({ via: 'usage', u }); });

const realFetch = global.fetch;
let FETCH = null;
global.fetch = async (url, init) => {
    TRACE.push({ via: 'fetch', url, headers: init.headers, body: JSON.parse(init.body) });
    return FETCH(url);
};
test.after(() => { global.fetch = realFetch; delete global._azureRerankerPath; });

const kb = require('./localKBIngest');

/** Rows a search returns, with the array extras made comparable. */
function snapshot(results) {
    const metricsOut = { ...results._metrics };
    assert.strictEqual(typeof metricsOut.latencyMs, 'number');
    delete metricsOut.latencyMs;
    return {
        // doc_meta / doc_kind are non-enumerable on purpose; pin them anyway.
        rows: results.map(r => (r.doc_meta === undefined ? { ...r } : { ...r, doc_meta: r.doc_meta, doc_kind: r.doc_kind })),
        orphanFiltered: results._orphanFiltered,
        metrics: metricsOut,
    };
}

function take() { const t = TRACE; TRACE = []; return t; }

const DOC = [
    '# Personeelshandboek',
    '',
    'Dit handboek beschrijft de arbeidsvoorwaarden van alle medewerkers in de organisatie, inclusief verlof en salaris.',
    '',
    '## 3.2 Salarisschalen',
    '',
    '| Schaal | Minimum | Maximum |',
    '|---|---|---|',
    '| 1 | 2000 | 2500 |',
    '| 2 | 2500 | 3100 |',
    '',
    'De schalen worden jaarlijks geindexeerd op basis van de cao en de inflatie van het voorgaande jaar.',
    '',
    '```',
    'code blok dat heel moet blijven en nooit gesplitst mag worden door de chunker',
    '```',
].join('\n');

const GOLDEN = require('./localKBIngest.characterisation.golden.json');

test('the barrel exports exactly the same keys', () => {
    assert.deepStrictEqual(Object.keys(kb).sort(), [
        'applyRerank', 'azureEmbed', 'chunkText', 'deleteChunksLocally', 'enrichWithDocumentFacts',
        'getDocumentContent', 'ingestLocally', 'purgeOrphanedChunks', 'searchLocally', 'trackEmbeddingCost',
    ]);
    assert.strictEqual(kb.azureEmbed, embedDispatch.azureEmbed);
});

test('chunkText: the golden chunks', () => {
    assert.deepStrictEqual(kb.chunkText(DOC), GOLDEN.chunks);
    assert.deepStrictEqual(kb.chunkText(''), []);
    assert.deepStrictEqual(kb.chunkText('x'.repeat(5000)).map(c => c.token_count), GOLDEN.longTokens);
});

test('ingestLocally: schema bootstrap, embed, reconcile, cost, one transaction', async () => {
    const out = await kb.ingestLocally('t1', 'kb1', 'doc1', DOC, { title: 'Handboek', sourceUri: 'u1', lang: 'nl' });
    assert.deepStrictEqual(out, GOLDEN.ingest.out);
    assert.deepStrictEqual(take(), GOLDEN.ingest.trace);
});

test('ingestLocally a second time: no schema bootstrap, only the reconcile probe', async () => {
    await kb.ingestLocally('t1', 'kb1', 'doc2', DOC, { pages: [{ page: 1, text: DOC }] });
    assert.deepStrictEqual(take(), GOLDEN.ingest2);
});

test('ingestLocally on nothing throws before touching anything', async () => {
    await assert.rejects(kb.ingestLocally('t1', 'kb1', 'd', '  '), /Document produced no chunks/);
    assert.deepStrictEqual(take(), []);
});

test('searchLocally without a reranker: hybrid SQL, orphans, RRF, context window, facts, hop', async () => {
    const res = await kb.searchLocally('t1', ['kb1'], 'salaris schalen tabel', { topK: 2 });
    assert.deepStrictEqual({ out: snapshot(res), trace: take() }, GOLDEN.searchRrf);
});

test('searchLocally with the CPU reranker: cached query vector, applyRerank order', async () => {
    CONFIG.cpu_reranker_enabled = true;
    CONFIG.__cpu = [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }, { index: 99, relevance_score: 1 }];
    try {
        const res = await kb.searchLocally('t1', ['kb1'], 'salaris schalen tabel', { topK: 2 });
        assert.deepStrictEqual({ out: snapshot(res), trace: take() }, GOLDEN.searchCpu);
    } finally { delete CONFIG.__cpu; }
});

test('searchLocally with CPU failing falls through to the GPU sidecar', async () => {
    process.env.RERANKER_URL = 'http://rr';
    FETCH = async () => ({ ok: true, json: async () => ({ results: [{ index: 1, relevance_score: 0.7 }] }) });
    try {
        const res = await kb.searchLocally('t1', ['kb1'], 'salaris', { topK: 3 });
        assert.deepStrictEqual({ out: snapshot(res), trace: take() }, GOLDEN.searchCpuToGpu);
    } finally { delete process.env.RERANKER_URL; delete CONFIG.cpu_reranker_enabled; }
});

test('searchLocally with only the GPU sidecar records the sidecar call', async () => {
    CONFIG.cpu_reranker_enabled = false;
    process.env.RERANKER_URL = 'http://rr';
    FETCH = async () => ({ ok: false, status: 503, text: async () => 'down' });
    try {
        const res = await kb.searchLocally('t1', ['kb1'], 'salaris', { topK: 3 });
        assert.deepStrictEqual({ out: snapshot(res), trace: take() }, GOLDEN.searchGpu);
    } finally { delete process.env.RERANKER_URL; delete CONFIG.cpu_reranker_enabled; }
});

test('searchLocally with Azure Cohere: tries paths in order and caches the one that works', async () => {
    CONFIG.azure_reranker_endpoint = 'https://az/';
    CONFIG.azure_reranker_key = 'k';
    let n = 0;
    FETCH = async () => (++n === 1
        ? { ok: false, status: 404, text: async () => 'nope' }
        : { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 0.99 }] }) });
    try {
        const first = await kb.searchLocally('t1', ['kb1'], 'salaris', { topK: 3 });
        const second = await kb.searchLocally('t1', ['kb1'], 'salaris', { topK: 3 });
        assert.deepStrictEqual({ first: snapshot(first), second: snapshot(second), trace: take() }, GOLDEN.searchAzure);
    } finally { delete CONFIG.azure_reranker_endpoint; delete CONFIG.azure_reranker_key; }
});

test('searchLocally with llama.cpp enabled ranks first and skips the rest', async () => {
    CONFIG.azure_reranker_endpoint = 'https://az/';
    CONFIG.azure_reranker_key = 'k';
    CONFIG.__llama = [{ index: 1, relevance_score: 0.6 }];
    try {
        const res = await kb.searchLocally('t1', ['kb1'], 'salaris', { topK: 3 });
        assert.deepStrictEqual({ out: snapshot(res), trace: take() }, GOLDEN.searchLlama);
    } finally { delete CONFIG.azure_reranker_endpoint; delete CONFIG.azure_reranker_key; delete CONFIG.__llama; }
});

test('delete, content, purge and cost: the SQL each sends', async () => {
    await kb.deleteChunksLocally('t1', 'kb1', 'doc1');
    await kb.deleteChunksLocally('t1', 'kb1');
    const content = await kb.getDocumentContent('t1', 'kb1', 'doc1');
    const purged = await kb.purgeOrphanedChunks();
    kb.trackEmbeddingCost(['abc', 'defgh']);
    kb.trackEmbeddingCost(null);
    assert.deepStrictEqual({ content, purged, trace: take() }, GOLDEN.maintenance);
});

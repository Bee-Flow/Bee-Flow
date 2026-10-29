// @typecheck
/**
 * Local KB search: hybrid (vector + full-text) retrieval over `kb_chunks`,
 * reciprocal rank fusion, the context window, then the reranker
 * (localRerank.js), the document facts (kbDocumentFacts.js) and the relation
 * hop. The query and fusion steps live in ./localSearchSteps.
 */

const { getClient } = require('../../db');
const log = require('../../telemetry/log');
const { ensureKBChunksTable, isPgvectorAvailable } = require('./kbChunksSchema');
const { rerankCandidates } = require('./localRerank');
const { enrichWithDocumentFacts } = require('./kbDocumentFacts');
const {
    MIN_VEC_SCORE, ftsQueriesFor, queryCandidates, makeOrphanFilter, fuseCandidates, expandContextWindow,
} = require('./localSearchSteps');
const { bestEffort } = require('../../utils/bestEffort');

// Collaborators that sit in the server's large import cycle are handed in by
// the barrel (localKBIngest.js) through wire(), so this module imports none of
// them itself and the cycle does not grow (lint:scc-ratchet). Lazy ones stay
// lazy: the barrel passes a loader, called at the point of use.
let dispatchEmbedTexts = null;
function wire(deps) {
    ({ dispatchEmbedTexts } = deps);
}

// ── Query embedding LRU cache ───────────────────────────────────────
// Avoids repeated Azure API calls (~200-400ms each) for identical queries.
const EMBEDDING_CACHE_MAX = 500;
const EMBEDDING_CACHE_TTL = 30 * 60 * 1000; // 30 minutes — query embeddings are stable
const _embeddingCache = new Map();

/**
 * @param {string} query
 */
function getCachedEmbedding(query) {
    const entry = _embeddingCache.get(query);
    if (!entry) return null;
    if (Date.now() - entry.ts > EMBEDDING_CACHE_TTL) {
        _embeddingCache.delete(query);
        return null;
    }
    return entry.embedding;
}

/**
 * @param {string} embedding
 * @param {string} query
 */
function setCachedEmbedding(query, embedding) {
    // Evict oldest if at capacity
    if (_embeddingCache.size >= EMBEDDING_CACHE_MAX) {
        const oldestKey = _embeddingCache.keys().next().value;
        _embeddingCache.delete(oldestKey);
    }
    _embeddingCache.set(query, { embedding, ts: Date.now() });
}

/**
 * Search locally-ingested KB chunks using hybrid (vector + FTS) search.
 *
 * @param {string} tenantId — user ID
 * @param {string[]} kbIds — knowledge base IDs to search
 * @param {string} query — user query text
 * @param {{ topK?: number }} options `topK`: defaults to 10
 * @returns {Promise<Array<{content: string, title: string, source_uri: string, score: number}>>}
 */
async function searchLocally(tenantId, kbIds, query, options = {}) {
    const { topK = 10 } = options;
    const _searchStart = Date.now();
    log.info(`[LocalKBSearch] searchLocally — tenantId="${tenantId}" kbIds=${JSON.stringify(kbIds)} query ${query.length} chars`);

    // Bootstrap pgvector. Don't pin a dim — `dispatchEmbedTexts` will tell us
    // what the configured provider actually produces (1024 for mistral-embed,
    // 1536 for text-embedding-3-small, 384 for the CPU fallback) and the table
    // reconciles to it on first ingest.
    await ensureKBChunksTable();

    // ── Embed query (with LRU cache) — done BEFORE acquiring DB connection ──
    const vectorStr = await embedQuery(query);
    const fts = ftsQueriesFor(query);

    // ── Phase 1: DB queries — acquire connection, run queries, release ──
    // Connection is held ONLY for actual database work, not for external API calls.
    let vectorResults = { rows: [] };
    let ftsResults = { rows: [] };
    /** @type {any[] & { _orphanFiltered?: boolean, _metrics?: object }} */
    let results = [];

    const client = await getClient();
    try {
        // Set ef_search on THIS connection for better HNSW recall
        if (isPgvectorAvailable()) {
            await client.query('SET hnsw.ef_search = 100').catch((e) => bestEffort('core/kb/localSearch:searchLocally', e));
        }

        let validDocIds;
        ({ vectorResults, ftsResults, validDocIds } = await queryCandidates(client, {
            kbIds, topK, vectorStr, pgvector: isPgvectorAvailable(), fts,
        }));
        const filterOrphans = makeOrphanFilter(validDocIds);

        // Apply cosine similarity floor — chunks below the floor are guaranteed noise
        const filteredVecRows = vectorResults.rows.filter(r => (r.vec_score || 0) >= MIN_VEC_SCORE);

        log.info(`[LocalKBSearch] Vector: ${vectorResults.rows.length}→${filteredVecRows.length} (floor=${MIN_VEC_SCORE}), FTS: ${ftsResults.rows.length} (query ${fts.ftsQueryStr.length} chars) [${Date.now() - _searchStart}ms]`);

        // Apply orphan filter to both result sets
        const cleanVecRows = filterOrphans(filteredVecRows);
        const cleanFtsRows = filterOrphans(ftsResults.rows);
        if (cleanVecRows.length < filteredVecRows.length || cleanFtsRows.length < ftsResults.rows.length) {
            log.info(`[LocalKBSearch] Orphan filter: vec ${filteredVecRows.length}→${cleanVecRows.length}, fts ${ftsResults.rows.length}→${cleanFtsRows.length}`);
        }

        // Reciprocal Rank Fusion, then the context window (adjacent chunks).
        results = fuseCandidates(cleanVecRows, cleanFtsRows, { query, topK });
        await expandContextWindow(client, results, filterOrphans);
    } finally {
        // Release DB connection BEFORE reranker API call
        // The reranker is a pure HTTP call that doesn't need the DB.
        client.release();
    }

    // Phase 2: reranking (localRerank.js) — no DB connection held.
    results = await rerankCandidates(results, query, topK);

    results = results.slice(0, topK);

    // The passage knows where it is; only the document knows what it is OF.
    await enrichWithDocumentFacts(results);

    // A table row knows which rows it points at, and which point at it. One
    // exact hop along those ids — after the reranker, on the survivors only,
    // under its own time budget — folds the linked rows into the passage.
    // Never fails the search: a hop that cannot run leaves the passage as it
    // was, which is what every search returned before it existed.
    try {
        const { expandRelations } = require('./relationHop');
        await expandRelations(results, { kbIds, query, vectorStr });
    } catch (hopErr) {
        log.warn(`[LocalKBSearch] Relation hop failed: ${/** @type {Error} */ (hopErr).message}`);
    }

    // Mark results as orphan-filtered so callers don't duplicate the work
    results._orphanFiltered = true;

    // Attach search metrics for observability
    const totalMs = Date.now() - _searchStart;
    results._metrics = {
        latencyMs: totalMs,
        vecCandidates: vectorResults.rows.length,
        ftsCandidates: ftsResults.rows.length,
        ftsMode: ftsResults.rows.length > 0 ? (fts.ftsQueryStr.includes(' AND ') ? 'AND' : 'OR') : 'none',
        topScore: results[0]?.score || 0,
        resultCount: results.length,
    };

    log.info(`[LocalKBSearch] Found ${results.length} results (vec=${vectorResults.rows.length}, fts=${ftsResults.rows.length}, top=${results[0]?.score?.toFixed(3) || 0}) [${totalMs}ms]`);
    return results;
}

/**
 * The query's embedding as a pgvector literal, from the LRU cache or the
 * configured embedder; null without pgvector or when embedding fails (the
 * search then runs keyword-only).
 * @param {string} query
 */
async function embedQuery(query) {
    if (!isPgvectorAvailable()) return null;
    const cached = getCachedEmbedding(query);
    if (cached) {
        log.info('[LocalKBSearch] Using cached query embedding');
        return cached;
    }
    try {
        // A search query, not stored text — asymmetric models must be
        // told so (see applyModelPrefix in core/embed/dispatch.js).
        const result = await dispatchEmbedTexts([query], { kind: 'query' });
        if (result.vectors.length > 0) {
            const vectorStr = `[${result.vectors[0].join(',')}]`;
            setCachedEmbedding(query, vectorStr);
            return vectorStr;
        }
        log.warn('[LocalKBSearch] Query embedding produced no vector — falling back to keyword-only search');
    } catch (err) {
        log.warn(`[LocalKBSearch] Query embedding failed: ${/** @type {Error} */ (err).message}`);
    }
    return null;
}

module.exports = { searchLocally, wire };

/**
 * Local KB search: hybrid (vector + full-text) retrieval over `kb_chunks`,
 * reciprocal rank fusion, the context window, then the reranker
 * (localRerank.js), the document facts (kbDocumentFacts.js) and the relation
 * hop.
 */

const { getClient } = require('../../db');
const log = require('../../telemetry/log');
const { ensureKBChunksTable, isPgvectorAvailable } = require('./kbChunksSchema');
const { rerankCandidates } = require('./localRerank');
const { enrichWithDocumentFacts } = require('./kbDocumentFacts');

// Collaborators that sit in the server's large import cycle are handed in by
// the barrel (localKBIngest.js) through wire(), so this module imports none of
// them itself and the cycle does not grow (lint:scc-ratchet). Lazy ones stay
// lazy: the barrel passes a loader, called where the require used to be.
let dispatchEmbedTexts = null;
function wire(deps) {
    ({ dispatchEmbedTexts } = deps);
}

// ── Query embedding LRU cache ───────────────────────────────────────
// Avoids repeated Azure API calls (~200-400ms each) for identical queries.
const EMBEDDING_CACHE_MAX = 500;
const EMBEDDING_CACHE_TTL = 30 * 60 * 1000; // 30 minutes — query embeddings are stable
const _embeddingCache = new Map();

function getCachedEmbedding(query) {
    const entry = _embeddingCache.get(query);
    if (!entry) return null;
    if (Date.now() - entry.ts > EMBEDDING_CACHE_TTL) {
        _embeddingCache.delete(query);
        return null;
    }
    return entry.embedding;
}

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
 * @param {object} options
 * @param {number} [options.topK=10]
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
    let vectorStr = null;
    if (isPgvectorAvailable()) {
        const cached = getCachedEmbedding(query);
        if (cached) {
            vectorStr = cached;
            log.info('[LocalKBSearch] Using cached query embedding');
        } else {
            try {
                // A search query, not stored text — asymmetric models must be
                // told so (see applyModelPrefix in core/embed/dispatch.js).
                const result = await dispatchEmbedTexts([query], { kind: 'query' });
                if (result.vectors.length > 0) {
                    vectorStr = `[${result.vectors[0].join(',')}]`;
                    setCachedEmbedding(query, vectorStr);
                } else {
                    log.warn('[LocalKBSearch] Query embedding produced no vector — falling back to keyword-only search');
                }
            } catch (err) {
                log.warn(`[LocalKBSearch] Query embedding failed: ${err.message}`);
            }
        }
    }

    // ── Build FTS query string ───────────────────────────────────
    const sanitizedQuery = query
        .replace(/[\\\"'*^$(){}[\]\\\\]/g, '')
        .trim();

    // Build AND-based FTS string first (stronger match — co-occurrence)
    // Fall back to OR if AND has no results
    const ftsWords = sanitizedQuery
        .split(/\s+/)
        .filter(w => w.length >= 2);
    const ftsAndQuery = ftsWords.join(' AND ');
    const ftsOrQuery = ftsWords.join(' OR ');
    const ftsQueryStr = ftsAndQuery.length > 0 ? ftsAndQuery : sanitizedQuery;

    // ── Phase 1: DB queries — acquire connection, run queries, release ──
    // Connection is held ONLY for actual database work, not for external API calls.
    let vectorResults = { rows: [] };
    let ftsResults = { rows: [] };
    let validDocIds = null;
    let results = [];

    const client = await getClient();
    try {
        // Issue #10: Set ef_search on THIS connection for better HNSW recall
        if (isPgvectorAvailable()) {
            await client.query('SET hnsw.ef_search = 100').catch(() => {});
        }

        // ── Run vector search + FTS in parallel ─────────────────────
        // System-managed KBs write chunks under
        // tenant_id='system'; org-managed KBs write under the caller's
        // tenant_id. Access is already gated by `kbIds` upstream — the agent
        // runtime only forwards KB ids the user is permitted to query — so
        // accepting either tenant marker is safe and lets a single search
        // span both org-owned and system-provisioned KBs.
        const vectorSearchPromise = (isPgvectorAvailable() && vectorStr)
            ? client.query(
                // Access boundary is kb_ids (authorized by every caller upstream);
                // knowledge_base_id scoping already restricts to those KBs. We do
                // NOT filter by the searcher's tenant_id — org-shared KBs are
                // ingested under the KB owner's tenant, so a tenant_id = searcher
                // filter wrongly hides every chunk for anyone but the ingester.
                `SELECT id, title, content, source_uri, document_id, chunk_id, page_start,
                        1 - (embedding <=> $1::vector) AS vec_score
                 FROM kb_chunks
                 WHERE knowledge_base_id = ANY($2::text[])
                 ORDER BY embedding <=> $1::vector
                 LIMIT $3`,
                [vectorStr, kbIds, topK * 2]
            ).catch(err => { log.warn(`[LocalKBSearch] Vector search failed: ${err.message}`); return { rows: [] }; })
            : Promise.resolve({ rows: [] });

        // Try AND-join first; if it returns 0 results, fall back to OR-join
        const ftsSearchPromise = (ftsQueryStr.length > 0)
            ? client.query(
                `SELECT id, title, content, source_uri, document_id, chunk_id, chunk_type, page_start,
                        GREATEST(
                            ts_rank_cd(tsv, websearch_to_tsquery('dutch', $1)) * 1.5,
                            ts_rank_cd(tsv, websearch_to_tsquery('simple', $1))
                        ) AS fts_score
                 FROM kb_chunks
                 WHERE knowledge_base_id = ANY($2::text[])
                   AND (
                       tsv @@ websearch_to_tsquery('dutch', $1)
                       OR tsv @@ websearch_to_tsquery('simple', $1)
                   )
                 ORDER BY fts_score DESC
                 LIMIT 15`,
                [ftsQueryStr, kbIds]
            ).catch(e => { log.warn('[LocalKBSearch] FTS query failed:', e.message); return { rows: [] }; })
            : Promise.resolve({ rows: [] });

        // Also fetch orphan filter data in parallel with searches
        const orphanPromise = client.query(
            `SELECT id::text FROM documents WHERE knowledge_base_id = ANY($1::uuid[])`,
            [kbIds]
        ).catch(e => { log.warn('[LocalKBSearch] Document validation query failed:', e.message); return { rows: [] }; });

        [vectorResults, ftsResults, { rows: validDocIds }] = await Promise.all([
            vectorSearchPromise, ftsSearchPromise, orphanPromise
        ]);

        // FTS AND-join fallback: if AND returned 0 results but OR might find some, retry
        if (ftsResults.rows.length === 0 && ftsOrQuery !== ftsAndQuery && ftsOrQuery.length > 0) {
            log.info(`[LocalKBSearch] FTS AND returned 0, falling back to OR`);
            try {
                ftsResults = await client.query(
                    `SELECT id, title, content, source_uri, document_id, chunk_id, chunk_type, page_start,
                            GREATEST(
                                ts_rank_cd(tsv, websearch_to_tsquery('dutch', $1)) * 1.5,
                                ts_rank_cd(tsv, websearch_to_tsquery('simple', $1))
                            ) AS fts_score
                     FROM kb_chunks
                     WHERE knowledge_base_id = ANY($2::text[])
                       AND (
                           tsv @@ websearch_to_tsquery('dutch', $1)
                           OR tsv @@ websearch_to_tsquery('simple', $1)
                       )
                     ORDER BY fts_score DESC
                     LIMIT 15`,
                    [ftsOrQuery, kbIds]
                );
            } catch (e) {
                log.warn('[LocalKBSearch] FTS OR fallback failed:', e.message);
            }
        }

        // Build orphan filter set
        const validDocIdSet = validDocIds.length > 0
            ? new Set(validDocIds.map(r => r.id.toLowerCase()))
            : null;
        const filterOrphans = (rows) => {
            if (!validDocIdSet) return rows; // skip filter if query failed
            return rows.filter(r => !r.document_id || validDocIdSet.has(String(r.document_id).toLowerCase()));
        };

        // Apply cosine similarity floor — chunks below 0.35 are guaranteed noise
        const MIN_VEC_SCORE = 0.35;
        const filteredVecRows = vectorResults.rows.filter(r => (r.vec_score || 0) >= MIN_VEC_SCORE);

        log.info(`[LocalKBSearch] Vector: ${vectorResults.rows.length}→${filteredVecRows.length} (floor=${MIN_VEC_SCORE}), FTS: ${ftsResults.rows.length} (query ${ftsQueryStr.length} chars) [${Date.now() - _searchStart}ms]`);

        // Apply orphan filter to both result sets
        const cleanVecRows = filterOrphans(filteredVecRows);
        const cleanFtsRows = filterOrphans(ftsResults.rows);
        if (cleanVecRows.length < filteredVecRows.length || cleanFtsRows.length < ftsResults.rows.length) {
            log.info(`[LocalKBSearch] Orphan filter: vec ${filteredVecRows.length}→${cleanVecRows.length}, fts ${ftsResults.rows.length}→${cleanFtsRows.length}`);
        }

        // C. Reciprocal Rank Fusion
        const scores = new Map();
        const contentMap = new Map();
        const K = 60;

        // Issue #5: Short queries (≤2 words) — boost FTS weight.
        // Single words like "phishing" are better matched by exact keyword
        // search than by embedding similarity (embeddings need more context).
        const queryWordCount = query.trim().split(/\s+/).filter(w => w.length >= 2).length;
        const ftsBoost = queryWordCount <= 2 ? 2.0 : 1.0;

        cleanVecRows.forEach((row, idx) => {
            const rank = idx + 1;
            scores.set(row.id, (scores.get(row.id) || 0) + 1 / (K + rank));
            contentMap.set(row.id, row);
        });

        cleanFtsRows.forEach((row, idx) => {
            const rank = idx + 1;
            scores.set(row.id, (scores.get(row.id) || 0) + (ftsBoost / (K + rank)));
            if (!contentMap.has(row.id)) contentMap.set(row.id, row);
        });

        // D. Sort by fused score, deprioritize ToC chunks, and take top candidates for reranking
        const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
        results = Array.from(scores.entries())
            .map(([id, score]) => {
                const row = contentMap.get(id);
                let adjustedScore = score;

                // Deprioritize ToC chunks (they match lots of keywords but have no real content)
                if (row.chunk_type === 'toc') {
                    adjustedScore *= 0.3;
                }

                // Heading boost: if chunk starts with a heading matching query terms, boost it
                const headingMatch = (row.content || '').match(/^#{1,6}\s+(.+)$/m);
                if (headingMatch && queryWords.length > 0) {
                    const headingLower = headingMatch[1].toLowerCase();
                    const matchCount = queryWords.filter(w => headingLower.includes(w)).length;
                    if (matchCount > 0) {
                        adjustedScore *= (1 + matchCount * 0.3); // 30% boost per matching word
                    }
                }

                return {
                    id: row.id,
                    content: row.content,
                    title: row.title || '',
                    source_uri: row.source_uri || '',
                    score: adjustedScore,
                    document_id: row.document_id,
                    chunk_id: row.chunk_id,
                    // Null for everything ingested before the chunker stamped
                    // pages; the citation renders without one.
                    page_start: row.page_start ?? null,
                };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, topK * 2); // Cap candidates for reranking

        // D2. Context window expansion: fetch adjacent chunks for table completeness
        //     When a table chunk is found, we also pull its neighbors (chunk_id ± 1)
        //     from the same document to give the agent the full picture.
        if (results.length > 0) {
            try {
                const existingIds = new Set(results.map(r => r.id));
                const adjacentRows = await client.query(
                    `SELECT DISTINCT ON (c.id) c.id, c.title, c.content, c.source_uri, c.document_id, c.chunk_id
                     FROM kb_chunks c
                     INNER JOIN (
                         SELECT document_id, chunk_id FROM kb_chunks WHERE id = ANY($1::bigint[])
                     ) h ON c.document_id = h.document_id
                        AND c.chunk_id BETWEEN h.chunk_id - 1 AND h.chunk_id + 1
                     WHERE c.id != ALL($1::bigint[])
                     LIMIT 10`,
                    [results.map(r => r.id)]
                );

                // Issue #6 fix: apply orphan filter to adjacent chunks too
                const cleanAdjacentRows = filterOrphans(adjacentRows.rows);

                for (const adj of cleanAdjacentRows) {
                    if (!existingIds.has(adj.id)) {
                        existingIds.add(adj.id);
                        results.push({
                            id: adj.id,
                            content: adj.content,
                            title: adj.title || '',
                            source_uri: adj.source_uri || '',
                            score: 0, // will be scored by reranker
                            document_id: adj.document_id,
                            chunk_id: adj.chunk_id,
                        });
                    }
                }

                if (cleanAdjacentRows.length > 0) {
                    log.info(`[LocalKBSearch] Context window: added ${cleanAdjacentRows.length} adjacent chunks`);
                }
            } catch (adjErr) {
                log.warn(`[LocalKBSearch] Context window expansion failed: ${adjErr.message}`);
            }
        }
    } finally {
        // Issue #16 fix: release DB connection BEFORE reranker API call
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
        log.warn(`[LocalKBSearch] Relation hop failed: ${hopErr.message}`);
    }

    // Mark results as orphan-filtered so callers don't duplicate the work
    results._orphanFiltered = true;

    // Issue #19: Attach search metrics for observability
    const totalMs = Date.now() - _searchStart;
    results._metrics = {
        latencyMs: totalMs,
        vecCandidates: vectorResults.rows.length,
        ftsCandidates: ftsResults.rows.length,
        ftsMode: ftsResults.rows.length > 0 ? (ftsQueryStr.includes(' AND ') ? 'AND' : 'OR') : 'none',
        topScore: results[0]?.score || 0,
        resultCount: results.length,
    };

    log.info(`[LocalKBSearch] Found ${results.length} results (vec=${vectorResults.rows.length}, fts=${ftsResults.rows.length}, top=${results[0]?.score?.toFixed(3) || 0}) [${totalMs}ms]`);
    return results;
}

module.exports = { searchLocally, wire };

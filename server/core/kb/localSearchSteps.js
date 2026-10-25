/** @typedef {import('pg').PoolClient} PoolClient */
// @typecheck
/**
 * The steps of a local KB search (./localSearch.js): the full-text query
 * strings, the candidate queries (vector + FTS, with the orphan filter), the
 * reciprocal rank fusion with its boosts, and the context-window expansion.
 * Every database step takes the connection the caller holds.
 */

const log = require('../../telemetry/log');

// Cosine similarity floor — chunks below 0.35 are guaranteed noise.
const MIN_VEC_SCORE = 0.35;
// The RRF constant.
const RRF_K = 60;

const FTS_SQL = `SELECT id, title, content, source_uri, document_id, chunk_id, chunk_type, page_start,
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
                 LIMIT 15`;

/**
 * The FTS query strings: an AND-join first (stronger match — co-occurrence),
 * an OR-join to fall back on when AND finds nothing.
 * @param {string} query
 */
function ftsQueriesFor(query) {
    const sanitizedQuery = query
        .replace(/[\\\"'*^$(){}[\]\\\\]/g, '')
        .trim();
    const ftsWords = sanitizedQuery
        .split(/\s+/)
        .filter(w => w.length >= 2);
    const ftsAndQuery = ftsWords.join(' AND ');
    const ftsOrQuery = ftsWords.join(' OR ');
    const ftsQueryStr = ftsAndQuery.length > 0 ? ftsAndQuery : sanitizedQuery;
    return { ftsAndQuery, ftsOrQuery, ftsQueryStr };
}

/**
 * Vector search, FTS and the orphan-filter data, in parallel on `client`;
 * then the FTS OR-join fallback when the AND-join found nothing.
 *
 * System-managed KBs write chunks under tenant_id='system'; org-managed KBs
 * write under the caller's tenant_id. Access is already gated by `kbIds`
 * upstream — the agent runtime only forwards KB ids the user is permitted to
 * query — so accepting either tenant marker is safe and lets a single search
 * span both org-owned and system-provisioned KBs.
 * @param {PoolClient} client
 */
async function queryCandidates(client, { kbIds, topK, vectorStr, pgvector, fts }) {
    const { ftsAndQuery, ftsOrQuery, ftsQueryStr } = fts;
    const vectorSearchPromise = (pgvector && vectorStr)
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
        ? client.query(FTS_SQL, [ftsQueryStr, kbIds])
            .catch(e => { log.warn('[LocalKBSearch] FTS query failed:', e.message); return { rows: [] }; })
        : Promise.resolve({ rows: [] });

    // Also fetch orphan filter data in parallel with searches
    const orphanPromise = client.query(
        `SELECT id::text FROM documents WHERE knowledge_base_id = ANY($1::uuid[])`,
        [kbIds]
    ).catch(e => { log.warn('[LocalKBSearch] Document validation query failed:', e.message); return { rows: [] }; });

    let [vectorResults, ftsResults, { rows: validDocIds }] = await Promise.all([
        vectorSearchPromise, ftsSearchPromise, orphanPromise,
    ]);

    // FTS AND-join fallback: if AND returned 0 results but OR might find some, retry
    if (ftsResults.rows.length === 0 && ftsOrQuery !== ftsAndQuery && ftsOrQuery.length > 0) {
        log.info(`[LocalKBSearch] FTS AND returned 0, falling back to OR`);
        try {
            ftsResults = await client.query(FTS_SQL, [ftsOrQuery, kbIds]);
        } catch (e) {
            log.warn('[LocalKBSearch] FTS OR fallback failed:', /** @type {Error} */ (e).message);
        }
    }
    return { vectorResults, ftsResults, validDocIds };
}

/**
 * A filter dropping rows whose document is gone (no-op when the lookup failed).
 * @param {{ id: string; }[]} validDocIds
 */
function makeOrphanFilter(validDocIds) {
    const validDocIdSet = validDocIds.length > 0
        ? new Set(validDocIds.map((/** @type {{ id: string; }} */ r) => r.id.toLowerCase()))
        : null;
    return (rows) => {
        if (!validDocIdSet) return rows; // skip filter if query failed
        return rows.filter(r => !r.document_id || validDocIdSet.has(String(r.document_id).toLowerCase()));
    };
}

/**
 * Reciprocal Rank Fusion of the two candidate lists, then the ToC penalty and
 * the heading boost. Resolves to the top `topK * 2` candidates for reranking.
 */
function fuseCandidates(cleanVecRows, cleanFtsRows, { query, topK }) {
    const scores = new Map();
    const contentMap = new Map();

    // Issue #5: Short queries (≤2 words) — boost FTS weight.
    // Single words like "phishing" are better matched by exact keyword
    // search than by embedding similarity (embeddings need more context).
    const queryWordCount = query.trim().split(/\s+/).filter(w => w.length >= 2).length;
    const ftsBoost = queryWordCount <= 2 ? 2.0 : 1.0;

    cleanVecRows.forEach((row, idx) => {
        const rank = idx + 1;
        scores.set(row.id, (scores.get(row.id) || 0) + 1 / (RRF_K + rank));
        contentMap.set(row.id, row);
    });

    cleanFtsRows.forEach((row, idx) => {
        const rank = idx + 1;
        scores.set(row.id, (scores.get(row.id) || 0) + (ftsBoost / (RRF_K + rank)));
        if (!contentMap.has(row.id)) contentMap.set(row.id, row);
    });

    // Sort by fused score, deprioritize ToC chunks, and take top candidates for reranking
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    return Array.from(scores.entries())
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
}

/**
 * Context window expansion: fetch adjacent chunks for table completeness.
 * When a table chunk is found, we also pull its neighbors (chunk_id ± 1)
 * from the same document to give the agent the full picture. Appends to
 * `results` in place; a failure is logged and skipped.
 * @param {PoolClient} client
 */
async function expandContextWindow(client, results, filterOrphans) {
    if (results.length === 0) return;
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
        log.warn(`[LocalKBSearch] Context window expansion failed: ${/** @type {Error} */ (adjErr).message}`);
    }
}

module.exports = { MIN_VEC_SCORE, ftsQueriesFor, queryCandidates, makeOrphanFilter, fuseCandidates, expandContextWindow };

// @typecheck strict
/**
 * stores/memorySimilarity.js — dedupe: the memories most similar to a text
 * (lexical and vector score) and the one that says the same thing. Split out
 * of stores/memoryStore.js.
 */

const { getAll } = require('../db');
const log = require('../telemetry/log');
const { vectorColumn, vectorLiteral } = require('./memoryVectors');
const { CANDIDATE_COLUMNS } = require('./memoryRetrieval');
const { embedOne, cosineSimilarity } = require('./memoryEmbedding');
const { SCHEDULE_COVERAGE_TYPE } = require('./memoryStats');
const { dep } = require('./memoryDeps');
const memoryIndex = dep('memoryIndex');
const { hydrateRows } = dep('memoryCrypto');

/** The store's schema-init memo, installed by stores/memoryStore (read per call). */
const initDB = () => dep('initDB')();

// Ceiling on rows pulled into the JS scoring passes (findRelevantMemories,
// findSimilarMemory). Both ran unbounded `getAll`s and then did per-row work —
// on every chat turn and every extraction respectively. Project memory makes
// this worse than it looks: the pool is shared across all members, so it grows
// with team size, not just with one user's history. Rows are ordered by
// importance before the cap, so what gets trimmed is the least useful tail.
const CANDIDATE_LIMIT = 500;

// ============ Similarity (dedupe) ============

/** A lexical similarity above this makes `findSimilarMemory` call it a duplicate (unchanged rule). */
const LEXICAL_DUPLICATE_THRESHOLD = 0.8;
/**
 * Cosine at or above which two memories are the same statement said twice. High
 * on purpose: small multilingual embedders put unrelated sentences at 0.75-0.85,
 * and a false duplicate silently drops a memory.
 */
const VECTOR_DUPLICATE_THRESHOLD = 0.93;

/**
 * @param {string} text
 */
const _normalizeText = (text) => String(text || '').toLowerCase().replace(/[^\w\s]/g, '').trim();
/**
 * @param {string} text
 */
const _wordsOf = (text) => _normalizeText(text).split(/\s+/).filter(w => w.length > 2);

/**
 * 0..1: 1 identical, 0.95 one contains the other, otherwise the word overlap of the shorter.
 * @param {string} a
 * @param {string} b
 */
function lexicalSimilarity(a, b) {
    const na = _normalizeText(a);
    const nb = _normalizeText(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
    if (short.length >= 4 && long.includes(short)) return 0.95;
    const wa = _wordsOf(a);
    const wb = _wordsOf(b);
    if (wa.length === 0 || wb.length === 0) return 0;
    const inB = new Set(wb);
    const matching = wa.filter(w => inB.has(w)).length;
    return matching / Math.min(wa.length, wb.length);
}

/** The vector of a hydrated row (JSONB may arrive as text), or null. */
/**
 * @param {Record<string, any> | null | undefined} memory
 * @returns {number[] | null}
 */
function _rowVector(memory) {
    let v = memory?.embedding;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    return Array.isArray(v) && v.length > 0 ? v : null;
}

/**
 * Scope of a dedupe lookup: the project's pool or the user's personal rows, in ONE agent bucket.
 * @param {(v: unknown) => string} bind
 * @param {{ userId: string, projectId?: string | null, agentId?: string | null }} scope
 */
function _strictScope(bind, { userId, projectId, agentId }) {
    const owner = projectId ? `project_id = ${bind(projectId)}` : `user_id = ${bind(userId)} AND project_id IS NULL`;
    return `status = 'active' AND valid_to IS NULL AND (expires_at IS NULL OR expires_at > NOW())
            AND type <> ${bind(SCHEDULE_COVERAGE_TYPE)} AND ${owner} AND agent_id IS NOT DISTINCT FROM ${bind(agentId || null)}`;
}

/**
 * The most similar existing memories to `content`, best first, each with a
 * `similarity` in [0, 1] (the larger of the lexical and the vector score) and
 * the two parts as `lexical` and `cosine` (null when there is no comparable
 * vector: none stored, or another dimension, which is "not embedded", never 0).
 *
 * Scoped to the user's personal rows (or the project's pool) AND one agent
 * bucket, so a global memory never matches an agent-scoped one.
 *
 * @param {string} userId
 * @param {string} content
 * @param {{ projectId?: string|null, agentId?: string|null, limit?: number }} [opts]
 * @returns {Promise<Array<Record<string, any> & { similarity: number, lexical: number, cosine: number|null }>>}
 */
async function findSimilarMemories(userId, content, { projectId = null, agentId = null, limit = 5 } = {}) {
    await initDB();
    if (!content) return [];
    const scope = { userId, projectId, agentId };
    /** @type {unknown[]} */
    const params = [];
    /** @param {unknown} v */
    const bind = (v) => { params.push(v); return `$${params.length}`; };
    // Same bounded pool as before; it is the candidate set for the lexical
    // score and for the vector score of rows without a typed vector column.
    const pool = await hydrateRows(await getAll(
        `SELECT * FROM user_memories WHERE ${_strictScope(bind, scope)}
          ORDER BY importance DESC NULLS LAST, updated_at DESC LIMIT ${CANDIDATE_LIMIT}`, params));

    const q = await embedOne(String(content).slice(0, 2000), { kind: 'passage', timeoutMs: 5000 });
    const byId = new Map(pool.map((/** @type {Record<string, any>} */ m) => [m.id, m]));
    const sqlCosine = new Map();

    // Rows beyond the pool that are close in vector space (plaintext rows with a
    // typed column only; sealed rows never have one).
    if (q && memoryIndex.isPgvectorAvailable() && memoryIndex.hasVectorColumn(q.dim)) {
        try {
            const col = vectorColumn(q.dim);
            /** @type {unknown[]} */
            const p2 = [];
            /** @param {unknown} v */
            const bind2 = (v) => { p2.push(v); return `$${p2.length}`; };
            const lit = bind2(vectorLiteral(q.vector));
            const near = await getAll(
                `SELECT ${CANDIDATE_COLUMNS.join(', ')}, 1 - ("${col}" <=> ${lit}::vector) AS cos
                   FROM user_memories WHERE ${_strictScope(bind2, scope)} AND "${col}" IS NOT NULL
                  ORDER BY "${col}" <=> ${lit}::vector LIMIT ${Math.max(10, limit * 2)}`, p2);
            for (const r of near) {
                const { cos, ...memory } = r;
                sqlCosine.set(memory.id, Number(cos));
                if (!byId.has(memory.id)) byId.set(memory.id, (await hydrateRows([memory]))[0]);
            }
        } catch (e) {
            log.warn('[MemoryStore] vector similarity lookup failed, using lexical:', /** @type {Error} */ (e).message);
        }
    }

    /** @type {Array<Record<string, any> & { similarity: number, lexical: number, cosine: number | null }>} */
    const out = [];
    for (const memory of byId.values()) {
        if (!memory) continue;
        const lexical = lexicalSimilarity(content, memory.content);
        let cosine = sqlCosine.has(memory.id) ? sqlCosine.get(memory.id) : null;
        const vec = _rowVector(memory);
        if (cosine === null && q && vec && vec.length === q.dim) cosine = cosineSimilarity(q.vector, vec);
        const similarity = Math.max(0, Math.min(1, Math.max(lexical, cosine ?? 0)));
        if (similarity <= 0) continue;
        const { embedding, ...rest } = memory;
        out.push({ ...rest, similarity, lexical, cosine });
    }
    out.sort((a, b) => b.similarity - a.similarity);
    return out.slice(0, Math.max(1, limit));
}

/**
 * The existing memory that says the same thing as `content`, or null. Used to
 * dedupe a memory that has no canonical key. The row comes back with its
 * `similarity` in [0, 1].
 * @param {string} userId
 * @param {string} content
 * @param {string | null} [projectId]
 * @param {string | null} [agentId]
 */
async function findSimilarMemory(userId, content, projectId = null, agentId = null) {
    const hits = await findSimilarMemories(userId, content, { projectId, agentId, limit: 5 });
    return hits.find(h => h.lexical > LEXICAL_DUPLICATE_THRESHOLD
        || (h.cosine !== null && h.cosine >= VECTOR_DUPLICATE_THRESHOLD)) || null;
}

module.exports = { lexicalSimilarity, findSimilarMemories, findSimilarMemory, _rowVector };

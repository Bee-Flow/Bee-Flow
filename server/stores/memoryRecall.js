// @typecheck noImplicitAny
/**
 * stores/memoryRecall.js — which memories reach this turn's prompt:
 * findRelevantMemories (hybrid retrieval in SQL, or scoring in JS when the
 * scope holds sealed rows) and the budget selection. Split out of
 * stores/memoryStore.js; the SQL candidate legs live in memoryRetrieval.js.
 */

const { run, getOne, getAll } = require('../db');
const log = require('../telemetry/log');
const { validateDim, MEMORY_QUERY_EMBED_TIMEOUT_MS } = require('./memoryVectors');
const { retrieveCandidates, scoreFused, scopePredicate, LEG_LIMIT, VEC_MIN_COSINE } = require('./memoryRetrieval');
const { selectTiers, keywordOverlap, RELATIVE_COSINE_MARGIN, KEYWORD_OVERLAP_MIN } = require('./memoryScoring');
const { embedOne, cosineSimilarity } = require('./memoryEmbedding');
const { DEFAULT_SCAN_LIMIT } = require('./memoryReads');
const { _rowVector } = require('./memorySimilarity');
const { dep } = require('./memoryDeps');
const memoryIndex = dep('memoryIndex');
const { hydrateRows, ENVELOPE_LIKE } = dep('memoryCrypto');

/** The store's schema-init memo, installed by stores/memoryStore (read per call). */
const initDB = () => dep('initDB')();

// ============ Memory Retrieval ============

/**
 * Words of the message that a memory can share (kept from the keyword fallback).
 * @param {unknown} content
 * @param {string} lowerMsg
 */
const _keywordHits = (content, lowerMsg) => {
    const words = String(content || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    let n = 0;
    for (const w of words) if (lowerMsg.includes(w)) n++;
    return n;
};

/**
 * A caller-supplied query vector, if it is usable.
 * @param {number[] | null} v
 */
function _usableVector(v) {
    return Array.isArray(v) && validateDim(v.length) && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Does this owner scope hold rows that are sealed (or carry a sealed vector)?
 * Also tells whether it holds anything at all, so an empty memory costs one
 * query and no embedding call.
 * @param {{ userId: string; agentId: string | null; projectId: string | null; includeGeneral: boolean; includeSensitive: boolean; }} scope
 */
async function _scopeState(scope) {
    /** @type {unknown[]} */
    const params = [];
    /** @param {unknown} v */
    const bind = (v) => { params.push(v); return `$${params.length}`; };
    const where = scopePredicate(scope, bind);
    const row = await getOne(
        `SELECT EXISTS (SELECT 1 FROM user_memories WHERE ${where}) AS present,
                EXISTS (SELECT 1 FROM user_memories WHERE ${where}
                          AND (content LIKE '${ENVELOPE_LIKE}' OR embedding_enc IS NOT NULL)) AS sealed`, params);
    return { present: !!row?.present, sealed: !!row?.sealed };
}

/**
 * Plaintext mode: pgvector + tsvector + base legs, one round trip.
 * @param {{ userId: string; agentId: string | null; projectId: string | null; includeGeneral: boolean; includeSensitive: boolean; }} scope
 * @param {string} queryText
 * @param {{ vector: number[], dim: number } | null} q
 */
async function _retrieveInSql(scope, queryText, q) {
    /** @type {number | null} */
    let dim = null;
    /** @type {number[] | null} */
    let queryVector = null;
    if (q && await memoryIndex.ensureVectorColumn(q.dim)) { dim = q.dim; queryVector = q.vector; }
    const candidates = await retrieveCandidates({ ...scope, dim, queryVector, queryText });
    // Nothing is sealed in this scope, so this is a pass-through; it is the
    // seam that keeps a row sealed in the meantime from reaching the prompt as ciphertext.
    const opened = await hydrateRows(candidates.map(c => c.memory));
    const byId = new Map(opened.map((/** @type {Record<string, any>} */ m) => [m.id, m]));
    return candidates.filter(c => byId.has(c.memory.id)).map(c => ({ memory: byId.get(c.memory.id), score: c.score, relevant: c.relevant === true }));
}

/**
 * Sealed mode (or no pgvector): the importance/recency-ordered base rows of the
 * scope, bounded by the org's maxPerUser, are opened and scored here. A row
 * whose vector has another dimension than the query's is "not embedded": it is
 * ranked by keywords and the base order, never by a cosine of 0.
 * @param {{ userId: string; agentId: string | null; projectId: string | null; includeGeneral: boolean; includeSensitive: boolean; }} scope
 * @param {string} queryText
 * @param {{ vector: number[], dim: number } | null} q
 * @param {number} maxPerUser
 */
async function _retrieveInJs(scope, queryText, q, maxPerUser) {
    const cap = Math.max(1, Math.min(10000, parseInt(String(maxPerUser), 10) || DEFAULT_SCAN_LIMIT));
    /** @type {unknown[]} */
    const params = [];
    /** @param {unknown} v */
    const bind = (v) => { params.push(v); return `$${params.length}`; };
    const rows = await hydrateRows(await getAll(
        `SELECT * FROM user_memories WHERE ${scopePredicate(scope, bind)}
          ORDER BY importance DESC NULLS LAST, updated_at DESC LIMIT ${cap}`, params));
    if (rows.length === 0) return [];

    const lowerMsg = String(queryText || '').toLowerCase();
    const vec = [];
    const kw = [];
    const cosById = new Map();
    const overlapById = new Map();
    for (const m of rows) {
        const v = q ? _rowVector(m) : null;
        if (q && v && v.length === q.dim) {
            const cos = cosineSimilarity(q.vector, v);
            cosById.set(m.id, cos);
            if (cos >= VEC_MIN_COSINE) vec.push({ id: m.id, s: cos });
        }
        const hits = lowerMsg ? _keywordHits(m.content, lowerMsg) : 0;
        if (hits > 0) kw.push({ id: m.id, s: hits });
        overlapById.set(m.id, lowerMsg ? keywordOverlap(m.content, lowerMsg) : 0);
    }
    /** @param {Array<{ id: string, s: number }>} list */
    const top = (list) => list.sort((a, b) => b.s - a.s).slice(0, LEG_LIMIT).map(x => x.id);
    const legs = [
        { key: 'base', ids: rows.slice(0, LEG_LIMIT).map((/** @type {Record<string, any>} */ m) => m.id) },
        { key: 'fts', ids: top(kw) },
    ];
    if (vec.length) legs.push({ key: 'vec', ids: top(vec) });

    // Relevant = close to the best candidate (not just above an absolute floor)
    // or sharing enough words with the message.
    const best = vec.reduce((mx, x) => Math.max(mx, x.s), -1);
    const cosFloor = Math.max(VEC_MIN_COSINE, best - RELATIVE_COSINE_MARGIN);
    const vectors = new Map(rows.map((/** @type {Record<string, any>} */ m) => [m.id, q ? _rowVector(m) : null]));

    // The vector is bookkeeping, not part of what the prompt or the caller sees.
    return scoreFused(rows.map(/** @param {Record<string, any>} row */ ({ embedding, ...m }) => m), legs).map(item => ({
        ...item,
        relevant: (cosById.get(item.memory.id) ?? -1) >= cosFloor || (overlapById.get(item.memory.id) || 0) >= KEYWORD_OVERLAP_MIN,
        vector: vectors.get(item.memory.id) || null,
    }));
}

/**
 * Mark memories as used: one statement, fire-and-forget, never failing the turn.
 * @param {string[]} ids
 */
function _trackUsage(ids) {
    if (!ids.length) return;
    try {
        Promise.resolve(run(
            `UPDATE user_memories SET last_used_at = NOW(), use_count = COALESCE(use_count, 0) + 1 WHERE id = ANY($1::text[])`,
            [ids])).catch(e => log.warn('[MemoryStore] usage tracking failed:', e.message));
    } catch (e) {
        log.warn('[MemoryStore] usage tracking failed:', /** @type {Error} */ (e).message);
    }
}

/**
 * The memories to put in this turn's prompt, best first, within `tokenLimit`.
 * Each result carries `id`, `type` and `content` (the chat layer reports them).
 *
 * @param {string} userId
 * @param {string|null} agentId
 * @param {string} userMessage
 * @param {number} [tokenLimit]
 * @param {string|null} [projectId]
 * @param {{
 *   includeGeneral?: boolean, includeSensitive?: boolean, queryEmbedding?: number[]|null, maxPerUser?: number,
 *   search?: boolean,
 * }} [options]
 *   includeGeneral: false = only this agent's own bucket
 *   includeSensitive: true = art. 9 rows may be returned (the caller resolved the user's opt-in); default false
 *   queryEmbedding: the user message, if the turn already embedded it
 *   maxPerUser: rows scored in JS in sealed mode (the org's maxPerUser)
 *   search: the memory_search tool: relevance only, wider cap, no profile
 */
async function findRelevantMemories(userId, agentId, userMessage, tokenLimit = 500, projectId = null, { includeGeneral = true, includeSensitive = false, queryEmbedding = null, maxPerUser = DEFAULT_SCAN_LIMIT, search = false } = {}) {
    await initDB();
    const scope = { userId, agentId: agentId || null, projectId: projectId || null, includeGeneral, includeSensitive: includeSensitive === true };
    const text = String(userMessage || '');

    const state = await _scopeState(scope);
    if (!state.present) return [];

    let q = null;
    if (_usableVector(queryEmbedding)) {
        q = { vector: queryEmbedding, dim: queryEmbedding.length };
    } else if (text.trim()) {
        q = await embedOne(text.slice(0, 2000), { kind: 'query', timeoutMs: MEMORY_QUERY_EMBED_TIMEOUT_MS });
    }

    let scored;
    if (!state.sealed && memoryIndex.isPgvectorAvailable()) {
        try {
            scored = await _retrieveInSql(scope, text, q);
        } catch (e) {
            log.warn('[MemoryStore] hybrid retrieval failed, scoring in JS:', /** @type {Error} */ (e).message);
        }
    }
    if (!scored) scored = await _retrieveInJs(scope, text, q, maxPerUser);

    // `search`: the memory_search tool — relevance only, wider cap, no profile.
    const selected = selectWithinBudget(scored, tokenLimit, search ? { profile: false, relevantMax: SEARCH_RELEVANT_MAX } : undefined);
    _trackUsage(selected.map(m => m.id).filter(Boolean));
    return selected;
}

// ── Budget selection ─────────────────────────────────────────────────────────
//
// Which scored memories actually reach the system prompt. Exported and tested
// on its own (memoryStore.instructionBudget.test.js) because it is the one
// piece of the retrieval path that must survive the move to DB-side ranking
// unchanged.
//
// THE BUG THIS REPLACES: the old loop `continue`d past the budget check for
// `type: 'instruction'`, so N instructions of any length all reached the
// prompt — under a heading that read "MUST FOLLOW". With `POST /agents/memory`
// accepting an unvalidated `type`, that was a persistent prompt-injection
// channel (OWASP ASI06 memory poisoning). Instructions still go first — they
// out-rank every other type for the budget — but at most 5 of them (plus 3
// preferences) as the always-on profile, each clipped at 300 characters.

/**
 * Which scored memories reach the system prompt: a small always-on profile
 * (instructions, preferences) plus the memories with a relevance signal for
 * this message (`item.relevant`), capped and de-duplicated. See
 * `memoryScoring.selectTiers`. Every row carries `why: 'profile' | 'relevant'`.
 *
 * @param {Array<{memory: any, score: number, relevant?: boolean, vector?: number[]|null}>} scoredMemories
 * @param {number} tokenLimit  prompt budget in tokens (≈ 4 chars each)
 * @returns {any[]}
 * @param {{ profile: boolean; relevantMax: number; } | undefined} tierOptions
 */
function selectWithinBudget(scoredMemories, tokenLimit = 500, tierOptions) {
    if (!Array.isArray(scoredMemories) || scoredMemories.length === 0) return [];
    return selectTiers(scoredMemories, Math.max(0, Number(tokenLimit) || 0) * 4, tierOptions);
}

/** Relevant cap for an explicit memory_search call (vs 8 injected per turn). */
const SEARCH_RELEVANT_MAX = 20;

module.exports = { findRelevantMemories, selectWithinBudget, SEARCH_RELEVANT_MAX };

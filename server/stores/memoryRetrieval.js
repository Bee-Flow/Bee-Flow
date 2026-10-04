// @typecheck
/**
 * memoryRetrieval — hybrid candidate selection for `findRelevantMemories`.
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 * The previous path pulled up to 500 rows into Node on every chat turn and ran
 * a JS cosine loop over each one. That had three problems, in ascending order
 * of severity:
 *
 *   1. Cost scaled with the candidate cap, on the hot path, per turn.
 *   2. The cap itself silently discarded memories once a user (or a shared
 *      project pool) grew past 500 rows.
 *   3. `cosineSimilarity` returns 0 across mismatched dimensions, so every row
 *      embedded under a previous provider scored zero against everything and
 *      was, in practice, deleted.
 *
 * ── Three legs, fused ────────────────────────────────────────────────────────
 *   • `vec`  — pgvector `<=>` against the active dimension's column
 *   • `fts`  — weighted tsvector, `websearch_to_tsquery` so user punctuation
 *              cannot raise a syntax error mid-turn
 *   • `base` — importance then recency: the ordering the system used before
 *              any of this existed
 *
 * `base` is the point of the design. It is weighted lowest and never removed,
 * so when pgvector is absent, the embedding provider times out, the dictionary
 * is missing, or a row simply has not been backfilled yet, retrieval returns
 * the pre-Wave-7 result instead of nothing. There is no configuration in which
 * this path returns an empty list where the old one would not have.
 *
 * Rows entering JS per turn: 515 → at most 3×`LEG_LIMIT`.
 * Cosine computations in JS per turn: ~500 → 0.
 */

const { getAll } = require('../db');
const {
    vectorColumn, validateDim, vectorLiteral, tsqueryExpr,
} = require('./memoryVectors');
const { rrfFuse, finalScore } = require('./memoryScoring');

/**
 * Rows each leg may contribute.
 *
 * 60 is chosen against the budget, not the corpus: a turn's memory budget is
 * ~800 tokens, so even short memories cannot fill more than a couple of dozen
 * slots. Anything past 60 per leg cannot reach the prompt.
 */
const LEG_LIMIT = 60;

/** Internal bookkeeping rows, never rendered — see memoryStore. */
const SCHEDULE_COVERAGE_TYPE = 'schedule_coverage';

/**
 * Build the one-round-trip candidate query.
 *
 * Pure: no database, no config, no clock. `memoryRetrieval.sql.test.js` pins
 * its output, because the failure modes here are all silent — a `null::vector`
 * cast that throws, a CTE that materialises and full-scans, an interpolated
 * dimension.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.userId]
 * @param {string}  [opts.agentId]
 * @param {string}  [opts.projectId]
 * @param {boolean} [opts.includeGeneral]
 * @param {number}  [opts.dim]            active embedding dimension, if any
 * @param {number[]}[opts.queryVector]    the embedded user message, if any
 * @param {string}  [opts.queryText]      raw user message, for the lexical leg
 * @param {number}  [opts.legLimit]
 * @returns {{sql: string, params: any[], legs: string[]}}
 */
function buildCandidateQuery({
    userId, agentId = null, projectId = null, includeGeneral = true,
    dim = null, queryVector = null, queryText = '', legLimit = LEG_LIMIT,
} = {}) {
    if (!Number.isInteger(legLimit) || legLimit <= 0 || legLimit > 500) {
        throw new Error(`buildCandidateQuery: invalid legLimit ${legLimit}`);
    }

    const params = [];
    const bind = (value) => { params.push(value); return `$${params.length}`; };

    // ── scope predicate ──────────────────────────────────────────────────────
    const conditions = [
        `status = 'active'`,
        `(expires_at IS NULL OR expires_at > NOW())`,
        `type <> ${bind(SCHEDULE_COVERAGE_TYPE)}`,
    ];

    const agentClause = (!includeGeneral && agentId)
        ? `agent_id = ${bind(agentId)}`
        : `(agent_id = ${bind(agentId)} OR agent_id IS NULL)`;

    let ownerClause;
    if (projectId) {
        ownerClause = `project_id = ${bind(projectId)}`;
        if (includeGeneral) {
            // Behavioural memories cross the project boundary; project DATA
            // never does. Same rule the previous implementation applied with a
            // second query and a manual merge — expressed here as an OR branch
            // so the legs rank both pools together instead of appending one
            // unranked block after the other.
            ownerClause = `(${ownerClause} OR (user_id = ${bind(userId)} AND project_id IS NULL `
                + `AND type IN ('instruction', 'preference')))`;
        }
    } else {
        ownerClause = `(user_id = ${bind(userId)} AND project_id IS NULL)`;
    }

    const scopeWhere = [...conditions, agentClause, ownerClause].join('\n              AND ');

    // ── legs ─────────────────────────────────────────────────────────────────
    const legs = [];
    const ctes = [];
    const joins = [];
    const rankCols = [];

    // `NOT MATERIALIZED` is load-bearing. A CTE referenced more than once is
    // materialised by default from PG12 on, which would compute the scope into
    // a temp result and force each leg to scan it linearly — including the
    // vector leg, which would then never use an index. Inlined, each leg gets
    // its own index access path against the base table.
    ctes.push(`scope AS NOT MATERIALIZED (
            SELECT * FROM user_memories
             WHERE ${scopeWhere}
        )`);

    const col = validateDim(dim) ? vectorColumn(dim) : null;
    const literal = vectorLiteral(queryVector);
    // The literal must be exactly `dim` long or Postgres raises "different
    // vector dimensions" at query time — an exception on the chat hot path
    // rather than a degraded ranking. Belt and braces: the caller derives both
    // from the same embedding, so a mismatch here means a caller bug.
    const dimMatches = col && literal && queryVector.length === dim;
    if (dimMatches) {
        // Bound as text and cast, never interpolated. The COLUMN name has to be
        // interpolated — Postgres has no parameter form for an identifier —
        // which is why `validateDim` exists and is checked here again.
        const vecParam = bind(literal);
        ctes.push(`vec AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY "${col}" <=> ${vecParam}::vector) AS rank
              FROM scope
             WHERE "${col}" IS NOT NULL
             ORDER BY "${col}" <=> ${vecParam}::vector
             LIMIT ${legLimit}
        )`);
        joins.push('LEFT JOIN vec ON vec.id = s.id');
        rankCols.push('vec.rank AS vec_rank');
        legs.push('vec');
    }

    const trimmedQuery = (queryText || '').trim();
    if (trimmedQuery) {
        const qParam = bind(trimmedQuery.slice(0, 1000));
        const tsq = tsqueryExpr(qParam);
        ctes.push(`fts AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_vector, ${tsq}) DESC) AS rank
              FROM scope
             WHERE search_vector IS NOT NULL AND search_vector @@ ${tsq}
             ORDER BY ts_rank_cd(search_vector, ${tsq}) DESC
             LIMIT ${legLimit}
        )`);
        joins.push('LEFT JOIN fts ON fts.id = s.id');
        rankCols.push('fts.rank AS fts_rank');
        legs.push('fts');
    }

    // Always present. This is the leg that makes every other one optional.
    ctes.push(`base AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY importance DESC NULLS LAST, updated_at DESC) AS rank
              FROM scope
             ORDER BY importance DESC NULLS LAST, updated_at DESC
             LIMIT ${legLimit}
        )`);
    joins.push('LEFT JOIN base ON base.id = s.id');
    rankCols.push('base.rank AS base_rank');
    legs.push('base');

    const matched = legs.map(l => `${l}.id IS NOT NULL`).join(' OR ');

    const sql = `
        WITH ${ctes.join(',\n        ')}
        SELECT s.*, ${rankCols.join(', ')}
          FROM scope s
          ${joins.join('\n          ')}
         WHERE ${matched}
    `;

    return { sql, params, legs };
}

/**
 * Fetch and rank candidates. Returns `[{memory, score}]`, highest first —
 * the shape `selectWithinBudget` consumes.
 */
async function retrieveCandidates(opts) {
    const { sql, params, legs } = buildCandidateQuery(opts);
    const rows = await getAll(sql, params);
    if (!rows || rows.length === 0) return [];

    // Rebuild each leg's ranking from the per-row rank columns. Fusing here
    // rather than in SQL keeps the weighting in a tested pure function instead
    // of inside a query string.
    const ranked = {};
    for (const leg of legs) ranked[leg] = [];
    for (const row of rows) {
        for (const leg of legs) {
            const rank = row[`${leg}_rank`];
            if (rank != null) ranked[leg].push({ id: row.id, rank: Number(rank) });
        }
    }
    const legLists = legs.map(leg => ({
        key: leg,
        ids: ranked[leg].sort((a, b) => a.rank - b.rank).map(r => r.id),
    }));

    const fused = rrfFuse(legLists);
    const now = Date.now();

    return rows
        .map((row) => {
            // The rank columns are query bookkeeping, not part of a memory.
            const { vec_rank, fts_rank, base_rank, ...memory } = row;
            return { memory, score: finalScore(memory, fused.get(row.id) || 0, { now }) };
        })
        .sort((a, b) => b.score - a.score);
}

module.exports = { buildCandidateQuery, retrieveCandidates, LEG_LIMIT };

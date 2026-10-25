// @typecheck
/**
 * QUERY COMPILER (the ONLY place SQL is generated) — for App Studio apps
 * AND automation datatables.
 *
 * THE ONE INVARIANT: no client of any kind ever sends SQL. Every byte of SQL
 * that runs against a per-app SQLite database is produced HERE, from a
 * *validated* data-model table descriptor (dataModel.js) plus a structured,
 * closed-vocabulary request descriptor (filters/sort/aggregates/values). Two
 * rules make that safe:
 *
 *   1. IDENTIFIERS come only from the model. Every client-supplied `field`
 *      name is resolved through tableMeta.fields (or the fixed SYSTEM_COLUMNS
 *      list) to a real column and QUOTED. An unknown name throws — a client
 *      string can NEVER become an identifier. Table keys are re-checked against
 *      the key grammar before they're quoted, so `__proto__`/`constructor` and
 *      friends can't slip through.
 *   2. VALUES are always bound `?` params — never string-interpolated. Ops,
 *      aggregate functions and date buckets are checked against the closed
 *      vocabularies in dataModel.js; anything else throws.
 *
 * The RLS gateway's access filter ({where, params}) is a REQUIRED argument on
 * every read/mutate compiler (list/aggregate/update/delete/getById). It is
 * AND-ed into the WHERE *before* GROUP BY, so aggregates fold only rows the
 * viewer may see. There is deliberately no overload that omits it — the
 * compiler cannot be called unscoped.
 *
 * This module has NO database or network dependency; it is a pure
 * descriptor→{sql, params} transform and is exercised by
 * queryCompiler.safety.test.js (+ queryCompiler.pg.test.js for the pg dialect).
 *
 * ── DIALECT SURFACE (the ONLY sqlite↔pg differences in this file) ───
 * One compiler, two dialects. The dialect is resolved ONCE per entry point
 * from `opts.dialect`, falling back to engineFlag.getDialect() when the caller
 * passes none — so App Studio behaves exactly as before, while a caller whose
 * storage is not the one STUDIO_APP_ENGINE names (automation datatables are
 * always Postgres) states its dialect explicitly and cannot be given SQLite
 * SQL by a process-global default. The
 * compiler ALWAYS emits `?` placeholders; the PG engine converts to $n once
 * (toDollarParams). Everything not listed here is byte-identical SQL in both
 * dialects (quoted identifiers, keyset row-value comparison, LIMIT ?, BETWEEN,
 * IS [NOT] NULL, INSERT/UPDATE/DELETE shapes, ORDER BY alias):
 *
 *   1. scalar()          bool filter values  — sqlite binds 0/1 (better-sqlite3
 *                        refuses raw booleans; bool columns store 0/1);
 *                        pg binds true/false (BOOLEAN columns).
 *   2. coerceValue()     bool create/update values — same split as scalar().
 *   3. contains/notContains/startsWith/endsWith — sqlite LIKE (ASCII-case-
 *                        insensitive there); pg ILIKE (preserves those
 *                        semantics). ESCAPE '\' is valid in both and kept.
 *   4. empty `in`/`notIn` — sqlite emits literal 0/1 (falsy/truthy integers);
 *                        pg emits FALSE/TRUE (AND demands a boolean operand
 *                        there).
 *   5. dateBucketSql() (dateBuckets.js) — sqlite strftime family; pg to_char family
 *                        (week is ISO IYYY-"W"IW under pg vs %Y-W%W —
 *                        documented drift, both label a week bucket).
 *   6. percentiles p50/p90 — sqlite has no percentile aggregate → ranked
 *                        ROW_NUMBER/COUNT window CTE; pg uses
 *                        PERCENTILE_DISC(f) WITHIN GROUP (ORDER BY col) in the
 *                        plain aggregate shape. CRITICAL invariant in BOTH:
 *                        the access filter sits in the WHERE that feeds the
 *                        aggregate (CTE's WHERE / the single query's WHERE),
 *                        never applied after ranking/folding.
 */

'use strict';

// The vocabulary and the id minter directly, NOT appStudio's dataModel.js
// facade: that facade also carries the connector/mailbox validators, which
// are a feature concern and must not be pulled down into core.
const { AGG_FNS, PERCENTILE_FNS, DATE_BUCKETS } = require('./dataModel/vocabulary');
const { resolveDialect } = require('./engineFlag');
const { dateBucketSql } = require('./dateBuckets');
const { MAX_RESULT_ROWS, DEFAULT_LIMIT, MAX_KEY_INDEX_KEYS, MAX_GROUP_BY, MAX_AGGREGATES, ALIAS_RE, CompileError, RowsLockedError, assertRowsWritable, qi, assertTableMeta, fieldMap, resolveColumn, scalar, assertAccessFilter, MATCH_MODES, buildWhere, clampLimit } = require('./queryCompilerBase');
const { compileInsert, compileUpdate, compileDelete, compileUpsertByKey, compileUpsertById } = require('./queryCompilerWrite');
const { compileIdList, compileKeyValues, compileDeleteAll, compileDeleteOlderThan, compileSelectOlderThan, compileDeleteOrphans } = require('./queryCompilerMaintenance');
const { bestEffort } = require('../../utils/bestEffort');

// ── Table + field resolution ────────────────────────────────────────

// ── Value binding ───────────────────────────────────────────────────

// ── Access filter guard ─────────────────────────────────────────────

// ── WHERE builder (filters AND access) ──────────────────────────────

// ── Limit + keyset cursor ───────────────────────────────────────────

// Opaque base64url keyset cursor of (primary-sort-value, id) — mirrors
// automationStore/runs.js. A malformed cursor decodes to null (fall back to
// page 1) rather than 500.
function encodeCursor(v, i) {
    if (v === undefined || v === null || i === undefined || i === null) return null;
    return Buffer.from(JSON.stringify({ v, i }), 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
    if (!cursor || typeof cursor !== 'string') return null;
    try {
        const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (o && o.v !== undefined && o.v !== null && o.i !== undefined && o.i !== null) {
            return { v: o.v, i: o.i };
        }
    } catch (err) { bestEffort('core/dataEngine/queryCompiler:decodeCursor', err); /* fall through */ }
    return null;
}

// Single-column keyset sort: the first valid `sort` entry becomes the primary
// column (default created_at DESC); `id` is the tiebreaker in the same
// direction, making (col, id) a total order for a correct row-value keyset.
function resolvePrimarySort(tableMeta, fm, sort) {
    const first = Array.isArray(sort) ? sort[0] : sort;
    if (first && typeof first === 'object' && typeof first.field === 'string' && first.field) {
        const column = resolveColumn(tableMeta, first.field, fm);
        const dir = String(first.dir || first.direction || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
        return { fieldKey: first.field, column, dir };
    }
    return { fieldKey: 'created_at', column: qi('created_at'), dir: 'desc' };
}

// ── Public compilers ────────────────────────────────────────────────

/**
 * List records with filters + single-column keyset pagination.
 *   compileRecordList(tableMeta, { filters, match, sort, cursor, limit, maxLimit },
 *                     accessFilter)
 * Returns { sql, params, primaryField, limit }. The route slices at `limit`
 * (one probe row is fetched) and builds the next cursor from
 * `encodeCursor(row[primaryField], row.id)`.
 *
 * `match: 'any'` ORs the client filters; the access predicate stays ANDed
 * outside that group. `maxLimit` caps the page below MAX_RESULT_ROWS.
 */
function compileRecordList(tableMeta, opts = {}, accessFilter) {
    const dialect = resolveDialect(opts);
    assertTableMeta(tableMeta);
    const fm = fieldMap(tableMeta);
    const { where, params } = buildWhere(
        tableMeta, fm, opts.filters, accessFilter, dialect, opts.match, opts.search);
    const limit = clampLimit(opts.limit, opts.maxLimit);
    const { fieldKey, column, dir } = resolvePrimarySort(tableMeta, fm, opts.sort);
    const DIR = dir.toUpperCase();
    const cmp = dir === 'asc' ? '>' : '<';

    let clause = where;
    const allParams = [...params];
    const cur = decodeCursor(opts.cursor);
    if (cur) {
        clause += ` AND (${column}, ${qi('id')}) ${cmp} (?, ?)`;
        allParams.push(cur.v, cur.i);
    }

    const sql = `SELECT * FROM ${qi(tableMeta.key)} ${clause} `
        + `ORDER BY ${column} ${DIR}, ${qi('id')} ${DIR} LIMIT ?`;
    allParams.push(limit + 1); // probe row → nextCursor
    return { sql, params: allParams, primaryField: fieldKey, limit };
}

/** SELECT one record by id, access-scoped. Hidden rows return 0 rows → 404. */
function compileGetById(tableMeta, id, accessFilter, opts = {}) {
    resolveDialect(opts);
    assertTableMeta(tableMeta);
    assertAccessFilter(accessFilter);
    if (typeof id !== 'string' || !id) throw new CompileError('record id is required');
    return {
        sql: `SELECT * FROM ${qi(tableMeta.key)} WHERE ${qi('id')} = ? AND (${accessFilter.where}) LIMIT 1`,
        params: [id, ...accessFilter.params],
    };
}

function safeAlias(alias) {
    if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) throw new CompileError(`invalid alias: ${alias}`);
    return alias;
}

function resolveAggSort(sort, knownAliases) {
    const first = Array.isArray(sort) ? sort[0] : sort;
    if (!first || typeof first !== 'object' || typeof first.field !== 'string' || !first.field) return null;
    if (!knownAliases.has(first.field)) throw new CompileError(`cannot sort by unknown output column: ${first.field}`);
    const dir = String(first.dir || first.direction || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    return `${qi(first.field)} ${dir}`;
}

/**
 * Grouped aggregate query.
 *   compileAggregate(tableMeta, { filters, groupBy:[{field,bucket,as}],
 *     aggregates:[{fn,field,as}], sort, limit }, accessFilter)
 * The access predicate is ANDed into the WHERE BEFORE GROUP BY, so buckets fold
 * only visible rows (no cross-tenant/cross-owner aggregate leakage).
 */
function compileAggregate(tableMeta, opts = {}, accessFilter) {
    const dialect = resolveDialect(opts);
    assertTableMeta(tableMeta);
    const fm = fieldMap(tableMeta);
    const { where, params } = buildWhere(tableMeta, fm, opts.filters, accessFilter, dialect, opts.match);
    const allParams = [...params];

    const groupBy = Array.isArray(opts.groupBy) ? opts.groupBy : [];
    const aggregates = Array.isArray(opts.aggregates) ? opts.aggregates : [];
    if (groupBy.length > MAX_GROUP_BY) throw new CompileError(`too many groupBy fields (max ${MAX_GROUP_BY})`);
    if (aggregates.length > MAX_AGGREGATES) throw new CompileError(`too many aggregates (max ${MAX_AGGREGATES})`);
    if (groupBy.length === 0 && aggregates.length === 0) {
        throw new CompileError('aggregate query needs at least one groupBy or aggregate');
    }

    const selectParts = [];
    const groupExprs = [];
    const groupAliases = [];
    const knownAliases = new Set();

    for (const g of groupBy) {
        if (!g || typeof g !== 'object') throw new CompileError('groupBy entry must be an object');
        const col = resolveColumn(tableMeta, g.field, fm);
        if (g.bucket && !DATE_BUCKETS.includes(g.bucket)) throw new CompileError(`unknown date bucket: ${g.bucket}`);
        const expr = g.bucket ? dateBucketSql(col, g.bucket, dialect) : col;
        if (expr === null) throw new CompileError(`unknown date bucket: ${g.bucket}`);
        const alias = safeAlias(g.as || (g.bucket ? `${g.field}_${g.bucket}` : g.field));
        selectParts.push(`${expr} AS ${qi(alias)}`);
        groupExprs.push(expr);
        groupAliases.push(alias);
        knownAliases.add(alias);
    }

    // Percentiles need a ranked window over the rows, so they take a different
    // shape (a CTE) from the plain aggregates. Detected first so the simple path
    // compiles byte-identically to before when none is requested.
    const percentiles = [];

    for (const a of aggregates) {
        if (!a || typeof a !== 'object') throw new CompileError('aggregate entry must be an object');
        if (!AGG_FNS.includes(a.fn)) throw new CompileError(`unknown aggregate fn: ${a.fn}`);
        const alias = safeAlias(a.as || `${a.fn}_${a.field && a.field !== '*' ? a.field : 'all'}`);

        if (PERCENTILE_FNS[a.fn] !== undefined) {
            if (a.field === undefined || a.field === null || a.field === '*') {
                throw new CompileError(`${a.fn} needs a field to rank`);
            }
            const pcol = resolveColumn(tableMeta, a.field, fm);
            if (dialect === 'pg') {
                // Postgres HAS a discrete-percentile aggregate, so pg keeps the
                // plain single-query shape — the access filter stays in the one
                // WHERE that feeds the aggregate, same invariant as the CTE.
                // The fraction comes from the frozen PERCENTILE_FNS map (0.5 /
                // 0.9), never from the client, so interpolating it is safe.
                selectParts.push(
                    `PERCENTILE_DISC(${PERCENTILE_FNS[a.fn]}) WITHIN GROUP (ORDER BY ${pcol}) AS ${qi(alias)}`,
                );
                knownAliases.add(alias);
                continue;
            }
            percentiles.push({ alias, fraction: PERCENTILE_FNS[a.fn], col: pcol });
            knownAliases.add(alias);
            continue;
        }

        let inner;
        if (a.fn === 'count' && (a.field === undefined || a.field === null || a.field === '*')) {
            inner = '*';
        } else {
            inner = resolveColumn(tableMeta, a.field, fm);
        }
        selectParts.push(`${a.fn.toUpperCase()}(${inner}) AS ${qi(alias)}`);
        knownAliases.add(alias);
    }

    const limit = clampLimit(opts.limit);

    if (percentiles.length === 0) {
        let sql = `SELECT ${selectParts.join(', ')} FROM ${qi(tableMeta.key)} ${where}`;
        if (groupExprs.length) sql += ` GROUP BY ${groupExprs.join(', ')}`;
        const orderBy = resolveAggSort(opts.sort, knownAliases);
        if (orderBy) sql += ` ORDER BY ${orderBy}`;
        sql += ` LIMIT ?`;
        allParams.push(limit);
        return { sql, params: allParams };
    }

    /*
     * Nearest-rank percentile via a window function.
     *
     * The access predicate lives in the CTE's WHERE, NOT the outer query. That
     * placement is the whole security story here: the window ranks whatever the
     * CTE returns, so filtering afterwards would compute the median over rows
     * the viewer is not allowed to see and then hand them the answer. Assert on
     * it in tests, not just in review.
     *
     * ORDER BY puts NULLs last and COUNT(col) counts non-NULLs, so a column with
     * gaps ranks over its real values instead of over a pile of nulls.
     */
    const partition = groupExprs.length ? `PARTITION BY ${groupExprs.join(', ')} ` : '';
    const srcParts = [...groupExprs.map((expr, i) => `${expr} AS ${qi(groupAliases[i])}`)];
    const outerParts = [...groupAliases.map((alias) => qi(alias))];

    // The non-percentile aggregates still work — they just fold the CTE.
    for (const part of selectParts.slice(groupBy.length)) outerParts.push(part);

    percentiles.forEach((p, i) => {
        const v = `__pv_${i}`;
        const rn = `__rn_${i}`;
        const cn = `__cn_${i}`;
        srcParts.push(`${p.col} AS ${qi(v)}`);
        srcParts.push(`ROW_NUMBER() OVER (${partition}ORDER BY (CASE WHEN ${p.col} IS NULL THEN 1 ELSE 0 END), ${p.col}) AS ${qi(rn)}`);
        srcParts.push(`COUNT(${p.col}) OVER (${partition}) AS ${qi(cn)}`);
        outerParts.push(
            `MIN(CASE WHEN ${qi(rn)} >= CAST(${p.fraction} * ${qi(cn)} + 0.5 AS INTEGER) THEN ${qi(v)} END) AS ${qi(p.alias)}`,
        );
    });

    let sql = `WITH __src AS (SELECT ${srcParts.join(', ')} FROM ${qi(tableMeta.key)} ${where})`
        + ` SELECT ${outerParts.join(', ')} FROM __src`;
    if (groupAliases.length) sql += ` GROUP BY ${groupAliases.map((a) => qi(a)).join(', ')}`;
    const orderBy = resolveAggSort(opts.sort, knownAliases);
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    sql += ` LIMIT ?`;
    allParams.push(limit);
    return { sql, params: allParams };
}

/**
 * The (key value → record id) index a connector sync needs to decide
 * insert-vs-update, looked up for a SPECIFIC set of key values.
 *
 * Scoped to the incoming batch rather than the whole table on purpose. A
 * full-table scan would be bounded by the storage engine's 10k result cap, so a
 * table larger than that would hand back a PARTIAL map — and every unmatched row
 * would be re-inserted as a duplicate on every sync. Looking up only the keys
 * about to be written is bounded by the batch (≤ a few hundred), correct at any
 * table size, and an index seek on the key column's unique index.
 *
 * Access-scoped like every other read; a sync passes the owner's filter.
 */
function compileKeyIndex(tableMeta, keyFieldName, keys, accessFilter, opts = {}) {
    const dialect = resolveDialect(opts);
    assertTableMeta(tableMeta);
    assertAccessFilter(accessFilter);
    const fm = fieldMap(tableMeta);
    const column = resolveColumn(tableMeta, keyFieldName, fm);
    const list = (Array.isArray(keys) ? keys : []).filter((k) => k !== null && k !== undefined && k !== '');
    if (!list.length) throw new CompileError('compileKeyIndex requires at least one key value');
    if (list.length > MAX_KEY_INDEX_KEYS) {
        throw new CompileError(`compileKeyIndex accepts at most ${MAX_KEY_INDEX_KEYS} keys per call`);
    }
    return {
        sql: `SELECT ${qi('id')} AS ${qi('id')}, ${column} AS ${qi('k')} FROM ${qi(tableMeta.key)} `
            + `WHERE (${accessFilter.where}) AND ${column} IN (${list.map(() => '?').join(', ')})`,
        params: [...accessFilter.params, ...list.map((k) => scalar(k, dialect))],
    };
}

module.exports = {
    compileRecordList,
    compileGetById,
    compileAggregate,
    compileInsert,
    compileUpdate,
    compileDelete,
    compileKeyIndex,
    compileUpsertByKey,
    compileUpsertById,
    compileIdList,
    compileKeyValues,
    compileDeleteAll,
    compileDeleteOlderThan,
    compileSelectOlderThan,
    compileDeleteOrphans,
    encodeCursor,
    decodeCursor,
    // Exported so a route clamps with the compiler's own rule, not a copy.
    clampLimit,
    CompileError,
    RowsLockedError,
    assertRowsWritable,
    MATCH_MODES,
    MAX_RESULT_ROWS,
    MAX_AGGREGATES,
    DEFAULT_LIMIT,
    // Test-only internals
    _qi: qi,
    _resolveColumn: resolveColumn,
    _fieldMap: fieldMap,
};

/**
 * A model field as the compiler reads it.
 * @typedef {{ key?: string, type?: string, unique?: boolean, computed?: { stored?: boolean } }} CompilerField
 */

/**
 * The table descriptor every compiler takes (a data-model table).
 * @typedef {{ key?: string, fields?: CompilerField[], rowsLocked?: boolean }} TableMeta
 */

/**
 * The RLS gateway's access predicate.
 * @typedef {{ where: string, params: unknown[] }} AccessFilter
 */

/** @typedef {{ field?: string, op?: string, value?: unknown, ci?: boolean }} FilterSpec */

/** @typedef {{ field?: string, dir?: string, direction?: string }} SortEntry */

/** @typedef {{ value?: unknown, fields?: string[] }} SearchSpec */

/**
 * @typedef {{ dialect?: string, filters?: FilterSpec[], match?: string, search?: SearchSpec | null,
 *   sort?: SortEntry | SortEntry[], cursor?: string, limit?: unknown, maxLimit?: number }} ListOpts
 */

/**
 * @typedef {ListOpts & { groupBy?: Array<{ field?: string, bucket?: string, as?: string }>,
 *   aggregates?: Array<{ fn?: string, field?: string, as?: string }> }} AggregateOpts
 */

/** @typedef {{ dialect?: string, allowLockedRows?: boolean }} DialectOpts */

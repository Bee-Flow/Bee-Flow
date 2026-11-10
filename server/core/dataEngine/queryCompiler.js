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

// The layout, one concern per module (each pinned by queryCompiler.snapshot.test.js):
//   queryCompilerCore.js        limits, errors, quoting, the field resolver, binding, page size
//   queryCompilerFilter.mts     the filter tree: clauses, any-groups, match, search
//   queryCompilerSelect.mts     the select list of a record read
//   queryCompilerOrder.mts      sort, ORDER BY and the keyset cursor
//   queryCompilerAggregate.mts  group-by, date buckets, aggregate functions, percentiles
//   queryCompilerWrite.js / queryCompilerMaintenance.js / queryCompilerBulk.mts  the writes
// This file composes the record reads and is the one import every caller uses.
const { resolveDialect } = require('./engineFlag');
const { MAX_RESULT_ROWS, DEFAULT_LIMIT, MAX_KEY_INDEX_KEYS, MAX_AGGREGATES, CompileError, RowsLockedError, assertRowsWritable, qi, assertTableMeta, fieldMap, resolveColumn, scalar, assertAccessFilter, MATCH_MODES, buildWhere, clampLimit } = require('./queryCompilerBase');
const { compileInsert, compileUpdate, compileDelete, compileUpsertByKey, compileUpsertById } = require('./queryCompilerWrite');
const { compileIdList, compileKeyValues, compileDeleteAll, compileDeleteOlderThan, compileSelectOlderThan, compileDeleteOrphans, compileDoomedUnderParent, compileRetentionDelete } = require('./queryCompilerMaintenance');
const { encodeCursor, decodeCursor, resolvePrimarySort, keysetClause, recordOrderBy } = require('./queryCompilerOrder.mts');
const { recordSelectList, computedSelectFor, computedReadMeta } = require('./queryCompilerSelect.mts');
const { compileAggregate } = require('./queryCompilerAggregate.mts');

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
 *
 * `readTimeComputed: true` (set by the caller, never taken from a client
 * descriptor) adds every read-time computed field to the select list, and the
 * result gains `readTimeComputed { keys, refused, columns, fallbackSql }`. Run
 * such a read through computedRead.mts, so a failing expression reads NULL with
 * a note instead of failing the read. Without the option, or on a table without
 * such a field, the SQL and the result are what they always were.
 */
function compileRecordList(tableMeta, opts = {}, accessFilter) {
    const dialect = resolveDialect(opts);
    assertTableMeta(tableMeta);
    const fm = fieldMap(tableMeta);
    const { where, params } = buildWhere(
        tableMeta, fm, opts.filters, accessFilter, dialect, opts.match, opts.search);
    const limit = clampLimit(opts.limit, opts.maxLimit);
    const primary = resolvePrimarySort(tableMeta, fm, opts.sort);

    let clause = where;
    const allParams = [...params];
    const cur = decodeCursor(opts.cursor);
    if (cur) {
        const keyset = keysetClause(primary, cur);
        clause += keyset.sql;
        allParams.push(...keyset.params);
    }

    const computed = computedSelectFor(tableMeta, opts, dialect);
    /** @param {string} list */
    const sqlWith = (list) => `SELECT ${list} FROM ${qi(tableMeta.key)} ${clause} `
        + `${recordOrderBy(primary)} LIMIT ?`;
    allParams.push(limit + 1); // probe row → nextCursor
    return {
        sql: sqlWith(recordSelectList(computed)), params: allParams, primaryField: primary.fieldKey, limit,
        ...computedReadMeta(computed, sqlWith),
    };
}

/**
 * How many records a list read matches, for a page that shows a total.
 *   compileRecordCount(tableMeta, { filters, match, search }, accessFilter)
 * Returns { sql, params } that select one row `{ total }`. The WHERE is the one
 * compileRecordList builds from the same descriptor (access filter, client
 * filters, match, search); the cursor, the order and the limit are left out,
 * because the total is the size of the whole result, not of one page.
 */
function compileRecordCount(tableMeta, opts = {}, accessFilter) {
    const dialect = resolveDialect(opts);
    assertTableMeta(tableMeta);
    const fm = fieldMap(tableMeta);
    const { where, params } = buildWhere(
        tableMeta, fm, opts.filters, accessFilter, dialect, opts.match, opts.search);
    return { sql: `SELECT COUNT(*) AS ${qi('total')} FROM ${qi(tableMeta.key)} ${where}`, params: [...params] };
}

/**
 * SELECT one record by id, access-scoped. Hidden rows return 0 rows → 404.
 * `opts.readTimeComputed: true` adds the read-time computed fields, as in
 * compileRecordList.
 */
function compileGetById(tableMeta, id, accessFilter, opts = {}) {
    const dialect = resolveDialect(opts);
    assertTableMeta(tableMeta);
    assertAccessFilter(accessFilter);
    if (typeof id !== 'string' || !id) throw new CompileError('record id is required');
    const computed = computedSelectFor(tableMeta, opts, dialect);
    /** @param {string} list */
    const sqlWith = (list) => `SELECT ${list} FROM ${qi(tableMeta.key)} WHERE ${qi('id')} = ? AND (${accessFilter.where}) LIMIT 1`;
    return {
        sql: sqlWith(recordSelectList(computed)),
        params: [id, ...accessFilter.params],
        ...computedReadMeta(computed, sqlWith),
    };
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
    compileRecordCount,
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
    compileDeleteOrphans, compileDoomedUnderParent, compileRetentionDelete,
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
 *   sort?: SortEntry | SortEntry[], cursor?: string, limit?: unknown, maxLimit?: number,
 *   readTimeComputed?: boolean }} ListOpts
 */

/**
 * @typedef {ListOpts & { groupBy?: Array<{ field?: string, bucket?: string, as?: string }>,
 *   aggregates?: Array<{ fn?: string, field?: string, as?: string }> }} AggregateOpts
 */

/** @typedef {{ dialect?: string, allowLockedRows?: boolean }} DialectOpts */

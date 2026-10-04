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
 *   5. dateBucketExpr()  — sqlite strftime family; pg to_char family
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
const { FILTER_OPS, AGG_FNS, PERCENTILE_FNS, DATE_BUCKETS, SYSTEM_COLUMNS, KEY_RE } = require('./dataModel/vocabulary');
const { newRecordId } = require('./dataModel/ids');
const { resolveDialect } = require('./engineFlag');

// Hard ceiling on rows a single list/aggregate may return. The store applies
// its own MAX_RESULT_ROWS too; this keeps the SQL LIMIT sane and predictable.
const MAX_RESULT_ROWS = 1000;
const DEFAULT_LIMIT = 50;
// Key values a single compileKeyIndex lookup may carry. One sync writes at most
// MAX_CONNECTOR_ROWS (500) rows, and the caller chunks below this anyway; the
// cap is here so a bound variable list can never grow past SQLite's limit.
const MAX_KEY_INDEX_KEYS = 200;
const MAX_IN_VALUES = 200;
const MAX_FILTERS = 50;
const MAX_GROUP_BY = 8;
const MAX_AGGREGATES = 16;

// Alias grammar for aggregate/group output columns (they become quoted
// identifiers, so they must be constrained just like field keys — but we allow
// leading upper-case for readability).
const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

/** A 422-style compile failure — a bad/unknown descriptor, never an internal bug. */
class CompileError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CompileError';
        this.status = 422;
    }
}

/**
 * A row write to a table whose rows a Solution release owns (a reference
 * table in a UAT or PRD stage: its model descriptor carries `rowsLocked:
 * true`). 409 `managed_part`, the same refusal as any other write to a managed
 * part, and deliberately NOT a CompileError: every caller that turns a compile
 * failure into a 400/422 (or a per-row import error) has to let this one
 * through, because the request was well formed and the answer is "change it in
 * Dev and deploy", not "fix your descriptor". `errorClass` names it for a
 * automation's on_error branch; `expose` lets the terminal handler answer it.
 */
class RowsLockedError extends Error {
    constructor(message = 'The rows of this table are managed by a Solution release. Change them in Dev and deploy.') {
        super(message);
        this.name = 'RowsLockedError';
        this.status = 409;
        this.code = 'managed_part';
        this.errorClass = 'managed_part';
        this.expose = true;
    }
}

/**
 * Throw RowsLockedError when `tableMeta` is a locked reference table, unless
 * the caller is the deploy itself (`allowLockedRows: true`). Exported so a
 * caller can refuse BEFORE it spends a quota read or synthesises a preview.
 *
 * @param {object} tableMeta
 * @param {{ allowLockedRows?: boolean }} [opts]
 */
function assertRowsWritable(tableMeta, opts) {
    if (!tableMeta || tableMeta.rowsLocked !== true) return;
    if (opts && opts.allowLockedRows === true) return;
    throw new RowsLockedError();
}

// ── Identifier quoting ──────────────────────────────────────────────
function qi(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

// ── Table + field resolution ────────────────────────────────────────

function assertTableMeta(tableMeta) {
    if (!tableMeta || typeof tableMeta !== 'object' || typeof tableMeta.key !== 'string' || !tableMeta.key) {
        throw new CompileError('tableMeta with a key is required');
    }
    // The key comes from a validated model, but it's about to become a quoted
    // identifier — never trust it blindly. KEY_RE also rejects `__proto__`,
    // `constructor`, whitespace, quotes, etc. (must start lowercase a-z).
    if (!KEY_RE.test(tableMeta.key)) {
        throw new CompileError(`invalid table key: ${tableMeta.key}`);
    }
}

// Prototype-safe key→field map. A Map never resolves `__proto__`/`constructor`
// to an inherited value the way a bare object would.
function fieldMap(tableMeta) {
    const m = new Map();
    const fields = Array.isArray(tableMeta.fields) ? tableMeta.fields : [];
    for (const f of fields) {
        if (f && typeof f.key === 'string') m.set(f.key, f);
    }
    return m;
}

/**
 * Resolve a client-supplied field name to a QUOTED real column. System columns
 * (id/created_at/updated_at/created_by/org_id) are allowed for filter/sort.
 * Read-time computed fields have no physical column, so they're rejected. Any
 * other unknown name throws — the client string never becomes an identifier.
 */
function resolveColumn(tableMeta, fieldName, fm) {
    if (typeof fieldName !== 'string' || !fieldName) throw new CompileError('field must be a non-empty string');
    if (SYSTEM_COLUMNS.includes(fieldName)) return qi(fieldName);
    const map = fm || fieldMap(tableMeta);
    if (!map.has(fieldName)) throw new CompileError(`unknown field: ${fieldName}`);
    const f = map.get(fieldName);
    if (f.type === 'computed' && !(f.computed && f.computed.stored === true)) {
        throw new CompileError(`field "${fieldName}" is a read-time computed field and cannot be queried`);
    }
    return qi(f.key);
}

// ── Value binding ───────────────────────────────────────────────────

function scalar(v, dialect) {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    // sqlite: 0/1, matching how coerceValue STORES a bool column — and because
    // better-sqlite3 refuses to bind a raw boolean at all, so every
    // `eq true/false` filter on a bool column was a 500 waiting to be clicked.
    // pg: booleans stay booleans (the column is BOOLEAN; 0/1 would not compare).
    if (t === 'boolean') return dialect === 'pg' ? v : (v ? 1 : 0);
    if (t === 'string' || t === 'number') return v;
    throw new CompileError('filter value must be a string, number, boolean or null');
}

// Escape LIKE metacharacters so a `contains`/`startsWith` value can't smuggle
// `%`/`_` wildcards. Paired with `ESCAPE '\'` in the emitted SQL.
function likeEscape(v) {
    return String(v == null ? '' : v).replace(/[\\%_]/g, (c) => '\\' + c);
}

// Coerce a create/update value for a specific field. Booleans → 0/1 under
// sqlite (it has no bool) but stay true/false under pg (BOOLEAN column);
// multiselect/file → JSON text; other objects rejected (no silent JSON
// coercion into a text column).
function coerceValue(v, field, dialect) {
    if (v === undefined || v === null) return null;
    const t = typeof v;
    if (t === 'boolean') return dialect === 'pg' ? v : (v ? 1 : 0);
    if (field.type === 'multiselect' || field.type === 'file') return JSON.stringify(v);
    if (t === 'object') throw new CompileError(`field "${field.key}" does not accept an object value`);
    return v;
}

// ── Access filter guard ─────────────────────────────────────────────

/** A caller-supplied record id: a bounded, non-empty string, nothing else. */
function assertRecordId(id) {
    if (typeof id !== 'string' || !id || id.length > 64) {
        throw new CompileError('record id must be a non-empty string of at most 64 characters');
    }
    return id;
}

function assertAccessFilter(accessFilter) {
    if (!accessFilter || typeof accessFilter !== 'object'
        || typeof accessFilter.where !== 'string' || !accessFilter.where
        || !Array.isArray(accessFilter.params)) {
        throw new CompileError('accessFilter {where, params} is required — the query compiler cannot run unscoped');
    }
}

// ── WHERE builder (filters AND access) ──────────────────────────────

function compileFilter(tableMeta, fm, filter, out, dialect) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new CompileError('filter must be an object');
    const col = resolveColumn(tableMeta, filter.field, fm);
    const op = filter.op;
    if (!FILTER_OPS.includes(op)) throw new CompileError(`unknown filter op: ${op}`);
    switch (op) {
        case 'eq': out.sql.push(`${col} = ?`); out.params.push(scalar(filter.value, dialect)); break;
        case 'neq': out.sql.push(`${col} != ?`); out.params.push(scalar(filter.value, dialect)); break;
        case 'gt': out.sql.push(`${col} > ?`); out.params.push(scalar(filter.value, dialect)); break;
        case 'gte': out.sql.push(`${col} >= ?`); out.params.push(scalar(filter.value, dialect)); break;
        case 'lt': out.sql.push(`${col} < ?`); out.params.push(scalar(filter.value, dialect)); break;
        case 'lte': out.sql.push(`${col} <= ?`); out.params.push(scalar(filter.value, dialect)); break;
        case 'contains':
            // SQLite LIKE is ASCII-case-insensitive; pg ILIKE preserves that.
            out.sql.push(`${col} ${dialect === 'pg' ? 'ILIKE' : 'LIKE'} ? ESCAPE '\\'`);
            out.params.push('%' + likeEscape(filter.value) + '%');
            break;
        case 'notContains':
            // NOT (col LIKE ?), not `col NOT LIKE ?`: a NULL column makes the
            // bare NOT LIKE answer NULL, so the row is neither in nor out and
            // silently vanishes from a "does not contain" list.
            out.sql.push(`(${col} IS NULL OR NOT (${col} ${dialect === 'pg' ? 'ILIKE' : 'LIKE'} ? ESCAPE '\\'))`);
            out.params.push('%' + likeEscape(filter.value) + '%');
            break;
        case 'startsWith':
            out.sql.push(`${col} ${dialect === 'pg' ? 'ILIKE' : 'LIKE'} ? ESCAPE '\\'`);
            out.params.push(likeEscape(filter.value) + '%');
            break;
        case 'endsWith':
            out.sql.push(`${col} ${dialect === 'pg' ? 'ILIKE' : 'LIKE'} ? ESCAPE '\\'`);
            out.params.push('%' + likeEscape(filter.value));
            break;
        case 'in':
        case 'notIn': {
            // A non-array is a MISTAKE, not "match nothing". `in` used to
            // silently compile a string value to a literal FALSE, so a step
            // whose binding produced 'a,b' instead of ['a','b'] matched zero
            // rows for ever and reported success.
            if (!Array.isArray(filter.value)) {
                throw new CompileError(`${op} needs a list of values, not ${typeof filter.value}`);
            }
            const arr = filter.value;
            // IN () is invalid SQL → match nothing (and NOT IN () → everything).
            // sqlite accepts a falsy 0; pg's AND demands a boolean, so it gets a
            // literal FALSE/TRUE.
            if (arr.length === 0) {
                if (op === 'in') out.sql.push(dialect === 'pg' ? 'FALSE' : '0');
                else out.sql.push(dialect === 'pg' ? 'TRUE' : '1');
                break;
            }
            if (arr.length > MAX_IN_VALUES) throw new CompileError(`${op} filter exceeds ${MAX_IN_VALUES} values`);
            const holes = arr.map(() => '?').join(', ');
            // Same NULL problem as notContains: `col NOT IN (…)` is NULL for a
            // NULL column, so the row would disappear from both sides.
            out.sql.push(op === 'in'
                ? `${col} IN (${holes})`
                : `(${col} IS NULL OR ${col} NOT IN (${holes}))`);
            for (const v of arr) out.params.push(scalar(v, dialect));
            break;
        }
        case 'between': {
            const arr = Array.isArray(filter.value) ? filter.value : null;
            if (!arr || arr.length !== 2) throw new CompileError('between requires a [min, max] array');
            out.sql.push(`(${col} BETWEEN ? AND ?)`);
            out.params.push(scalar(arr[0], dialect), scalar(arr[1], dialect));
            break;
        }
        case 'isNull': out.sql.push(`${col} IS NULL`); break;
        case 'isNotNull': out.sql.push(`${col} IS NOT NULL`); break;
        default: throw new CompileError(`unsupported filter op: ${op}`);
    }
}

// How the client filters join each other. ONE top-level combinator, never a
// nested group: 'status is new OR retry' is the shape people actually ask for,
// and a recursive query-builder would trade the closed descriptor — the whole
// reason no client SQL exists — for a grammar.
const MATCH_MODES = Object.freeze(['all', 'any']);

/**
 * Build a WHERE clause combining the (validated) client filters with the RLS
 * access predicate. The access predicate is ALWAYS present and ANDed first, so
 * even a zero-filter query is scoped.
 *
 * With `match: 'any'` the CLIENT filters OR each other inside one parenthesised
 * group and the access predicate stays ANDed OUTSIDE it. That placement is the
 * whole security story: `access OR status='new'` would hand every row of the
 * table to anyone who asked for the right status.
 */
function buildWhere(tableMeta, fm, filters, accessFilter, dialect, match = 'all', search = null) {
    assertAccessFilter(accessFilter);
    if (!MATCH_MODES.includes(match)) throw new CompileError(`match must be one of ${MATCH_MODES.join(', ')}`);
    const out = { sql: [], params: [] };
    if (filters != null) {
        if (!Array.isArray(filters)) throw new CompileError('filters must be an array');
        if (filters.length > MAX_FILTERS) throw new CompileError(`too many filters (max ${MAX_FILTERS})`);
        for (const f of filters) compileFilter(tableMeta, fm, f, out, dialect);
    }
    const user = (match === 'any' && out.sql.length > 1)
        ? [`(${out.sql.join(' OR ')})`]
        : out.sql;
    const clauses = [`(${accessFilter.where})`, ...user];
    const params = [...accessFilter.params, ...out.params];

    // ONE fixed extra group: "this word appears somewhere in the row".
    //
    // It is a named, server-built shape rather than a nested filter group. The
    // descriptor stays closed — every column still goes through resolveColumn
    // and the value is still a bound parameter — and the search ANDs with
    // whatever the filters said instead of joining their combinator, so a
    // `match:'any'` filter set cannot widen the search or the other way round.
    if (search && typeof search === 'object') {
        const value = search.value;
        const fields = Array.isArray(search.fields) ? search.fields : [];
        if (typeof value !== 'string' || !value) throw new CompileError('search needs a non-empty string');
        if (!fields.length) throw new CompileError('search needs at least one column to look in');
        if (fields.length > MAX_FILTERS) throw new CompileError(`search spans at most ${MAX_FILTERS} columns`);
        const like = dialect === 'pg' ? 'ILIKE' : 'LIKE';
        const parts = [];
        for (const f of fields) {
            parts.push(`${resolveColumn(tableMeta, f, fm)} ${like} ? ESCAPE '\\'`);
            params.push('%' + likeEscape(value) + '%');
        }
        clauses.push(`(${parts.join(' OR ')})`);
    }
    return { where: 'WHERE ' + clauses.join(' AND '), params };
}

// ── Limit + keyset cursor ───────────────────────────────────────────

/**
 * The one place a page size is decided. Anything that is not a positive number
 * — '', -5, 'abc', NaN — becomes the default rather than travelling on: a route
 * that re-derived its own limit and then sliced by it returned `rows.slice(0,
 * -5)` (46 of 51 rows) while reporting hasMore, so the caller paged for ever.
 *
 * `max` lets a caller cap below MAX_RESULT_ROWS; it can never raise the ceiling.
 */
function clampLimit(limit, max = MAX_RESULT_ROWS) {
    const ceiling = Math.min(Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_RESULT_ROWS, MAX_RESULT_ROWS);
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return Math.min(DEFAULT_LIMIT, ceiling);
    return Math.min(n, ceiling);
}

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
    } catch { /* fall through */ }
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

function dateBucketExpr(col, bucket, dialect) {
    if (dialect === 'pg') {
        // ::timestamptz because the column may be DATE or TIMESTAMPTZ; both
        // cast cleanly and to_char then formats one type, not two.
        switch (bucket) {
            // Hour-of-day (00–23), not a timestamp — see the sqlite note below.
            case 'hour': return `to_char(${col}::timestamptz, 'HH24')`;
            case 'day': return `to_char(${col}::timestamptz, 'YYYY-MM-DD')`;
            case 'week': return `to_char(${col}::timestamptz, 'IYYY-"W"IW')`;
            case 'month': return `to_char(${col}::timestamptz, 'YYYY-MM')`;
            case 'quarter': return `to_char(${col}::timestamptz, 'YYYY-"Q"Q')`;
            case 'year': return `to_char(${col}::timestamptz, 'YYYY')`;
            default: throw new CompileError(`unknown date bucket: ${bucket}`);
        }
    }
    switch (bucket) {
        // Hour-of-day (00–23), not a timestamp: what a "busiest hours"
        // histogram folds every day of the range onto.
        case 'hour': return `strftime('%H', ${col})`;
        case 'day': return `strftime('%Y-%m-%d', ${col})`;
        case 'week': return `strftime('%Y-W%W', ${col})`;
        case 'month': return `strftime('%Y-%m', ${col})`;
        case 'quarter':
            return `(strftime('%Y', ${col}) || '-Q' || ((CAST(strftime('%m', ${col}) AS INTEGER) + 2) / 3))`;
        case 'year': return `strftime('%Y', ${col})`;
        default: throw new CompileError(`unknown date bucket: ${bucket}`);
    }
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
        const expr = g.bucket ? dateBucketExpr(col, g.bucket, dialect) : col;
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
 * INSERT a record. System columns are stamped from the server-supplied args
 * (createdBy/orgId) plus a fresh record id and timestamps — a client can NEVER
 * set id/created_at/updated_at/created_by/org_id (those keys are dropped).
 * Returns { sql, params, id }.
 */
function compileInsert(tableMeta, values, {
    createdBy = null, orgId = null, dialect: dialectOpt, id: idOpt, allowLockedRows = false,
} = {}) {
    const dialect = resolveDialect({ dialect: dialectOpt });
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    const fm = fieldMap(tableMeta);
    // `id` is a SERVER-ONLY option, never read from `values` (a client's
    // `values.id` is still dropped below with the other system columns). A
    // mirror of an external table stores its rows under the SOURCE's row id,
    // so a relation value there — the target's row id — IS the target row's
    // `id`, and a push event can address the row it is about.
    const id = idOpt === undefined ? newRecordId() : assertRecordId(idOpt);
    const now = new Date().toISOString();
    const cols = ['id', 'created_at', 'updated_at', 'created_by', 'org_id'];
    const params = [id, now, now, createdBy, orgId];

    const vals = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};
    for (const [k, v] of Object.entries(vals)) {
        if (SYSTEM_COLUMNS.includes(k)) continue; // clients cannot set system columns
        if (!fm.has(k)) throw new CompileError(`unknown field: ${k}`);
        const f = fm.get(k);
        if (f.type === 'computed') continue; // computed columns are derived, never written
        cols.push(f.key);
        params.push(coerceValue(v, f, dialect));
    }
    const sql = `INSERT INTO ${qi(tableMeta.key)} (${cols.map(qi).join(', ')}) `
        + `VALUES (${cols.map(() => '?').join(', ')})`;
    return { sql, params, id };
}

/**
 * UPDATE a record by id, access-scoped. The WHERE is `id = ? AND (accessFilter)`
 * so a viewer updating a row they can't see changes 0 rows → the route answers
 * 404. updated_at is always bumped server-side; system columns are never
 * settable by the client.
 *
 * OPTIMISTIC CONCURRENCY (opt-in): pass `expectedUpdatedAt` — the updated_at
 * the caller read — and it is ANDed into the WHERE. A row someone else has
 * written since carries a different stamp, so the update matches 0 rows and the
 * caller can tell "gone/out of scope" from "changed under me" by re-reading.
 * updated_at is already server-stamped on every write and returned on every
 * read, so this needs NO new column and works identically in both dialects
 * (SQLite TEXT ISO, Postgres TIMESTAMPTZ — the ms-precision ISO string the
 * writer stamps round-trips exactly through both).
 *
 * Deliberately opt-in: action sequences (update_record steps) stay
 * last-write-wins because they are server-authoritative flows with no user
 * holding a stale copy; the record API + inline grid edits pass the token.
 */
function compileUpdate(tableMeta, id, values, accessFilter, {
    expectedUpdatedAt = null, dialect: dialectOpt, allowLockedRows = false,
} = {}) {
    const dialect = resolveDialect({ dialect: dialectOpt });
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    assertAccessFilter(accessFilter);
    if (typeof id !== 'string' || !id) throw new CompileError('record id is required');
    const fm = fieldMap(tableMeta);
    const vals = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};

    const sets = [`${qi('updated_at')} = ?`];
    const params = [new Date().toISOString()];
    for (const [k, v] of Object.entries(vals)) {
        if (SYSTEM_COLUMNS.includes(k)) continue; // system columns are server-owned
        if (!fm.has(k)) throw new CompileError(`unknown field: ${k}`);
        const f = fm.get(k);
        if (f.type === 'computed') continue;
        sets.push(`${qi(f.key)} = ?`);
        params.push(coerceValue(v, f, dialect));
    }

    const guard = [];
    const guardParams = [];
    if (expectedUpdatedAt !== null && expectedUpdatedAt !== undefined) {
        if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
            throw new CompileError('expectedUpdatedAt must be a non-empty ISO timestamp string');
        }
        guard.push(` AND ${qi('updated_at')} = ?`);
        guardParams.push(expectedUpdatedAt);
    }

    const sql = `UPDATE ${qi(tableMeta.key)} SET ${sets.join(', ')} `
        + `WHERE ${qi('id')} = ? AND (${accessFilter.where})${guard.join('')}`;
    return { sql, params: [...params, id, ...accessFilter.params, ...guardParams] };
}

/**
 * DELETE a record by id, access-scoped. Same 0-rows-changed = 404 semantics as
 * update.
 */
function compileDelete(tableMeta, id, accessFilter, opts = {}) {
    resolveDialect(opts);
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, opts);
    assertAccessFilter(accessFilter);
    if (typeof id !== 'string' || !id) throw new CompileError('record id is required');
    return {
        sql: `DELETE FROM ${qi(tableMeta.key)} WHERE ${qi('id')} = ? AND (${accessFilter.where})`,
        params: [id, ...accessFilter.params],
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
    resolveDialect(opts);
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
        params: [...accessFilter.params, ...list.map(scalar)],
    };
}

/**
 * INSERT … ON CONFLICT (<unique key column>) DO UPDATE — one statement, no
 * probe, no duplicate.
 *
 * `execDatatable`'s own `save_row` deliberately does NOT do this: it looks the
 * row up first, because an upsert compiled as INSERT-on-conflict needs a unique
 * index the AUTHOR may never have declared, and a missing one turns the
 * statement into a runtime error rather than an append. That reasoning does not
 * apply to a MANAGED table (dataModel/managedTables.js), whose column contract
 * declares the key unique — which is exactly why this exists here and is not
 * offered to the ordinary datatable step.
 *
 * So the unique declaration is CHECKED, not assumed: without it Postgres
 * answers "no unique or exclusion constraint matching the ON CONFLICT
 * specification", which is a 500 from inside somebody's nightly automation.
 *
 * THE ACCESS FILTER GUARDS THE UPDATE HALF. `ON CONFLICT … DO UPDATE … WHERE`
 * takes a predicate over the EXISTING row, so a row the caller may not write is
 * left exactly as it is (and, the insert having conflicted, nothing is written
 * at all). Without it this would be the one write on this path that can change
 * a row the caller could not have reached with compileUpdate — precisely the
 * hole `row_scope: 'own'` exists to close.
 *
 * Postgres only. SQLite spells the upsert differently enough that a
 * one-dialect-tested statement would be a guess, and the only storage this is
 * reachable from is a datatable, which is always Postgres.
 */
function compileUpsertByKey(tableMeta, keyFieldName, values, accessFilter, {
    createdBy = null, orgId = null, dialect: dialectOpt, allowLockedRows = false,
} = {}) {
    const dialect = resolveDialect({ dialect: dialectOpt });
    if (dialect !== 'pg') throw new CompileError('compileUpsertByKey is Postgres-only');
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    assertAccessFilter(accessFilter);
    const fm = fieldMap(tableMeta);
    const keyField = fm.get(keyFieldName);
    if (!keyField) throw new CompileError(`unknown field: ${keyFieldName}`);
    if (keyField.unique !== true) {
        throw new CompileError(`compileUpsertByKey needs "${keyFieldName}" to be a unique column`);
    }
    const vals = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};
    if (vals[keyFieldName] === undefined || vals[keyFieldName] === null || vals[keyFieldName] === '') {
        throw new CompileError(`compileUpsertByKey requires a value for "${keyFieldName}"`);
    }

    const id = newRecordId();
    const now = new Date().toISOString();
    const cols = ['id', 'created_at', 'updated_at', 'created_by', 'org_id'];
    const params = [id, now, now, createdBy, orgId];
    // Only the caller's own columns are refreshed on a conflict. id,
    // created_at and created_by stay whatever the row already had: the row IS
    // the same answer, re-fetched, and rewriting its identity would break
    // anything keyed on it (and lie about who first stored it).
    const updates = [`${qi('updated_at')} = EXCLUDED.${qi('updated_at')}`];
    for (const [k, v] of Object.entries(vals)) {
        if (SYSTEM_COLUMNS.includes(k)) continue;
        if (!fm.has(k)) throw new CompileError(`unknown field: ${k}`);
        const f = fm.get(k);
        if (f.type === 'computed') continue;
        cols.push(f.key);
        params.push(coerceValue(v, f, dialect));
        // The conflict column itself is not re-assigned: it is what matched.
        if (f.key !== keyField.key) updates.push(`${qi(f.key)} = EXCLUDED.${qi(f.key)}`);
    }

    const sql = `INSERT INTO ${qi(tableMeta.key)} (${cols.map(qi).join(', ')}) `
        + `VALUES (${cols.map(() => '?').join(', ')}) `
        + `ON CONFLICT (${qi(keyField.key)}) DO UPDATE SET ${updates.join(', ')} `
        + `WHERE ${accessFilter.where}`;
    return { sql, params: [...params, ...accessFilter.params], id };
}

/**
 * INSERT … ON CONFLICT ("id") DO UPDATE — the write a MIRROR of an external
 * table makes for every row it fetches, keyed on the id it already knows.
 *
 * Unlike compileUpsertByKey there is no unique-column question: `id` is the
 * primary key of every table. What IS different is the second half of the
 * WHERE. `(cols) IS DISTINCT FROM (EXCLUDED.cols)` makes an UNCHANGED row a
 * no-op — `updated_at` stays what it was. Without that guard every scheduled
 * pass would stamp every row, and every editor holding an `expectedUpdatedAt`
 * from a minute ago would be told a colleague changed the row (row_conflict)
 * when nobody did. It is also what lets a push event's patch and our own
 * write-through's echo of the same row land twice without a second version
 * bump. With no data columns at all the guard is `1=0`: nothing to change.
 *
 * The access filter guards the update half exactly as in compileUpsertByKey.
 * Postgres only, for the same reason.
 */
function compileUpsertById(tableMeta, id, values, accessFilter, {
    createdBy = null, orgId = null, dialect: dialectOpt, allowLockedRows = false,
} = {}) {
    const dialect = resolveDialect({ dialect: dialectOpt });
    if (dialect !== 'pg') throw new CompileError('compileUpsertById is Postgres-only');
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    assertAccessFilter(accessFilter);
    assertRecordId(id);
    const fm = fieldMap(tableMeta);
    const vals = (values && typeof values === 'object' && !Array.isArray(values)) ? values : {};

    const now = new Date().toISOString();
    const cols = ['id', 'created_at', 'updated_at', 'created_by', 'org_id'];
    const params = [id, now, now, createdBy, orgId];
    const updates = [`${qi('updated_at')} = EXCLUDED.${qi('updated_at')}`];
    const dataCols = [];
    for (const [k, v] of Object.entries(vals)) {
        if (SYSTEM_COLUMNS.includes(k)) continue;
        if (!fm.has(k)) throw new CompileError(`unknown field: ${k}`);
        const f = fm.get(k);
        if (f.type === 'computed') continue;
        cols.push(f.key);
        dataCols.push(f.key);
        params.push(coerceValue(v, f, dialect));
        updates.push(`${qi(f.key)} = EXCLUDED.${qi(f.key)}`);
    }
    // The EXISTING row's columns are qualified with the table name: inside
    // ON CONFLICT DO UPDATE a bare column name is ambiguous between the table
    // and EXCLUDED, and Postgres says so (42702) rather than guessing.
    const t = qi(tableMeta.key);
    const changed = dataCols.length
        ? `(${dataCols.map(c => `${t}.${qi(c)}`).join(', ')}) IS DISTINCT FROM (${dataCols.map(c => `EXCLUDED.${qi(c)}`).join(', ')})`
        : '1=0';

    const sql = `INSERT INTO ${qi(tableMeta.key)} (${cols.map(qi).join(', ')}) `
        + `VALUES (${cols.map(() => '?').join(', ')}) `
        + `ON CONFLICT (${qi('id')}) DO UPDATE SET ${updates.join(', ')} `
        + `WHERE (${accessFilter.where}) AND ${changed}`;
    return { sql, params: [...params, ...accessFilter.params] };
}

/**
 * Every id a scope can see — the snapshot a mirror takes BEFORE it fetches, so
 * that "rows the source no longer has" is computed against what existed when
 * the pass began and never against rows written while it ran.
 *
 * No LIMIT: the only caller is the mirror engine, whose tables are bounded by
 * its own row cap (far below MAX_ROWS_PER_TABLE), and a partial snapshot would
 * be worse than none — every id it missed would be swept as "gone".
 */
function compileIdList(tableMeta, accessFilter, opts = {}) {
    resolveDialect(opts);
    assertTableMeta(tableMeta);
    assertAccessFilter(accessFilter);
    return {
        sql: `SELECT ${qi('id')} FROM ${qi(tableMeta.key)} WHERE ${accessFilter.where}`,
        params: [...accessFilter.params],
    };
}

/**
 * (id, value) for ONE column over the whole table, NULLs left out — the index
 * a mirror builds over its RELATION TARGET to turn "the row whose <column>
 * equals this value" into a row id, and the (id → label) map it fills a
 * relation's label column from. The whole-table twin of compileKeyIndex; the
 * same row-cap argument as compileIdList is what bounds it.
 */
function compileKeyValues(tableMeta, fieldName, accessFilter, opts = {}) {
    resolveDialect(opts);
    assertTableMeta(tableMeta);
    assertAccessFilter(accessFilter);
    const column = resolveColumn(tableMeta, fieldName);
    return {
        sql: `SELECT ${qi('id')} AS ${qi('id')}, ${column} AS ${qi('k')} FROM ${qi(tableMeta.key)} `
            + `WHERE (${accessFilter.where}) AND ${column} IS NOT NULL`,
        params: [...accessFilter.params],
    };
}

/**
 * DELETE every row a scope can see. Only 'replace'-mode connector syncs use
 * this: a source with no stable per-row identity can only be refreshed by
 * emptying the table and refilling it. Access-scoped, so it can never delete
 * beyond what the caller may already see.
 */
function compileDeleteAll(tableMeta, accessFilter, opts = {}) {
    resolveDialect(opts);
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, opts);
    assertAccessFilter(accessFilter);
    return {
        sql: `DELETE FROM ${qi(tableMeta.key)} WHERE ${accessFilter.where}`,
        params: [...accessFilter.params],
    };
}

/**
 * "Rows of this table older than the cutoff" — the predicate itself.
 *
 * ONE definition, shared by the DELETE below and by the SELECT that finds the
 * ids it is about to remove. Two hand-written copies would be two places to
 * forget the NOT NULL guard, and the copy that forgot it would silently eat
 * every undated row in the table.
 */
function olderThanWhere(tableMeta, accessFilter, { field, cutoffIso }) {
    assertTableMeta(tableMeta);
    assertAccessFilter(accessFilter);
    const column = resolveColumn(tableMeta, field);
    if (typeof cutoffIso !== 'string' || !cutoffIso) {
        throw new CompileError('retention cutoff must be an ISO timestamp', 'bad_cutoff');
    }
    // NOT NULL guard: a row with no timestamp has no age, and deleting it
    // would silently eat data the connector never dated.
    return {
        column,
        where: `${accessFilter.where} AND ${column} IS NOT NULL AND ${column} < ?`,
        params: [...accessFilter.params, cutoffIso],
    };
}

/**
 * Delete rows whose timestamp column is older than a cutoff.
 *
 * Backs a connector's `retentionDays`. Ingesting mail copies customer personal
 * data into the app's database, and an unbounded copy is not defensible — so
 * the retention setting has to actually delete something. The column goes
 * through resolveColumn, so an unknown or unstored field is a CompileError
 * rather than an injection point.
 */
function compileDeleteOlderThan(tableMeta, accessFilter, { field, cutoffIso, dialect: dialectOpt, allowLockedRows = false }) {
    resolveDialect({ dialect: dialectOpt });
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    const { where, params } = olderThanWhere(tableMeta, accessFilter, { field, cutoffIso });
    return {
        sql: `DELETE FROM ${qi(tableMeta.key)} WHERE ${where}`,
        params,
        // Handed back so a caller can SELECT exactly the rows this is about to
        // delete (the file blobs they point at have to be collected first).
        // Returned rather than rebuilt by the caller so there is one definition
        // of "doomed", not two that can drift.
        where,
        whereParams: params,
    };
}

/**
 * The ids of the rows compileDeleteOlderThan would delete, OLDEST FIRST and
 * capped.
 *
 * Postgres has no `DELETE … LIMIT`, so a retention sweep that must not
 * monopolise one pass has to name the rows before it removes them. Oldest
 * first is not cosmetic: with a per-pass cap, an arbitrary slice would let the
 * same middle of a large backlog be re-read for ever while the genuinely
 * expired head never drains.
 *
 * Only `id` is selected. A retention pass has no business reading the personal
 * data it is about to delete, and the rows it names go straight back into
 * compileDelete.
 */
function compileSelectOlderThan(tableMeta, accessFilter, { field, cutoffIso, limit, dialect: dialectOpt }) {
    resolveDialect({ dialect: dialectOpt });
    const { column, where, params } = olderThanWhere(tableMeta, accessFilter, { field, cutoffIso });
    return {
        sql: `SELECT ${qi('id')} FROM ${qi(tableMeta.key)} WHERE ${where} `
            + `ORDER BY ${column} ASC, ${qi('id')} ASC LIMIT ?`,
        params: [...params, clampLimit(limit)],
    };
}

/**
 * Delete child rows whose parent record is gone.
 *
 * This is how retention reaches a child table that carries no date of its own.
 * An email attachment has no timestamp — its age IS its message's age — so the
 * only honest rule is "when the message goes, the attachment goes". Run after
 * the parent purge, this turns the parent's cutoff into the child's.
 *
 * A NULL relation is swept too — but only for connector-WRITTEN children
 * (`sweepNull` true, the default): the sync always stamps the parent id, so a
 * NULL one is a row whose parent was never written. Left alone it would sit in
 * a table with a stated retention policy and never age out.
 *
 * Dependents are the opposite case: the connector never writes them, the app's
 * users do, and relation columns are always created nullable — so a row whose
 * relation is (still) empty is legitimate user data with no parent to inherit
 * an age from. Callers pass `sweepNull: false` there, and only rows that point
 * AT a vanished parent are collected.
 */
function compileDeleteOrphans(tableMeta, accessFilter, {
    relationField, parentTableMeta, sweepNull = true, dialect: dialectOpt, allowLockedRows = false,
}) {
    resolveDialect({ dialect: dialectOpt });
    assertTableMeta(tableMeta);
    assertRowsWritable(tableMeta, { allowLockedRows });
    assertTableMeta(parentTableMeta);
    assertAccessFilter(accessFilter);
    const column = resolveColumn(tableMeta, relationField);
    const orphanTest = sweepNull
        ? `(${column} IS NULL OR ${column} NOT IN (SELECT "id" FROM ${qi(parentTableMeta.key)}))`
        : `(${column} IS NOT NULL AND ${column} NOT IN (SELECT "id" FROM ${qi(parentTableMeta.key)}))`;
    const where = `${accessFilter.where} AND ${orphanTest}`;
    return {
        sql: `DELETE FROM ${qi(tableMeta.key)} WHERE ${where}`,
        params: [...accessFilter.params],
        where,
        whereParams: [...accessFilter.params],
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
    // Exported so a route clamps with the compiler's own rule instead of
    // re-deriving one that disagrees with it.
    clampLimit,
    CompileError,
    RowsLockedError,
    assertRowsWritable,
    MATCH_MODES,
    MAX_RESULT_ROWS,
    DEFAULT_LIMIT,
    // Test-only internals
    _qi: qi,
    _resolveColumn: resolveColumn,
    _fieldMap: fieldMap,
};

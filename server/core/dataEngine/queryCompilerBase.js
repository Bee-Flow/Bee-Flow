// @typecheck
const { FILTER_OPS, SYSTEM_COLUMNS, KEY_RE } = require('./dataModel/vocabulary');

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
    /**
     * @param {string} message
     */
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
    /**
     * @param {string} [message]
     */
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
 * @param {{ rowsLocked?: boolean } | null | undefined} tableMeta
 * @param {{ allowLockedRows?: boolean }} [opts]
 */
function assertRowsWritable(tableMeta, opts) {
    if (!tableMeta || tableMeta.rowsLocked !== true) return;
    if (opts && opts.allowLockedRows === true) return;
    throw new RowsLockedError();
}

// ── Identifier quoting ──────────────────────────────────────────────
/**
 * @param {string} name
 */
function qi(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

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
/**
 * @param {string} v
 */
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

/**
 * A caller-supplied record id: a bounded, non-empty string, nothing else.
 * @param {unknown} id  validated here
 * @returns {string}
 */
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

function compileFilter(tableMeta, fm, filter, out, dialect) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new CompileError('filter must be an object');
    const col = resolveColumn(tableMeta, filter.field, fm);
    const op = filter.op;
    if (!FILTER_OPS.includes(op)) throw new CompileError(`unknown filter op: ${op}`);
    switch (op) {
        case 'eq': {
            // `ci: true` on a text match: equality without regard to case
            // (ILIKE/LIKE with no wildcard). Only for a string value.
            const ci = filter.ci === true && typeof filter.value === 'string';
            out.sql.push(ci ? `${col} ${dialect === 'pg' ? 'ILIKE' : 'LIKE'} ? ESCAPE '\\'` : `${col} = ?`);
            out.params.push(ci ? likeEscape(filter.value) : scalar(filter.value, dialect));
            break;
        }
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
            // A non-array is a MISTAKE, not "match nothing". Compiling a string value
            // to a literal FALSE silently would make a step
            // whose binding produced 'a,b' instead of ['a','b'] match zero
            // rows for ever and report success.
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
        /** @type {string[]} */
        const parts = [];
        for (const f of fields) {
            parts.push(`${resolveColumn(tableMeta, f, fm)} ${like} ? ESCAPE '\\'`);
            params.push('%' + likeEscape(value) + '%');
        }
        clauses.push(`(${parts.join(' OR ')})`);
    }
    return { where: 'WHERE ' + clauses.join(' AND '), params };
}

/**
 * The one place a page size is decided. Anything that is not a positive number
 * — '', -5, 'abc', NaN — becomes the default rather than travelling on: a route
 * that re-derived its own limit and then sliced by it returned `rows.slice(0,
 * -5)` (46 of 51 rows) while reporting hasMore, so the caller paged for ever.
 *
 * `max` lets a caller cap below MAX_RESULT_ROWS; it can never raise the ceiling.
 * @param {string | number} limit
 * @param {number} [max]
 */
function clampLimit(limit, max = MAX_RESULT_ROWS) {
    const ceiling = Math.min(Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_RESULT_ROWS, MAX_RESULT_ROWS);
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return Math.min(DEFAULT_LIMIT, ceiling);
    return Math.min(n, ceiling);
}

module.exports = { MAX_RESULT_ROWS, DEFAULT_LIMIT, MAX_KEY_INDEX_KEYS, MAX_GROUP_BY, MAX_AGGREGATES, ALIAS_RE, CompileError, RowsLockedError, assertRowsWritable, qi, assertTableMeta, fieldMap, resolveColumn, scalar, coerceValue, assertRecordId, assertAccessFilter, MATCH_MODES, buildWhere, clampLimit };

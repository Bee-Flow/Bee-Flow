// @typecheck strict
/**
 * The primitives every SQL compiler in this folder is built from: the limits,
 * the two error classes, identifier quoting, the closed field resolver, value
 * binding and the page-size rule. No SQL clause is assembled here.
 *
 * Moved out of queryCompilerBase.js unchanged so the concern modules (filter
 * tree, ordering, select list, aggregation) can sit on top of it without an
 * import cycle; queryCompilerBase.js re-exports all of it, so every existing
 * import keeps working.
 */
/** @typedef {import('./queryCompiler').TableMeta} TableMeta */
/** @typedef {import('./queryCompiler').AccessFilter} AccessFilter */
/** @typedef {import('./queryCompiler').CompilerField} CompilerField */
const { SYSTEM_COLUMNS, KEY_RE } = require('./dataModel/vocabulary');
const { MAX_FILTER_CLAUSES } = require('../../shared/expr/filterGroups.mjs');

// Hard ceiling on rows a single list/aggregate may return. The store applies
// its own MAX_RESULT_ROWS too; this keeps the SQL LIMIT sane and predictable.
const MAX_RESULT_ROWS = 1000;

const DEFAULT_LIMIT = 50;

// Key values a single compileKeyIndex lookup may carry. One sync writes at most
// MAX_CONNECTOR_ROWS (500) rows, and the caller chunks below this anyway; the
// cap is here so a bound variable list can never grow past SQLite's limit.
const MAX_KEY_INDEX_KEYS = 200;

const MAX_IN_VALUES = 200;

// Clauses per query, counted over the top level and every `any` group.
const MAX_FILTERS = MAX_FILTER_CLAUSES;

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

/**
 * @param {TableMeta} tableMeta
 */
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
/**
 * @param {TableMeta} tableMeta
 * @returns {Map<string, CompilerField>}
 */
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
 * @param {TableMeta} tableMeta
 * @param {unknown} fieldName  validated here
 * @param {Map<string, CompilerField>} [fm]
 * @returns {string}
 */
function resolveColumn(tableMeta, fieldName, fm) {
    if (typeof fieldName !== 'string' || !fieldName) throw new CompileError('field must be a non-empty string');
    if (SYSTEM_COLUMNS.includes(fieldName)) return qi(fieldName);
    const map = fm || fieldMap(tableMeta);
    if (!map.has(fieldName)) throw new CompileError(`unknown field: ${fieldName}`);
    const f = /** @type {CompilerField} */ (map.get(fieldName));
    if (f.type === 'computed' && !(f.computed && f.computed.stored === true)) {
        throw new CompileError(`field "${fieldName}" is a read-time computed field and cannot be queried`);
    }
    return qi(/** @type {string} */ (f.key));
}

/**
 * @param {unknown} v
 * @param {string} dialect
 * @returns {string | number | boolean | null}
 */
function scalar(v, dialect) {
    if (v === null || v === undefined) return null;
    // sqlite: 0/1, matching how coerceValue STORES a bool column — and because
    // better-sqlite3 refuses to bind a raw boolean at all, so every
    // `eq true/false` filter on a bool column was a 500 waiting to be clicked.
    // pg: booleans stay booleans (the column is BOOLEAN; 0/1 would not compare).
    if (typeof v === 'boolean') return dialect === 'pg' ? v : (v ? 1 : 0);
    if (typeof v === 'string' || typeof v === 'number') return v;
    throw new CompileError('filter value must be a string, number, boolean or null');
}

// Coerce a create/update value for a specific field. Booleans → 0/1 under
// sqlite (it has no bool) but stay true/false under pg (BOOLEAN column);
// multiselect/file → JSON text; other objects rejected (no silent JSON
// coercion into a text column).
/**
 * @param {unknown} v
 * @param {CompilerField} field
 * @param {string} dialect
 */
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

/**
 * @param {AccessFilter} accessFilter
 */
function assertAccessFilter(accessFilter) {
    if (!accessFilter || typeof accessFilter !== 'object'
        || typeof accessFilter.where !== 'string' || !accessFilter.where
        || !Array.isArray(accessFilter.params)) {
        throw new CompileError('accessFilter {where, params} is required — the query compiler cannot run unscoped');
    }
}

/**
 * The one place a page size is decided. Anything that is not a positive number
 * — '', -5, 'abc', NaN — becomes the default rather than travelling on: a route
 * that re-derived its own limit and then sliced by it returned `rows.slice(0,
 * -5)` (46 of 51 rows) while reporting hasMore, so the caller paged for ever.
 *
 * `max` lets a caller cap below MAX_RESULT_ROWS; it can never raise the ceiling.
 * @param {unknown} limit
 * @param {number} [max]
 */
function clampLimit(limit, max = MAX_RESULT_ROWS) {
    const ceiling = Math.min(Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_RESULT_ROWS, MAX_RESULT_ROWS);
    const n = parseInt(/** @type {string} */ (limit), 10);
    if (!Number.isFinite(n) || n <= 0) return Math.min(DEFAULT_LIMIT, ceiling);
    return Math.min(n, ceiling);
}

module.exports = {
    MAX_FILTERS, MAX_RESULT_ROWS, DEFAULT_LIMIT, MAX_KEY_INDEX_KEYS, MAX_IN_VALUES, MAX_GROUP_BY, MAX_AGGREGATES, ALIAS_RE,
    CompileError, RowsLockedError, assertRowsWritable, qi, assertTableMeta, fieldMap, resolveColumn, scalar, coerceValue,
    assertRecordId, assertAccessFilter, clampLimit,
};

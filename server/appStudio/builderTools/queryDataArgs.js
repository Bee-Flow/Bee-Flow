// @typecheck
/**
 * app_query_data — argument checking, row shaping and error mapping.
 *
 * Kept apart from dataTools.js (no dependency on it) so the rules a model
 * trips over are testable on their own: which arguments are refused, what a
 * page looks like, and which failures may be quoted back.
 */

'use strict';

const { FILTER_OPS, SYSTEM_COLUMNS } = require('../dataModel');
const queryCompiler = require('../queryCompiler');
const rlsGateway = require('../rlsGateway');
const log = require('../../telemetry/log');

// 200 since 2026-11 (was 20). The engine ceiling (MAX_RESULT_ROWS) is higher; this is the per-call page.
const MAX_QUERY_LIMIT = 200;
const DEFAULT_QUERY_LIMIT = 5;
// Internal ids the model has no use for (noise, and the org id is not its business).
const HIDDEN_COLUMNS = ['created_by', 'org_id'];
const SORT_DIRS = ['asc', 'desc'];

/**
 * @param {string} error
 * @param {string} [_fixHint]
 */
const bad = (error, _fixHint) => ({ error, _fixHint });

/**
 * Either the error pair (`error`, `_fixHint`) or the parsed fields; one object
 * type because the checker's null checks are off and cannot narrow a union.
 *
 * @typedef {{
 *   error?: string, _fixHint?: string, tableId?: string|null, datasetId?: string|null, limit?: number,
 *   limitClamped?: boolean, requestedLimit?: number, sort?: { field: string, dir: string }, orderBy?: unknown[], filter?: any[], match?: string, search?: { value: string, fields: any[] }, cursor?: string|null,
 *   total?: boolean,
 *   params?: Record<string, unknown>,
 *   expand?: unknown[], fields?: unknown[],
 * }} QueryArgs
 */

/** @param {unknown} v */
const given = (v) => v !== undefined && v !== null;

/**
 * The arguments' readers, in the order their refusals are checked. Each reads
 * its argument(s) from `a` into `out`, or answers the refusal.
 * @typedef {(a: Record<string, any>, out: QueryArgs) => QueryArgs | undefined} QueryArgReader
 */

/** @type {QueryArgReader} */
function readSource(a, out) {
    out.tableId = typeof a.tableId === 'string' && a.tableId ? a.tableId : null;
    out.datasetId = typeof a.datasetId === 'string' && a.datasetId ? a.datasetId : null;
    if (out.tableId && out.datasetId) {
        return bad('Pass either tableId or datasetId, not both.', 'tableId lists raw rows (filter/sort/paging); datasetId runs a saved aggregation.');
    }
    if (!out.tableId && !out.datasetId) {
        return bad('Pass tableId (raw rows) or datasetId (a saved aggregation).', 'Table ids are in the data model (app_get_data_model).');
    }
    return undefined;
}

/** A limit past the per-call page is clamped, and the answer says so. @type {QueryArgReader} */
function readLimit(a, out) {
    out.limit = DEFAULT_QUERY_LIMIT;
    out.limitClamped = false;
    out.requestedLimit = undefined;
    if (!given(a.limit)) return undefined;
    const n = Number(a.limit);
    if (!Number.isInteger(n) || n < 1) {
        return bad('limit must be a whole number of at least 1.', `Rows per call: 1-${MAX_QUERY_LIMIT} (default ${DEFAULT_QUERY_LIMIT}); page on with cursor.`);
    }
    out.limitClamped = n > MAX_QUERY_LIMIT;
    if (out.limitClamped) out.requestedLimit = n;
    out.limit = Math.min(n, MAX_QUERY_LIMIT);
    return undefined;
}

/** @type {QueryArgReader} */
function readSort(a, out) {
    out.sort = undefined;
    if (!given(a.sort)) return undefined;
    const dir = a.sort && typeof a.sort === 'object' ? (a.sort.dir ?? 'desc') : null;
    if (!a.sort || typeof a.sort !== 'object' || Array.isArray(a.sort) || typeof a.sort.field !== 'string' || !a.sort.field
        || typeof dir !== 'string' || !SORT_DIRS.includes(dir.toLowerCase())) {
        return bad('sort must be { field, dir } with dir "asc" or "desc".');
    }
    out.sort = { field: a.sort.field, dir: dir.toLowerCase() };
    return undefined;
}

/** @type {QueryArgReader} */
function readOrderBy(a, out) {
    if (!given(a.orderBy)) return undefined;
    if (!Array.isArray(a.orderBy) || !a.orderBy.length || out.sort) return bad('orderBy must be a list of { field, dir } entries, without sort.', 'Up to 3 columns; dir is "asc" or "desc".');
    out.orderBy = a.orderBy;
    return undefined;
}

/** @type {QueryArgReader} */
function readFilter(a, out) {
    out.filter = undefined;
    if (!given(a.filter)) return undefined;
    if (!Array.isArray(a.filter)) return bad('filter must be an array of { field, op, value? }.', `ops: ${FILTER_OPS.join(', ')}.`);
    out.filter = a.filter;
    return undefined;
}

/** @type {QueryArgReader} */
function readMatch(a, out) {
    if (!given(a.match)) return undefined;
    if (a.match !== 'all' && a.match !== 'any') return bad('match must be "all" or "any".', '"any" returns a row when ONE of the filters matches; "all" (the default) needs every one.');
    out.match = a.match;
    return undefined;
}

/** @type {QueryArgReader} */
function readSearch(a, out) {
    if (!given(a.search)) return undefined;
    const s = a.search;
    if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.value !== 'string' || !s.value || !Array.isArray(s.fields) || !s.fields.length) {
        return bad('search must be { value: <text>, fields: [<field keys>] }.', 'It finds rows where ANY of the fields contains the text; it ANDs with filter.');
    }
    out.search = { value: s.value, fields: s.fields };
    return undefined;
}

/** @type {QueryArgReader} */
function readPaging(a) {
    if (given(a.cursor) && typeof a.cursor !== 'string') {
        return bad('cursor must be the nextCursor string of the previous call.');
    }
    if (given(a.total) && typeof a.total !== 'boolean') {
        return bad('total must be true or false.', 'total:true adds totalRows, the number of rows the whole read matches (tableId only).');
    }
    return undefined;
}

/** Read through a relation (tableId only); the compiler checks the entries against both tables. @type {QueryArgReader} */
function readThrough(a, out) {
    for (const name of /** @type {const} */ (['expand', 'fields'])) {
        if (!given(a[name])) continue;
        if (!Array.isArray(a[name]) || !a[name].length) {
            return bad(`${name} must be a non-empty list.`, name === 'expand' ? 'expand: [{ field: <relation field>, pick?: [<fields of the related table>], as? }].' : 'fields: the field keys to return.');
        }
        out[name] = a[name];
    }
    return undefined;
}

/** @type {QueryArgReader[]} */
const QUERY_ARG_READERS = [readSource, readLimit, readSort, readOrderBy, readFilter, readMatch, readSearch, readPaging, readThrough];

/**
 * Validate app_query_data arguments. Returns { error, _fixHint } or the parsed
 * { tableId, datasetId, limit, limitClamped, sort, filter, cursor }.
 *
 * @param {import('../builderTools').ToolArgs} args
 * @returns {QueryArgs}
 */
function parseQueryArgs(args) {
    const a = args && typeof args === 'object' ? args : {};
    /** @type {QueryArgs} */
    const o = {};
    for (const read of QUERY_ARG_READERS) {
        const refusal = read(a, o);
        if (refusal) return refusal;
    }
    return queryArgsResult(a, o);
}

/**
 * The parsed arguments, keys in the order callers have always received them.
 * @param {Record<string, any>} a @param {QueryArgs} o
 * @returns {QueryArgs}
 */
function queryArgsResult(a, o) {
    const params = a.params && typeof a.params === 'object' && !Array.isArray(a.params) ? a.params : undefined;
    const through = { ...(o.expand ? { expand: o.expand } : {}), ...(o.fields ? { fields: o.fields } : {}) };
    return {
        tableId: o.tableId, datasetId: o.datasetId, limit: o.limit, limitClamped: o.limitClamped, requestedLimit: o.requestedLimit, sort: o.sort,
        ...(o.orderBy ? { orderBy: o.orderBy } : {}), ...through, filter: o.filter,
        ...(o.match ? { match: o.match } : {}), ...(o.search ? { search: o.search } : {}), cursor: a.cursor || null,
        ...(a.total === true ? { total: true } : {}), ...(params ? { params } : {}),
    };
}

/** A row without the internal ids a model has no use for. */
function shapeRow(row) {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    for (const k of HIDDEN_COLUMNS) delete out[k];
    return out;
}

// What a table row may show: the table's declared fields plus these. An
// allow-list, so a column added to the physical table later does not leak.
const ROW_SYSTEM_KEYS = ['id', 'created_at', 'updated_at'];

/**
 * A table row reduced to the table's declared field keys and the safe system columns, plus the
 * keys the read's own expansions landed in (`expanded`: the related rows, already reduced to
 * what was picked).
 * @param {string[]} [expanded]
 */
function shapeTableRow(row, table, expanded = []) {
    if (!row || typeof row !== 'object') return row;
    const fields = table && Array.isArray(table.fields) ? table.fields : [];
    const allowed = new Set([...ROW_SYSTEM_KEYS, ...fields.map((f) => f && f.key).filter(Boolean), ...expanded]);
    return Object.fromEntries(Object.entries(row).filter(([k]) => allowed.has(k)));
}

// A saved dataset is an aggregation result: the page cursor is a plain row offset.
function encodeOffset(n) { return Buffer.from(JSON.stringify({ o: n }), 'utf8').toString('base64url'); }
/**
 * @param {import('buffer').WithImplicitCoercion<string>} cursor
 */
function decodeOffset(cursor) {
    if (!cursor) return 0;
    try {
        const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).o;
        return Number.isInteger(o) && o > 0 ? o : 0;
    } catch (_) { return 0; }
}

/**
 * One page of a dataset's rows.
 * @param {string | null | undefined} cursor
 * @param {number | undefined} limit
 */
function pageDatasetRows(rows, cursor, limit) {
    const start = decodeOffset(cursor);
    const page = rows.slice(start, start + limit).map(shapeRow);
    const more = start + limit < rows.length;
    return { rows: page, rowCount: page.length, totalRows: rows.length, ...(more ? { more: true, nextCursor: encodeOffset(start + limit) } : {}) };
}

/**
 * The paging/limit fields every successful answer carries.
 *
 * @param {{ more?: boolean, nextCursor?: string|null }} page
 * @param {{ limit?: number, limitClamped?: boolean, requestedLimit?: number }} parsed
 */
function pageMeta({ more, nextCursor }, { limit, limitClamped, requestedLimit }) {
    return {
        ...(more ? { more: true, nextCursor } : {}),
        ...(limitClamped ? { limitClamped: true, limit, requestedLimit } : {}),
    };
}

/**
 * Map a thrown read error to a tool error. Only messages written for a reader
 * are quoted (compiler complaints about the caller's own fields, access
 * refusals, `safe` read refusals); a database error names internal relations,
 * so it goes to the log and the model gets a generic sentence.
 *
 * @param {Error & { safe?: boolean }} e
 * @param {{ appId?: string, linked?: boolean }} [opts]
 */
function queryFailure(e, { appId, linked = false } = {}) {
    if (e instanceof queryCompiler.CompileError) {
        const hint = `filter is [{field, op, value?}] with ops ${FILTER_OPS.join(', ')}; `
            + `fields must exist on the table (or be system columns: ${SYSTEM_COLUMNS.join(', ')}).`;
        return bad(`Query failed: ${e.message}`, hint);
    }
    if (e instanceof rlsGateway.AccessError || (e && e.safe === true)) {
        return linked
            ? bad(
                `The linked Studio table could not be read: ${e.message}`,
                'This is an access or availability problem with the Studio table, not your arguments; bind the table anyway, the app reads it live.',
            )
            : { error: `Query failed: ${e.message}` };
    }
    log.warn('app_query_data failed', { appId: appId || null, linked, error: e && e.message ? e.message : String(e) });
    return { error: 'The query could not be run (details are in the server log).' };
}

module.exports = { parseQueryArgs, shapeRow, shapeTableRow, pageDatasetRows, pageMeta, queryFailure, MAX_QUERY_LIMIT };

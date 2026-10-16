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

const MAX_QUERY_LIMIT = 20;
const DEFAULT_QUERY_LIMIT = 5;
// Internal ids the model has no use for (noise, and the org id is not its business).
const HIDDEN_COLUMNS = ['created_by', 'org_id'];
const SORT_DIRS = ['asc', 'desc'];

const bad = (error, _fixHint) => ({ error, _fixHint });

/**
 * Validate app_query_data arguments. Returns { error, _fixHint } or the parsed
 * { tableId, datasetId, limit, limitClamped, sort, filter, cursor }.
 */
function parseQueryArgs(args) {
    const a = args && typeof args === 'object' ? args : {};
    const tableId = typeof a.tableId === 'string' && a.tableId ? a.tableId : null;
    const datasetId = typeof a.datasetId === 'string' && a.datasetId ? a.datasetId : null;
    if (tableId && datasetId) {
        return bad('Pass either tableId or datasetId, not both.', 'tableId lists raw rows (filter/sort/paging); datasetId runs a saved aggregation.');
    }
    if (!tableId && !datasetId) {
        return bad('Pass tableId (raw rows) or datasetId (a saved aggregation).', 'Table ids are in the data model (app_get_data_model).');
    }

    let limit = DEFAULT_QUERY_LIMIT;
    let limitClamped = false;
    if (a.limit !== undefined && a.limit !== null) {
        const n = Number(a.limit);
        if (!Number.isInteger(n) || n < 1) {
            return bad('limit must be a whole number of at least 1.', `Rows per call: 1-${MAX_QUERY_LIMIT} (default ${DEFAULT_QUERY_LIMIT}); page on with cursor.`);
        }
        limitClamped = n > MAX_QUERY_LIMIT;
        limit = Math.min(n, MAX_QUERY_LIMIT);
    }

    let sort;
    if (a.sort !== undefined && a.sort !== null) {
        const dir = a.sort && typeof a.sort === 'object' ? (a.sort.dir ?? 'desc') : null;
        if (!a.sort || typeof a.sort !== 'object' || Array.isArray(a.sort) || typeof a.sort.field !== 'string' || !a.sort.field
            || typeof dir !== 'string' || !SORT_DIRS.includes(dir.toLowerCase())) {
            return bad('sort must be { field, dir } with dir "asc" or "desc".');
        }
        sort = { field: a.sort.field, dir: dir.toLowerCase() };
    }

    let filter;
    if (a.filter !== undefined && a.filter !== null) {
        if (!Array.isArray(a.filter)) return bad('filter must be an array of { field, op, value? }.', `ops: ${FILTER_OPS.join(', ')}.`);
        filter = a.filter;
    }

    if (a.cursor !== undefined && a.cursor !== null && typeof a.cursor !== 'string') return bad('cursor must be the nextCursor string of the previous call.');
    return { tableId, datasetId, limit, limitClamped, sort, filter, cursor: a.cursor || null };
}

/** A row without the internal ids a model has no use for. */
function shapeRow(row) {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    for (const k of HIDDEN_COLUMNS) delete out[k];
    return out;
}

// A saved dataset is an aggregation result: the page cursor is a plain row offset.
function encodeOffset(n) { return Buffer.from(JSON.stringify({ o: n }), 'utf8').toString('base64url'); }
function decodeOffset(cursor) {
    if (!cursor) return 0;
    try {
        const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).o;
        return Number.isInteger(o) && o > 0 ? o : 0;
    } catch (_) { return 0; }
}

/** One page of a dataset's rows. */
function pageDatasetRows(rows, cursor, limit) {
    const start = decodeOffset(cursor);
    const page = rows.slice(start, start + limit).map(shapeRow);
    const more = start + limit < rows.length;
    return { rows: page, rowCount: page.length, totalRows: rows.length, ...(more ? { more: true, nextCursor: encodeOffset(start + limit) } : {}) };
}

/** The paging/limit fields every successful answer carries. */
function pageMeta({ more, nextCursor }, { limit, limitClamped }) {
    return {
        ...(more ? { more: true, nextCursor } : {}),
        ...(limitClamped ? { limitClamped: true, limit } : {}),
    };
}

/**
 * Map a thrown read error to a tool error. Only messages written for a reader
 * are quoted (compiler complaints about the caller's own fields, access
 * refusals, `safe` read refusals); a database error names internal relations,
 * so it goes to the log and the model gets a generic sentence.
 */
function queryFailure(e, { appId, linked = false } = {}) {
    if (e instanceof queryCompiler.CompileError) {
        return bad(`Query failed: ${e.message}`, `filter is [{field, op, value?}] with ops ${FILTER_OPS.join(', ')}; fields must exist on the table (or be system columns: ${SYSTEM_COLUMNS.join(', ')}).`);
    }
    if (e instanceof rlsGateway.AccessError || (e && e.safe === true)) {
        return linked
            ? bad(`The linked Studio table could not be read: ${e.message}`, 'This is an access or availability problem with the Studio table, not your arguments — bind the table anyway; the app reads it live.')
            : { error: `Query failed: ${e.message}` };
    }
    log.warn('app_query_data failed', { appId: appId || null, linked, error: e && e.message ? e.message : String(e) });
    return { error: 'The query could not be run (details are in the server log).' };
}

module.exports = { parseQueryArgs, shapeRow, pageDatasetRows, pageMeta, queryFailure, MAX_QUERY_LIMIT };

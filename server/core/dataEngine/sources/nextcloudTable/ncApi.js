/**
 * The Nextcloud Tables REST calls a mirror makes, bound to one authenticated
 * `fetch`.
 *
 * Thin on purpose: the prefix, the header set and the row-data wire shape are
 * the agent tools' own (integrations/nextcloudTablesTools.js), so the two
 * cannot drift into talking to two different APIs. What is NOT reused is the
 * tools' `handle()`: it folds every failure into `{ error: <sentence> }` for a
 * model to read, and drops the HTTP status on the way. A mirror needs the
 * status — 403 and 404 and 422 are three different things to do next — so
 * every call here throws a NextcloudSourceError carrying it instead.
 *
 * A table mirror and a VIEW mirror differ in exactly two paths: columns and
 * rows are read from `/views/{id}/…` and a row is created through
 * `/views/{id}/rows`. Updating and deleting a row is by row id either way.
 */

'use strict';

const { TABLES_API, HEADERS, toWireData, readJsonSafe, describeColumn, mapTable } = require('../../../../integrations/nextcloudTablesTools');
const { fromNcResponse } = require('./errors');

// The API's own page ceiling (the agent tool caps at the same number).
const PAGE = 500;

function enc(v) { return encodeURIComponent(String(v)); }

/** `{tableId}` or `{viewId}` → the collection prefix rows/columns live under. */
function nodePath(ref) {
    if (ref && ref.viewId) return `/views/${enc(ref.viewId)}`;
    if (ref && ref.tableId) return `/tables/${enc(ref.tableId)}`;
    throw new Error('ncApi: a tableId or a viewId is required');
}

/**
 * @param {{ baseUrl:string, fetch:Function, authError?:string }} auth
 *   what nextcloudClient.resolveAuth answered for the linker
 */
function forLinker(auth) {
    if (!auth || !auth.baseUrl || typeof auth.fetch !== 'function') {
        throw new Error('ncApi.forLinker needs a resolved Nextcloud auth ({baseUrl, fetch})');
    }
    const api = `${auth.baseUrl}${TABLES_API}`;

    async function call(method, path, { body, what, ncTableId } = {}) {
        let res;
        try {
            res = await auth.fetch(`${api}${path}`, {
                method, headers: HEADERS, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            });
        } catch (e) {
            // A network failure has no status; fromNcResponse reads "no answer".
            throw fromNcResponse(0, e && e.message, what, { ncTableId });
        }
        const parsed = await readJsonSafe(res);
        if (!res.ok) {
            const message = typeof parsed === 'string' ? parsed : (parsed?.message || parsed?.ocs?.meta?.message || '');
            throw fromNcResponse(res.status, message, what, { ncTableId });
        }
        // A misrouted call can still come back inside an OCS envelope.
        return parsed && typeof parsed === 'object' && parsed.ocs ? parsed.ocs.data : parsed;
    }

    return {
        /** Every table the linker can see — the API includes each table's views. */
        async listTables() {
            const data = await call('GET', '/tables', { what: 'table list' });
            return Array.isArray(data) ? data : [];
        },
        async getTable(tableId) {
            return call('GET', `/tables/${enc(tableId)}`, { what: `table ${tableId}`, ncTableId: tableId });
        },
        async getView(viewId) {
            return call('GET', `/views/${enc(viewId)}`, { what: `view ${viewId}` });
        },
        /** Full column objects (describeColumn), in the table's own order. */
        async getColumns(ref) {
            const data = await call('GET', `${nodePath(ref)}/columns`, { what: 'column list', ncTableId: ref.tableId || null });
            const cols = (Array.isArray(data) ? data : []).map(describeColumn);
            cols.sort((a, b) => (a.orderWeight - b.orderWeight) || (a.id - b.id));
            return cols;
        },
        /** One page of raw rows (`{id, data:[{columnId, value}], …}`). */
        async listRows(ref, { limit = PAGE, offset = 0 } = {}) {
            const params = new URLSearchParams({ limit: String(Math.min(PAGE, Math.max(1, limit))), offset: String(Math.max(0, offset)) });
            const data = await call('GET', `${nodePath(ref)}/rows?${params}`, { what: 'row list', ncTableId: ref.tableId || null });
            return Array.isArray(data) ? data : [];
        },
        async getRow(rowId) {
            return call('GET', `/rows/${enc(rowId)}`, { what: `row ${rowId}` });
        },
        /** `pairs` is the [{columnId, value}] list; shaped at the wire like the tools do. */
        async createRow(ref, pairs) {
            return call('POST', `${nodePath(ref)}/rows`, { body: { data: toWireData(pairs) }, what: 'row', ncTableId: ref.tableId || null });
        },
        async updateRow(rowId, pairs) {
            return call('PUT', `/rows/${enc(rowId)}`, { body: { data: toWireData(pairs) }, what: `row ${rowId}` });
        },
        async deleteRow(rowId) {
            return call('DELETE', `/rows/${enc(rowId)}`, { what: `row ${rowId}` });
        },
    };
}

module.exports = { forLinker, mapTable, PAGE };

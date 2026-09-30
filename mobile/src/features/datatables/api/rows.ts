/**
 * The rows of a table (routes/datatables/rows.js): a page, an insert, an edit,
 * a delete, a selection deleted at once, a whole file imported, the whole
 * table exported.
 *
 * `filters`, `match`, `sort`, `dir` and `q` are a CLOSED DESCRIPTOR: the
 * server resolves every key against the table's own columns and ANDs the
 * access predicate in regardless. The list query is `.strict()`, so only
 * those and `limit`/`cursor` are ever sent. `cursor` is the keyset token the
 * previous page returned — not an offset, which both skips and repeats rows
 * on a table two routines are writing to.
 */

import { api, type QueryParams } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';

import { tablePath } from './endpoints';
import { readBulkDelete, readBulkImport, readInsertedId, readRowEnvelope, readRowsPage } from './readers';
import { EXPIRING_COUNT_LIMIT } from '../model/retention';
import type { BulkImportResult, RowQuery, RowsPage, TableRow } from '../model/types';

/** The web's page size; the server caps a page at 500. */
export const PAGE_SIZE = 50;
/** The server's cap on one bulk delete (413 `too_many_ids` above it). */
export const BULK_DELETE_MAX = 200;
/** The server's cap on one import (413 `too_many_rows` above it). */
export const BULK_IMPORT_MAX = 5000;

const rowsPath = (id: string) => `${tablePath(id)}/rows`;
const rowPath = (id: string, rowId: string) => `${rowsPath(id)}/${encodeURIComponent(rowId)}`;

/** Only what narrows the question goes on the wire: an empty filter list is no `filters`. */
export function rowsQuery(query: RowQuery, cursor: string | null): QueryParams {
    return {
        limit: PAGE_SIZE,
        cursor: cursor ?? undefined,
        filters: query.filters.length ? JSON.stringify(query.filters) : undefined,
        match: query.filters.length > 1 ? query.match : undefined,
        sort: query.sort?.field,
        dir: query.sort?.dir,
        q: query.q.trim() || undefined,
    };
}

export async function listRows(
    id: string,
    query: RowQuery,
    cursor: string | null,
    signal?: AbortSignal,
): Promise<RowsPage> {
    return readRowsPage(await api.get<unknown>(rowsPath(id), { signal, query: rowsQuery(query, cursor) }));
}

/**
 * How many rows expire soon: ONE page of rows whose retention date is at or
 * before `cutoffIso`, COUNTED. The page's `total` is the table's row count,
 * filtered or not, so reading it would report the whole table as expiring;
 * `more` says the page was full and the count is a floor.
 */
export async function countExpiringRows(
    id: string,
    field: string,
    cutoffIso: string,
    signal?: AbortSignal,
): Promise<{ count: number; more: boolean }> {
    const filters = JSON.stringify([{ field, op: 'lte', value: cutoffIso }]);
    const page = readRowsPage(await api.get<unknown>(rowsPath(id), { signal, query: { limit: EXPIRING_COUNT_LIMIT, filters } }));
    return { count: page.rows.length, more: page.hasMore };
}

/** `values` is required; the answer carries the id the server minted. */
export async function addRow(id: string, values: Record<string, unknown>): Promise<string | null> {
    return readInsertedId(await api.post<unknown>(rowsPath(id), { values }));
}

/**
 * `expectedUpdatedAt` is the `updated_at` the row was READ with, and it is
 * required: a stale one comes back 409 `row_conflict` carrying the row as it
 * now is, rather than one colleague silently overwriting another.
 */
export async function updateRow(
    id: string,
    row: TableRow,
    values: Record<string, unknown>,
): Promise<TableRow | null> {
    const expectedUpdatedAt = String(row.updated_at ?? '');
    return readRowEnvelope(await api.put<unknown>(rowPath(id, row.id), { values, expectedUpdatedAt }));
}

export async function deleteRow(id: string, rowId: string): Promise<void> {
    await api.delete(rowPath(id, rowId));
}

/** One transaction; `deleted` may be fewer than asked (a row already gone, or not yours to see). */
export async function deleteRows(id: string, ids: string[]): Promise<{ deleted: number; requested: number }> {
    return readBulkDelete(await api.post<unknown>(`${rowsPath(id)}/bulk-delete`, { ids }));
}

/**
 * A whole file in ONE request: every row is checked before anything is
 * written, and a bad row comes back with its line rather than failing the
 * file. A file where nothing could be written answers 422 with the same body,
 * which the caller reads off the error.
 */
export async function importRows(id: string, rows: Record<string, unknown>[]): Promise<BulkImportResult> {
    return readBulkImport(await api.post<unknown>(`${rowsPath(id)}/bulk`, { rows }, { retry: false, timeoutMs: 120_000 }));
}

/**
 * The whole table as CSV, handed to the share sheet. Fetched through the
 * session (never a link a browser opens without the cookie) and streamed by
 * the server by keyset page, under the same access filter as a read.
 */
export async function exportRows(id: string, tableKey: string): Promise<void> {
    await shareServerFile(`${rowsPath(id)}.csv`, `${tableKey || 'datatable'}.csv`, 'text/csv');
}

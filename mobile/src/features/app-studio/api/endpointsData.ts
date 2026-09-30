/**
 * An app's data, as its runtime reads and writes it (server/routes/
 * studioAppData.js). Every read and write is RLS-scoped to the VIEWER on the
 * server; nothing here decides access. The runtime calls dataBatch and
 * dataQuery directly; the record CRUD also backs the hooks.
 */

import { api } from '@/core/api/client';

import { appPath, expectedRefusal } from './paths';
import {
    readBatch,
    readOneRecord,
    readQuery,
    readRecordPage,
    readRecordWrite,
    readTables,
} from './readersData';
import type {
    BatchRead,
    BatchResult,
    DataRecord,
    DataTable,
    QueryResult,
    RecordPage,
    RecordsQuery,
    RecordUpdateResult,
    RecordWrite,
} from '../model/runtimeTypes';

const tablePath = (appId: string, tableId: string) =>
    `${appPath(appId)}/data/tables/${encodeURIComponent(tableId)}`;
const recordPath = (appId: string, tableId: string, recordId: string) =>
    `${tablePath(appId, tableId)}/records/${encodeURIComponent(recordId)}`;

/** Statuses that mean "this server has no batch route", not "this failed". */
const NOT_BATCHED = [404, 405, 501];

/**
 * Many reads in one request. Each read answers for itself (`ok`, `status`),
 * so one bad binding never blanks the screen. `supported: false` means the
 * route is not there — replay the reads one by one; it is never "no data".
 */
export async function dataBatch(appId: string, reads: BatchRead[], signal?: AbortSignal): Promise<BatchResult> {
    try {
        // A read, so retrying is safe; the route reads nothing it would write twice.
        return readBatch(await api.post<unknown>(`${appPath(appId)}/data/batch`, { reads }, { signal, retry: {} }));
    } catch (err) {
        expectedRefusal(err, NOT_BATCHED);
        return { supported: false };
    }
}

/**
 * A saved dataset (`{ datasetId }`) or an inline aggregate descriptor
 * (`{ tableId, aggregate }`). `refresh` bypasses the dataset cache.
 */
export async function dataQuery(
    appId: string,
    body: Record<string, unknown>,
    opts: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<QueryResult> {
    const res = await api.post<unknown>(`${appPath(appId)}/data/query`, body, {
        signal: opts.signal,
        query: opts.refresh ? { refresh: 1 } : undefined,
        retry: {},
    });
    return readQuery(res);
}

/** Tables the viewer may read, fields only (never the access rules). */
export async function listTables(appId: string, signal?: AbortSignal): Promise<DataTable[]> {
    return readTables(await api.get<unknown>(`${appPath(appId)}/data/tables`, { signal }));
}

function recordsQueryParams(query: RecordsQuery) {
    return {
        filter: query.filter === undefined ? undefined : JSON.stringify(query.filter),
        sort: query.sort === undefined ? undefined : JSON.stringify(query.sort),
        cursor: query.cursor,
        limit: query.limit,
        sample: query.sample ? 1 : undefined,
    };
}

/** One keyset page; pass `nextCursor` back as `cursor` for the next. */
export async function listRecords(
    appId: string,
    tableId: string,
    query: RecordsQuery = {},
    signal?: AbortSignal,
): Promise<RecordPage> {
    const res = await api.get<unknown>(`${tablePath(appId, tableId)}/records`, {
        signal,
        query: recordsQueryParams(query),
    });
    return readRecordPage(res);
}

/** One record; null when it is hidden from this viewer or gone (the uniform 404). */
export async function getRecord(
    appId: string,
    tableId: string,
    recordId: string,
    signal?: AbortSignal,
): Promise<DataRecord | null> {
    try {
        return readOneRecord(await api.get<unknown>(recordPath(appId, tableId, recordId), { signal }));
    } catch (err) {
        expectedRefusal(err, [404]);
        return null;
    }
}

/**
 * Create a row. `created_by` is the session; system columns in `values` are
 * dropped by the server's compiler. 409 `quota_exceeded` throws.
 */
export async function createRecord(appId: string, tableId: string, values: DataRecord): Promise<RecordWrite> {
    return readRecordWrite(await api.post<unknown>(`${tablePath(appId, tableId)}/records`, { values }));
}

/**
 * Update a row. With `expectedUpdatedAt` the write is conditional, and a 409
 * `record_conflict` is returned as `outcome: 'conflict'` with the row as it
 * now stands. A 404 (gone or out of scope) throws.
 */
export async function updateRecord(
    appId: string,
    tableId: string,
    recordId: string,
    change: { values: DataRecord; expectedUpdatedAt?: string },
): Promise<RecordUpdateResult> {
    try {
        const res = await api.patch<unknown>(recordPath(appId, tableId, recordId), change);
        return { outcome: 'saved', record: readRecordWrite(res).record };
    } catch (err) {
        const refusal = expectedRefusal(err, [409]);
        const conflict = readRecordWrite(refusal.body);
        // A 409 without a row is a quota refusal, not a conflict: rethrow it.
        if (!conflict.record) throw err;
        return { outcome: 'conflict', record: conflict.record };
    }
}

export async function deleteRecord(appId: string, tableId: string, recordId: string): Promise<void> {
    await api.delete<unknown>(recordPath(appId, tableId, recordId));
}

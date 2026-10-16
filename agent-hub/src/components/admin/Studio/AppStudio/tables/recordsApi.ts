import { createJsonResource } from '../../../../../api/client';
import type { JsonResourceError, JsonResourceInit } from '../../../../../api/client';
import { API_BASE } from '../../../../../utils/helpers';

/**
 * App Studio — record CRUD for the owner's row editor.
 *
 * The SAME endpoints the runtime reads through (runtime/useAppDataSource.js →
 * GET .../data/tables/:tableId/records) plus their write siblings, documented
 * in server/routes/studioAppData.js:
 *   GET    /:appId/data/tables/:tableId/records?limit&cursor
 *   POST   /:appId/data/tables/:tableId/records            { values }
 *   PATCH  /:appId/data/tables/:tableId/records/:recordId  { values }
 *   DELETE /:appId/data/tables/:tableId/records/:recordId
 *
 * Every write is rate limited per viewer and app (20 a minute by default), so a
 * 429 is an ordinary outcome of adding many rows at once, not a failure: its
 * Retry-After is carried on the error as `.retryAfter` seconds. Non-2xx always
 * throws an Error holding the SERVER's own sentence (body.error) — that text is
 * written for the person reading it, so callers show it instead of inventing one.
 */

/** One row of a saved table, as the record endpoints return it. */
export interface RowRecord {
    id: string;
    updated_at?: string | null;
    [key: string]: unknown;
}

const enc = encodeURIComponent;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// The server caps a list at 1000 rows (queryCompiler.MAX_RESULT_ROWS) and pages
// the rest behind nextCursor.
export const PAGE_SIZE = 100;

function recordsUrl(appId: string, tableId: string) {
    return `${API_BASE}/api/studio-apps/${enc(appId)}/data/tables/${enc(tableId)}/records`;
}

// The caller sets its own headers. A 429 carries Retry-After (seconds) as
// `err.retryAfter`; an empty 2xx body reads as {}.
const resource = createJsonResource('', {
    contentType: 'none',
    decorate: (err: JsonResourceError, _body: Record<string, unknown> | null, res: Response) => {
        const header = typeof res.headers?.get === 'function' ? res.headers.get('Retry-After') : null;
        const seconds = Number(header);
        err.retryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    },
});
const request = async (url: string, options: JsonResourceInit = {}) => (await resource(url, options)) || {};

export async function listRecords(appId: string, tableId: string, { limit = PAGE_SIZE, cursor = null }: { limit?: number; cursor?: string | null } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    const body = await request(`${recordsUrl(appId, tableId)}?${params.toString()}`);
    return {
        records: Array.isArray(body.records) ? body.records : [],
        nextCursor: body.nextCursor || null,
    };
}

/** Returns the created row as the server stored it ({ id, record }). */
export function createRecord(appId: string, tableId: string, values: Record<string, unknown>) {
    return request(recordsUrl(appId, tableId), {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ values }),
    });
}

/**
 * Returns the row after the change ({ record }) — computed columns included.
 *
 * Pass `expectedUpdatedAt` (the updated_at of the row you edited) for a
 * compare-and-set: if someone else wrote the row in the meantime the server
 * answers 409 with `code:'record_conflict'` and the CURRENT row on
 * `err.body.record`, instead of silently overwriting their change. Omit it and
 * the write stays last-write-wins, as before.
 */
export function updateRecord(appId: string, tableId: string, recordId: string, values: Record<string, unknown>, { expectedUpdatedAt = null }: { expectedUpdatedAt?: string | null } = {}) {
    const payload = expectedUpdatedAt ? { values, expectedUpdatedAt } : { values };
    return request(`${recordsUrl(appId, tableId)}/${enc(recordId)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
    });
}

export function deleteRecord(appId: string, tableId: string, recordId: string) {
    return request(`${recordsUrl(appId, tableId)}/${enc(recordId)}`, { method: 'DELETE' });
}

export default { listRecords, createRecord, updateRecord, deleteRecord, PAGE_SIZE };

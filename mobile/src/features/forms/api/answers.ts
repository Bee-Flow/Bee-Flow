/**
 * A form's answers, read from its answers table (routes/datatables/*). Every
 * read is gated by the table's grade ladder — the same ladder that gates its
 * rows — so sharing the table IS sharing the dashboard: a colleague who may
 * read the table gets these, anyone else a 403.
 */

import { api } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';

import { readAnswerRowResponse, readAnswerRows, readAnswersSummary } from './answerReaders';
import type { AnswerRow, AnswerRowsPage, AnswersSummary } from '../model/answerTypes';

const tablePath = (datatableId: string) => `/api/datatables/${encodeURIComponent(datatableId)}`;

/**
 * The whole dashboard in one answer: totals, the timeline, one breakdown per
 * question, the recent responses. `from`/`to` are calendar days; both absent
 * is "all time" — the server then defaults to the last 30 days only for the
 * timeline's own bucket.
 */
export async function getAnswersSummary(
    datatableId: string,
    range: { from: string | null; to: string | null },
    signal?: AbortSignal,
): Promise<AnswersSummary> {
    const query = { ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) };
    return readAnswersSummary(await api.get<unknown>(`${tablePath(datatableId)}/answers/summary`, { signal, query }));
}

export const ANSWER_PAGE = 25;

/**
 * The responses, newest first, one page at a time. `focus` narrows to the
 * rows that answered one question (the dashboard's "See all answers").
 */
export async function listAnswerRows(
    datatableId: string,
    opts: { focus?: string | null; cursor?: string | null; signal?: AbortSignal } = {},
): Promise<AnswerRowsPage> {
    const query: Record<string, string | number> = { sort: 'created_at', dir: 'desc', limit: ANSWER_PAGE };
    if (opts.focus) query.filters = JSON.stringify([{ field: opts.focus, op: 'isNotNull' }]);
    if (opts.cursor) query.cursor = opts.cursor;
    return readAnswerRows(await api.get<unknown>(`${tablePath(datatableId)}/rows`, { signal: opts.signal, query }));
}

/** One response, every column (the summary carries a preview only). */
export async function getAnswerRow(datatableId: string, rowId: string, signal?: AbortSignal): Promise<AnswerRow | null> {
    return readAnswerRowResponse(await api.get<unknown>(`${tablePath(datatableId)}/rows/${encodeURIComponent(rowId)}`, { signal }));
}

/** Every response as CSV, handed to the share sheet ("save to Drive", "send"). */
export async function exportAnswersCsv(datatableId: string, tableName: string): Promise<void> {
    const name = `${(tableName || 'answers').replace(/[^\w.-]+/g, '_')}.csv`;
    await shareServerFile(`${tablePath(datatableId)}/rows.csv`, name, 'text/csv');
}

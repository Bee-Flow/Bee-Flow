// The memory panel's reads: one page of the list (filtered and paged on the server)
// and the counts. The panel keeps its rows in the cache of the first page, so an edit
// shows at once and a refusal puts the rows back.

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiFetch } from '../typedRequest';
import { READ_ONCE } from './readOnce';

const PAGE_SIZE = 50;

/** What the panel filters on; the strings are the panel's own (view, scope, type and sort names). */
export interface MemoryListFilter {
    view: string;
    scope: string;
    projectId?: string;
    search: string;
    type: string;
    sort: string;
}

export class MemoryHttpError extends Error {
    status: number;
    /** The server's machine-readable reason (`sensitive_identifier`, `memory_unreadable`, ...), when it sent one. */
    code: string | null;
    constructor(status: number, code: string | null = null) {
        super(`HTTP ${status}`);
        this.status = status;
        this.code = code;
    }
}

/** The Response of a 2xx; anything else is a MemoryHttpError with the server's code. */
export async function memoryRequest(pending: Promise<Response>): Promise<Response> {
    const res = await pending;
    if (!res.ok) {
        const body = (await res.json?.().catch(() => null)) as { code?: unknown } | null;
        throw new MemoryHttpError(res.status, typeof body?.code === 'string' ? body.code : null);
    }
    return res;
}

function fetchList(q: MemoryListFilter, offset: number): Promise<Response> {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    if (q.view === 'review') return apiFetch('GET /agents/memory/review', { query: params });
    params.set('scope', q.scope);
    if (q.projectId && (q.scope === 'project' || q.scope === 'all')) params.set('projectId', q.projectId);
    if (q.search) params.set('search', q.search);
    if (q.type !== 'all') params.set('type', q.type);
    params.set('status', q.view === 'archived' ? 'archived' : 'active');
    params.set('sort', q.sort);
    return apiFetch('GET /agents/memory', { query: params });
}

/** The rows the panel holds for one filter and how many the server has. */
export interface MemoryRows<Row> { items: Row[]; total: number }

interface ListResponse<Row> { items?: Row[]; memories?: Row[]; total?: number }

/** One page from `offset`: its rows, and the server's total when it sent one. */
export async function readMemoryPage<Row>(filter: MemoryListFilter, offset: number): Promise<{ items: Row[]; total: number | null }> {
    const res = await memoryRequest(fetchList(filter, offset));
    const data = (await res.json()) as ListResponse<Row>;
    return { items: data.items ?? data.memories ?? [], total: typeof data.total === 'number' ? data.total : null };
}

/** The cache key of one filter's rows, for the panel that edits them in place. */
export const memoryListKey = (f: MemoryListFilter) => ['memory', 'list', f.view, f.scope, f.projectId ?? null, f.search, f.type, f.sort] as const;

/**
 * The first page of one filter, asked again whenever the filter changes or the panel
 * reloads; a refusal errors with a MemoryHttpError and is not retried. While another
 * filter loads, the rows of the previous one stay as they were.
 */
export function useMemoryFirstPageQuery<Row>(filter: MemoryListFilter) {
    return useQuery<MemoryRows<Row>, Error>({
        queryKey: memoryListKey(filter),
        queryFn: async () => {
            const page = await readMemoryPage<Row>(filter, 0);
            return { items: page.items, total: page.total ?? page.items.length };
        },
        ...READ_ONCE,
        gcTime: 0,
        placeholderData: keepPreviousData,
    });
}

/** GET /agents/memory/stats: the per-type counts, the pending-review count and the last update. */
export function useMemoryCountsQuery<Stats>(enabled: boolean) {
    return useQuery<Stats, Error>({
        queryKey: ['memory', 'counts'],
        queryFn: async () => (await memoryRequest(apiFetch('GET /agents/memory/stats'))).json() as Promise<Stats>,
        enabled,
        ...READ_ONCE,
        gcTime: 0,
    });
}

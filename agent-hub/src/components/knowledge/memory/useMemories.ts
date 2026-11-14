/**
 * Data for the memory panel: the list (paged, filtered on the server), the
 * stats, and every mutation. Each mutation updates the list first and rolls
 * back when the server refuses, so a row never sits in the wrong state.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    MemoryHttpError, memoryListKey, memoryRequest, readMemoryPage, useMemoryCountsQuery, useMemoryFirstPageQuery,
    type MemoryListFilter, type MemoryRows,
} from '@/api/queries/memoryList';
import { apiFetch } from '@/api/typedRequest';
import type {
    Memory, MemorySort, MemoryScope, MemoryStats, MemoryType, MemoryView,
} from './memoryTypes';

export interface MemoryQuery {
    view: MemoryView;
    scope: MemoryScope;
    projectId?: string;
    search: string;
    type: MemoryType | 'all';
    sort: MemorySort;
}

/** What a write that can be refused for a reason the person should read comes back with. */
export type WriteResult = { ok: true } | { ok: false; status: number | null; code: string | null };

const failure = (err: unknown): WriteResult => (err instanceof MemoryHttpError
    ? { ok: false, status: err.status, code: err.code }
    : { ok: false, status: null, code: null });

const request = memoryRequest;

/** A JSON body as the panel builds it (wider than the routes' schema types). */
const jsonInit = (body: unknown) => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

function loadErrorKind(status: number | null): 'forbidden' | 'failed' {
    return status === 403 ? 'forbidden' : 'failed';
}

export interface MemoriesState {
    items: Memory[];
    total: number;
    loading: boolean;
    loadingMore: boolean;
    error: 'forbidden' | 'failed' | null;
    hasMore: boolean;
    reload: () => void;
    loadMore: () => void;
    update: (id: string, patch: { content?: string; type?: MemoryType; importance?: number }) => Promise<WriteResult>;
    remove: (id: string) => Promise<boolean>;
    bulkRemove: (ids: string[]) => Promise<boolean>;
    bulkType: (ids: string[], type: MemoryType) => Promise<boolean>;
    restore: (id: string) => Promise<boolean>;
    approve: (id: string) => Promise<boolean>;
    reject: (id: string) => Promise<boolean>;
    create: (input: { content: string; type: MemoryType; projectId?: string }) => Promise<WriteResult>;
    clearAll: (projectId?: string) => Promise<boolean>;
}

type Rows = MemoryRows<Memory>;
const NO_ROWS: Rows = { items: [], total: 0 };
const statusOf = (err: unknown): number | null => (err instanceof MemoryHttpError ? err.status : null);

/** What loading further pages is doing, for the filter it was started on. */
interface MoreState { key: string; loading: boolean; error: 'forbidden' | 'failed' | null }

export function useMemories(query: MemoryQuery, onChanged?: () => void): MemoriesState {
    const queryClient = useQueryClient();
    const onChangedRef = useRef(onChanged);
    useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);
    const { view, scope, projectId, search, type, sort } = query;
    const filter = useMemo<MemoryListFilter>(() => ({ view, scope, projectId, search, type, sort }), [view, scope, projectId, search, type, sort]);
    const listKey = useMemo(() => memoryListKey(filter), [filter]);
    const keyText = listKey.join('\n');
    const first = useMemoryFirstPageQuery<Memory>(filter);
    const { refetch } = first;
    // Loading more belongs to one filter: another filter starts without it.
    const [moreState, setMore] = useState<MoreState>({ key: keyText, loading: false, error: null });
    const more = moreState.key === keyText ? moreState : { key: keyText, loading: false, error: null };
    const seq = useRef(0);

    // Access gone: the stale rows are dropped so no action lingers behind the error.
    const forbidden = statusOf(first.error) === 403;
    const shown = forbidden ? NO_ROWS : first.data ?? NO_ROWS;
    const firstError = first.isError && !first.isFetching ? loadErrorKind(statusOf(first.error)) : null;

    /** The rows held for this filter right now (not the ones of the last render). */
    const held = useCallback((): Rows => {
        const state = queryClient.getQueryState<Rows>(listKey);
        return statusOf(state?.error) === 403 ? NO_ROWS : state?.data ?? NO_ROWS;
    }, [queryClient, listKey]);
    const commit = useCallback((next: Memory[], nextTotal: number) => {
        queryClient.setQueryData<Rows>(listKey, { items: next, total: nextTotal });
    }, [queryClient, listKey]);

    const reload = useCallback(() => {
        seq.current += 1;
        // A sticky error would hide every later successful fetch.
        setMore({ key: keyText, loading: false, error: null });
        void refetch();
    }, [refetch, keyText]);

    const loadMore = useCallback(() => {
        const before = held();
        if (before.items.length >= before.total) return;
        const mine = ++seq.current;
        setMore({ key: keyText, loading: true, error: null });
        void (async () => {
            try {
                const page = await readMemoryPage<Memory>(filter, before.items.length);
                if (mine !== seq.current) return;
                const nextItems = [...held().items, ...page.items];
                commit(nextItems, page.total ?? nextItems.length);
                setMore({ key: keyText, loading: false, error: null });
            } catch (err) {
                if (mine === seq.current) setMore({ key: keyText, loading: false, error: loadErrorKind(statusOf(err)) });
            }
        })();
    }, [held, commit, filter, keyText]);

    /** Run `apply` on the list now; `call` on the server; undo on failure. */
    const optimistic = useCallback(async (
        apply: (list: Memory[]) => Memory[],
        call: () => Promise<Response>,
        { totalDelta = 0, keepServerRow = false }: { totalDelta?: number; keepServerRow?: boolean } = {},
        onFail?: (err: unknown) => void,
    ): Promise<boolean> => {
        const before = held();
        commit(apply(before.items), Math.max(0, before.total + totalDelta));
        try {
            const res = await call();
            if (keepServerRow) {
                const body = (await res.json().catch(() => null)) as { memory?: Memory } | null;
                const fresh = body?.memory;
                const now = held();
                if (fresh) commit(now.items.map((m) => (m.id === fresh.id ? { ...m, ...fresh } : m)), now.total);
            }
            onChangedRef.current?.();
            return true;
        } catch (err) {
            commit(before.items, before.total);
            onFail?.(err);
            return false;
        }
    }, [commit, held]);

    const update: MemoriesState['update'] = useCallback(async (id, patch) => {
        let failed: WriteResult = { ok: false, status: null, code: null };
        const ok = await optimistic(
            (list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)),
            () => request(apiFetch('PUT /agents/memory/{id}', { params: { id }, init: jsonInit(patch) })),
            { keepServerRow: true },
            (err) => { failed = failure(err); },
        );
        return ok ? { ok: true } : failed;
    }, [optimistic]);

    const remove: MemoriesState['remove'] = useCallback((id) => optimistic(
        (list) => list.filter((m) => m.id !== id),
        () => request(apiFetch('DELETE /agents/memory/{id}', { params: { id } })),
        { totalDelta: -1 },
    ), [optimistic]);

    const bulkRemove: MemoriesState['bulkRemove'] = useCallback((ids) => {
        const gone = new Set(ids);
        return optimistic(
            (list) => list.filter((m) => !gone.has(m.id)),
            () => request(apiFetch('POST /agents/memory/bulk-delete', { init: jsonInit({ ids }) })),
            { totalDelta: -ids.length },
        );
    }, [optimistic]);

    const bulkType: MemoriesState['bulkType'] = useCallback((ids, nextType) => {
        const picked = new Set(ids);
        return optimistic(
            (list) => list.map((m) => (picked.has(m.id) ? { ...m, type: nextType } : m)),
            () => request(apiFetch('POST /agents/memory/bulk-update', { init: jsonInit({ ids, type: nextType }) })),
        );
    }, [optimistic]);

    // Restore / approve / reject take the row out of the current view.
    const leaveView = useCallback((id: string, call: () => Promise<Response>) => optimistic(
        (list) => list.filter((m) => m.id !== id),
        () => request(call()),
        { totalDelta: -1 },
    ), [optimistic]);

    const restore: MemoriesState['restore'] = useCallback((id) => leaveView(id, () => apiFetch('POST /agents/memory/{id}/restore', { params: { id } })), [leaveView]);
    const approve: MemoriesState['approve'] = useCallback((id) => leaveView(id, () => apiFetch('POST /agents/memory/review/{id}/approve', { params: { id } })), [leaveView]);
    const reject: MemoriesState['reject'] = useCallback((id) => leaveView(id, () => apiFetch('POST /agents/memory/review/{id}/reject', { params: { id } })), [leaveView]);

    const create: MemoriesState['create'] = useCallback(async (input) => {
        try {
            const res = await request(apiFetch('POST /agents/memory', { init: jsonInit(input) }));
            const data = (await res.json().catch(() => null)) as { id?: string } | null;
            if (!data?.id) return { ok: false, status: null, code: null };
            onChangedRef.current?.();
            reload();
            return { ok: true };
        } catch (err) {
            return failure(err);
        }
    }, [reload]);

    // Without a body /clear is the PERSONAL clear; a project names itself.
    const clearAll: MemoriesState['clearAll'] = useCallback(async (clearProjectId) => {
        try {
            await request(apiFetch('POST /agents/memory/clear', clearProjectId ? { init: jsonInit({ projectId: clearProjectId }) } : undefined));
            commit([], 0);
            onChangedRef.current?.();
            return true;
        } catch {
            return false;
        }
    }, [commit]);

    return {
        items: shown.items, total: shown.total,
        loading: first.isFetching, loadingMore: more.loading, error: more.error ?? firstError,
        hasMore: shown.items.length < shown.total,
        reload, loadMore, update, remove, bulkRemove, bulkType, restore, approve, reject, create, clearAll,
    };
}

/** The per-type counts, pending-review count and last update; failure leaves what was there (null at first). */
export function useMemoryStats(enabled: boolean): { stats: MemoryStats | null; refresh: () => void } {
    const { data, refetch } = useMemoryCountsQuery<MemoryStats>(enabled);
    const refresh = useCallback(() => {
        // non-fatal when it fails: pills fall back to no counts
        if (enabled) void refetch();
    }, [enabled, refetch]);
    return { stats: data ?? null, refresh };
}

export async function exportMemories(): Promise<void> {
    const res = await request(apiFetch('GET /agents/memory/export/all'));
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'memories.json';
    a.click();
    URL.revokeObjectURL(url);
}

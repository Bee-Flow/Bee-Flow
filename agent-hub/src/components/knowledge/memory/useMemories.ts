/**
 * Data for the memory panel: the list (paged, filtered on the server), the
 * stats, and every mutation. Each mutation updates the list first and rolls
 * back when the server refuses, so a row never sits in the wrong state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiFetch } from '@/api/typedRequest';
import type {
    Memory, MemorySort, MemoryScope, MemoryStats, MemoryType, MemoryView,
} from './memoryTypes';

const PAGE_SIZE = 50;

export interface MemoryQuery {
    view: MemoryView;
    scope: MemoryScope;
    projectId?: string;
    search: string;
    type: MemoryType | 'all';
    sort: MemorySort;
}

class MemoryHttpError extends Error {
    status: number;
    /** The server's machine-readable reason (`sensitive_identifier`, `memory_unreadable`, ...), when it sent one. */
    code: string | null;
    constructor(status: number, code: string | null = null) {
        super(`HTTP ${status}`);
        this.status = status;
        this.code = code;
    }
}

/** What a write that can be refused for a reason the person should read comes back with. */
export type WriteResult = { ok: true } | { ok: false; status: number | null; code: string | null };

const failure = (err: unknown): WriteResult => (err instanceof MemoryHttpError
    ? { ok: false, status: err.status, code: err.code }
    : { ok: false, status: null, code: null });

/** The Response of a 2xx; anything else is a MemoryHttpError with the server's code. */
async function request(pending: Promise<Response>): Promise<Response> {
    const res = await pending;
    if (!res.ok) {
        const body = (await res.json?.().catch(() => null)) as { code?: unknown } | null;
        throw new MemoryHttpError(res.status, typeof body?.code === 'string' ? body.code : null);
    }
    return res;
}

/** A JSON body as the panel builds it (wider than the routes' schema types). */
const jsonInit = (body: unknown) => ({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

function fetchList(q: MemoryQuery, offset: number): Promise<Response> {
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

interface ListResponse { items?: Memory[]; memories?: Memory[]; total?: number }

export function useMemories(query: MemoryQuery, onChanged?: () => void): MemoriesState {
    const [items, setItems] = useState<Memory[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<'forbidden' | 'failed' | null>(null);
    const itemsRef = useRef<Memory[]>([]);
    const totalRef = useRef(0);
    const seq = useRef(0);
    const onChangedRef = useRef(onChanged);
    onChangedRef.current = onChanged;

    const commit = useCallback((next: Memory[], nextTotal: number) => {
        itemsRef.current = next;
        totalRef.current = nextTotal;
        setItems(next);
        setTotal(nextTotal);
    }, []);

    const { view, scope, projectId, search, type, sort } = query;
    const fetchPage = useCallback(async (append: boolean) => {
        const mine = ++seq.current;
        if (append) setLoadingMore(true); else setLoading(true);
        // A sticky error would hide every later successful fetch.
        setError(null);
        try {
            const offset = append ? itemsRef.current.length : 0;
            const res = await request(fetchList({ view, scope, projectId, search, type, sort }, offset));
            const data = (await res.json()) as ListResponse;
            if (mine !== seq.current) return;
            const page = data.items ?? data.memories ?? [];
            const nextItems = append ? [...itemsRef.current, ...page] : page;
            commit(nextItems, typeof data.total === 'number' ? data.total : nextItems.length);
        } catch (err) {
            if (mine !== seq.current) return;
            const status = err instanceof MemoryHttpError ? err.status : null;
            setError(loadErrorKind(status));
            // Access gone: drop the stale rows so no action lingers behind the error.
            if (status === 403 && !append) commit([], 0);
        } finally {
            if (mine === seq.current) { setLoading(false); setLoadingMore(false); }
        }
    }, [view, scope, projectId, search, type, sort, commit]);

    useEffect(() => { void fetchPage(false); }, [fetchPage]);

    const reload = useCallback(() => { void fetchPage(false); }, [fetchPage]);
    const loadMore = useCallback(() => {
        if (itemsRef.current.length < totalRef.current) void fetchPage(true);
    }, [fetchPage]);

    /** Run `apply` on the list now; `call` on the server; undo on failure. */
    const optimistic = useCallback(async (
        apply: (list: Memory[]) => Memory[],
        call: () => Promise<Response>,
        { totalDelta = 0, keepServerRow = false }: { totalDelta?: number; keepServerRow?: boolean } = {},
        onFail?: (err: unknown) => void,
    ): Promise<boolean> => {
        const before = itemsRef.current;
        const beforeTotal = totalRef.current;
        commit(apply(before), Math.max(0, beforeTotal + totalDelta));
        try {
            const res = await call();
            if (keepServerRow) {
                const body = (await res.json().catch(() => null)) as { memory?: Memory } | null;
                const fresh = body?.memory;
                if (fresh) commit(itemsRef.current.map((m) => (m.id === fresh.id ? { ...m, ...fresh } : m)), totalRef.current);
            }
            onChangedRef.current?.();
            return true;
        } catch (err) {
            commit(before, beforeTotal);
            onFail?.(err);
            return false;
        }
    }, [commit]);

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
            void fetchPage(false);
            return { ok: true };
        } catch (err) {
            return failure(err);
        }
    }, [fetchPage]);

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
        items, total, loading, loadingMore, error,
        hasMore: items.length < total,
        reload, loadMore, update, remove, bulkRemove, bulkType, restore, approve, reject, create, clearAll,
    };
}

/** The per-type counts, pending-review count and last update; failure leaves it null. */
export function useMemoryStats(enabled: boolean): { stats: MemoryStats | null; refresh: () => void } {
    const [stats, setStats] = useState<MemoryStats | null>(null);
    const refresh = useCallback(() => {
        if (!enabled) return;
        request(apiFetch('GET /agents/memory/stats'))
            .then((res) => res.json() as Promise<MemoryStats>)
            .then(setStats)
            .catch(() => { /* non-fatal: pills fall back to no counts */ });
    }, [enabled]);
    useEffect(() => { refresh(); }, [refresh]);
    return { stats, refresh };
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

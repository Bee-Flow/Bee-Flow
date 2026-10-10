/**
 * Data for the memory panel: the list (paged, filtered on the server), the
 * stats, and every mutation. Each mutation updates the list first and rolls
 * back when the server refuses, so a row never sits in the wrong state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { API_BASE, authFetch } from '../../../utils/helpers';
import type {
    Memory, MemorySort, MemoryScope, MemoryStats, MemoryType, MemoryView,
} from './memoryTypes';

export const PAGE_SIZE = 50;

export interface MemoryQuery {
    view: MemoryView;
    scope: MemoryScope;
    projectId?: string;
    search: string;
    type: MemoryType | 'all';
    sort: MemorySort;
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

/** What a write that can be refused for a reason the person should read comes back with. */
export type WriteResult = { ok: true } | { ok: false; status: number | null; code: string | null };

const failure = (err: unknown): WriteResult => (err instanceof MemoryHttpError
    ? { ok: false, status: err.status, code: err.code }
    : { ok: false, status: null, code: null });

const BASE = `${API_BASE}/agents/memory`;

async function request(path: string, init?: RequestInit): Promise<Response> {
    const res = await authFetch(`${BASE}${path}`, init);
    if (!res.ok) {
        const body = (await res.json?.().catch(() => null)) as { code?: unknown } | null;
        throw new MemoryHttpError(res.status, typeof body?.code === 'string' ? body.code : null);
    }
    return res;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export function buildListPath(q: MemoryQuery, offset: number): string {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    if (q.view === 'review') return `/review?${params.toString()}`;
    params.set('scope', q.scope);
    if (q.projectId && (q.scope === 'project' || q.scope === 'all')) params.set('projectId', q.projectId);
    if (q.search) params.set('search', q.search);
    if (q.type !== 'all') params.set('type', q.type);
    params.set('status', q.view === 'archived' ? 'archived' : 'active');
    params.set('sort', q.sort);
    return `?${params.toString()}`;
}

export function loadErrorKind(status: number | null): 'forbidden' | 'failed' {
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
            const res = await request(buildListPath({ view, scope, projectId, search, type, sort }, offset));
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
            () => request(`/${encodeURIComponent(id)}`, jsonInit('PUT', patch)),
            { keepServerRow: true },
            (err) => { failed = failure(err); },
        );
        return ok ? { ok: true } : failed;
    }, [optimistic]);

    const remove: MemoriesState['remove'] = useCallback((id) => optimistic(
        (list) => list.filter((m) => m.id !== id),
        () => request(`/${encodeURIComponent(id)}`, { method: 'DELETE' }),
        { totalDelta: -1 },
    ), [optimistic]);

    const bulkRemove: MemoriesState['bulkRemove'] = useCallback((ids) => {
        const gone = new Set(ids);
        return optimistic(
            (list) => list.filter((m) => !gone.has(m.id)),
            () => request('/bulk-delete', jsonInit('POST', { ids })),
            { totalDelta: -ids.length },
        );
    }, [optimistic]);

    const bulkType: MemoriesState['bulkType'] = useCallback((ids, nextType) => {
        const picked = new Set(ids);
        return optimistic(
            (list) => list.map((m) => (picked.has(m.id) ? { ...m, type: nextType } : m)),
            () => request('/bulk-update', jsonInit('POST', { ids, type: nextType })),
        );
    }, [optimistic]);

    // Restore / approve / reject take the row out of the current view.
    const leaveView = useCallback((id: string, path: string) => optimistic(
        (list) => list.filter((m) => m.id !== id),
        () => request(path, { method: 'POST' }),
        { totalDelta: -1 },
    ), [optimistic]);

    const restore: MemoriesState['restore'] = useCallback((id) => leaveView(id, `/${encodeURIComponent(id)}/restore`), [leaveView]);
    const approve: MemoriesState['approve'] = useCallback((id) => leaveView(id, `/review/${encodeURIComponent(id)}/approve`), [leaveView]);
    const reject: MemoriesState['reject'] = useCallback((id) => leaveView(id, `/review/${encodeURIComponent(id)}/reject`), [leaveView]);

    const create: MemoriesState['create'] = useCallback(async (input) => {
        try {
            const res = await request('', jsonInit('POST', input));
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
            await request('/clear', clearProjectId ? jsonInit('POST', { projectId: clearProjectId }) : { method: 'POST' });
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
        request('/stats')
            .then((res) => res.json() as Promise<MemoryStats>)
            .then(setStats)
            .catch(() => { /* non-fatal: pills fall back to no counts */ });
    }, [enabled]);
    useEffect(() => { refresh(); }, [refresh]);
    return { stats, refresh };
}

export async function exportMemories(): Promise<void> {
    const res = await request('/export/all');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'memories.json';
    a.click();
    URL.revokeObjectURL(url);
}

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetStateAction } from 'react';
import { API_BASE } from '@/utils/helpers';
import { mutate, RefusedError, errorBody } from '@/api/mutate';
import type { AuthFetchOptions } from '@/utils/helpers';

/** One organization in `GET /auth/organizations`. */
interface OrgListEntry {
    id: string;
    name?: string;
    trial_used_at?: string | null;
    total_calls?: number;
    estimated_cost?: number;
}

/** `GET /auth/organizations`: a bare list, or wrapped under `organizations` / `orgs`. */
export type OrgListPayload = OrgListEntry[] | { organizations?: OrgListEntry[]; orgs?: OrgListEntry[] };

export async function apiJson(path: string, opts?: AuthFetchOptions) {
    let res: Response;
    try {
        res = await mutate(`${API_BASE}${path}`, opts);
    } catch (e) {
        if (!(e instanceof RefusedError)) throw e;
        const body = errorBody(e);
        const err: Error & { status?: number; body?: unknown } = new Error(body?.error || `Request failed (${e.status})`);
        err.status = e.status;
        err.body = body;
        throw err;
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return body;
}

/**
 * Lightweight data loader — keeps state in sync and exposes reload().
 *   const { data, loading, error, reload } = useResource('/api/subscriptions/plans', { initial: [] });
 *
 * A query underneath, keyed per mounted caller (two callers of one path with a
 * different `transform` never share a transformed answer). `enabled` gates the
 * first read; `reload()` always reads; a failed read keeps the last data and
 * `setData` edits the cached copy.
 */
interface UseResourceOptions<T, B> {
    initial?: T | null;
    enabled?: boolean;
    transform?: (body: B) => T;
}

interface Resource<D> {
    data: D;
    loading: boolean;
    error: unknown;
    reload: () => Promise<void>;
    setData(next: SetStateAction<D>): void;
}

// With an `initial` value the data is never null before the first load.
export function useResource<T, B = never>(path: string | null | undefined, options: UseResourceOptions<T, B> & { initial: T }): Resource<T>;
export function useResource<T, B = never>(path: string | null | undefined, options?: UseResourceOptions<T, B>): Resource<T | null>;
export function useResource<T, B = never>(path: string | null | undefined, { initial = null, enabled = true, transform }: UseResourceOptions<T, B> = {}): Resource<T | null> {
    const queryClient = useQueryClient();
    const callerId = useId();
    const key = useMemo(() => ['subscriptions', 'resource', callerId, path ?? null] as const, [callerId, path]);
    // Callers pass `transform` inline; the latest one is read when the answer lands.
    const transformRef = useRef(transform);
    useEffect(() => { transformRef.current = transform; }, [transform]);
    // The first `initial` stands for "nothing read yet", one stable value as a state slot keeps it.
    const [initialValue] = useState(initial);

    const query = useQuery<T | null>({
        queryKey: key,
        enabled: enabled && !!path,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            const body = await apiJson(path as string);
            const transformNow = transformRef.current;
            return transformNow ? transformNow(body) : body;
        },
    });
    const { refetch } = query;

    const reload = useCallback(async () => {
        if (!path) return;
        await refetch();
    }, [path, refetch]);

    const setData = useCallback((next: SetStateAction<T | null>) => {
        queryClient.setQueryData<T | null>(key, (prev) => {
            const base = prev === undefined ? initialValue : prev;
            return typeof next === 'function' ? (next as (p: T | null) => T | null)(base) : next;
        });
    }, [queryClient, key, initialValue]);

    // A read in flight shows no error, as a fresh reload always did.
    return { data: query.data === undefined ? initialValue : query.data, loading: query.isFetching, error: query.isFetching ? null : query.error, reload, setData };
}

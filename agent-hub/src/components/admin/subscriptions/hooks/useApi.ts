import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import { API_BASE } from '../../../../utils/helpers';
import { mutate, RefusedError, errorBody } from '../../../../api/mutate';
import type { AuthFetchOptions } from '../../../../utils/helpers';

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
    const [data, setData] = useState<T | null>(initial);
    const [loading, setLoading] = useState(enabled);
    const [error, setError] = useState<unknown>(null);
    const alive = useRef(true);
    const pathRef = useRef(path);
    pathRef.current = path;
    // Callers pass `transform` inline; the latest one is read at reload time.
    const transformRef = useRef(transform);
    useEffect(() => { transformRef.current = transform; }, [transform]);

    const reload = useCallback(async () => {
        if (!pathRef.current) return;
        setLoading(true);
        setError(null);
        try {
            const body = await apiJson(pathRef.current);
            if (!alive.current) return;
            const transformNow = transformRef.current;
            setData(transformNow ? transformNow(body) : body);
        } catch (e) {
            if (alive.current) setError(e);
        } finally {
            if (alive.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        alive.current = true;
        if (enabled) reload();
        return () => { alive.current = false; };
    }, [enabled, reload]);

    return { data, loading, error, reload, setData };
}

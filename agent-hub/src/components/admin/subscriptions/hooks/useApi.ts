import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';

export function api(path: string, opts?: RequestInit) {
    return authFetch(`${API_BASE}${path}`, opts);
}

/** An API error: the HTTP status and the parsed body ride along. */
export type ApiError = Error & { status?: number; body?: { error?: string } | null };

export async function apiJson<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
    const res = await api(path, opts);
    let body: { error?: string } | null = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
        const err: ApiError = new Error(body?.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body as T;
}

/**
 * Lightweight data loader — keeps state in sync and exposes reload().
 *   const { data, loading, error, reload } = useResource('/api/subscriptions/plans', { initial: [] });
 */
export function useResource<T = unknown>(
    path: string | null | undefined,
    { initial = null, enabled = true, transform }: {
        initial?: T | null;
        enabled?: boolean;
        transform?: (body: unknown) => T;
    } = {},
) {
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
            const body = await apiJson<unknown>(pathRef.current);
            if (!alive.current) return;
            const transformNow = transformRef.current;
            setData(transformNow ? transformNow(body) : (body as T));
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

/**
 * useResource — one lazily-loaded GET behind the Compliance Center's
 * "null = not loaded, [] / {} = loaded" convention (redesign, Sep 2026).
 *
 * Every register hook used to be twenty lines in index.jsx: a state slot, a
 * refresh callback, and an effect that fires the first time its section opens.
 * This is those twenty lines once. Two rules it enforces so a page never has to:
 *
 *   - `enabled` gates the FIRST fetch (a section's data loads when the section
 *     is opened, not when the hub mounts), and a later `refresh()` always runs.
 *   - `parse` turns the body into what the page expects — or `null`. The nav
 *     test mocks every non-/overview url as `[]`, and an aggregate endpoint
 *     that has not shipped yet answers 404 or junk; both must read as "not
 *     loaded" (render nothing), never as "zero".
 *
 * `onError` receives the error and may return a fallback value to store
 * (today's hooks store `{ error }` or `[]` — each register keeps its habit).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../../../api/complianceApi';

interface UseResourceOptions<T> {
    enabled?: boolean;
    parse?: (body: unknown) => T | null;
    onError?: ((e: unknown) => T | null | undefined) | null;
    deps?: readonly unknown[];
}

export default function useResource<T = unknown>(url: string, { enabled = true, parse = (b) => b as T, onError = null, deps = [] }: UseResourceOptions<T> = {}) {
    const [data, setData] = useState<T | null>(null);
    const [failed, setFailed] = useState(false);
    const [loading, setLoading] = useState(false);
    const requested = useRef(false);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    const refresh = useCallback(async () => {
        if (!url) return null;
        setLoading(true);
        try {
            const body = await fetchJson(url);
            const value = parse(body);
            if (alive.current) { setData(value); setFailed(false); }
            return value;
        } catch (e) {
            const fallback = onError ? onError(e) : undefined;
            if (alive.current) {
                setFailed(true);
                if (fallback !== undefined) setData(fallback);
            }
            return fallback === undefined ? null : fallback;
        } finally {
            if (alive.current) setLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's own list; the inline parse/onError are covered by it
    }, [url, ...deps]);

    useEffect(() => {
        if (!enabled || requested.current || !url) return;
        requested.current = true;
        refresh();
    }, [enabled, url, refresh]);

    return { data, setData, refresh, loading, failed };
}

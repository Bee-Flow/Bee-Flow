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
 *
 * It is a query underneath (a key of its own per mounted caller, so two callers
 * with different `parse` never share a parsed answer): the section's first
 * open reads it, `refresh()` reads it again, and `setData` edits the cached copy.
 */
import { useCallback, useId } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/api/complianceApi';

interface UseResourceOptions<T> {
    enabled?: boolean;
    parse?: (body: unknown) => T | null;
    onError?: ((e: unknown) => T | null | undefined) | null;
    deps?: readonly unknown[];
}

/** What one read settled on: the value to show and whether the read failed. */
interface Read<T> { value: T | null; failed: boolean }

export default function useResource<T = unknown>(url: string, { enabled = true, parse = (b) => b as T, onError = null, deps = [] }: UseResourceOptions<T> = {}) {
    const queryClient = useQueryClient();
    const callerId = useId();
    const key = ['compliance', 'resource', callerId, url, ...deps] as const;
    const query = useQuery<Read<T>>({
        queryKey: key,
        enabled: enabled && !!url,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            try {
                return { value: parse(await fetchJson(url)), failed: false };
            } catch (e) {
                const fallback = onError ? onError(e) : undefined;
                // A fallback is stored; without one the previous value stays (null before the first read).
                return { value: fallback === undefined ? (queryClient.getQueryData<Read<T>>(key)?.value ?? null) : fallback, failed: true };
            }
        },
    });
    const { refetch } = query;

    const refresh = useCallback(async () => {
        if (!url) return null;
        const result = await refetch();
        return result.data?.value ?? null;
    }, [url, refetch]);

    const setData = useCallback((next: T | null) => {
        queryClient.setQueryData<Read<T>>(key, (prev) => ({ value: next, failed: prev?.failed ?? false }));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is rebuilt from url, deps and the id each render
    }, [queryClient, url, callerId, ...deps]);

    return { data: query.data?.value ?? null, setData, refresh, loading: query.isFetching, failed: query.data?.failed ?? false };
}

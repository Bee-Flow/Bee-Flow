/**
 * Studio's reads. Screens and the drawer use these, never useQuery itself, so
 * the keys and freshness are decided once.
 */

import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { fetchRecentSource, fetchStudioAttention, fetchStudioCounts, searchStudio } from '../api/endpoints';
import { studioKeys } from '../api/keys';
import { recentSourcesFor, summariseRecent, type RecentSourceId, type RecentWork } from '../model/recent';
import { MIN_QUERY_LENGTH } from '../model/search';
import type { ResolvedSection } from '../model/types';

/**
 * The numbers on the Studio rows. The server caches them a minute per user,
 * and the web's rail polls at 30s; a minute here keeps the drawer honest
 * without a timer per open screen (React Query pauses it in the background).
 * `enabled` is the canSeeStudio answer: someone with no Studio pays nothing.
 */
export function useStudioCounts(enabled: boolean) {
    return useQuery({
        queryKey: studioKeys.counts,
        queryFn: ({ signal }) => fetchStudioCounts(signal),
        enabled,
        staleTime: 30_000,
        refetchInterval: enabled ? 60_000 : false,
    });
}

/** "Needs attention": read when the hub opens, never polled (the server caches a minute). */
export function useStudioAttention(enabled = true) {
    return useQuery({
        queryKey: studioKeys.attention,
        queryFn: ({ signal }) => fetchStudioAttention(signal),
        enabled,
        staleTime: 60_000,
        retry: 1,
    });
}

/** Name search. Under two characters nothing is asked — the server would not look either. */
export function useStudioSearch(term: string) {
    const q = term.trim();
    return useQuery({
        queryKey: studioKeys.search(q),
        queryFn: ({ signal }) => searchStudio(q, signal),
        enabled: q.length >= MIN_QUERY_LENGTH,
        staleTime: 30_000,
        retry: false,
    });
}

/**
 * "Recently edited": one list per open section this person may read, once
 * when the hub opens. Each section fails on its own — a list that falls over
 * is named, and never takes the others with it.
 */
export function useRecentWork(sections: readonly ResolvedSection[]): RecentWork {
    const asked = recentSourcesFor(sections);
    const results = useQueries({
        queries: asked.map((section) => ({
            queryKey: studioKeys.recent(section.id),
            queryFn: ({ signal }: { signal: AbortSignal }) => fetchRecentSource(section.id as RecentSourceId, signal),
            staleTime: 60_000,
            retry: 1,
        })),
    });
    return summariseRecent(
        asked,
        results.map((r) => (r.data ? r.data : r.error ? (r.error as Error) : undefined)),
    );
}

/**
 * The hub's pull-to-refresh: every Studio read at once — the counts, what
 * needs attention and "Recently edited", which nothing else marks stale when
 * an object is renamed or deleted elsewhere. Invalidation refetches only the
 * reads that are mounted and enabled, so someone without Studio proper asks
 * nothing. Resolves when those refetches have landed.
 */
export function useRefreshStudio(): () => Promise<void> {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: studioKeys.all });
}

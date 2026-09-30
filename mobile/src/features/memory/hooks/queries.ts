/** Memory queries. Screens call these rather than useQuery. */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { getMemoryStats, listMemories, MEMORY_PAGE_SIZE } from '../api/endpoints';
import { memoryKeys } from '../api/keys';

export function useMemoryStats() {
    return useQuery({
        queryKey: memoryKeys.stats,
        queryFn: ({ signal }) => getMemoryStats(signal),
    });
}

/**
 * The Memory screen's list, paged as the person scrolls. `hasMore` is the
 * server's own arithmetic (offset + returned < total); trusting it rather than
 * recomputing keeps the two in step if the route's paging ever changes.
 */
export function useMemoryPages(search: string, type: string | null) {
    return useInfiniteQuery({
        queryKey: memoryKeys.list(search, type),
        queryFn: ({ pageParam, signal }) =>
            listMemories({ search, type, limit: MEMORY_PAGE_SIZE, offset: pageParam }, signal),
        initialPageParam: 0,
        getNextPageParam: (last) => (last.hasMore ? last.offset + last.memories.length : undefined),
    });
}

/** The Library sheet's one page of up to a hundred rows, read while it is open. */
export function useMemorySheetList(search: string, type: string | null, enabled: boolean) {
    return useQuery({
        queryKey: memoryKeys.sheet(search, type),
        queryFn: ({ signal }) => listMemories({ search, type, limit: 100 }, signal),
        enabled,
    });
}

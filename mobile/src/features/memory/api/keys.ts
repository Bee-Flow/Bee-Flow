/**
 * React Query keys for memory.
 *
 * Two views read the same rows. The Memory screen pages them infinitely under
 * 'memory'; the Library hub's sheet reads one plain page under the hub's
 * 'library' prefix, so the hub's pull-to-refresh refreshes it. They cannot
 * share a key — one caches pages, the other a single response.
 */

export const memoryKeys = {
    all: ['memory'] as const,
    list: (search: string, type: string | null) => ['memory', 'list', search, type ?? ''] as const,
    stats: ['memory', 'stats'] as const,
    sheetAll: ['library', 'memory'] as const,
    sheet: (search: string, type: string | null) => ['library', 'memory', search, type ?? ''] as const,
};

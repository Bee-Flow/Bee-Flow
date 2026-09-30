/** React Query keys for Studio's aggregates and the per-section recent lists. */

export const studioKeys = {
    all: ['studio'] as const,
    counts: ['studio', 'counts'] as const,
    attention: ['studio', 'attention'] as const,
    search: (q: string) => ['studio', 'search', q] as const,
    recent: (source: string) => ['studio', 'recent', source] as const,
};

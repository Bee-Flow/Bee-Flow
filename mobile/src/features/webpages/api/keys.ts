/**
 * React Query keys for webpages, under the published-surfaces 'publishing'
 * prefix. Everything about one page sits under `detail(id)`, so invalidating
 * the page refreshes its parts — except the file bodies and the built
 * document, which have their own prefixes: they can run to megabytes, and a
 * publish toggle is no reason to download them again.
 */

export const webpageKeys = {
    all: ['publishing', 'webpages'] as const,
    detail: (id: string) => ['publishing', 'webpage', id] as const,
    shares: (id: string) => ['publishing', 'webpage', id, 'shares'] as const,
    sources: (id: string) => ['publishing', 'webpage', id, 'sources'] as const,
    versions: (id: string) => ['publishing', 'webpage', id, 'versions'] as const,
    audience: (id: string) => ['publishing', 'webpage', id, 'audience'] as const,
    grants: (id: string) => ['publishing', 'webpage', id, 'grants'] as const,
    dataCards: (id: string) => ['publishing', 'webpage', id, 'data-cards'] as const,
    calls: (id: string) => ['publishing', 'webpage', id, 'calls'] as const,
    files: (id: string) => ['publishing', 'webpage-files', id] as const,
    document: (id: string) => ['publishing', 'webpage-document', id] as const,
};

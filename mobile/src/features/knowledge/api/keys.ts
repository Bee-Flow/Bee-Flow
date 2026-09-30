/**
 * React Query keys for knowledge bases. They stay under the Library tab's
 * 'library' prefix, so the hub's pull-to-refresh (which invalidates
 * ['library']) still refreshes every one of them.
 */

export const knowledgeKeys = {
    all: ['library', 'kb'] as const,
    base: (id: string) => ['library', 'kb', id] as const,
    documents: (id: string) => ['library', 'kb', id, 'documents'] as const,
    chunks: (kbId: string, docId: string) => ['library', 'kb', kbId, 'doc', docId] as const,
    sources: (id: string) => ['library', 'kb', id, 'sources'] as const,
    sourceDocuments: (id: string, sid: string, filter: string, q: string) => ['library', 'kb', id, 'sources', sid, 'documents', filter, q] as const,
    usage: (id: string) => ['library', 'kb', id, 'usage'] as const,
    // Outside the per-base prefix: they are not about one base.
    categories: ['library', 'kb-meta', 'categories'] as const,
    favorites: ['library', 'kb-meta', 'favorites'] as const,
    system: ['library', 'kb-meta', 'system'] as const,
    workflows: ['library', 'kb-meta', 'n8n-workflows'] as const,
};

/**
 * The cross-base document views (features/documents) are assembled from these
 * rows, so a change to a base's documents has to invalidate them too. The key
 * belongs to features/documents; it is spelled here because documents imports
 * this feature, never the other way round.
 */
export const INGESTED_DOCUMENTS = ['library', 'documents'] as const;

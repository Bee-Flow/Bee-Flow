/** React Query keys for global search. The hooks own them. */

export const searchKeys = {
    all: ['search'] as const,
    /** Per-query server results. The term is part of the key, so React Query caches it. */
    query: (term: string) => ['search', 'query', term] as const,
    /** The three query-less lists, shared across every term the user types. */
    corpus: ['search', 'corpus'] as const,
    /** Recent terms, persisted on the device. See model/recent.ts. */
    recent: ['search', 'recent'] as const,
};

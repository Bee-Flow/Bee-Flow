/**
 * React Query keys for documents, under the Library tab's 'library' prefix.
 * features/knowledge invalidates `all` after an ingest (its INGESTED_DOCUMENTS
 * is the same key), because the cross-base views are built from its rows.
 */

export const documentKeys = {
    all: ['library', 'documents'] as const,
    /** Cross-KB document views. `scope` distinguishes the hub's short list. */
    across: (scope: string, baseIds: string) => ['library', 'documents', 'across', scope, baseIds] as const,
    rendered: ['library', 'documents', 'rendered'] as const,
};

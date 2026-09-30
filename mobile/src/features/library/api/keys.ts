/**
 * React Query keys the Library hub owns. Every Library collection (notebooks,
 * knowledge bases, documents, templates, the memory sheet) keys under
 * 'library', so the hub's pull-to-refresh can invalidate `all` in one call.
 */

export const libraryKeys = {
    all: ['library'] as const,
    houseStyles: (orgId: string) => ['library', 'house-styles', orgId] as const,
};

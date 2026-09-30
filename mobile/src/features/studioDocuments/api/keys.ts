/** React Query keys for Studio Documents. */

import type { DocumentFilters } from '../model/types';

export const studioDocumentKeys = {
    all: ['studio-documents'] as const,
    list: (filters: DocumentFilters) => ['studio-documents', 'list', filters] as const,
    detail: (id: string) => ['studio-documents', 'detail', id] as const,
    versions: (id: string) => ['studio-documents', 'versions', id] as const,
    starters: (locale: string) => ['studio-documents', 'starters', locale] as const,
};

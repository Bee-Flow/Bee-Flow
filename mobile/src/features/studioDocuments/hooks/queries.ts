/** Studio Documents queries. Screens call these rather than useQuery. */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { DOCUMENT_PAGE_SIZE, getStudioDocument, listStarters, listStudioDocuments, listVersions } from '../api/endpoints';
import { studioDocumentKeys } from '../api/keys';
import type { DocumentFilters, StudioDocumentRow } from '../model/types';

/**
 * The library, a page at a time (the web pages by thirty too). The server
 * filters and searches, so the filters are the key; the flat row list is
 * what the screen renders.
 */
export function useStudioDocumentPages(filters: DocumentFilters) {
    const query = useInfiniteQuery({
        queryKey: studioDocumentKeys.list(filters),
        queryFn: ({ pageParam, signal }) => listStudioDocuments(filters, pageParam, signal),
        initialPageParam: 0,
        getNextPageParam: (last, pages) =>
            last.length < DOCUMENT_PAGE_SIZE ? undefined : pages.reduce((n, page) => n + page.length, 0),
    });
    const rows: StudioDocumentRow[] | undefined = query.data?.pages.flat();
    return { ...query, rows };
}

export function useStudioDocument(id: string) {
    return useQuery({
        queryKey: studioDocumentKeys.detail(id),
        queryFn: ({ signal }) => getStudioDocument(id, signal),
        enabled: id !== '',
    });
}

export function useDocumentVersions(id: string, enabled: boolean) {
    return useQuery({
        queryKey: studioDocumentKeys.versions(id),
        queryFn: ({ signal }) => listVersions(id, signal),
        enabled: enabled && id !== '',
    });
}

export function useDocumentStarters(locale: string, enabled: boolean) {
    return useQuery({
        queryKey: studioDocumentKeys.starters(locale),
        queryFn: ({ signal }) => listStarters(locale, signal),
        enabled,
        staleTime: 10 * 60_000,
    });
}

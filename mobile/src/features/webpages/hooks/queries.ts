/** Webpage queries. Screens call these rather than useQuery. */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { getAudience, getDataCards, getGrants, getPageCalls } from '../api/audienceEndpoints';
import { listSources, listVersions, VERSION_PAGE_SIZE } from '../api/buildEndpoints';
import { getDraftDocument, getWebpage, getWebpageFiles, listWebpages, listWebpageShares } from '../api/endpoints';
import { webpageKeys } from '../api/keys';
import { anyProcessing } from '../model/sources';

/** How often the Knowledge tab looks again while a source is being read. */
const SOURCE_POLL_MS = 4000;

export function useWebpages() {
    return useQuery({
        queryKey: webpageKeys.all,
        queryFn: ({ signal }) => listWebpages(signal),
    });
}

export function useWebpage(id: string) {
    return useQuery({
        queryKey: webpageKeys.detail(id),
        queryFn: ({ signal }) => getWebpage(id, signal),
        enabled: id !== '',
    });
}

export function useWebpageShares(id: string) {
    return useQuery({
        queryKey: webpageKeys.shares(id),
        queryFn: ({ signal }) => listWebpageShares(id, signal),
        enabled: id !== '',
    });
}

/** The three bodies, which the builder chat sends with a turn. */
export function webpageFilesQuery(id: string) {
    return {
        queryKey: webpageKeys.files(id),
        queryFn: ({ signal }: { signal?: AbortSignal }) => getWebpageFiles(id, signal),
        // The builder chat keeps this copy current from its own frames, so a
        // background refetch only costs bytes.
        staleTime: 60_000,
    };
}

/** How long before the baked preview token expires the document is fetched again. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/**
 * The page as the server built it for the preview. A builder turn, a restore
 * and Reload invalidate it; otherwise it is fetched again only shortly before
 * its preview token runs out, so the page's live data keeps working.
 */
export function useDraftDocument(id: string, enabled: boolean) {
    return useQuery({
        queryKey: webpageKeys.document(id),
        queryFn: ({ signal }) => getDraftDocument(id, signal),
        enabled: enabled && id !== '',
        staleTime: Infinity,
        refetchInterval: (query) => {
            const expiresAt = query.state.data?.expiresAt;
            return expiresAt ? Math.max(60_000, expiresAt - Date.now() - TOKEN_MARGIN_MS) : false;
        },
    });
}

export function useWebpageSources(id: string, enabled = true) {
    return useQuery({
        queryKey: webpageKeys.sources(id),
        queryFn: ({ signal }) => listSources(id, signal),
        enabled: enabled && id !== '',
        refetchInterval: (query) => (anyProcessing(query.state.data) ? SOURCE_POLL_MS : false),
    });
}

export function useWebpageVersions(id: string, enabled = true) {
    return useInfiniteQuery({
        queryKey: webpageKeys.versions(id),
        queryFn: ({ pageParam, signal }) => listVersions(id, pageParam, signal),
        initialPageParam: 0,
        getNextPageParam: (last, pages) => (last.hasMore ? pages.length * VERSION_PAGE_SIZE : undefined),
        enabled: enabled && id !== '',
    });
}

export function useWebpageAudience(id: string, enabled = true) {
    return useQuery({
        queryKey: webpageKeys.audience(id),
        queryFn: ({ signal }) => getAudience(id, signal),
        enabled: enabled && id !== '',
    });
}

export function useWebpageGrants(id: string, enabled = true) {
    return useQuery({
        queryKey: webpageKeys.grants(id),
        queryFn: ({ signal }) => getGrants(id, signal),
        enabled: enabled && id !== '',
    });
}

export function useWebpageDataCards(id: string, enabled = true) {
    return useQuery({
        queryKey: webpageKeys.dataCards(id),
        queryFn: ({ signal }) => getDataCards(id, signal),
        enabled: enabled && id !== '',
    });
}

export function useWebpageCalls(id: string, enabled = true) {
    return useQuery({
        queryKey: webpageKeys.calls(id),
        queryFn: ({ signal }) => getPageCalls(id, signal),
        enabled: enabled && id !== '',
    });
}

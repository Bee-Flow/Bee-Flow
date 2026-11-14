// The web pages section's reads: the list of pages the caller may open, and
// one page's whole editor bundle (row, sources, files, chat) when it opens.
// The bundle is not kept once read (gcTime 0): opening a page always reads it
// afresh, as the section always did.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api, fetchWebpageBundle } from '../webpagesApi';
import { READ_ONCE } from './readOnce';

export function useWebpagesListQuery<R>(enabled: boolean) {
    return useQuery<R[], Error>({
        queryKey: ['webpages', 'list'],
        enabled,
        ...READ_ONCE,
        queryFn: async () => ((await api('/')).webpages || []) as R[],
    });
}

export function useWebpageBundleRead() {
    const qc = useQueryClient();
    return useCallback((id: string) => qc.fetchQuery({
        queryKey: ['webpages', id, 'bundle'],
        queryFn: () => fetchWebpageBundle(id),
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
}

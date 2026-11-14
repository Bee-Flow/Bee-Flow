// A web page's version history, page by page (GET /api/webpages/:id/versions,
// `?offset=` for the next page) and one version's content. The history panel
// keeps the list it builds; these read the server's pages through the query
// cache, asked anew each time (the history changes with every save).

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../webpagesApi';

export function useWebpageVersionsRead<P>() {
    const qc = useQueryClient();
    return useCallback((webpageId: string, offset = 0) => qc.fetchQuery<P>({
        queryKey: ['webpages', webpageId, 'versions', offset],
        queryFn: () => api(offset ? `/${webpageId}/versions?offset=${offset}` : `/${webpageId}/versions`) as Promise<P>,
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
}

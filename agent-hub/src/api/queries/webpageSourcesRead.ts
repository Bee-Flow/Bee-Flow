// A web page's reference sources, read again while one is still being
// ingested (the panel keeps the list in its parent; this reads the server's
// copy through the query cache). null when the server did not answer ok.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { webpagesRequest } from '../webpagesRequest';

export function useWebpageSourcesRead<S>() {
    const qc = useQueryClient();
    return useCallback((webpageId: string) => qc.fetchQuery<S[] | null>({
        queryKey: ['webpages', webpageId, 'sources'],
        queryFn: async () => {
            const res = await webpagesRequest(`/${webpageId}/sources`);
            if (!res.ok) return null;
            const { sources } = await res.json();
            return (sources || []) as S[];
        },
        staleTime: 0,
        retry: false,
    }), [qc]);
}

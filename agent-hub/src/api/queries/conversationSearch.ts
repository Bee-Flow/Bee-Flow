// The search overlay's read: conversations matching a term and filters (GET
// /agents/conversations/search). Each search is asked through the query cache
// (the same term and filters within a moment share one request). A refusal
// reads as null: the overlay keeps what it shows.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { RefusedError } from '../mutate';
import { apiRequest } from '../typedRequest';

export function useConversationSearchRead<R>() {
    const qc = useQueryClient();
    return useCallback((query: URLSearchParams) => qc.fetchQuery<R | null>({
        queryKey: ['agents', 'conversations', 'search', query.toString()],
        queryFn: async () => {
            let res: Response;
            try {
                res = await apiRequest('GET /agents/conversations/search', { query });
            } catch (err) {
                if (err instanceof RefusedError) return null;
                throw err;
            }
            return (await res.json()) as R;
        },
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
}

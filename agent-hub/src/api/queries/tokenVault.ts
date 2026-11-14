// The person's privacy token vault, one page at a time (GET
// /api/privacy/token-vault with limit, offset and an optional search). The
// section keeps the entries it has shown; this reads each page through the
// query cache, asked anew every time (a forget changes the vault). A refusal
// throws its HTTP status as the message.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { RefusedError } from '../mutate';
import { apiRequest } from '../typedRequest';

export function useTokenVaultPageRead<P>() {
    const qc = useQueryClient();
    return useCallback((query: URLSearchParams) => qc.fetchQuery<P>({
        queryKey: ['privacy', 'token-vault', query.toString()],
        queryFn: async () => {
            let res: Response;
            try {
                res = await apiRequest('GET /api/privacy/token-vault', { query });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                throw new Error(String(err.status));
            }
            return (await res.json()) as P;
        },
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
}

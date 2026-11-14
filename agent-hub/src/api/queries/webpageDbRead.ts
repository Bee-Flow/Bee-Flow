// A read of a web page's own SQLite database from the data viewer (POST
// /api/webpages/:id/db/query with a SELECT). Asked anew each time (rows change
// under the viewer) through the query cache; the answer keeps its `ok` so the
// viewer can show the server's error text.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { webpageRequest } from '../webpagesRequest';

export interface DbReadAnswer<B> { ok: boolean; body: B }

export function useWebpageDbRead<B>() {
    const qc = useQueryClient();
    return useCallback((webpageId: string | undefined, sql: string, params?: unknown[]) => qc.fetchQuery<DbReadAnswer<B>>({
        queryKey: ['webpages', webpageId ?? null, 'db', sql, params ?? null],
        queryFn: async () => {
            const res = await webpageRequest(webpageId, '/db/query', { method: 'POST', body: JSON.stringify(params ? { sql, params } : { sql }) });
            return { ok: res.ok, body: (await res.json()) as B };
        },
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
}

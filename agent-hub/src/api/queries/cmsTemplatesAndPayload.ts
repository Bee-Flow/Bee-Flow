// Two CMS editor reads that refresh state the editor keeps itself: the page
// templates (org-wide; asked when the panel opens and after a template is
// saved or deleted), and the active site's payload asked again when the tab
// comes back or after a page change. A refused read is null: the editor keeps
// what it shows.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { RefusedError } from '../mutate';
import { apiRequest } from '../typedRequest';
import { READ_ONCE } from './readOnce';

const cmsTemplatesKey = ['cms', 'admin', 'templates'] as const;

/** The org's page templates; a refusal reads as null, a network failure is the query's error. */
export function useCmsTemplatesQuery<T>() {
    return useQuery<T[] | null, Error>({
        queryKey: cmsTemplatesKey,
        ...READ_ONCE,
        queryFn: async () => {
            let res: Response;
            try {
                res = await apiRequest('GET /api/cms/admin/templates');
            } catch (err) {
                if (err instanceof RefusedError) return null;
                throw err;
            }
            const data = await res.json();
            return Array.isArray(data.templates) ? data.templates as T[] : [];
        },
    });
}

/** Read one site's editor payload again; null when the server refused. */
export function useCmsSitePayloadRead<P>() {
    const qc = useQueryClient();
    return useCallback((siteId: string) => qc.fetchQuery<P | null>({
        queryKey: ['cms', 'editor', 'reload', siteId],
        queryFn: async () => {
            let res: Response;
            try {
                res = await apiRequest('GET /api/cms/sites/{siteId}', { params: { siteId } });
            } catch (err) {
                if (err instanceof RefusedError) return null;
                throw err;
            }
            return (await res.json()) as P;
        },
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
}

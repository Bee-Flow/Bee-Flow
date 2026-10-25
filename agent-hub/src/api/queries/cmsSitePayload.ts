// The admin payload of one CMS site (GET cmsApi.site: the site doc plus its
// pages with blocks), as the sitemap view reads it. The caller names the
// payload type; it lives next to the view, which api/ may not import.

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { settled } from '../settled';

/** `url` is the site's admin endpoint; null means no site is chosen (nothing is read). */
export function useCmsSitePayload<T>(siteId: string | null, url: string | null) {
    const query = useQuery<T, Error>({
        queryKey: ['cms', 'sitePayload', siteId] as const,
        enabled: !!siteId && !!url,
        retry: false,
        staleTime: 0,
        placeholderData: keepPreviousData,
        queryFn: async () => {
            const res = await settled(url as string, undefined, 'empty');
            if (!res.ok) throw new Error(res.body.error || `Failed to load (${res.status})`);
            return (await res.res.json()) as T;
        },
    });
    return {
        data: siteId ? (query.data ?? null) : null,
        loading: !!siteId && query.isFetching,
        error: query.isFetching ? null : query.error,
        refetch: query.refetch,
    };
}

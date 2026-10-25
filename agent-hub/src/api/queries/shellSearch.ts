// The Studio search overlay's request: GET /api/studio/search?q=. The caller
// debounces the term and passes `enabled` only for a term long enough to ask;
// a non-ok answer or a network failure rejects (the overlay renders that as
// "Search is unavailable", never as an empty result).

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

/** One hit of the search, as GET /api/studio/search lists it. */
export interface StudioHit {
    id: string;
    name?: string;
}

/** What GET /api/studio/search answers. */
export interface StudioSearchAnswer {
    results?: Record<string, StudioHit[]>;
    errors?: unknown[];
    tooShort?: boolean;
}

export function useStudioSearchQuery(term: string, enabled: boolean) {
    return useQuery<StudioSearchAnswer, Error>({
        queryKey: ['shell', 'studioSearch', term] as const,
        enabled,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/studio/search?q=${encodeURIComponent(term)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        // The previous answer stays on screen until the new one lands, like the effect it replaces.
        placeholderData: keepPreviousData,
        staleTime: 0,
        retry: false,
    });
}

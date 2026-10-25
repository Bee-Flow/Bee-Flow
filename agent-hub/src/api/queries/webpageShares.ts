// The public shares of a webpage (agent editor, external share section), moved out of
// the component. authFetch stays inside queryFn on purpose: the component tests mock it.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export function useWebpagePublicShares<T>(webpageId: string | null | undefined) {
    return useQuery<T[], Error>({
        queryKey: ['webpageShares', webpageId ?? null],
        enabled: !!webpageId,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/webpages/${webpageId}/public-shares`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
            return Array.isArray(data.shares) ? data.shares : [];
        },
        staleTime: 0,
        retry: false,
    });
}

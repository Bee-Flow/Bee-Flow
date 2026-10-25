// The user's active icon pack id. No pack list (non-ok answer, network
// failure) means the default icons, which is what renders until one arrives:
// nothing to report, so the query resolves to null instead of failing.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export function useActiveIconPackId(): string | null {
    const q = useQuery<string | null, Error>({
        queryKey: ['icon-pack', 'active'],
        retry: false,
        staleTime: 0,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/icons`);
                if (!res.ok) return null;
                const data = await res.json();
                return data.activeIconPackId || null;
            } catch {
                return null;
            }
        },
    });
    return q.data ?? null;
}

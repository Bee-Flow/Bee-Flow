// Sidebar reads: the Cowork row's badge count. A non-ok answer or a network
// failure is swallowed (the badge keeps its last value), so the queryFn
// rejects and the query keeps the data it already had.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

const shellSidebarKeys = {
    coworkCount: ['shell', 'sidebar', 'coworkCount'] as const,
};

export function useActiveCoworkCountQuery() {
    return useQuery<number, Error>({
        queryKey: shellSidebarKeys.coworkCount,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/cowork`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const schedules: Array<{ isActive?: boolean }> = Array.isArray(data?.schedules) ? data.schedules : [];
            return schedules.filter(s => s.isActive).length;
        },
        staleTime: 0,
        retry: false,
    });
}

// The licence status read by the super-admin server-licence panel. authFetch stays
// inside queryFn on purpose: the panel's tests mock it.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export function useLicenseStatus<T>() {
    return useQuery<T, Error>({
        queryKey: ['license', 'status'],
        queryFn: async () => {
            const r = await authFetch(`${API_BASE}/api/license/status`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        },
        staleTime: 0,
        retry: false,
    });
}

// The system knowledge bases of the organisation (Knowledge → System). authFetch stays
// inside queryFn on purpose: the panel's tests mock it.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export interface SystemKbList<T> {
    items: T[];
    orgId: string | null;
    isSuperAdmin: boolean;
}

export function useSystemKnowledgeBases<T>() {
    return useQuery<SystemKbList<T>, Error>({
        queryKey: ['knowledge', 'systemKnowledgeBases'],
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/kb/system`);
            if (!res.ok) throw new Error(`Load failed (${res.status})`);
            const j = await res.json();
            return {
                items: Array.isArray(j.items) ? j.items : [],
                orgId: j.orgId || null,
                isSuperAdmin: !!j.isSuperAdmin,
            };
        },
        staleTime: 0,
        retry: false,
    });
}

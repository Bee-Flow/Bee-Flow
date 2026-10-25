// One skill as GET /skills/:id answers it (the form modal asks once on open for the
// `managed` part the list rows do not carry). A refused answer or a failure is "nothing
// extra": the 409 on save still turns the form read-only. authFetch stays inside queryFn.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export function useSkillDetail<T>(skillId: string | null, enabled: boolean) {
    return useQuery<T | null, Error>({
        queryKey: ['skills', 'detail', skillId],
        enabled: enabled && !!skillId,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/skills/${encodeURIComponent(skillId as string)}`);
                return res.ok ? await res.json() : null;
            } catch {
                return null;
            }
        },
        staleTime: 0,
        retry: false,
    });
}

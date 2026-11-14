// The skills a direct-chat conversation made for itself (GET
// /ai/direct/conversations/:id/session-skills), read again each time the skills
// popover opens. A refusal reads as null: the popover keeps what it shows.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { RefusedError } from '../mutate';
import { apiRequest } from '../typedRequest';

export function useSessionSkillsRead<S>() {
    const qc = useQueryClient();
    return useCallback((conversationId: string) => qc.fetchQuery<S[] | null>({
        queryKey: ['direct-chat', conversationId, 'session-skills'],
        queryFn: async () => {
            let res: Response;
            try {
                res = await apiRequest('GET /ai/direct/conversations/{id}/session-skills', { params: { id: conversationId } });
            } catch (err) {
                if (err instanceof RefusedError) return null;
                throw err;
            }
            const data = await res.json();
            return Array.isArray(data.skills) ? data.skills as S[] : [];
        },
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
}

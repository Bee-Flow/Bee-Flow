// POST /api/projects/:id/presence: "I am here, looking at this item", sent by
// the project page's heartbeat. Best-effort: a missed beat only lets the
// presence dot expire a little sooner.

import { useMutation } from '@tanstack/react-query';
import { apiClient } from '../client';

export interface PresenceBeat {
    projectId: string;
    /** The open item, or null for "in the project". */
    target: { type: string; id: string } | null;
}

export function usePresenceBeatMutation() {
    return useMutation<unknown, Error, PresenceBeat>({
        mutationFn: ({ projectId, target }) => apiClient.post(`/api/projects/${encodeURIComponent(projectId)}/presence`, target ? { target } : {}),
    });
}

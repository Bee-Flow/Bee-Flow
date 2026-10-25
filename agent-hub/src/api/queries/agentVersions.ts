// The snapshot list of one agent (agent editor, Version history). Not the notebook/document
// versions contract in ./versions. authFetch stays inside queryFn: the component tests mock it.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export interface AgentVersionRow {
    id: string;
    version_number: number;
    created_at: string;
    change_summary: string;
}

export const agentVersionsKey = (agentId: string | number | null | undefined) => ['agentVersions', agentId ?? null] as const;

export function useAgentVersions(agentId: string | number | null | undefined, enabled: boolean) {
    return useQuery<AgentVersionRow[], Error>({
        queryKey: agentVersionsKey(agentId),
        enabled: enabled && !!agentId,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/versions/${agentId}`);
            const data = await res.json();
            return Array.isArray(data) ? data : [];
        },
        staleTime: 0,
        retry: false,
    });
}

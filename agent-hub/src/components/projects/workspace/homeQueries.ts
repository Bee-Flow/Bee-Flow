// The reads the workspace shell needs beyond the project, chat and content
// query modules: the agents the caller can chat with (the composers' agent
// pickers).

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../../api/client';

export interface AgentSummary {
    id: string;
    name?: string;
    icon?: string;
}

const agentRows = (rows: unknown): AgentSummary[] => (Array.isArray(rows)
    ? rows.filter((a): a is AgentSummary => !!a && typeof a.id === 'string')
    : []);

/**
 * The two lists the app merges into the agents a person can open, the same
 * way the hub's own agent list does: `/agents` holds the caller's own (drafts
 * included) and the system agents, `/agents/published` the ones published to
 * their organisation or groups. One id once; the published record wins. Only
 * when both reads fail is the list an error: one of them still names agents
 * the person can use.
 */
function mergeUsableAgents(own: unknown, published: unknown): AgentSummary[] {
    const byId = new Map<string, AgentSummary>();
    for (const a of agentRows(own)) byId.set(a.id, a);
    for (const a of agentRows(published)) byId.set(a.id, a);
    return [...byId.values()];
}

/** The agents the caller may chat with: their own, and those published to them. */
export function useUsableAgents(enabled = true) {
    return useQuery<AgentSummary[], Error>({
        queryKey: ['project-home', 'agents'],
        enabled,
        staleTime: 60_000,
        queryFn: async ({ signal }) => {
            const [own, published] = await Promise.allSettled([
                apiClient.get<unknown>('/agents', { signal, retry: false }),
                apiClient.get<unknown>('/agents/published', { signal, retry: false }),
            ]);
            if (own.status === 'rejected' && published.status === 'rejected') throw own.reason;
            return mergeUsableAgents(
                own.status === 'fulfilled' ? own.value : [],
                published.status === 'fulfilled' ? published.value : [],
            );
        },
    });
}

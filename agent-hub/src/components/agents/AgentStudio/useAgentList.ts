import { useCallback } from 'react';
import type { AgentListRow } from './agentCardFacts';
import { useAgentListQuery } from '@/api/queries/sharedReads';
import { messageOf } from '@/utils/caughtError';

export interface AgentList {
    agents: AgentListRow[];
    loading: boolean;
    loadError: string | null;
    fetchAgents: () => Promise<void>;
}

const NO_AGENTS: AgentListRow[] = [];

/**
 * The agent list of the Studio screen: one read, re-armed by `fetchAgents`.
 * A failed read shows its message and an empty list.
 */
export default function useAgentList(systemMode: boolean): AgentList {
    const query = useAgentListQuery<AgentListRow>(systemMode);
    const { refetch } = query;
    const fetchAgents = useCallback(async () => { await refetch(); }, [refetch]);
    return {
        agents: query.isError ? NO_AGENTS : query.data ?? NO_AGENTS,
        loading: query.isFetching,
        loadError: query.isError ? messageOf(query.error, 'Failed to load') : null,
        fetchAgents,
    };
}

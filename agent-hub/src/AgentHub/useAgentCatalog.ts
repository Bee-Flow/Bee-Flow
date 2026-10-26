import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { agentCatalogOptions, type CatalogCategory } from '../api/queries/hubData';
import type { AgentLike } from './useAgentHubData.types';

const NO_AGENTS: AgentLike[] = [];
const NO_CATEGORIES: CatalogCategory[] = [];

/**
 * The agents the hub lists (published + the user's own) and their categories.
 * `refreshAgents()` re-reads them and resolves with the merged list, or null
 * when nothing could be read (the last known list stays on screen then).
 */
export default function useAgentCatalog() {
    const query = useQuery(agentCatalogOptions<AgentLike>());
    const { refetch } = query;
    const refreshAgents = useCallback(async (): Promise<AgentLike[] | null> => {
        const result = await refetch();
        return result.data?.agents ?? null;
    }, [refetch]);
    return {
        agents: query.data?.agents ?? NO_AGENTS,
        agentCategories: query.data?.categories ?? NO_CATEGORIES,
        refreshAgents,
    };
}

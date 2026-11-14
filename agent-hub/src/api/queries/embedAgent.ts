// The public embed's agent read, once per agent id.

import { useQuery } from '@tanstack/react-query';
import { fetchEmbedAgent } from '../embedApi';
import { READ_ONCE, statusAnswer, type StatusAnswer } from './readOnce';

/** The embed payload of an agent with its HTTP status; a network failure is the query's error. */
export function useEmbedAgentQuery<T>(agentId: string) {
    return useQuery<StatusAnswer<T>, Error>({
        queryKey: ['embed', 'agent', agentId],
        ...READ_ONCE,
        queryFn: async () => statusAnswer<T>(await fetchEmbedAgent(agentId)),
    });
}

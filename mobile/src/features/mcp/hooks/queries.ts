/** MCP queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import { getMcpTokenStatus, listMcpServers } from '../api/endpoints';
import { mcpKeys } from '../api/keys';

export function useMcpToken() {
    return useQuery({
        queryKey: mcpKeys.token,
        queryFn: ({ signal }) => getMcpTokenStatus(signal),
    });
}

export function useMcpServers() {
    return useQuery({
        queryKey: mcpKeys.servers,
        queryFn: ({ signal }) => listMcpServers(signal),
    });
}

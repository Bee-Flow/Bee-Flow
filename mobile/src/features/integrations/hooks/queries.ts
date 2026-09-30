/** Integration queries. Screens call these, never useQuery directly. */

import { useQueries, useQuery } from '@tanstack/react-query';

import { getIntegrationStatus, getUserSettings } from '../api/endpoints';
import { integrationKeys } from '../api/keys';
import { CONNECTORS } from '../model/catalog';

/**
 * One query per connector rather than one combined query: they are five
 * independent endpoints with five shapes, any of which may 403 on its own,
 * and a combined query would let one refusal blank the other four. The
 * results are in CONNECTORS order.
 */
export function useConnectorStatuses() {
    return useQueries({
        queries: CONNECTORS.map((connector) => ({
            queryKey: integrationKeys.status(connector.provider),
            queryFn: ({ signal }: { signal: AbortSignal }) =>
                getIntegrationStatus(connector.provider, signal),
            staleTime: 30_000,
            retry: false,
        })),
    });
}

export function useUserSettings() {
    return useQuery({
        queryKey: integrationKeys.userSettings,
        queryFn: ({ signal }) => getUserSettings(signal),
        staleTime: 60_000,
    });
}

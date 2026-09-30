/** Reads for the integrations hub and its Nextcloud tool switches. Admins only (the screens decide). */

import { useQuery } from '@tanstack/react-query';

import { getActiveFeatures, getHasMapsKey, getNcIntegrationGroups, getNcIntegrations } from '../api/integrations';
import { integrationKeys } from '../api/keys';

export function useHasMapsKey(enabled: boolean) {
    return useQuery({ queryKey: integrationKeys.mapsKey, queryFn: ({ signal }) => getHasMapsKey(signal), enabled });
}

export function useNcIntegrations(orgId: string | null) {
    return useQuery({
        queryKey: integrationKeys.ncIntegrations(orgId ?? 'none'),
        queryFn: ({ signal }) => getNcIntegrations(orgId as string, signal),
        enabled: Boolean(orgId),
        retry: false,
    });
}

export function useNcIntegrationGroups(orgId: string | null) {
    return useQuery({
        queryKey: integrationKeys.ncIntegrationGroups(orgId ?? 'none'),
        queryFn: ({ signal }) => getNcIntegrationGroups(orgId as string, signal),
        enabled: Boolean(orgId),
        retry: false,
    });
}

export function useActiveFeatures(enabled: boolean) {
    return useQuery({
        queryKey: integrationKeys.activeFeatures,
        queryFn: ({ signal }) => getActiveFeatures(signal),
        enabled,
        retry: false,
    });
}

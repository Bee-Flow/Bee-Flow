/** The Azure configuration's reads and writes (self-hosted org admins; the screens decide). */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getAzureConfig, saveAzureSection, saveAzureSyncSettings, syncAzureGroups, type AzureSectionBody } from '../api/azure';
import { integrationKeys } from '../api/keys';
import type { AzureConfig, AzureGroupSyncSettings } from '../model/azureTypes';

function requireOrg(orgId: string | null): string {
    if (!orgId) throw new Error('No organisation');
    return orgId;
}

export function useAzureConfig(orgId: string | null) {
    return useQuery({
        queryKey: integrationKeys.azure(orgId ?? 'none'),
        queryFn: ({ signal }) => getAzureConfig(orgId as string, signal),
        enabled: Boolean(orgId),
        retry: false,
    });
}

/** A section save answers `{ ok }` only, so the configuration is re-read before it resolves. */
export function useSaveAzureSection(orgId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: AzureSectionBody) => saveAzureSection(requireOrg(orgId), body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: integrationKeys.azure(orgId ?? 'none') }),
    });
}

export function useSyncAzureGroups(orgId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => syncAzureGroups(requireOrg(orgId)),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: integrationKeys.azure(orgId ?? 'none') }),
    });
}

/** One sync setting at a time, saved at once; the answer is the stored settings, adopted as-is. */
export function useSaveAzureSyncSettings(orgId: string | null) {
    const queryClient = useQueryClient();
    const key = integrationKeys.azure(orgId ?? 'none');
    return useMutation({
        mutationFn: (patch: Partial<AzureGroupSyncSettings>) => saveAzureSyncSettings(requireOrg(orgId), patch),
        onSuccess: (groupSyncSettings) =>
            queryClient.setQueryData<AzureConfig>(key, (old) => (old ? { ...old, groupSyncSettings } : old)),
    });
}

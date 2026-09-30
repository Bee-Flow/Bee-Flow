/**
 * Writes for the integrations hub and the Nextcloud tool switches. The
 * per-group switch is optimistic, as on the web (OrgNcIntegrationsPanel's
 * toggleGroupDisable): the list flips at once and flips back if the save fails.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { saveMapsKey, saveNcGroupDisabled, saveNcIntegrations } from '../api/integrations';
import { integrationKeys } from '../api/keys';
import type { NcIntegrationGroup } from '../model/types';

function requireOrg(orgId: string | null): string {
    if (!orgId) throw new Error('No organisation');
    return orgId;
}

export function useSaveMapsKey() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (key: string) => saveMapsKey(key),
        onSuccess: () => queryClient.setQueryData(integrationKeys.mapsKey, true),
    });
}

export function useSaveNcIntegrations(orgId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (enabled: string[]) => saveNcIntegrations(requireOrg(orgId), enabled),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: integrationKeys.ncIntegrations(orgId ?? 'none') }),
    });
}

export function useSetNcGroupDisabled(orgId: string | null) {
    const queryClient = useQueryClient();
    const key = integrationKeys.ncIntegrationGroups(orgId ?? 'none');
    return useMutation({
        mutationFn: ({ groupId, disabled }: { groupId: string; disabled: string[] }) =>
            saveNcGroupDisabled(requireOrg(orgId), groupId, disabled),
        onMutate: async ({ groupId, disabled }) => {
            await queryClient.cancelQueries({ queryKey: key });
            const before = queryClient.getQueryData<NcIntegrationGroup[]>(key);
            queryClient.setQueryData<NcIntegrationGroup[]>(key, (groups) =>
                groups?.map((g) => (g.id === groupId ? { ...g, disabledIntegrations: disabled } : g)),
            );
            return { before };
        },
        onError: (_err, _vars, context) => queryClient.setQueryData(key, context?.before),
    });
}

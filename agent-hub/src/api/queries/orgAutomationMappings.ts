// The organisation setting "Update mappings automatically when an automation
// is opened" (M8b of the data-mapping work). The server side is
// routes/orgAutomationMappings.js (storage and the rule in
// automation/mappingSettings.js): members read it, an org admin changes it.
// The builder never reads it: the server decides on each open
// (POST /api/automation/:id/upgrade-mappings with `auto: true`).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';

export interface OrgAutomationMappingSettings {
    /** Apply the provably-equal mapping update when someone who may edit an automation opens it. */
    autoUpgradeOnOpen: boolean;
    /** Saved at least once, rather than the product default (off). */
    configured: boolean;
}

const BASE = '/api/org-automation-mappings';

export const orgAutomationMappingsKeys = {
    org: (orgId: string) => ['orgAutomationMappings', orgId] as const,
};

function parse(body: unknown): OrgAutomationMappingSettings | null {
    const b = body && typeof body === 'object' ? body as Record<string, unknown> : null;
    if (!b || typeof b.autoUpgradeOnOpen !== 'boolean') return null;
    return { autoUpgradeOnOpen: b.autoUpgradeOnOpen, configured: b.configured === true };
}

export function useOrgAutomationMappings(orgId: string | null | undefined) {
    return useQuery<OrgAutomationMappingSettings, Error>({
        queryKey: orgAutomationMappingsKeys.org(orgId || ''),
        enabled: !!orgId,
        queryFn: async ({ signal }) => {
            const body = parse(await apiClient.get<unknown>(`${BASE}/${encodeURIComponent(orgId!)}`, { signal, retry: false }));
            // Never show a guess as the saved setting: no answer is a failed load.
            if (!body) throw new Error('Could not load the mapping update setting');
            return body;
        },
    });
}

export function useSaveOrgAutomationMappings(orgId: string) {
    const qc = useQueryClient();
    return useMutation<OrgAutomationMappingSettings, Error, boolean>({
        mutationFn: async (autoUpgradeOnOpen) => {
            const body = parse(await apiClient.put<unknown>(`${BASE}/${encodeURIComponent(orgId)}`, { autoUpgradeOnOpen }, { retry: false }));
            if (!body) throw new Error('Could not save the mapping update setting');
            return body;
        },
        onSuccess: (saved) => { qc.setQueryData(orgAutomationMappingsKeys.org(orgId), saved); },
    });
}

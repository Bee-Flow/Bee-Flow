// The organisation's switch for real-time co-editing of project notebooks
// and pages. The server side is routes/orgCollab.js (storage and the rule in
// core/collab/settings.js): members read it, an org admin changes it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';

export interface OrgCollabSettings {
    /** The organisation's own switch (what the toggle shows). */
    collabEnabled: boolean;
    /** The operator switched co-editing off for the whole server: off whatever the organisation says. */
    serverDisabled: boolean;
    /** Saved at least once, rather than the product default. */
    configured: boolean;
}

const BASE = '/api/org-collab';

export const orgCollabKeys = {
    org: (orgId: string) => ['orgCollab', orgId] as const,
};

export function useOrgCollab(orgId: string | null | undefined) {
    return useQuery<OrgCollabSettings, Error>({
        queryKey: orgCollabKeys.org(orgId || ''),
        enabled: !!orgId,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<OrgCollabSettings>(`${BASE}/${encodeURIComponent(orgId!)}`, { signal, retry: false });
            // Never show a guess as the saved setting: no answer is a failed load.
            if (!body || typeof body.collabEnabled !== 'boolean') throw new Error('Could not load the co-editing setting');
            return { collabEnabled: body.collabEnabled, serverDisabled: body.serverDisabled === true, configured: body.configured === true };
        },
    });
}

export function useSaveOrgCollab(orgId: string) {
    const qc = useQueryClient();
    return useMutation<OrgCollabSettings, Error, boolean>({
        mutationFn: async (collabEnabled) => {
            const body = await apiClient.put<OrgCollabSettings>(`${BASE}/${encodeURIComponent(orgId)}`, { collabEnabled }, { retry: false });
            if (!body || typeof body.collabEnabled !== 'boolean') throw new Error('Could not save the co-editing setting');
            return body;
        },
        onSuccess: (saved) => { qc.setQueryData(orgCollabKeys.org(orgId), saved); },
    });
}

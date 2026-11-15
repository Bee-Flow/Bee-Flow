// The organisation's switch "images to AI in automations". The server side is
// routes/orgAutomationImageAi.mts (storage and the rule in
// core/automationRunner/imageAiSetting.mts): members read it, an org admin
// changes it. Off by default.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../typedRequest';

export interface OrgImageAiSetting {
    /** Automations may show images to an AI model that reads them. */
    enabled: boolean;
    /** Saved at least once, rather than the product default. */
    configured: boolean;
}

const orgImageAiKeys = {
    org: (orgId: string) => ['orgAutomationImageAi', orgId] as const,
};

/** Never a guess shown as the saved setting: an answer without the switch is a failed load. */
function settingOf(body: unknown, what: string): OrgImageAiSetting {
    const b = body as Partial<OrgImageAiSetting> | null;
    if (!b || typeof b.enabled !== 'boolean') throw new Error(what);
    return { enabled: b.enabled, configured: b.configured === true };
}

export function useOrgAutomationImageAi(orgId: string | null | undefined) {
    return useQuery<OrgImageAiSetting, Error>({
        queryKey: orgImageAiKeys.org(orgId || ''),
        enabled: !!orgId,
        retry: false,
        queryFn: async ({ signal }) => {
            const res = await apiRequest('GET /api/org-automation-image-ai/{orgId}', { params: { orgId: String(orgId) }, init: { signal } });
            return settingOf(await res.json(), 'Could not load the images-to-AI setting');
        },
    });
}

export function useSaveOrgAutomationImageAi(orgId: string) {
    const qc = useQueryClient();
    return useMutation<OrgImageAiSetting, Error, boolean>({
        mutationFn: async (enabled) => {
            const res = await apiRequest('PUT /api/org-automation-image-ai/{orgId}', { params: { orgId }, body: { enabled } });
            return settingOf(await res.json(), 'Could not save the images-to-AI setting');
        },
        onSuccess: (saved) => { qc.setQueryData(orgImageAiKeys.org(orgId), saved); },
    });
}

// Website forms: which automations a CMS `form` block may start. The ONLY place
// that knows the /api/cms/admin/form-automations wire contract
// (server/routes/cmsForms.js). An automation is a candidate when it has a
// webhook trigger; an admin switches it on for website forms here, apart from
// the block that names it, and approves each block that may target it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';

/** A form block that names an automation, as the live site's draft has it. */
interface FormBlockTarget {
    blockId: string;
    pageTitle: string;
    /** True once an admin approved this block for the automation. */
    approved: boolean;
    /** Submissions dropped silently by the honeypot / the minimum form age. */
    drops: { honeypot: number; tooFast: number };
}

export interface FormAutomation {
    id: string;
    title: string;
    /** True once an admin has enabled it for website forms. */
    enabled: boolean;
    blocks: FormBlockTarget[];
}

interface FormAutomationsResponse {
    automations: FormAutomation[];
}

const cmsFormAutomationKeys = {
    all: ['cms-form-automations'] as const,
};

export function useFormAutomationsQuery() {
    return useQuery<FormAutomation[]>({
        queryKey: cmsFormAutomationKeys.all,
        queryFn: async ({ signal }) => {
            const res = await apiClient.get<FormAutomationsResponse>('/api/cms/admin/form-automations', { signal });
            return res?.automations ?? [];
        },
    });
}

/** Switch one automation on or off for website forms. Never retried: it is a write. */
export function useSetFormAutomationEnabled() {
    const qc = useQueryClient();
    return useMutation<unknown, Error, { id: string; enabled: boolean }>({
        mutationFn: ({ id, enabled }) => apiClient.put(
            `/api/cms/admin/form-automations/${encodeURIComponent(id)}`,
            { enabled },
            { retry: false },
        ),
        onSettled: () => qc.invalidateQueries({ queryKey: cmsFormAutomationKeys.all }),
    });
}

/** Approve or withdraw one form block for an automation. */
export function useSetFormBlockApproved() {
    const qc = useQueryClient();
    return useMutation<unknown, Error, { automationId: string; blockId: string; approved: boolean }>({
        mutationFn: ({ automationId, blockId, approved }) => apiClient.put(
            `/api/cms/admin/form-automations/${encodeURIComponent(automationId)}/blocks/${encodeURIComponent(blockId)}`,
            { approved },
            { retry: false },
        ),
        onSettled: () => qc.invalidateQueries({ queryKey: cmsFormAutomationKeys.all }),
    });
}

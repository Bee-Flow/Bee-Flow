// What an organisation's administrators see in Cowork's Organisation panel (server/usecases/coworkOrgPanel.mts,
// server/routes/coworkPolicyRoutes.js): their organisation with this month's AI spend, its Cowork policy, and the check
// of every receipt chain. The policy is read and saved by id, the way the admin settings do it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson, apiUrl } from './typedRequest';

export interface CoworkOrgOverview { orgId: string; name: string; spent: number | null }
export interface OrgCoworkPolicy {
    ceiling: 'asks_everything' | 'asks_before_sending' | 'on_its_own';
    readOnly: boolean;
    /** The apps a task may use while nobody watches; null: every app. */
    unattendedApps: string[] | null;
    monthlyBudget?: number | null;
    habitsAllowed?: boolean;
    autoFix?: boolean;
}
export type OrgPolicyPatch = Partial<Pick<OrgCoworkPolicy, 'readOnly' | 'unattendedApps' | 'monthlyBudget' | 'habitsAllowed' | 'autoFix'>>;
export interface ReceiptsAudit {
    checkedAt: string;
    items: number;
    receipts: number;
    unsigned: number;
    missing: number;
    problems: Array<{ itemId: string; seq: number; kind: 'gap' | 'link' | 'content' | 'signature' }>;
    truncated: boolean;
    ok: boolean;
}

/** The caller's organisation; it fails (403) for someone who does not administer it. */
export function useCoworkOrgOverview() {
    return useQuery<CoworkOrgOverview, Error>({
        queryKey: ['cowork', 'org', 'overview'],
        queryFn: () => apiJson<'GET /api/cowork/policy/mine/org', CoworkOrgOverview>('GET /api/cowork/policy/mine/org'),
        retry: false,
    });
}

/** The organisation's policy, and saving some of it at once. */
export function useOrgCoworkPolicy(orgId: string | undefined) {
    const client = useQueryClient();
    const key = ['cowork', 'org', 'policy', orgId] as const;
    const query = useQuery<OrgCoworkPolicy, Error>({
        queryKey: key,
        enabled: !!orgId,
        queryFn: () => apiJson<'GET /api/cowork/policy/{orgId}', OrgCoworkPolicy>('GET /api/cowork/policy/{orgId}', { params: { orgId: String(orgId) } }),
        retry: false,
    });
    const save = useMutation<OrgCoworkPolicy, Error, OrgPolicyPatch>({
        mutationFn: (patch) => apiJson<'PUT /api/cowork/policy/{orgId}', OrgCoworkPolicy>('PUT /api/cowork/policy/{orgId}', { params: { orgId: String(orgId) }, body: patch }),
        onSuccess: (next) => {
            client.setQueryData(key, next);
            void client.invalidateQueries({ queryKey: ['cowork', 'policy', 'mine'] });
        },
    });
    return { query, save };
}

/** "Check now": every receipt chain of the organisation, read again each time. */
export function useReceiptsAudit() {
    return useMutation<ReceiptsAudit, Error, void>({
        mutationFn: () => apiJson<'GET /api/cowork/policy/mine/receipts-audit', ReceiptsAudit>('GET /api/cowork/policy/mine/receipts-audit'),
    });
}

/** Where the audit downloads as a file. */
export const receiptsAuditDownloadUrl = (): string => `${apiUrl('GET /api/cowork/policy/mine/receipts-audit')}?download=true`;

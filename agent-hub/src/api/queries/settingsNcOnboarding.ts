// The two reads that pre-fill the Nextcloud onboarding wizard: the organisation
// row (a non-ok answer is `null`, so the wizard falls back to the bootstrap data;
// a network failure is a query error and leaves the form blank) and the groups
// of the linked Nextcloud (a non-ok answer or a failure is an empty list).

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

const ncOnboardingKeys = {
    org: (orgId: string | undefined) => ['settings', 'nc-onboarding', 'org', orgId] as const,
    groups: (orgId: string | undefined) => ['settings', 'nc-onboarding', 'groups', orgId] as const,
};

export interface NcOnboardingOrg {
    name?: string;
    email?: string;
    tagline?: string;
    description?: string;
    address?: string;
    phone?: string;
    website?: string;
    kvk?: string;
    vat?: string;
}

export function useNcOnboardingOrg(orgId: string | undefined) {
    return useQuery<NcOnboardingOrg | null, Error>({
        queryKey: ncOnboardingKeys.org(orgId),
        enabled: !!orgId,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/auth/organizations/${orgId}`);
            return res.ok ? await res.json() : null;
        },
        staleTime: 0,
        retry: false,
    });
}

export function useNcSyncGroups(orgId: string | undefined) {
    return useQuery<string[], Error>({
        queryKey: ncOnboardingKeys.groups(orgId),
        enabled: !!orgId,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/auth/admin/${orgId}/nc-sync/groups`);
                const j = res.ok ? await res.json() : { groups: [] };
                return j.groups || [];
            } catch {
                return [];
            }
        },
        staleTime: 0,
        retry: false,
    });
}

// The reads behind the organisation form: the organisations and groups the
// caller can see (each `[]` when refused), and the caller's current
// organisation id from /auth/user (the cached user prop can predate an org
// rename or a re-binding). Asked anew each time the form loads.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { settled } from '../settled';
import { apiUrl } from '../typedRequest';

export function useOrgFormReads<O, G>() {
    const qc = useQueryClient();
    const readOrgsAndGroups = useCallback(() => qc.fetchQuery<{ orgs: O[]; groups: G[] }>({
        queryKey: ['org-info', 'orgs-and-groups'],
        queryFn: async () => {
            const [orgsRes, groupsRes] = await Promise.all([
                settled(apiUrl('GET /auth/organizations'), undefined, 'empty'),
                settled(apiUrl('GET /auth/groups'), undefined, 'empty'),
            ]);
            const orgs: O[] = orgsRes.ok ? await orgsRes.res.json() : [];
            const groups: G[] = groupsRes.ok ? await groupsRes.res.json() : [];
            return { orgs, groups };
        },
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
    const readCurrentOrgId = useCallback(() => qc.fetchQuery<string | null>({
        queryKey: ['org-info', 'current-user-org'],
        queryFn: async () => {
            const fresh = await settled(apiUrl('GET /auth/user'), undefined, 'empty').then(r => (r.ok ? r.res.json() : null));
            return fresh?.user?.organizationId || null;
        },
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
    return { readOrgsAndGroups, readCurrentOrgId };
}

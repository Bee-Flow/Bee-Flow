/**
 * The org's groups for the sharing sheet, read once per session and shared by
 * every screen that offers "specific groups" (a skill, a knowledge base).
 * `data === null` is a read that failed or was refused — see core/api/orgGroups.
 */

import { useQuery } from '@tanstack/react-query';

import { fetchOrgGroups } from '@/core/api/orgGroups';

export const ORG_GROUPS_KEY = ['org', 'groups', 'sharing'] as const;

export function useOrgGroups(enabled = true) {
    return useQuery({
        queryKey: ORG_GROUPS_KEY,
        queryFn: ({ signal }) => fetchOrgGroups(signal),
        enabled,
        staleTime: 5 * 60_000,
    });
}

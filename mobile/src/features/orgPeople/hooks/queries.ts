/**
 * The people surface's reads. Screens call these, never useQuery. `enabled`
 * is the caller's gate: every one of these answers 403 to someone who is not
 * an organisation administrator, and a screen that will 403 is not asked.
 */

import { useQuery } from '@tanstack/react-query';

import {
    getCustomTiersList,
    getGroupAccess,
    getOrgCustomTiers,
    getOrgRoles,
    listGroups,
    listInvitations,
    listMembers,
    listModelOptions,
} from '../api/endpoints';
import { peopleKeys } from '../api/keys';

const FIVE_MINUTES = 5 * 60_000;

export function useMembers(enabled: boolean) {
    return useQuery({
        queryKey: peopleKeys.members,
        queryFn: ({ signal }) => listMembers(signal),
        enabled,
        retry: false,
    });
}

export function useGroups(enabled: boolean) {
    return useQuery({
        queryKey: peopleKeys.groups,
        queryFn: ({ signal }) => listGroups(signal),
        enabled,
        retry: false,
    });
}

export function useInvitations(enabled: boolean) {
    return useQuery({
        queryKey: peopleKeys.invitations,
        queryFn: ({ signal }) => listInvitations(signal),
        enabled,
        retry: false,
    });
}

export function useOrgRoles(enabled: boolean) {
    return useQuery({
        queryKey: peopleKeys.roles,
        queryFn: ({ signal }) => getOrgRoles(signal),
        enabled,
        retry: false,
        staleTime: FIVE_MINUTES,
    });
}

/** The custom tiers a group may be limited to (global and the org's own). */
export function useCustomTiersList(enabled: boolean) {
    return useQuery({
        queryKey: peopleKeys.customTiersList,
        queryFn: ({ signal }) => getCustomTiersList(signal),
        enabled,
        staleTime: FIVE_MINUTES,
    });
}

export function useOrgTiers(enabled: boolean) {
    return useQuery({
        queryKey: peopleKeys.orgTiers,
        queryFn: ({ signal }) => getOrgCustomTiers(signal),
        enabled,
        retry: false,
    });
}

/** Every provider's models, for the tier sheet's pickers. */
export function useModelOptions(enabled: boolean) {
    return useQuery({
        queryKey: peopleKeys.models,
        queryFn: ({ signal }) => listModelOptions(signal),
        enabled,
        staleTime: FIVE_MINUTES,
    });
}

export function useGroupAccess(orgId: string | null, enabled: boolean) {
    return useQuery({
        queryKey: peopleKeys.access(orgId ?? 'none'),
        queryFn: ({ signal }) => getGroupAccess(orgId ?? '', signal),
        enabled: enabled && Boolean(orgId),
        retry: false,
    });
}

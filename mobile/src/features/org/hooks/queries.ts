/** Organisation queries. Screens call these, never useQuery directly. */

import { useQuery } from '@tanstack/react-query';

import {
    getGuardStatus,
    getLicenseHealth,
    getOrganization,
    getOrgShield,
    getUserShield,
    listDsrRequests,
    listGroups,
    listOrgMembers,
} from '../api/endpoints';
import { orgKeys } from '../api/keys';

/** Org-admin only; a member's null answer is rendered, not retried. */
export function useOrganization(orgId: string | null) {
    return useQuery({
        queryKey: orgKeys.org(orgId ?? 'none'),
        queryFn: ({ signal }) => (orgId ? getOrganization(orgId, signal) : Promise.resolve(null)),
        enabled: Boolean(orgId),
        staleTime: 5 * 60_000,
    });
}

/**
 * The roster. `enabled` is the caller's org-admin check: the endpoint 403s for
 * anyone else, and a screen that will 403 is not asked for. `staleTime` is per
 * caller, spread so that omitting it keeps the client's default.
 */
export function useOrgMembers({ enabled, staleTime }: { enabled: boolean; staleTime?: number }) {
    return useQuery({
        queryKey: orgKeys.members,
        queryFn: ({ signal }) => listOrgMembers(signal),
        enabled,
        retry: false,
        ...(staleTime === undefined ? {} : { staleTime }),
    });
}

export function useOrgGroups(enabled: boolean) {
    return useQuery({
        queryKey: orgKeys.groups,
        queryFn: ({ signal }) => listGroups(signal),
        enabled,
        retry: false,
        staleTime: 5 * 60_000,
    });
}

export function useUserShield() {
    return useQuery({
        queryKey: orgKeys.userShield,
        queryFn: ({ signal }) => getUserShield(signal),
    });
}

export function useGuardStatus() {
    return useQuery({
        queryKey: orgKeys.guardStatus,
        queryFn: ({ signal }) => getGuardStatus(signal),
        staleTime: 60_000,
        retry: false,
    });
}

export function useOrgShield(orgId: string | null) {
    return useQuery({
        queryKey: orgKeys.shield(orgId ?? 'none'),
        queryFn: ({ signal }) => (orgId ? getOrgShield(orgId, signal) : Promise.resolve(null)),
        enabled: Boolean(orgId),
        staleTime: 5 * 60_000,
        retry: false,
    });
}

/** Needs `admin_compliance`; the caller passes that check as `enabled`. */
export function useDsrRequests(enabled: boolean) {
    return useQuery({
        queryKey: orgKeys.dsr,
        queryFn: ({ signal }) => listDsrRequests(signal),
        enabled,
        retry: false,
    });
}

/** Org-admin only; the caller passes that check as `enabled`. */
export function useLicenseHealth(enabled: boolean) {
    return useQuery({
        queryKey: orgKeys.licenseHealth,
        queryFn: ({ signal }) => getLicenseHealth(signal),
        enabled,
        retry: false,
        staleTime: 5 * 60_000,
    });
}

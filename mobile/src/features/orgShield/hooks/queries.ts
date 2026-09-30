/** The org shield's reads. Screens call these, never useQuery directly. */

import { useQuery } from '@tanstack/react-query';

import { getGuardStatus, getShieldActivity, getShieldDoc, getShieldEnv } from '../api/endpoints';
import { orgShieldKeys } from '../api/keys';

export function useShieldDoc(orgId: string | null) {
    return useQuery({
        queryKey: orgShieldKeys.doc(orgId ?? 'none'),
        queryFn: ({ signal }) => (orgId ? getShieldDoc(orgId, signal) : Promise.resolve(null)),
        enabled: Boolean(orgId),
    });
}

/** Self-scoped and cheap. A failure leaves it undefined, which renders nothing:
 *  an unreachable status endpoint is not evidence of an unreachable guard. */
export function useGuardStatus(enabled: boolean) {
    return useQuery({
        queryKey: orgShieldKeys.guard,
        queryFn: ({ signal }) => getGuardStatus(signal),
        enabled,
        staleTime: 60_000,
        retry: false,
    });
}

export function useShieldEnv(enabled: boolean) {
    return useQuery({
        queryKey: orgShieldKeys.env,
        queryFn: ({ signal }) => getShieldEnv(signal),
        enabled,
        staleTime: 5 * 60_000,
        retry: false,
    });
}

/** Fetched only while the tab is open and the licence allows it. */
export function useShieldActivity(days: number, enabled: boolean) {
    return useQuery({
        queryKey: orgShieldKeys.activity(days),
        queryFn: ({ signal }) => getShieldActivity(days, signal),
        enabled,
    });
}

// The two reads the sign-in screen makes before anyone signs in: what the
// deployment offers (/auth/setup-status) and the public organisation list.
// Asked once per mount (no refetch on focus or reconnect); a failure is not
// retried, the screen then shows its safe defaults.

import { useQuery } from '@tanstack/react-query';
import { getPublicOrganizations, getSetupStatus } from '../loginRequests';

const loginKeys = {
    setupStatus: ['login', 'setup-status'] as const,
    publicOrganizations: ['login', 'public-organizations'] as const,
};

const ONCE_PER_MOUNT = { staleTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

/** The setup-status answer; null when the server answered with an error status. A network failure errors. */
export function useSetupStatusQuery<T>() {
    return useQuery<T | null, Error>({
        queryKey: loginKeys.setupStatus,
        ...ONCE_PER_MOUNT,
        queryFn: async () => {
            try {
                const res = await getSetupStatus();
                return res.ok ? (await res.json()) as T : null;
            } catch (err) {
                console.error('Failed to check setup status:', err);
                throw err;
            }
        },
    });
}

/** The organisations a signup may join; null when the server answered with an error status. Only asked when `enabled`. */
export function usePublicOrganizationsQuery(enabled: boolean) {
    return useQuery<unknown[] | null, Error>({
        queryKey: loginKeys.publicOrganizations,
        enabled,
        ...ONCE_PER_MOUNT,
        queryFn: async () => {
            const res = await getPublicOrganizations();
            return res.ok ? (await res.json()) as unknown[] : null;
        },
    });
}

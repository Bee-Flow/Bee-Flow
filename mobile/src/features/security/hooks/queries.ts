/** Two-factor queries. Screens call these, never useQuery directly. */

import { useQuery } from '@tanstack/react-query';

import { getMfaStatus, startMfaSetup } from '../api/endpoints';
import { securityKeys } from '../api/keys';

/**
 * Is two-factor on? `retry: false` plus a nullable read means a server that
 * refuses still leaves a working screen. `staleTime` is per caller: a screen
 * that only shows a status line can hold it longer than Security itself.
 */
export function useMfaStatus(options: { staleTime?: number } = {}) {
    return useQuery({
        queryKey: securityKeys.mfa,
        queryFn: ({ signal }) => getMfaStatus(signal),
        retry: false,
        // Spread, not `staleTime: undefined`: an explicit undefined would
        // override the client's default instead of falling back to it.
        ...(options.staleTime === undefined ? {} : { staleTime: options.staleTime }),
    });
}

/**
 * The pending enrolment secret and its QR. Only minted while the sheet is
 * actually open — a pending secret is session state, not something to create
 * on a screen visit.
 */
export function useMfaSetup(open: boolean) {
    return useQuery({
        queryKey: securityKeys.mfaSetup,
        queryFn: () => startMfaSetup(false),
        enabled: open,
        staleTime: 5 * 60_000,
        retry: false,
    });
}

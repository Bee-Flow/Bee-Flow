/** Branding queries. Screens and the boot-time sync call these. */

import { useQuery } from '@tanstack/react-query';

import { getBranding, getPublicBranding } from '../api/endpoints';
import { brandingKeys } from '../api/keys';

/** The account's effective branding, for the Appearance screen. */
export function useBranding() {
    return useQuery({
        queryKey: brandingKeys.effective,
        queryFn: ({ signal }) => getBranding(signal),
        staleTime: 5 * 60_000,
    });
}

/**
 * The branding to paint the app with right now: the account's once signed in,
 * the public subset before that — which is what makes the LOGIN screen match
 * the org too. `known` is false while the auth layer is still settling: firing
 * then races the session-token install and answers 401 for no reason.
 */
export function useActiveBranding({ signedIn, known }: { signedIn: boolean; known: boolean }) {
    return useQuery({
        queryKey: signedIn ? brandingKeys.effective : brandingKeys.public,
        queryFn: ({ signal }) => (signedIn ? getBranding(signal) : getPublicBranding(signal)),
        enabled: known,
        staleTime: 5 * 60_000,
        // A themed app that cannot reach its server is not broken — it just
        // keeps the theme it cached. Retrying hard would delay nothing useful.
        retry: 1,
    });
}

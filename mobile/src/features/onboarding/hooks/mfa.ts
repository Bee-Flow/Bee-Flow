/**
 * TOTP enrolment during sign-in, over the security feature's MFA endpoints.
 *
 * The endpoints answer null for "nothing usable came back", which the
 * signed-in Security sheet renders as nothing to show. Sign-in cannot go on
 * without a secret or a confirmation, so here those are errors, and the
 * screen offers to start over. Neither call retries during sign-in.
 */

import { useMutation, useQuery } from '@tanstack/react-query';

import { translate } from '@/core/i18n';
import { enableMfa, startMfaSetup, type MfaSetup } from '@/features/security';

import { onboardingKeys } from '../api/keys';

export interface MfaSetupData extends MfaSetup {
    /** Device clock minus server clock, measured at the moment of the answer. */
    driftMs: number;
}

/** POST /auth/mfa/enable, confirmed. The recovery codes come back exactly once, here. */
export interface MfaEnableResponse {
    success: boolean;
    recoveryCodes: string[];
}

async function requireSetup(force: boolean): Promise<MfaSetup> {
    const res = await startMfaSetup(force, { retry: false });
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and an error message about a missing setup secret, not a secret
    if (!res?.secret) throw new Error(translate('mobile.onboarding.mfa_no_secret', 'The server did not return a setup secret.'));
    return res;
}

async function requireEnabled(code: string): Promise<MfaEnableResponse> {
    const res = await enableMfa(code, { retry: false });
    if (!res?.success) throw new Error(translate('mobile.onboarding.mfa_not_confirmed', 'The server did not confirm the enrolment.'));
    return { success: true, recoveryCodes: res.recoveryCodes ?? [] };
}

/**
 * The pending TOTP secret. The secret is stable server-side for ten minutes,
 * and re-fetching it is exactly the desync the enrolment screen exists to
 * avoid — so it is never refetched on its own. A missing server clock reads
 * as NaN drift: no warning.
 */
export function useMfaSetup() {
    return useQuery<MfaSetupData>({
        queryKey: onboardingKeys.mfaSetup,
        queryFn: async () => {
            const res = await requireSetup(false);
            return { ...res, driftMs: Date.now() - (res.serverTime ?? Number.NaN) };
        },
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        retry: false,
    });
}

export function useEnableMfa(handlers: { onSuccess: (result: MfaEnableResponse) => void; onError: () => void }) {
    return useMutation({
        mutationFn: (code: string) => requireEnabled(code),
        onSuccess: handlers.onSuccess,
        onError: handlers.onError,
    });
}

/** Discards the pending secret and mints another; `onRestarted` re-reads it. */
export function useRestartMfaSetup(onRestarted: () => Promise<unknown>) {
    return useMutation({
        mutationFn: () => requireSetup(true),
        onSuccess: async () => {
            await onRestarted();
        },
    });
}

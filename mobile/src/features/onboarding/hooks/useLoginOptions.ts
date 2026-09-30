/**
 * What this instance offers at the login screen, merged from its two sources:
 * `oauthProviders` on the signed-out stage (from /auth/user) and
 * /auth/setup-status, the only place Google and Microsoft are reported. An
 * instance with Google configured but an empty `oauthProviders` is normal, so
 * trusting either source alone hides a button the user needs.
 */

import { useAuth } from '@/core/auth/AuthProvider';

import { useSetupStatus } from './queries';
import { resolveProviders } from '../api/sso';

export function useLoginOptions() {
    const { stage } = useAuth();
    const status = useSetupStatus();
    const data = status.data ?? null;
    return {
        providers: resolveProviders(stage.kind === 'signed-out' ? stage.oauthProviders : [], data),
        // `allowPasswordLogin` is an operator kill switch (ALLOW_PASSWORD_LOGIN).
        // Until /auth/setup-status answers, assume the form is allowed — hiding
        // it and then showing it is worse than showing it and then hiding it.
        passwordAllowed: data?.allowPasswordLogin !== false,
        instanceName: data?.branding?.name ?? null,
        allowSignups: Boolean(data?.allowSignups),
        waitlist: Boolean(data?.waitlistEnabled),
    };
}

/**
 * The endpoints the signed-out screens talk to.
 *
 * Paths are the FULL client-visible ones. `server/index.js` mounts the auth
 * router at `/auth` and the MFA router at `/auth/mfa`, so a handler declared as
 * `router.post('/enable')` in `auth/mfaRoutes.js` is reached at
 * `/auth/mfa/enable`. The router files read as if they were mounted at the
 * root, which is the easiest way to get a path wrong here.
 *
 * Sign-in itself is NOT here — that lives in src/core/auth/api.ts behind
 * `useAuth()`, because the stage machine owns it. This module is only the
 * things around the edges of a sign-in: what the instance allows and the two
 * "send me another email" endpoints. TOTP enrolment reads the security
 * feature's MFA endpoints (hooks/mfa.ts).
 */

import { api } from '@/core/api/client';

import { readSetupStatus, type SetupStatus } from './readers';

export async function fetchSetupStatus(signal?: AbortSignal): Promise<SetupStatus | null> {
    return readSetupStatus(await api.get<unknown>('/auth/setup-status', { signal }));
}

/**
 * POST /auth/forgot-password — always answers 200, whether or not the address
 * exists (server/auth/login/passwordResetRoutes.js). The screen must not
 * pretend otherwise: "if that address has an account, a link is on its way" is
 * the only honest confirmation, and saying more would turn this into an
 * account-enumeration oracle.
 *
 * The reset link itself lands on the WEB app (`/login?reset=<token>`), so the
 * phone hands the user off to their mailbox and their browser from here.
 */
export async function requestPasswordReset(email: string): Promise<void> {
    await api.post('/auth/forgot-password', { email }, { retry: false });
}

/**
 * POST /auth/resend-verification — same constant-response contract, plus a
 * server-side 60-second throttle that silently does nothing if a token was
 * issued more recently than that. The screen mirrors the 60 seconds in its own
 * cooldown so a second tap is not a lie.
 */
export async function resendVerificationEmail(email: string): Promise<void> {
    await api.post('/auth/resend-verification', { email }, { retry: false });
}

/**
 * The endpoints the signed-out screens talk to.
 *
 * Paths are the FULL client-visible ones. `server/index.js` mounts the auth
 * router at `/auth` (line 434) and the MFA router at `/auth/mfa` (line 439),
 * so a handler declared as `router.post('/enable')` in `auth/mfaRoutes.js` is
 * reached at `/auth/mfa/enable`. The router files read as if they were mounted
 * at the root, which is the easiest way to get a path wrong here.
 *
 * Sign-in itself is NOT here — that lives in src/auth/api.ts behind
 * `useAuth()`, because the stage machine owns it. This module is only the
 * things around the edges of a sign-in: what the instance allows, the two
 * "send me another email" endpoints, and TOTP enrolment.
 */

import { api } from '../../api/client';

export const onboardingKeys = {
    /** What this instance permits before anyone has signed in. */
    setupStatus: ['onboarding', 'setup-status'] as const,
    /** The pending TOTP secret for the current enrolment attempt. */
    mfaSetup: ['onboarding', 'mfa-setup'] as const,
};

/**
 * GET /auth/setup-status — the pre-auth capability document
 * (server/auth/login/setupRoutes.js).
 *
 * Public by design: the login screen has to know whether to offer a password
 * form, an SSO button or a sign-up link before it can authenticate anyone.
 * Every field below is one the login screen branches on; the rest of the
 * payload (locales, captcha config) is web-only.
 */
export interface SetupStatus {
    /** False on a brand-new instance whose operator password is unset. */
    isSetupComplete: boolean;
    /** Legacy Nextcloud OAuth (config.oauth), distinct from the two below. */
    isOAuthConfigured: boolean;
    isGoogleConfigured: boolean;
    isMicrosoftConfigured: boolean;
    deploymentMode: 'cloud' | 'self-hosted' | string;
    /** Self-host only: the single tenant's logo and name, for the login card. */
    branding: { logo: string | null; name: string | null } | null;
    /** Already folded together with the ALLOW_SIGNUPS kill switch server-side. */
    allowSignups: boolean;
    allowPasswordLogin: boolean;
    waitlistEnabled: boolean;
    /** Which methods a consumer account may use: 'password' | 'google' | 'microsoft'. */
    consumerLoginMethods: string[];
}

export async function fetchSetupStatus(signal?: AbortSignal): Promise<SetupStatus | null> {
    return api.get<SetupStatus>('/auth/setup-status', { signal });
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

/**
 * POST /auth/mfa/setup — mints (or re-serves) the pending TOTP secret.
 *
 * The secret lives in the SESSION and is not persisted until /enable accepts a
 * code, and the route is idempotent for ten minutes: re-mounting this screen
 * returns the SAME secret rather than desyncing the QR on screen from the
 * secret the server will check (the BFSF-274 failure mode, where every code
 * read as "invalid"). Pass `force` only for an explicit "start over".
 */
export interface MfaSetupResponse {
    /** otpauth://totp/... — what the QR encodes. */
    otpauthUrl: string;
    /** A PNG data URL the server rendered. Our own SVG is preferred; this is the fallback. */
    qr: string;
    /** Base32 secret, for typing into an authenticator by hand. */
    secret: string;
    /** Server clock in ms, so the screen can warn about device drift. */
    serverTime: number;
}

export async function startMfaSetup(force = false): Promise<MfaSetupResponse> {
    const res = await api.post<MfaSetupResponse>('/auth/mfa/setup', { force }, { retry: false });
    if (!res?.secret) throw new Error('The server did not return a setup secret.');
    return res;
}

/**
 * POST /auth/mfa/enable — verifies a code against the pending secret and, only
 * then, persists it. The recovery codes come back exactly once, in this
 * response; there is no endpoint that will ever show them again.
 */
export interface MfaEnableResponse {
    success: boolean;
    recoveryCodes: string[];
}

export async function enableMfa(code: string): Promise<MfaEnableResponse> {
    const res = await api.post<MfaEnableResponse>('/auth/mfa/enable', { code }, { retry: false });
    if (!res?.success) throw new Error('The server did not confirm the enrolment.');
    return { success: true, recoveryCodes: res.recoveryCodes ?? [] };
}

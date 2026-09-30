/**
 * Contract readers for the pre-auth answers: the setup document, the SSO
 * pickup and the encryption PIN routes (auth/opaqueRoutes.js, auth/sso*).
 *
 * The setup document drives what the login screen OFFERS, so its readers
 * keep "the server did not say" apart from "the server said no": an absent
 * `allowPasswordLogin` must still show the password form.
 */

import { field, nullable, shapeOf } from '@/core/api/contract';
import { readWrappedKey } from '@/core/auth/readers';
import type { WrappedKey } from '@/core/crypto/keys';

/**
 * GET /auth/setup-status — the pre-auth capability document
 * (server/auth/login/setupRoutes.js). Public by design: the login screen has
 * to know whether to offer a password form, an SSO button or a sign-up link
 * before it can authenticate anyone.
 */
export interface SetupStatus {
    /** False on a brand-new instance whose operator password is unset. */
    isSetupComplete?: boolean;
    /** Legacy Nextcloud OAuth (config.oauth), distinct from the two below. */
    isOAuthConfigured?: boolean;
    isGoogleConfigured?: boolean;
    isMicrosoftConfigured?: boolean;
    deploymentMode?: string;
    /** Self-host only: the single tenant's logo and name, for the login card. */
    branding: { logo: string | null; name: string | null } | null;
    /** Already folded together with the ALLOW_SIGNUPS kill switch server-side. */
    allowSignups?: boolean;
    /** An operator kill switch (ALLOW_PASSWORD_LOGIN); absent means allowed. */
    allowPasswordLogin?: boolean;
    waitlistEnabled?: boolean;
    /** Which methods a consumer account may use: 'password' | 'google' | 'microsoft'. */
    consumerLoginMethods: string[];
}

const readBranding = nullable(shapeOf({ logo: field.strOrNull, name: field.strOrNull }));

export const readSetupStatus: (raw: unknown) => SetupStatus | null = nullable(
    shapeOf({
        isSetupComplete: field.optBool,
        isOAuthConfigured: field.optBool,
        isGoogleConfigured: field.optBool,
        isMicrosoftConfigured: field.optBool,
        deploymentMode: field.optStr,
        branding: readBranding,
        allowSignups: field.optBool,
        allowPasswordLogin: field.optBool,
        waitlistEnabled: field.optBool,
        consumerLoginMethods: field.strArray,
    }),
);

/** GET /auth/login-pickup: the bridge token once the browser leg is done. */
export const readPickup: (raw: unknown) => { sessionToken?: string; pending?: boolean } | null = nullable(
    shapeOf({ sessionToken: field.optStr, pending: field.optBool }),
);

/** POST /auth/opaque/pin/register/start. */
export const readRegistrationStart: (raw: unknown) => { registrationResponse?: string } | null = nullable(
    shapeOf({ registrationResponse: field.optStr }),
);

/** POST /auth/opaque/pin/login/start: an OPAQUE answer, or "this account has no PIN yet". */
export const readPinLoginStart: (raw: unknown) => {
    needsSetup?: boolean;
    loginResponse?: string;
    loginId?: string;
    wrappedDEK: WrappedKey | null;
} | null = nullable(
    shapeOf({
        needsSetup: field.optBool,
        loginResponse: field.optStr,
        loginId: field.optStr,
        wrappedDEK: readWrappedKey,
    }),
);

/**
 * The legacy PIN routes and recovery (/auth/sso-encryption-setup, -unlock,
 * /auth/sso-recovery) and the OPAQUE PIN finish: success, and what came with it.
 */
export const readPinOutcome: (raw: unknown) => {
    success?: boolean;
    needsSetup?: boolean;
    recoveryKey?: string;
    error?: string;
} | null = nullable(
    shapeOf({
        success: field.optBool,
        needsSetup: field.optBool,
        recoveryKey: field.optStr,
        error: field.optStr,
    }),
);

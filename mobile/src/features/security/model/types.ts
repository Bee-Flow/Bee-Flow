/** The two-factor and app-password shapes (server/auth/mfaRoutes.js,
 *  auth/admin/appPasswordRoutes.js). */

/** `GET /auth/mfa/status`. */
export interface MfaStatus {
    enabled: boolean;
    recoveryCodesRemaining: number;
    /** False for SSO-only accounts — they have no password to change. */
    hasPassword: boolean;
}

/** `POST /auth/mfa/setup`. */
export interface MfaSetup {
    otpauthUrl: string;
    /** Data-URI PNG of the enrolment QR. */
    qr: string;
    secret: string;
    /** Lets the client warn about device clock drift before a code is refused.
     *  Null when the server did not say, which means no warning. */
    serverTime: number | null;
}

/** `POST /auth/mfa/enable` and `/auth/mfa/recovery-codes/regenerate`. */
export interface RecoveryCodesResponse {
    success?: boolean;
    recoveryCodes?: string[];
    error?: string;
}

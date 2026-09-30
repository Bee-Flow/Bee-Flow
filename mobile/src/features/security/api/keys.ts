/**
 * Query keys for two-factor. `mfaSetup` sits under `mfa` on purpose: an
 * invalidation after enabling or disabling 2FA drops a pending enrolment too.
 */

export const securityKeys = {
    mfa: ['settings', 'mfa'] as const,
    mfaSetup: ['settings', 'mfa', 'setup'] as const,
    appPassword: ['settings', 'app-password'] as const,
};

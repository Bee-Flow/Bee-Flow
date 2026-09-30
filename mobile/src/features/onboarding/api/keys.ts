/** React Query keys for the signed-out screens. The hooks own them. */

export const onboardingKeys = {
    /** What this instance permits before anyone has signed in. */
    setupStatus: ['onboarding', 'setup-status'] as const,
    /** The pending TOTP secret for the current enrolment attempt. */
    mfaSetup: ['onboarding', 'mfa-setup'] as const,
};

/** Onboarding writes: the two "send me an email" calls (TOTP enrolment is hooks/mfa.ts). */

import { useMutation } from '@tanstack/react-query';

import { requestPasswordReset, resendVerificationEmail } from '../api/endpoints';

export function usePasswordReset() {
    return useMutation({ mutationFn: (email: string) => requestPasswordReset(email) });
}

export function useResendVerification(onSent: () => void) {
    return useMutation({
        mutationFn: (address: string) => resendVerificationEmail(address),
        onSuccess: onSent,
    });
}

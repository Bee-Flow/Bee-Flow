/**
 * What the encryption-PIN forms refuse before anything is sent. The server
 * checks too; saying it here means the person sees which field is wrong
 * without a round trip — and without an OPAQUE exchange spent on a typo.
 */

import { translate } from '@/core/i18n';

/** The server's own floor (auth/login/ssoEncryptionRoutes.js). */
export const MIN_PIN_LENGTH = 6;

const mismatch = () => translate('mobile.onboarding.pin_mismatch', 'Those two PINs are not the same.');

export function pinSetupProblem(pin: string, confirm: string): string | null {
    if (pin.length < MIN_PIN_LENGTH) {
        return translate('mobile.onboarding.pin_too_short', 'Your PIN needs at least {n} characters.', { n: MIN_PIN_LENGTH });
    }
    return pin === confirm ? null : mismatch();
}

export function pinUnlockProblem(pin: string): string | null {
    return pin ? null : translate('mobile.onboarding.pin_missing', 'Enter your encryption PIN.');
}

export function recoveryProblem(recoveryKey: string, newPin: string, confirm: string): string | null {
    if (!recoveryKey.trim()) {
        return translate('mobile.onboarding.recovery_key_missing', 'Paste the recovery key you saved when you set this up.');
    }
    if (newPin.length < MIN_PIN_LENGTH) {
        return translate('mobile.onboarding.new_pin_too_short', 'Your new PIN needs at least {n} characters.', {
            n: MIN_PIN_LENGTH,
        });
    }
    return newPin === confirm ? null : mismatch();
}

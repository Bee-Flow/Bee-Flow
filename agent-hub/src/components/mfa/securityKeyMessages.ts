// The words for every SecurityKeyErrorCode, shared by Settings → Security,
// the forced 2FA setup and the sign-in step, so all three say the same thing
// about the same failure.

import type { SecurityKeyErrorCode } from '../../api/queries/securityKeys';
import type { TranslateFn } from '../../hooks/useTranslation';

/** [dictionary key, English fallback] per code. */
const MESSAGES: Record<SecurityKeyErrorCode, [string, string]> = {
    cancelled: ['mfa.security_key_cancelled', 'The security key prompt was closed or timed out. Try again.'],
    already_registered: ['mfa.security_key_already_registered', 'This security key is already registered.'],
    webauthn_unavailable: ['mfa.security_key_unavailable', 'Security keys cannot be used from this address. Open Bee Flow on its own HTTPS address and try again.'],
    rate_limited: ['mfa.too_many_attempts', 'Too many attempts — wait a few minutes and try again.'],
    invalid_code: ['mfa.invalid_code', 'Invalid code. Please try again.'],
    mfa_secret_unreadable: ['mfa.secret_unreadable', 'Your authenticator can no longer be verified on this server. Use a recovery code, or ask your administrator to reset two-factor authentication.'],
    mfa_not_enabled: ['mfa.sign_in_again', 'Something changed on this account. Sign in again with your password.'],
    proof_required: ['mfa.proof_required', 'Confirm it is you first, with a code from your authenticator app, a recovery code or one of your security keys.'],
    last_factor: ['mfa.security_key_last_factor', 'This key is your only second factor. Add another one first, or turn two-factor authentication off.'],
    too_many_keys: ['mfa.security_key_too_many', 'You have reached the maximum number of security keys. Remove one first.'],
    registration_expired: ['mfa.security_key_expired', 'That took too long. Try again.'],
    challenge_expired: ['mfa.security_key_expired', 'That took too long. Try again.'],
    security_key_rejected: ['mfa.security_key_rejected', 'The security key could not be verified. Try again.'],
    no_security_key_here: ['mfa.security_key_none_here', 'None of your security keys is registered for this address.'],
    no_pending_login: ['mfa.attempts_exhausted', 'Too many failed attempts. Sign in again with your password.'],
    mfa_attempts_exhausted: ['mfa.attempts_exhausted', 'Too many failed attempts. Sign in again with your password.'],
    failed: ['mfa.request_failed', 'Request failed. Please try again.'],
};

export function securityKeyMessage(code: SecurityKeyErrorCode, t: TranslateFn): string {
    const [key, fallback] = MESSAGES[code] ?? MESSAGES.failed;
    return t(key, fallback);
}

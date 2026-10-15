import type { FormEvent } from 'react';
import { securityKeyErrorCode, signInWithSecurityKey } from '../../api/queries/securityKeys';
import { securityKeyMessage } from '../../components/mfa/securityKeyMessages';
import type { TranslateFn } from '../../hooks/useTranslation';
import { opaqueLogin } from '../../lib/opaque';
import { postAdminLogin, postMfaVerifyLogin, postSetup } from './loginRequests';
import { messageOf } from '../../utils/caughtError';
import type { AuthAnswer, OnLogin, Setter } from './loginShared';

interface LoginActionsDeps {
    t: TranslateFn;
    onLogin: OnLogin;
    setupMode: boolean;
    username: string;
    password: string;
    confirmPassword: string;
    setError: Setter<string>;
    setIsLoading: Setter<boolean>;
    setPassword: Setter<string>;
    setConfirmPassword: Setter<string>;
    setAdminRecoveryKey: Setter<string | null>;
    setSetupMode: Setter<boolean>;
    setIsSetupComplete: Setter<boolean | undefined>;
    setMfaMethods: Setter<unknown[]>;
    setMfaRequired: Setter<boolean>;
    setVerifyEmail: Setter<string>;
    setResendDone: Setter<boolean>;
    setVerifyEmailSent: Setter<boolean>;
}

/**
 * The credentials step and its second factor: first-run root password, password
 * sign-in (with the transparent OPAQUE hand-off), the TOTP code and the security
 * key. The secrets stay in the caller's state; this only reads them per call.
 */
export function useLoginActions(deps: LoginActionsDeps) {
    const {
        t, onLogin, setupMode, username, password, confirmPassword,
        setError, setIsLoading, setPassword, setConfirmPassword, setAdminRecoveryKey,
        setSetupMode, setIsSetupComplete, setMfaMethods, setMfaRequired,
        setVerifyEmail, setResendDone, setVerifyEmailSent,
    } = deps;

    const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        try {
            if (setupMode) {
                if (password !== confirmPassword) {
                    setError(t('login.passwords_no_match'));
                    setIsLoading(false);
                    return;
                }
                const res = await postSetup(password);
                if (res.ok) {
                    const data: AuthAnswer = await res.json();
                    if (data.recoveryKey) {
                        // Show recovery key before switching to login
                        setAdminRecoveryKey(data.recoveryKey);
                    } else {
                        setSetupMode(false);
                        setIsSetupComplete(true);
                    }
                    setPassword('');
                    setConfirmPassword('');
                    setError('');
                } else {
                    const data: AuthAnswer = await res.json();
                    setError(data.error || t('login.setup_failed'));
                }
            } else {
                const res = await postAdminLogin(username, password);
                const data: AuthAnswer = await res.json();

                if (data.useOpaque) {
                    // User has migrated to OPAQUE: use OPAQUE flow transparently
                    try {
                        const result: { useLegacy?: boolean; success?: boolean; user?: unknown } = await opaqueLogin(username, password);
                        if (result.useLegacy) {
                            setError(t('login.auth_error_contact_admin'));
                        } else if (result.success) {
                            onLogin(result.user);
                        } else {
                            setError(t('login.login_failed'));
                        }
                    } catch (opaqueErr) {
                        setError(messageOf(opaqueErr, t('login.login_failed')));
                    }
                } else if (res.ok && data.mfaRequired) {
                    // Password verified: prompt for the second factor.
                    setMfaMethods(Array.isArray(data.mfaMethods) ? data.mfaMethods : ['totp']);
                    setMfaRequired(true);
                } else if (res.ok && data.emailVerificationRequired) {
                    // Credentials OK but the email isn't confirmed yet: gate
                    // them on verification and offer a resend.
                    setVerifyEmail(username.includes('@') ? username : '');
                    setResendDone(false);
                    setVerifyEmailSent(true);
                } else if (res.ok && data.success) {
                    onLogin(data.user, data.recoveryKey);
                } else {
                    setError(data.error || t('login.login_failed'));
                }
            }
        } catch {
            setError(t('login.connection_error'));
        } finally {
            setIsLoading(false);
        }
    };

    const cancelMfa = () => {
        setMfaRequired(false);
        setError('');
        setPassword('');
    };

    // Back to the password step, saying why.
    const endMfaWith = (message: string) => {
        cancelMfa();
        setError(message);
    };

    const handleMfaVerify = async (code: string) => {
        setError('');
        setIsLoading(true);
        try {
            const res = await postMfaVerifyLogin(code);
            const data: AuthAnswer = await res.json();
            if (res.ok && data.success) {
                onLogin(data.user, data.recoveryKey);
            } else if (data.code === 'mfa_attempts_exhausted') {
                // The server threw the pending login away; another code here
                // could only ever answer "no pending login".
                endMfaWith(data.error ?? '');
            } else {
                setError(data.error || t('mfa.invalid_code', 'Invalid code. Please try again.'));
            }
        } catch {
            setError(t('login.connection_error'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleSecurityKey = async () => {
        setError('');
        setIsLoading(true);
        try {
            const data = await signInWithSecurityKey();
            if (data.success) onLogin(data.user, data.recoveryKey);
            else setError(data.error || t('login.login_failed'));
        } catch (err) {
            const code = securityKeyErrorCode(err);
            // Each of these means the pending login is gone server-side.
            if (['mfa_attempts_exhausted', 'no_pending_login', 'mfa_not_enabled'].includes(code)) endMfaWith(securityKeyMessage(code, t));
            else setError(securityKeyMessage(code, t));
        } finally {
            setIsLoading(false);
        }
    };

    return { handleSubmit, handleMfaVerify, handleSecurityKey, cancelMfa };
}

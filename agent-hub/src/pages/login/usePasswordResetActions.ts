import type { TranslateFn } from '../../hooks/useTranslation';
import { postForgotPassword, postResetPassword } from '../../api/loginRequests';
import type { AuthAnswer, Setter } from './loginShared';

interface PasswordResetDeps {
    t: TranslateFn;
    resetToken: string | null;
    setError: Setter<string>;
    setIsLoading: Setter<boolean>;
    setForgotMode: Setter<boolean>;
    setForgotSent: Setter<boolean>;
    setResetToken: Setter<string | null>;
    setResetDone: Setter<boolean>;
}

/** The forgot-password e-mail step and the reset-with-token step. */
export function usePasswordResetActions(deps: PasswordResetDeps) {
    const { t, resetToken, setError, setIsLoading, setForgotMode, setForgotSent, setResetToken, setResetDone } = deps;

    const handleForgotPassword = async (email: string) => {
        setError('');
        setIsLoading(true);
        try {
            // Always 200 from the server: show the same confirmation either way.
            await postForgotPassword(email);
            setForgotSent(true);
        } catch {
            // Network error only: still show the neutral confirmation.
            setForgotSent(true);
        } finally {
            setIsLoading(false);
        }
    };

    const handleResetPassword = async (newPassword: string) => {
        setError('');
        setIsLoading(true);
        try {
            const res = await postResetPassword(resetToken, newPassword);
            const data: AuthAnswer = await res.json();
            if (res.ok && data.success) {
                setResetDone(true);
            } else {
                setError(data.error || t('reset.failed', 'Failed to reset password.'));
            }
        } catch {
            setError(t('login.connection_error'));
        } finally {
            setIsLoading(false);
        }
    };

    const exitPasswordReset = () => {
        setForgotMode(false);
        setForgotSent(false);
        setResetToken(null);
        setResetDone(false);
        setError('');
    };

    return { handleForgotPassword, handleResetPassword, exitPasswordReset };
}

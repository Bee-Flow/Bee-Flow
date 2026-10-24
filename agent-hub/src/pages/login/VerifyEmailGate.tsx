import React from 'react';
import { MailCheck, CheckCircle } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import type { Setter } from './loginShared';

interface VerifyEmailGateProps {
    verifyEmail: string;
    setVerifyEmail: Setter<string>;
    resending: boolean;
    resendDone: boolean;
    onResend: (email: string) => void;
    onBack: () => void;
    inputClass: string;
}

/**
 * Email-verification gate: shown after a signup that needs confirmation, or
 * after a blocked login attempt for an unverified account. Takes priority
 * over the signup wizard / login form.
 */
const VerifyEmailGate = ({ verifyEmail, setVerifyEmail, resending, resendDone, onResend, onBack, inputClass }: VerifyEmailGateProps) => {
    const { t } = useTranslation();
    return (
        <div className="min-h-screen flex items-center justify-center p-4 relative [background:linear-gradient(160deg,var(--bg-primary)_0%,var(--bg-secondary)_50%,var(--bg-tertiary)_100%)]">
            <div className="w-full max-w-md">
                <div className="rounded-2xl shadow-xl p-8 text-center bg-[var(--bg-secondary)]">
                    <div className="w-16 h-16 mx-auto mb-5 rounded-full flex items-center justify-center bg-[var(--bg-primary)]">
                        <MailCheck className="w-8 h-8 text-[var(--accent-primary)]" />
                    </div>
                    <h2 className="text-xl font-bold mb-2 text-[var(--text-primary)]">
                        {t('login.verify_title', 'Confirm your email address')}
                    </h2>
                    <p className="text-sm mb-1 text-[var(--text-secondary)]">
                        {verifyEmail
                            ? t('login.verify_sent_to', 'We sent a confirmation link to')
                            : t('login.verify_check_inbox', 'We sent you a confirmation link. Please check your inbox to activate your account.')}
                    </p>
                    {verifyEmail && <p className="text-sm font-semibold mb-4 text-[var(--text-primary)]">{verifyEmail}</p>}
                    <p className="text-xs mb-6 text-[var(--text-muted)]">
                        {t('login.verify_then_login', 'Click the link in the email, then log in. You can\'t log in until your email is confirmed.')}
                    </p>

                    {resendDone ? (
                        <div className="mb-4 p-3 rounded-lg flex items-center justify-center gap-2 text-sm [background:rgba(34,197,94,0.1)] [color:#22c55e]!">
                            <CheckCircle className="w-4 h-4" /> {t('login.verify_resent', 'If that account needs confirmation, a new link is on its way.')}
                        </div>
                    ) : (
                        <div className="mb-4 space-y-2">
                            {!verifyEmail && (
                                <input
                                    type="email"
                                    value={verifyEmail}
                                    onChange={e => setVerifyEmail(e.target.value)}
                                    placeholder="you@example.com"
                                    className={inputClass}
                                />
                            )}
                            <button
                                onClick={() => onResend(verifyEmail)}
                                disabled={resending || !verifyEmail.trim()}
                                className="w-full py-2.5 rounded-lg text-sm font-medium text-white disabled:opacity-50 transition-opacity bg-[var(--accent-primary)]"
                            >
                                {resending ? t('login.verify_resending', 'Sending…') : t('login.verify_resend', 'Resend confirmation email')}
                            </button>
                        </div>
                    )}

                    <button
                        onClick={onBack}
                        className="text-sm font-medium text-[var(--accent-primary)]"
                    >
                        {t('login.back_to_login', 'Back to login')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default VerifyEmailGate;

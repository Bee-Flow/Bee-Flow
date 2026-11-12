import React from 'react';
import { MailCheck, CheckCircle } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import { LoginBackdrop } from './LoginChrome';
import { LINK_BUTTON_CLASS, LOGIN_CARD_CLASS, LOGIN_PAGE_CLASS, PRIMARY_BUTTON_CLASS, type Setter } from './loginShared';

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
        <div className={LOGIN_PAGE_CLASS}>
            <LoginBackdrop />
            <div className="w-full max-w-[26rem] relative z-10">
                <div className={`${LOGIN_CARD_CLASS} text-center`}>
                    <div className="w-12 h-12 mx-auto mb-5 rounded-md flex items-center justify-center bg-[var(--bg-tertiary)]">
                        <MailCheck className="w-6 h-6 text-[var(--text-primary)]" />
                    </div>
                    <h2 className="text-xl font-semibold tracking-tight mb-2 text-[var(--text-primary)]">
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
                                className={PRIMARY_BUTTON_CLASS}
                            >
                                {resending ? t('login.verify_resending', 'Sending…') : t('login.verify_resend', 'Resend confirmation email')}
                            </button>
                        </div>
                    )}

                    <button
                        onClick={onBack}
                        className={LINK_BUTTON_CLASS}
                    >
                        {t('login.back_to_login', 'Back to login')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default VerifyEmailGate;

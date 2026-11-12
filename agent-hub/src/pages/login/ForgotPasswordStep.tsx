import React, { useState } from 'react';
import { Mail, Loader2, ArrowLeft, Send, CheckCircle2 } from 'lucide-react';
import { LINK_BUTTON_CLASS, PRIMARY_BUTTON_CLASS } from './loginShared';
import { useTranslation } from '../../hooks/useTranslation';

interface ForgotPasswordStepProps {
    onSubmit: (email: string) => void;
    onBack: () => void;
    isLoading: boolean;
    sent: boolean;
    inputClass: string;
    labelClass: string;
}

/**
 * "Forgot password" email-entry step. Submits the email; the parent always
 * shows the same success state regardless of whether the account exists.
 */
const ForgotPasswordStep = ({ onSubmit, onBack, isLoading, sent, inputClass, labelClass }: ForgotPasswordStepProps) => {
    const { t } = useTranslation();
    const [email, setEmail] = useState('');

    if (sent) {
        return (
            <div className="space-y-5 text-center">
                <div className="flex justify-center"><CheckCircle2 className="w-12 h-12 text-[var(--success)]" /></div>
                <p className="text-sm text-[var(--text-secondary)]">
                    {t('reset.check_email', "If an account exists for that email, we've sent a password reset link. Check your inbox.")}
                </p>
                <button onClick={onBack} className={LINK_BUTTON_CLASS}>
                    <ArrowLeft className="w-4 h-4" /> {t('reset.back_to_signin', 'Back to sign in')}
                </button>
            </div>
        );
    }

    return (
        <form onSubmit={e => { e.preventDefault(); if (email.trim()) onSubmit(email.trim()); }} className="space-y-5">
            <p className="text-sm text-[var(--text-secondary)]">
                {t('reset.forgot_desc', "Enter your email and we'll send you a link to reset your password.")}
            </p>
            <div>
                <label className={labelClass}>{t('reset.email', 'Email')}</label>
                <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-tertiary)]" />
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputClass} placeholder="you@example.com" required autoFocus data-testid="forgot-email-input" />
                </div>
            </div>
            <button type="submit" disabled={isLoading || !email.trim()}
                className={PRIMARY_BUTTON_CLASS}>
                {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <><Send className="w-5 h-5" /> {t('reset.send_link', 'Send reset link')}</>}
            </button>
            <button type="button" onClick={onBack} className={LINK_BUTTON_CLASS}>
                <ArrowLeft className="w-4 h-4" /> {t('reset.back_to_signin', 'Back to sign in')}
            </button>
        </form>
    );
};

export default ForgotPasswordStep;

import React from 'react';
import { AlertCircle, Globe, CheckCircle } from 'lucide-react';
import beeFlowLogo from '../../assets/bee-flow-logo.svg';
import { useTranslation } from '../../hooks/useTranslation';

/** Animated background shapes behind the card. */
export const LoginBackdrop = () => (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute w-[500px] h-[500px] rounded-full opacity-[0.07] [background:radial-gradient(circle,var(--accent-primary),transparent_70%)] [top:-5%] [left:-10%] [animation:pulse_4s_ease-in-out_infinite]" />
        <div className="absolute w-80 h-80 rounded-full opacity-[0.05] [background:radial-gradient(circle,var(--accent-secondary),transparent_70%)] [bottom:5%] [right:-5%] [animation:pulse_5s_ease-in-out_infinite_1.5s]" />
        <div className="absolute w-48 h-48 rounded-full opacity-[0.04] [background:radial-gradient(circle,var(--accent-primary),transparent_70%)] [top:60%] [left:15%] [animation:pulse_6s_ease-in-out_infinite_0.8s]" />
        <div className="absolute w-32 h-32 rounded-full opacity-[0.06] [background:radial-gradient(circle,var(--accent-secondary),transparent_70%)] [top:15%] [right:30%] [animation:pulse_7s_ease-in-out_infinite_2s]" />
    </div>
);

interface LanguagePickerProps {
    availableLocales: { code: string }[];
    locale: string;
    setLocale: (locale: string) => void;
}

/** Language picker, only offered when the server lists more than one locale. */
export const LanguagePicker = ({ availableLocales, locale, setLocale }: LanguagePickerProps) => {
    if (availableLocales.length <= 1) return null;
    return (
        <div className="absolute top-4 right-4 z-10">
            <div className="relative inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1.5 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-default)] transition-colors cursor-pointer">
                <Globe className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                <select
                    value={locale}
                    onChange={(e) => setLocale(e.target.value)}
                    className="appearance-none bg-transparent text-xs font-medium text-[var(--text-secondary)] cursor-pointer pr-4 outline-none min-w-[2rem]"
                >
                    {availableLocales.map(l => (
                        <option key={l.code} value={l.code} className="bg-[var(--bg-secondary)]">
                            {l.code.toUpperCase()}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
};

interface LoginHeaderProps {
    setupMode: boolean;
    resetToken: string | null;
    forgotMode: boolean;
    mfaRequired: boolean;
    deploymentMode: string;
    orgLogo: string | null;
}

/** Logo and the one-line subtitle for the step on screen. */
export const LoginHeader = ({ setupMode, resetToken, forgotMode, mfaRequired, deploymentMode, orgLogo }: LoginHeaderProps) => {
    const { t } = useTranslation();
    // Determine subtitle (signup lives in the full-page SignupWizard).
    const getSubtitle = () => {
        if (setupMode) return t('login.create_admin_password');
        if (resetToken) return t('reset.title', 'Reset your password');
        if (forgotMode) return t('reset.forgot_title', 'Forgot your password?');
        if (mfaRequired) return t('mfa.title', 'Two-factor authentication');
        return t('login.sign_in_continue');
    };
    return (
        <div className="text-center mb-8">
            <div className="w-36 h-36 mx-auto mb-5 rounded-full overflow-hidden shadow-xl ring-4 ring-[var(--border-subtle)] flex items-center justify-center bg-[var(--bg-primary)]">
                {deploymentMode === 'self-hosted' && orgLogo
                    ? <img src={orgLogo} alt={t('login.org_logo_alt', 'Organization')} className="max-w-[80%] max-h-[80%] object-contain" />
                    : <img src={beeFlowLogo} alt="Bee Flow" className="w-full h-full object-cover" />}
            </div>
            <p className="text-sm text-[var(--text-secondary)] mt-1">
                {getSubtitle()}
            </p>
        </div>
    );
};

/** The email-verified success banner and the error banner. */
export const LoginNotices = ({ verifiedBanner, error }: { verifiedBanner: boolean; error: string }) => {
    const { t } = useTranslation();
    return (
        <>
            {/* Email-verified success banner (after clicking the link) */}
            {verifiedBanner && (
                <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-3 text-green-600 text-sm">
                    <CheckCircle className="w-5 h-5 shrink-0" />
                    {t('login.verified_success', 'Your email is confirmed. You can now log in.')}
                </div>
            )}

            {/* Error display */}
            {error && (
                <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-3 text-red-500 text-sm">
                    <AlertCircle className="w-5 h-5 shrink-0" />
                    {error}
                </div>
            )}
        </>
    );
};

/** Platform name and, on a self-hosted server, the "powered by" link. */
export const LoginFooter = ({ deploymentMode }: { deploymentMode: string }) => {
    const { t } = useTranslation();
    return (
        <>
            <p className="text-center text-xs text-[var(--text-tertiary)] mt-6">
                {t('login.platform_name')}
            </p>

            {deploymentMode === 'self-hosted' && (
                <p className="text-center text-[10px] text-[var(--text-tertiary)] mt-2">
                    <a
                        href="https://beeflow.nl"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-[var(--text-secondary)] transition-colors"
                    >
                        {t('sidebar.powered_by', 'Powered by Bee Flow')}
                    </a>
                </p>
            )}
        </>
    );
};

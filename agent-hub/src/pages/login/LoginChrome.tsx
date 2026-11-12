import React, { useId } from 'react';
import { AlertCircle, Globe, CheckCircle } from 'lucide-react';
import beeFlowIcon from '../../assets/BeeFlow-logo-Icon-2026.svg';
import { useTranslation } from '../../hooks/useTranslation';

const COMB_MASKS = {
    top: '[mask-image:radial-gradient(ellipse_at_top_right,black,transparent_68%)] top-0 right-0 w-[min(760px,90vw)] h-[620px]',
    bottom: '[mask-image:radial-gradient(ellipse_at_bottom_left,black,transparent_66%)] bottom-0 left-0 w-[min(520px,70vw)] h-[440px]',
};

/** One patch of honeycomb, drawn in the theme's ink and faded out towards the card. */
const Honeycomb = ({ corner }: { corner: keyof typeof COMB_MASKS }) => {
    const id = useId();
    return (
        <svg aria-hidden="true" className={`absolute ${COMB_MASKS[corner]}`}>
            <defs>
                <pattern id={id} width="56" height="97" patternUnits="userSpaceOnUse">
                    <path d="M28 0 56 16.17V48.5L28 64.67 0 48.5V16.17ZM28 64.67V97" fill="none" stroke="currentColor" strokeWidth="1" />
                </pattern>
            </defs>
            <rect width="100%" height="100%" fill={`url(#${id})`} />
        </svg>
    );
};

/** The still honeycomb behind the card, in two opposite corners. */
export const LoginBackdrop = () => (
    <div className="absolute inset-0 overflow-hidden pointer-events-none text-[var(--text-primary)] opacity-[0.13]">
        <Honeycomb corner="top" />
        <Honeycomb corner="bottom" />
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
        <div className="absolute top-6 right-6 sm:top-9 sm:right-8 z-10">
            {/* The select itself is the control: a theme that styles form fields (glass) then styles one shape, not a box inside a pill. */}
            <div className="relative">
                <Globe className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)] pointer-events-none z-10" />
                <select
                    value={locale}
                    onChange={(e) => setLocale(e.target.value)}
                    className="appearance-none pl-8 pr-3 py-1.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border-default)] hover:border-[var(--text-tertiary)] text-xs font-medium text-[var(--text-secondary)] cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
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

/** The brand mark: the organisation's own logo on a self-hosted server, the bee and its name otherwise. */
const LoginBrand = ({ deploymentMode, orgLogo }: { deploymentMode: string; orgLogo: string | null }) => {
    const { t } = useTranslation();
    if (deploymentMode === 'self-hosted' && orgLogo) {
        return <img src={orgLogo} alt={t('login.org_logo_alt', 'Organization')} className="h-11 max-w-[200px] object-contain object-left" />;
    }
    return (
        <div className="flex items-center gap-3">
            {/* The mark is black line art: it keeps its own white tile so it reads on a dark theme too. */}
            <div className="w-11 h-11 rounded-md bg-white border border-[var(--border-default)] flex items-center justify-center shrink-0">
                <img src={beeFlowIcon} alt={t('app.shell_logo_alt', 'Bee Flow')} className="w-7 h-7 object-contain" />
            </div>
            <span aria-hidden="true" className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
                {t('app.shell_logo_alt', 'Bee Flow')}
            </span>
        </div>
    );
};

/** The brand mark and the title of the step on screen. */
export const LoginHeader = ({ setupMode, resetToken, forgotMode, mfaRequired, deploymentMode, orgLogo }: LoginHeaderProps) => {
    const { t } = useTranslation();
    // The title names the step (signup lives in the full-page SignupWizard).
    const getTitle = () => {
        if (setupMode) return t('login.create_admin_password');
        if (resetToken) return t('reset.title', 'Reset your password');
        if (forgotMode) return t('reset.forgot_title', 'Forgot your password?');
        if (mfaRequired) return t('mfa.title', 'Two-factor authentication');
        return t('login.sign_in_continue');
    };
    return (
        <div className="mb-7">
            <LoginBrand deploymentMode={deploymentMode} orgLogo={orgLogo} />
            <h1 className="mt-8 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
                {getTitle()}
            </h1>
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
                <div className="mb-6 p-3.5 bg-green-500/10 border border-green-500/30 rounded-md flex items-center gap-3 text-[var(--success)] text-sm">
                    <CheckCircle className="w-5 h-5 shrink-0" />
                    {t('login.verified_success', 'Your email is confirmed. You can now log in.')}
                </div>
            )}

            {/* Error display */}
            {error && (
                <div className="mb-6 p-3.5 bg-red-500/10 border border-red-500/30 rounded-md flex items-center gap-3 text-[var(--error)] text-sm">
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
        <p className="text-center text-xs text-[var(--text-tertiary)] mt-6">
            {t('login.platform_name')}
            {deploymentMode === 'self-hosted' && (
                <a
                    href="https://beeflow.nl"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block mt-1.5 underline-offset-2 hover:underline hover:text-[var(--text-secondary)] transition-colors"
                >
                    {t('sidebar.powered_by', 'Powered by Bee Flow')}
                </a>
            )}
        </p>
    );
};

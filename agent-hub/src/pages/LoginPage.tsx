import { useState } from 'react';
import ForgotPasswordStep from './login/ForgotPasswordStep';
import { LoginBackdrop, LanguagePicker, LoginFooter, LoginHeader, LoginNotices } from './login/LoginChrome';
import LoginForm from './login/LoginForm';
import { INPUT_CLASS, INPUT_CLASS_SIMPLE, LABEL_CLASS, initialSignupData, initialSignupMode, type OnLogin } from './login/loginShared';
import MfaLoginStep from './login/MfaLoginStep';
import RecoveryKeyModal from './login/RecoveryKeyModal';
import ResetPasswordStep from './login/ResetPasswordStep';
import SignupWizard from './login/SignupWizard';
import { useAuthSettings } from './login/useAuthSettings';
import { useInviteToken, type InviteInfo } from './login/useInviteToken';
import { useLoginActions } from './login/useLoginActions';
import { useLoginUrlParams } from './login/useLoginUrlParams';
import { useOAuthPopup } from './login/useOAuthPopup';
import { usePasswordResetActions } from './login/usePasswordResetActions';
import { useSignupActions } from './login/useSignupActions';
import { useSignupPlans } from './login/useSignupPlans';
import VerifyEmailGate from './login/VerifyEmailGate';
import { useTranslation } from '../hooks/useTranslation';

interface LoginPageProps {
    onLogin: OnLogin;
}

const LoginPage = ({ onLogin }: LoginPageProps) => {
    const { t, locale, setLocale } = useTranslation();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [adminRecoveryKey, setAdminRecoveryKey] = useState<string | null>(null);
    // MFA: set when /auth/admin-login reports a second factor is required.
    const [mfaRequired, setMfaRequired] = useState(false);
    // Which second factors that answer offered: 'totp' always, 'security_key'
    // when the account has a YubiKey or other FIDO2 key registered.
    const [mfaMethods, setMfaMethods] = useState(['totp']);
    // Password reset: forgot-password email step + reset-with-token step.
    const [forgotMode, setForgotMode] = useState(false);
    const [forgotSent, setForgotSent] = useState(false);
    const [resetToken, setResetToken] = useState<string | null>(null);
    const [resetDone, setResetDone] = useState(false);

    // Email verification: "check your inbox" gate after signup / blocked login.
    const [verifyEmailSent, setVerifyEmailSent] = useState(false);
    const [verifyEmail, setVerifyEmail] = useState('');
    const [resending, setResending] = useState(false);
    const [resendDone, setResendDone] = useState(false);
    const [verifiedBanner, setVerifiedBanner] = useState(false);

    // Invite token state
    const [inviteToken, setInviteToken] = useState<string | null>(null);
    const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null); // { email, organizationId, orgName, role }

    // Signup state
    const [signupMode, setSignupMode] = useState(() => initialSignupMode(window.location.search));
    const [captchaToken, setCaptchaToken] = useState('');
    const [signupData, setSignupData] = useState(() => initialSignupData(window.location.search));

    // Effect order is the original one: public plans, setup-status, URL redirects, invite.
    const { availablePlans, selectedPlanId } = useSignupPlans(signupMode, signupData);
    const {
        availableLocales, setupMode, setSetupMode, setIsSetupComplete,
        isOAuthConfigured, serverUrl, isGoogleConfigured, isMicrosoftConfigured,
        allowSignups, allowOrgSignups, allowConsumerSignups, consumerLoginMethods,
        allowPasswordLogin, authSettingsLoaded, deploymentMode, orgLogo, signupOrgs, captchaConfig,
    } = useAuthSettings();
    useLoginUrlParams({ t, setResetToken, setVerifiedBanner, setError });
    useInviteToken({ setInviteToken, setInviteInfo, setSignupData, setSignupMode, setError });

    const { handleSubmit, handleMfaVerify, handleSecurityKey, cancelMfa } = useLoginActions({
        t, onLogin, setupMode, username, password, confirmPassword,
        setError, setIsLoading, setPassword, setConfirmPassword, setAdminRecoveryKey,
        setSetupMode, setIsSetupComplete, setMfaMethods, setMfaRequired,
        setVerifyEmail, setResendDone, setVerifyEmailSent,
    });
    const { handleForgotPassword, handleResetPassword, exitPasswordReset } = usePasswordResetActions({
        t, resetToken, setError, setIsLoading, setForgotMode, setForgotSent, setResetToken, setResetDone,
    });
    const { handleSignup, handleResendVerification, resetSignup } = useSignupActions({
        t, locale, onLogin, signupData, selectedPlanId, inviteInfo, inviteToken,
        captchaRequired: captchaConfig?.enabled, captchaToken, verifyEmail,
        setError, setIsLoading, setVerifyEmail, setResendDone, setVerifyEmailSent,
        setResending, setSignupMode, setSignupData,
    });
    const { handleOAuthLogin, handleGoogleLogin, handleMicrosoftLogin } = useOAuthPopup(onLogin, serverUrl);

    const inputClass = INPUT_CLASS;
    const inputClassSimple = INPUT_CLASS_SIMPLE;
    const labelClass = LABEL_CLASS;

    // Email-verification gate: takes priority over the signup wizard / login form.
    if (verifyEmailSent) {
        return (
            <VerifyEmailGate
                verifyEmail={verifyEmail} setVerifyEmail={setVerifyEmail}
                resending={resending} resendDone={resendDone}
                onResend={handleResendVerification}
                onBack={() => { setVerifyEmailSent(false); setResendDone(false); setSignupMode(false); setError(''); }}
                inputClass={inputClass}
            />
        );
    }

    // Signup is a dedicated full-page wizard (welcome → steps → auto-login),
    // mirroring the Nextcloud-connector onboarding flow. Shown once auth
    // settings have loaded so the wizard's flow gates have real values.
    if (authSettingsLoaded && signupMode) {
        return (
            <SignupWizard
                signupData={signupData} setSignupData={setSignupData}
                signupOrgs={signupOrgs}
                deploymentMode={deploymentMode} orgLogo={orgLogo}
                consumerLoginMethods={consumerLoginMethods}
                allowOrgSignups={allowOrgSignups} allowConsumerSignups={allowConsumerSignups}
                inviteInfo={inviteInfo} inviteToken={inviteToken}
                isLoading={isLoading} setIsLoading={setIsLoading}
                error={error} setError={setError}
                handleSignup={handleSignup} resetSignup={resetSignup}
                availableLocales={availableLocales} locale={locale} setLocale={setLocale}
                availablePlans={availablePlans} selectedPlanId={selectedPlanId}
                inputClass={inputClass} inputClassSimple={inputClassSimple} labelClass={labelClass}
                captchaConfig={captchaConfig} onCaptchaToken={setCaptchaToken}
            />
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center p-4 relative [background:linear-gradient(160deg,var(--bg-primary)_0%,var(--bg-secondary)_50%,var(--bg-tertiary)_100%)]">

            {adminRecoveryKey && (
                <RecoveryKeyModal
                    recoveryKey={adminRecoveryKey}
                    onSaved={() => { setAdminRecoveryKey(null); setSetupMode(false); setIsSetupComplete(true); }}
                />
            )}

            <LoginBackdrop />

            <div className="w-full max-w-md relative z-10 transition-all duration-300">
                <div className="backdrop-blur-xl rounded-3xl p-8 shadow-2xl border relative overflow-hidden bg-[var(--bg-secondary)] border-[var(--border-subtle)]">
                    {/* Top highlight line for glass effect */}
                    <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-[var(--border-default)] to-transparent" />

                    <LanguagePicker availableLocales={availableLocales} locale={locale} setLocale={setLocale} />

                    <LoginHeader
                        setupMode={setupMode} resetToken={resetToken} forgotMode={forgotMode}
                        mfaRequired={mfaRequired} deploymentMode={deploymentMode} orgLogo={orgLogo}
                    />

                    <LoginNotices verifiedBanner={verifiedBanner} error={error} />

                    {/* Content */}
                    {!authSettingsLoaded ? (
                        <div className="flex justify-center py-8">
                            <div className="w-6 h-6 rounded-full border-2 border-[var(--border-default)] border-t-[var(--accent-primary)] animate-spin" />
                        </div>
                    ) : resetToken ? (
                        <ResetPasswordStep
                            onSubmit={handleResetPassword}
                            onDone={exitPasswordReset}
                            isLoading={isLoading}
                            done={resetDone}
                            inputClass={inputClass}
                            labelClass={labelClass}
                        />
                    ) : forgotMode ? (
                        <ForgotPasswordStep
                            onSubmit={handleForgotPassword}
                            onBack={exitPasswordReset}
                            isLoading={isLoading}
                            sent={forgotSent}
                            inputClass={inputClass}
                            labelClass={labelClass}
                        />
                    ) : mfaRequired ? (
                        <MfaLoginStep
                            onVerify={handleMfaVerify}
                            onSecurityKey={handleSecurityKey}
                            methods={mfaMethods}
                            onCancel={cancelMfa}
                            isLoading={isLoading}
                            inputClass={inputClass}
                            labelClass={labelClass}
                        />
                    ) : (
                        <LoginForm
                            onForgotPassword={() => { setForgotMode(true); setError(''); }}
                            username={username} setUsername={setUsername}
                            password={password} setPassword={setPassword}
                            confirmPassword={confirmPassword} setConfirmPassword={setConfirmPassword}
                            setupMode={setupMode} isLoading={isLoading}
                            handleSubmit={handleSubmit}
                            handleOAuthLogin={handleOAuthLogin}
                            handleGoogleLogin={handleGoogleLogin}
                            handleMicrosoftLogin={handleMicrosoftLogin}
                            isOAuthConfigured={isOAuthConfigured}
                            isGoogleConfigured={isGoogleConfigured}
                            isMicrosoftConfigured={isMicrosoftConfigured}
                            setSignupMode={allowSignups ? setSignupMode : null}
                            setError={setError}
                            allowSignups={allowSignups}
                            allowPasswordLogin={allowPasswordLogin}
                            inputClass={inputClass} labelClass={labelClass}
                        />
                    )}
                </div>

                <LoginFooter deploymentMode={deploymentMode} />
            </div>
        </div>
    );
};

export default LoginPage;

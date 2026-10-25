import type { FormEvent } from 'react';
import type { TranslateFn } from '../../hooks/useTranslation';
import { postResendVerification, postSignup } from '../../api/loginRequests';
import type { AuthAnswer, ClearedSignupData, OnLogin, Setter } from './loginShared';
import { clearedSignupData } from './loginShared';
import { validateSubmit } from './signupValidation';
import type { SignupData } from './signupValidation';
import type { InviteInfo } from './useInviteToken';
import { logger } from '../../utils/logger';

interface SignupActionsDeps {
    t: TranslateFn;
    locale: string;
    onLogin: OnLogin;
    signupData: SignupData;
    selectedPlanId: string | null;
    inviteInfo: InviteInfo | null;
    inviteToken: string | null;
    captchaRequired?: boolean;
    captchaToken: string;
    verifyEmail: string;
    setError: Setter<string>;
    setIsLoading: Setter<boolean>;
    setVerifyEmail: Setter<string>;
    setResendDone: Setter<boolean>;
    setVerifyEmailSent: Setter<boolean>;
    setResending: Setter<boolean>;
    setSignupMode: Setter<boolean>;
    setSignupData: Setter<ClearedSignupData>;
}

/** Account creation, the "back" reset of the wizard and the resend-verification link. */
export function useSignupActions(deps: SignupActionsDeps) {
    const {
        t, locale, onLogin, signupData, selectedPlanId, inviteInfo, inviteToken,
        captchaRequired, captchaToken, verifyEmail,
        setError, setIsLoading, setVerifyEmail, setResendDone, setVerifyEmailSent,
        setResending, setSignupMode, setSignupData,
    } = deps;

    const handleSignup = async (e: FormEvent) => {
        e.preventDefault();
        setError('');

        if (signupData.password !== signupData.confirmPassword) {
            setError(t('login.passwords_no_match'));
            return;
        }
        // Same rules the wizard's Next button uses (see signupValidation.ts).
        {
            const v = validateSubmit(signupData, { locale, isInvite: !!inviteInfo, t });
            if (!v.ok) { setError(v.error ?? ''); return; }
        }
        if (captchaRequired && !captchaToken) {
            setError(t('signup.captcha_required', 'Please complete the verification challenge.'));
            return;
        }
        setIsLoading(true);
        try {
            const body: Record<string, unknown> = {
                username: signupData.username,
                password: signupData.password,
                displayName: `${signupData.firstName} ${signupData.lastName}`.trim() || signupData.username,
                firstName: signupData.firstName,
                lastName: signupData.lastName,
                email: signupData.email,
                // The chosen interface language drives the language of this
                // account's transactional emails (verification, welcome).
                locale,
                // Carried through signup so the app can send the user straight
                // to checkout after first login. Null means the default plan.
                selectedPlanId,
                // Empty unless a challenge provider is configured; the server
                // ignores it in that case and requires it otherwise.
                ...(captchaToken ? { captchaToken } : {}),
            };

            if (signupData.signupType === 'new') {
                body.newOrgName = signupData.newOrgName;
                body.orgDetails = {
                    tagline: signupData.orgTagline,
                    description: signupData.orgDescription,
                    address: signupData.orgAddress,
                    email: signupData.orgEmail,
                    phone: signupData.orgPhone,
                    website: signupData.orgWebsite,
                    kvk: signupData.orgKvk,
                    vat: signupData.orgVat,
                    allowSignup: signupData.orgAllowSignup,
                    authMethod: signupData.authMethod,
                    privacyShield: {
                        enabled: signupData.shieldEnabled !== false,
                        piiDetectionCategories: signupData.piiCategories || [],
                        piiDetectionAction: signupData.piiAction || 'block',
                        euModeEnabled: signupData.euModeEnabled
                    }
                };
            } else if (signupData.signupType === 'existing') {
                body.organizationId = signupData.organizationId;
            } else if (signupData.signupType === 'consumer') {
                // Personal account: no org fields, but the privacy step's
                // choices are written to this user's own Privacy Shield so a
                // new account starts protected (BFSF-289).
                body.privacyShield = {
                    enabled: signupData.shieldEnabled !== false,
                    piiDetectionCategories: signupData.piiCategories || [],
                    piiDetectionAction: signupData.piiAction || 'tokenize',
                    euModeEnabled: signupData.euModeEnabled,
                };
            }

            // Attach invite token if present
            if (inviteToken) {
                body.inviteToken = inviteToken;
            }


            const res = await postSignup(body);
            const data: AuthAnswer = await res.json();
            if (res.ok && data.emailVerificationRequired) {
                // Account created but blocked until the email is confirmed.
                setVerifyEmail(signupData.email || '');
                setResendDone(false);
                setVerifyEmailSent(true);
            } else if (res.ok && data.success) {
                onLogin(data.user, data.recoveryKey);
            } else {
                setError(data.error || t('login.signup_failed'));
            }
        } catch {
            setError('Connection error. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    // Resend a verification link. The server always responds 200 (no account
    // enumeration), so we just show a neutral confirmation.
    const handleResendVerification = async (email?: string) => {
        const target = (email || verifyEmail || '').trim();
        if (!target) return;
        setResending(true);
        try {
            await postResendVerification(target);
        } catch (err) { logger.debug('still show the neutral confirmation', err); }
        setResendDone(true);
        setResending(false);
    };

    const resetSignup = () => {
        setSignupMode(false);
        setError('');
        setSignupData(clearedSignupData());
    };

    return { handleSignup, handleResendVerification, resetSignup };
}

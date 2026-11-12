import React, { useState } from 'react';
import { lazy } from '../utils/lazyWithReload';
import { isNextcloudEmbed } from '../utils/helpers';
import type { TranslateFn } from '../hooks/useTranslation';
import type { OnLogin } from '../pages/login/loginShared';
import { NcSignInFailedScreen, type BootstrapDiagnostics } from './shellScreens';
import { signedOutScreen, type SignInRefusal } from './signedOutScreen';

const LoginPage = lazy(() => import('../pages/LoginPage'));
const NcOnboardingPending = lazy(() => import('../components/integrations/nextcloud/NcOnboardingPending'));
const EmailVerificationScreen = lazy(() => import('../components/onboarding/EmailVerificationScreen'));

interface SignedOutGateProps {
    ncOnboardingState: string | null;
    ncOrgName: string | null;
    bootstrapDiagnostics: BootstrapDiagnostics | null;
    signInRefusal: SignInRefusal | null;
    onLogin: OnLogin;
    t: TranslateFn;
    /** Inside Nextcloud? Defaults to what the build says. */
    embedded?: boolean;
}

/**
 * What a person without a session sees. Standalone that is the login page;
 * inside Nextcloud the connector signs the person in, so the screen first says
 * what its sign-in answered, and offers the login page as a second action for
 * a person with a Bee Flow account of their own (see ./signedOutScreen).
 * Rendered under AuthedApp's Suspense boundary, which covers the lazy screens.
 */
export function SignedOutGate({ ncOnboardingState, ncOrgName, bootstrapDiagnostics, signInRefusal, onLogin, t, embedded = isNextcloudEmbed() }: SignedOutGateProps) {
    const [formRequested, setFormRequested] = useState(false);
    const reload = () => window.location.reload();
    const screen = signedOutScreen({ ncOnboardingState, diagnosticsState: bootstrapDiagnostics?.state, embedded, formRequested });
    if (screen === 'nc_onboarding_pending') {
        return <NcOnboardingPending orgName={ncOrgName} onRefresh={reload} />;
    }
    // Embedded connector awaiting in-app email verification. The connector has
    // no tenant key yet, so /auth/user reports unauthenticated; the connector's
    // /setup/diagnostics tells us a code was emailed to the org admin.
    if (screen === 'email_verification') {
        return <EmailVerificationScreen verification={(bootstrapDiagnostics as BootstrapDiagnostics & { verification?: { organizationName?: string } | null }).verification} t={t} />;
    }
    if (screen === 'nc_sign_in_failed') {
        return <NcSignInFailedScreen message={signInRefusal?.message} linkUrl={signInRefusal?.linkUrl} onRetry={reload} onUseAccount={() => setFormRequested(true)} />;
    }
    return <LoginPage onLogin={onLogin} />;
}

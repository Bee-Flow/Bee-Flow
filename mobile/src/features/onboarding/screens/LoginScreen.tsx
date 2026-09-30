/**
 * Sign in.
 *
 * The branching lives in `useAuth().signIn`, not here: it posts to
 * /auth/admin-login, re-runs the whole thing over OPAQUE if the account has
 * migrated, and sets whichever stage the answer implies (MFA, unverified
 * email, pending approval). This screen's job is to collect two strings, say
 * what the instance actually offers (useLoginOptions), and never claim to know
 * more than the server told it.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { getServerUrl } from '@/core/api/server';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { Banner } from '@/shared/ui';

import { AuthShell } from '../components/AuthShell';
import { ForgotPassword } from '../components/ForgotPassword';
import { PasswordSignIn, type Credentials } from '../components/PasswordSignIn';
import { SignInBanners } from '../components/SignInBanners';
import { SignupHint } from '../components/SignupHint';
import { SsoButtons } from '../components/SsoButtons';
import { TextLink } from '../components/TextLink';
import { usePasswordReset } from '../hooks/mutations';
import { useLoginOptions } from '../hooks/useLoginOptions';
import { useSsoSignIn } from '../hooks/useSsoSignIn';

export function LoginScreen() {
    const { forgetServer, busy, error } = useAuth();
    const t = useTranslation();
    const [view, setView] = useState<'sign-in' | 'forgot'>('sign-in');
    const [credentials, setCredentials] = useState<Credentials>({ username: '', password: '' });
    const sso = useSsoSignIn();
    const options = useLoginOptions();
    const forgot = usePasswordReset();
    const serverUrl = getServerUrl();

    if (view === 'forgot') {
        return (
            <ForgotPassword
                busy={forgot.isPending}
                sent={forgot.isSuccess}
                error={forgot.isError ? describeError(forgot.error).message : null}
                onSubmit={(email) => forgot.mutate(email)}
                onBack={() => {
                    forgot.reset();
                    setView('sign-in');
                }}
            />
        );
    }

    return (
        <AuthShell
            title={
                options.instanceName
                    ? t('mobile.onboarding.sign_in_to', 'Sign in to {name}', { name: options.instanceName })
                    : t('login.title', 'Sign in')
            }
            subtitle={serverUrl ? serverUrl.replace(/^https?:\/\//, '') : undefined}
            footer={
                <TextLink
                    label={t('mobile.onboarding.change_server', 'Connect to a different server')}
                    tone="tertiary"
                    onPress={() => void forgetServer()}
                    accessibilityHint={t('mobile.onboarding.change_server_hint', 'Forgets this server and asks for another address')}
                />
            }
        >
            <SignInBanners error={error} ssoError={sso.error} stranded={sso.stranded} />

            {options.passwordAllowed ? (
                <PasswordSignIn value={credentials} onChange={setCredentials} onForgot={() => setView('forgot')} />
            ) : (
                <Banner tone="info" icon="Info">
                    {t('mobile.onboarding.password_off', 'This server has turned off password sign-in. Use one of the options below.')}
                </Banner>
            )}

            <SsoButtons
                providers={options.providers}
                withDivider={options.passwordAllowed}
                active={sso.provider}
                busy={busy}
                onStart={(provider) => void sso.start(provider)}
            />

            {options.allowSignups && serverUrl ? <SignupHint serverUrl={serverUrl} waitlist={options.waitlist} /> : null}
        </AuthShell>
    );
}

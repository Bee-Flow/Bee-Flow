/**
 * Enrol an authenticator, because this instance insists on it.
 *
 * `require_mfa_for_password_accounts` defaults to ON, so a password account on
 * a fresh instance meets this screen on its first sign-in. There is no "skip":
 * the stage is set from a live read of the database on every /auth/user
 * (server/auth/login/currentUserRoutes.js), so it clears the moment enrolment
 * lands and not before. The only way past is forward or out, and both are
 * offered plainly.
 *
 * Enrolment is two calls. POST /auth/mfa/setup puts a pending secret in the
 * SESSION — nothing is written to the account yet — and is idempotent for ten
 * minutes, deliberately: re-fetching it would hand back a different secret to a
 * QR that has already been scanned, and every code the user then typed would be
 * refused with no hint why. POST /auth/mfa/enable checks a code against that
 * pending secret and only then persists it, returning ten recovery codes that
 * are never shown again.
 */

import React, { useState } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { ErrorState, LoadingState } from '@/shared/ui';

import { AuthShell } from '../components/AuthShell';
import { MfaEnrolment } from '../components/MfaEnrolment';
import { RecoveryKeyCard } from '../components/RecoveryKeyCard';
import { TextLink } from '../components/TextLink';
import { useEnableMfa, useMfaSetup, useRestartMfaSetup } from '../hooks/mfa';

export function MfaSetupScreen() {
    const { refresh, signOut } = useAuth();
    const t = useTranslation();
    const [code, setCode] = useState('');
    const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

    const setup = useMfaSetup();
    const enable = useEnableMfa({
        onSuccess: (result) => setRecoveryCodes(result.recoveryCodes),
        onError: () => setCode(''),
    });
    const startOver = useRestartMfaSetup(async () => {
        setCode('');
        enable.reset();
        await setup.refetch();
    });

    if (recoveryCodes) {
        return (
            <AuthShell icon="CircleCheckBig" tone="success" title={t('mfa.enabled_title', 'Two-factor is on')}>
                <RecoveryKeyCard
                    secret={recoveryCodes}
                    title={t('mobile.onboarding.recovery_codes_title', 'Save your recovery codes')}
                    description={t(
                        'mobile.onboarding.recovery_codes_intro',
                        'Each of these signs you in once if you lose your phone. Without them, and without your authenticator, only an administrator can let you back in.',
                    )}
                    shareTitle={t('mobile.onboarding.recovery_codes_file', 'Bee Flow recovery codes')}
                    confirmLabel={t('mfa.ive_saved_them', 'I have saved them — continue')}
                    onConfirm={() => void refresh()}
                />
            </AuthShell>
        );
    }

    const title = t('mfa.required_title', 'Set up two-factor sign-in');

    if (setup.isLoading) {
        return (
            <AuthShell icon="Shield" title={title}>
                <LoadingState label={t('mobile.onboarding.mfa_preparing', 'Preparing your authenticator setup…')} />
            </AuthShell>
        );
    }

    if (setup.isError || !setup.data) {
        return (
            <AuthShell icon="Shield" title={title}>
                <ErrorState error={setup.error} onRetry={() => void setup.refetch()} />
                <TextLink label={t('login.sign_out', 'Sign out')} tone="tertiary" onPress={() => void signOut()} />
            </AuthShell>
        );
    }

    return (
        <MfaEnrolment
            data={setup.data}
            code={code}
            onCode={(value) => {
                setCode(value);
                if (enable.isError) enable.reset();
            }}
            enable={enable}
            restarting={startOver.isPending}
            onStartOver={() => void startOver.mutate()}
            onSignOut={() => void signOut()}
        />
    );
}

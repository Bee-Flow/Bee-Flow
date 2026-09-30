/**
 * The second factor.
 *
 * The password was accepted and the server is holding a half-finished login in
 * `session.mfaPending` (server/auth/login/mfaLoginRoutes.js). That handler
 * takes either a six-digit TOTP code or one of the ten one-time recovery codes
 * — the same field, tried in that order — and it allows five attempts before
 * it throws the pending login away and sends the user back to the password
 * screen. Both facts are said out loud here, because a code entry that
 * silently burns attempts is how people end up locked out of their own
 * account.
 *
 * OPAQUE accounts never arrive here: /auth/opaque/login/finish establishes the
 * session directly, so there is no pending login to second-factor.
 *
 * An account may sign in with a security key and have no authenticator app at
 * all (`methods` without 'totp'). This app cannot use a key, so such an
 * account opens on the recovery code, is told why, and is never offered an
 * authenticator it does not have.
 */

import React, { useState } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Banner, Button, Text } from '@/shared/ui';

import { AuthShell } from '../components/AuthShell';
import { MfaCodeInput, MFA_CODE_LENGTH } from '../components/MfaCodeInput';
import { TextLink } from '../components/TextLink';

/** What to type, and for a security-key account why it is a recovery code. */
function mfaSubtitle(t: TranslateFn, totp: boolean, hasTotp: boolean): string {
    if (totp) return t('mfa.enter_code', 'Open your authenticator app and enter the six digits it shows for Bee Flow.');
    if (hasTotp) {
        return t(
            'mfa.enter_recovery_code',
            'Enter one of the recovery codes you saved when you set up two-factor authentication. Each one works once.',
        );
    }
    return t(
        'mobile.onboarding.mfa_key_only',
        'This account signs in with a security key, which this app cannot use. Enter one of your recovery codes instead; each one works once. Your key works when you sign in on the web.',
    );
}

export function MfaScreen() {
    const { stage, submitMfaCode, signOut, busy, error, clearError } = useAuth();
    const t = useTranslation();
    const username = stage.kind === 'mfa-required' ? stage.username : '';
    const methods = stage.kind === 'mfa-required' ? stage.methods : undefined;
    const hasTotp = !methods || methods.includes('totp');
    const [mode, setMode] = useState<'totp' | 'recovery'>(hasTotp ? 'totp' : 'recovery');
    const [code, setCode] = useState('');
    const totp = mode === 'totp';

    const submit = async (value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        try {
            await submitMfaCode(trimmed);
        } catch {
            // The message is on `error`; clearing the field is the useful part,
            // so the next attempt does not start by deleting six digits.
            setCode('');
        }
    };

    const ready = totp ? code.length === MFA_CODE_LENGTH : code.trim().length > 0;

    return (
        <AuthShell
            icon={totp ? 'Smartphone' : 'LifeBuoy'}
            title={t('mobile.onboarding.mfa_title', 'Two-factor code')}
            subtitle={mfaSubtitle(t, totp, hasTotp)}
            footer={
                <>
                    {hasTotp ? (
                        <TextLink
                            label={
                                totp
                                    ? t('mfa.use_recovery', 'Lost your authenticator? Use a recovery code')
                                    : t('mfa.use_authenticator', 'Use your authenticator app instead')
                            }
                            onPress={() => {
                                setMode(totp ? 'recovery' : 'totp');
                                setCode('');
                                clearError();
                            }}
                        />
                    ) : null}
                    <TextLink
                        label={t('mobile.onboarding.mfa_someone_else', 'Sign in as someone else')}
                        tone="tertiary"
                        onPress={() => void signOut()}
                    />
                </>
            }
        >
            {error ? <Banner tone="error">{error}</Banner> : null}

            {username ? (
                <Text variant="caption" tone="tertiary" center>
                    {t('mobile.onboarding.mfa_signing_in_as', 'Signing in as {name}', { name: username })}
                </Text>
            ) : null}

            <MfaCodeInput
                mode={mode}
                code={code}
                onCode={setCode}
                busy={busy}
                hasError={Boolean(error)}
                clearError={clearError}
                onSubmit={(value) => void submit(value)}
            />

            <Button
                label={t('mfa.verify', 'Verify')}
                onPress={() => void submit(code)}
                size="lg"
                fullWidth
                loading={busy}
                disabled={!ready}
            />

            <Text variant="caption" tone="tertiary" center>
                {t('mobile.onboarding.mfa_attempts', 'Five wrong codes end this sign-in and send you back to your password.')}
            </Text>
        </AuthShell>
    );
}

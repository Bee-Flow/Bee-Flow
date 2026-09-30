/**
 * Password reset by email.
 *
 * /auth/forgot-password always answers 200 whether or not the address exists —
 * deliberately, so this endpoint cannot be used to discover who has an account.
 * The confirmation is worded to match that exactly: promising "we sent you an
 * email" for an address with no account would be a lie the server took care
 * not to tell.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { Banner, Button, Text, TextField } from '@/shared/ui';

import { AuthShell } from './AuthShell';
import { TextLink } from './TextLink';

export function ForgotPassword({
    busy,
    sent,
    error,
    onSubmit,
    onBack,
}: {
    busy: boolean;
    sent: boolean;
    error: string | null;
    onSubmit: (email: string) => void;
    onBack: () => void;
}) {
    const [email, setEmail] = useState('');
    const t = useTranslation();

    return (
        <AuthShell
            icon="Mail"
            title={t('reset.title', 'Reset your password')}
            subtitle={t(
                'mobile.onboarding.reset_intro',
                'We will email you a link. Opening it finishes the reset in your browser, then come back here to sign in.',
            )}
            footer={<TextLink label={t('reset.back_to_signin', 'Back to sign in')} tone="tertiary" onPress={onBack} />}
        >
            {error ? <Banner tone="error">{error}</Banner> : null}

            {sent ? (
                <Banner tone="success" icon="CircleCheckBig">
                    {t(
                        'mobile.onboarding.reset_sent',
                        'If that address belongs to a password account here, a reset link is on its way. It is valid for one hour.',
                    )}
                </Banner>
            ) : (
                <>
                    <TextField
                        label={t('login.email', 'Email address')}
                        value={email}
                        onChangeText={setEmail}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="email-address"
                        inputMode="email"
                        autoComplete="email"
                        textContentType="emailAddress"
                        autoFocus
                        returnKeyType="go"
                        onSubmitEditing={() => onSubmit(email.trim())}
                        editable={!busy}
                    />
                    <Button
                        label={t('reset.send_link', 'Send the link')}
                        onPress={() => onSubmit(email.trim())}
                        size="lg"
                        fullWidth
                        loading={busy}
                        disabled={!email.trim()}
                    />
                    <Text variant="caption" tone="tertiary" center>
                        {t(
                            'mobile.onboarding.reset_sso_note',
                            'Accounts that sign in with Google, Microsoft or Nextcloud do not have a password to reset.',
                        )}
                    </Text>
                </>
            )}
        </AuthShell>
    );
}

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
import { View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import { AuthShell, TextLink } from '../../src/features/onboarding/AuthShell';
import { CodeField } from '../../src/features/onboarding/CodeField';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Button } from '../../src/ui/Button';
import { Banner } from '../../src/ui/Feedback';
import { TextField } from '../../src/ui/Input';
import { Text } from '../../src/ui/Text';

const CODE_LENGTH = 6;

export default function MfaScreen() {
    const theme = useTheme();
    const { stage, submitMfaCode, signOut, busy, error, clearError } = useAuth();
    const username = stage.kind === 'mfa-required' ? stage.username : '';
    const methods = stage.kind === 'mfa-required' ? stage.methods : undefined;
    const hasTotp = !methods || methods.includes('totp');

    const [mode, setMode] = useState<'totp' | 'recovery'>(hasTotp ? 'totp' : 'recovery');
    const [code, setCode] = useState('');

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

    /**
     * Auto-submit the moment six digits are in. A TOTP code is only valid for
     * thirty seconds — making someone type six digits and then reach for a
     * button spends a meaningful slice of that window.
     */
    const onChangeTotp = (value: string) => {
        const digits = value.replace(/\D/g, '').slice(0, CODE_LENGTH);
        setCode(digits);
        if (error) clearError();
        if (digits.length === CODE_LENGTH && !busy) void submit(digits);
    };

    const ready = mode === 'totp' ? code.length === CODE_LENGTH : code.trim().length > 0;

    return (
        <AuthShell
            icon={mode === 'totp' ? 'smartphone' : 'life-buoy'}
            title="Two-factor code"
            subtitle={
                mode === 'totp'
                    ? 'Open your authenticator app and enter the six digits it shows for Bee Flow.'
                    : hasTotp
                        ? 'Enter one of the recovery codes you saved when you set up two-factor authentication. Each one works once.'
                        : 'This account signs in with a security key, which this app cannot use. Enter one of your recovery codes instead; each one works once. Your key works when you sign in on the web.'
            }
            footer={
                <>
                    {hasTotp ? (
                        <TextLink
                            label={
                                mode === 'totp'
                                    ? 'Lost your authenticator? Use a recovery code'
                                    : 'Use your authenticator app instead'
                            }
                            onPress={() => {
                                setMode(mode === 'totp' ? 'recovery' : 'totp');
                                setCode('');
                                clearError();
                            }}
                        />
                    ) : null}
                    <TextLink
                        label="Sign in as someone else"
                        tone="tertiary"
                        onPress={() => void signOut()}
                    />
                </>
            }
        >
            {error ? <Banner tone="error">{error}</Banner> : null}

            {username ? (
                <Text variant="caption" tone="tertiary" center>
                    Signing in as {username}
                </Text>
            ) : null}

            {mode === 'totp' ? (
                <View style={{ gap: theme.spacing.sm }}>
                    <CodeField
                        value={code}
                        onChangeText={onChangeTotp}
                        length={CODE_LENGTH}
                        autoFocus
                        editable={!busy}
                        accessibilityLabel="Six-digit authentication code"
                    />
                    <Text variant="caption" tone="tertiary" center>
                        Codes change every 30 seconds. If yours keeps being refused,
                        check that this phone&apos;s clock is set automatically.
                    </Text>
                </View>
            ) : (
                <TextField
                    label="Recovery code"
                    value={code}
                    onChangeText={(value) => {
                        setCode(value);
                        if (error) clearError();
                    }}
                    placeholder="a1b2-c3d4"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus
                    editable={!busy}
                    returnKeyType="go"
                    onSubmitEditing={() => void submit(code)}
                    hint="Using a recovery code uses it up. You have ten in total."
                />
            )}

            <Button
                label="Verify"
                onPress={() => void submit(code)}
                size="lg"
                fullWidth
                loading={busy}
                disabled={!ready}
            />

            <Text variant="caption" tone="tertiary" center>
                Five wrong codes end this sign-in and send you back to your password.
            </Text>
        </AuthShell>
    );
}

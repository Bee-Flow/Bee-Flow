/**
 * "Confirm your email address first."
 *
 * A dead end with three ways out and no session behind it — /auth/admin-login
 * answers `emailVerificationRequired` and explicitly clears the session
 * (server/auth/login/finalizeLogin.js), so nothing here can call an
 * authenticated endpoint. The only lever is POST /auth/resend-verification,
 * which is public.
 *
 * That endpoint always answers 200, whether or not the address exists and
 * whether or not it is unverified, and silently does nothing if a token was
 * issued in the last sixty seconds. Both behaviours are mirrored in the copy
 * and in the cooldown below: telling someone "sent!" when the server decided
 * not to send is the kind of small lie that costs a support ticket.
 */

import { useMutation } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import { resendVerificationEmail } from '../../src/features/onboarding/api';
import { AuthShell, TextLink } from '../../src/features/onboarding/AuthShell';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Button } from '../../src/ui/Button';
import { Banner, describeError } from '../../src/ui/Feedback';
import { TextField } from '../../src/ui/Input';
import { Text } from '../../src/ui/Text';

/** Matches the server's own refusal window in emailVerificationRoutes.js. */
const COOLDOWN_SECONDS = 60;

export default function VerifyEmailScreen() {
    const theme = useTheme();
    const { stage, refresh, signOut } = useAuth();

    // The stage carries the address only when the user signed in with one;
    // someone who typed a username has to tell us where to send it.
    const known = stage.kind === 'email-verification-required' ? stage.email : '';
    const [email, setEmail] = useState(known);
    const [cooldown, setCooldown] = useState(0);
    // `busy` on the auth context tracks a sign-in, not a refresh, so the
    // button below has to own its own pending state or it never spins.
    const [checking, setChecking] = useState(false);

    useEffect(() => {
        if (cooldown <= 0) return;
        const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
        return () => clearTimeout(timer);
    }, [cooldown]);

    const resend = useMutation({
        mutationFn: (address: string) => resendVerificationEmail(address),
        onSuccess: () => setCooldown(COOLDOWN_SECONDS),
    });

    return (
        <AuthShell
            icon="mail"
            tone="warning"
            title="Confirm your email address"
            subtitle={
                known
                    ? `Your password was right, but ${known} has not been confirmed yet. Open the link in the email we sent, then come back.`
                    : 'Your password was right, but this account has not confirmed its email address yet. Open the link in the email we sent, then come back.'
            }
            footer={
                <TextLink
                    label="Sign in with a different account"
                    tone="tertiary"
                    onPress={() => void signOut()}
                />
            }
        >
            {resend.isError ? (
                <Banner tone="error">{describeError(resend.error).message}</Banner>
            ) : null}

            {resend.isSuccess ? (
                <Banner tone="success" icon="check-circle">
                    If that address has an account here waiting to be confirmed, a new
                    link is on its way. Links last 24 hours.
                </Banner>
            ) : null}

            {known ? null : (
                <TextField
                    label="Email address"
                    value={email}
                    onChangeText={setEmail}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    inputMode="email"
                    autoComplete="email"
                    textContentType="emailAddress"
                    hint="Where should we send the link?"
                />
            )}

            <Button
                label={cooldown > 0 ? `Send again in ${cooldown}s` : 'Send the link again'}
                onPress={() => resend.mutate((known || email).trim())}
                variant="secondary"
                fullWidth
                loading={resend.isPending}
                disabled={cooldown > 0 || !(known || email).trim()}
                accessibilityHint={
                    cooldown > 0 ? 'The server will not issue another link yet' : undefined
                }
            />

            <Button
                label="I have confirmed it — try again"
                onPress={() => {
                    setChecking(true);
                    void refresh().finally(() => setChecking(false));
                }}
                size="lg"
                fullWidth
                loading={checking}
            />

            <View style={{ gap: theme.spacing.xs, paddingTop: theme.spacing.sm }}>
                <Text variant="caption" tone="tertiary" center>
                    Check your spam folder before asking again — the message comes from
                    whichever address your administrator configured, which may not look
                    like Bee Flow.
                </Text>
            </View>
        </AuthShell>
    );
}

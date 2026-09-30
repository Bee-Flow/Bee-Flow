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

import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Text, TextField } from '@/shared/ui';

import { AuthShell } from '../components/AuthShell';
import { TextLink } from '../components/TextLink';
import { useResendVerification } from '../hooks/mutations';

/** Matches the server's own refusal window in emailVerificationRoutes.js. */
const COOLDOWN_SECONDS = 60;

const makeStyles = (theme: Theme) => StyleSheet.create({ note: { gap: theme.spacing.xs, paddingTop: theme.spacing.sm } });

export function VerifyEmailScreen() {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
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

    const resend = useResendVerification(() => setCooldown(COOLDOWN_SECONDS));
    const address = (known || email).trim();

    return (
        <AuthShell
            icon="Mail"
            tone="warning"
            title={t('login.verify_title', 'Confirm your email address')}
            subtitle={
                known
                    ? t(
                          'mobile.onboarding.verify_intro_known',
                          'Your password was right, but {email} has not been confirmed yet. Open the link in the email we sent, then come back.',
                          { email: known },
                      )
                    : t(
                          'mobile.onboarding.verify_intro',
                          'Your password was right, but this account has not confirmed its email address yet. Open the link in the email we sent, then come back.',
                      )
            }
            footer={
                <TextLink
                    label={t('mobile.onboarding.verify_other_account', 'Sign in with a different account')}
                    tone="tertiary"
                    onPress={() => void signOut()}
                />
            }
        >
            {resend.isError ? <Banner tone="error">{describeError(resend.error).message}</Banner> : null}

            {resend.isSuccess ? (
                <Banner tone="success" icon="CircleCheckBig">
                    {t(
                        'mobile.onboarding.verify_resent',
                        'If that address has an account here waiting to be confirmed, a new link is on its way. Links last 24 hours.',
                    )}
                </Banner>
            ) : null}

            {known ? null : (
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
                    hint={t('mobile.onboarding.verify_where', 'Where should we send the link?')}
                />
            )}

            <Button
                label={
                    cooldown > 0
                        ? t('mobile.onboarding.verify_cooldown', 'Send again in {n}s', { n: cooldown })
                        : t('login.verify_resend', 'Send the link again')
                }
                onPress={() => resend.mutate(address)}
                variant="secondary"
                fullWidth
                loading={resend.isPending}
                disabled={cooldown > 0 || !address}
                accessibilityHint={
                    cooldown > 0 ? t('mobile.onboarding.verify_cooldown_hint', 'The server will not issue another link yet') : undefined
                }
            />

            <Button
                label={t('mobile.onboarding.verify_done', 'I have confirmed it — try again')}
                onPress={() => {
                    setChecking(true);
                    void refresh().finally(() => setChecking(false));
                }}
                size="lg"
                fullWidth
                loading={checking}
            />

            <View style={styles.note}>
                <Text variant="caption" tone="tertiary" center>
                    {t(
                        'mobile.onboarding.verify_spam',
                        'Check your spam folder before asking again — the message comes from whichever address your administrator configured, which may not look like Bee Flow.',
                    )}
                </Text>
            </View>
        </AuthShell>
    );
}

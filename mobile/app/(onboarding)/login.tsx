/**
 * Sign in.
 *
 * The branching lives in `useAuth().signIn`, not here: it posts to
 * /auth/admin-login, re-runs the whole thing over OPAQUE if the account has
 * migrated, and sets whichever stage the answer implies (MFA, unverified
 * email, pending approval). This screen's job is to collect two strings, say
 * what the instance actually offers, and never claim to know more than the
 * server told it.
 *
 * What the instance offers comes from two places that have to be merged:
 * `oauthProviders`/`isOAuthConfigured` ride along on the signed-out stage
 * (from /auth/user), while Google and Microsoft are only reported by
 * /auth/setup-status. An instance with Google configured but an empty
 * `oauthProviders` is normal, so trusting either source alone hides a button
 * the user needs.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { getServerUrl } from '../../src/api/server';
import { useAuth } from '../../src/auth/AuthProvider';
import { adoptSessionToken } from '../../src/auth/sessionToken';
import {
    fetchSetupStatus,
    onboardingKeys,
    requestPasswordReset,
} from '../../src/features/onboarding/api';
import { AuthShell, TextLink } from '../../src/features/onboarding/AuthShell';
import {
    resolveProviders,
    SSO_LABELS,
    SsoCancelledError,
    startSsoLogin,
    type SsoProvider,
} from '../../src/features/onboarding/sso';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Button } from '../../src/ui/Button';
import { Banner, describeError } from '../../src/ui/Feedback';
import { TextField } from '../../src/ui/Input';
import { Divider } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';

export default function LoginScreen() {
    const theme = useTheme();
    const { stage, signIn, refresh, forgetServer, busy, error, clearError } = useAuth();

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [view, setView] = useState<'sign-in' | 'forgot'>('sign-in');
    const [ssoProvider, setSsoProvider] = useState<SsoProvider | null>(null);
    /** Set only when SSO signed in on the server but not in this app — see below. */
    const [ssoStranded, setSsoStranded] = useState<string | null>(null);
    const [ssoError, setSsoError] = useState<string | null>(null);
    const ssoAbort = useRef<AbortController | null>(null);

    // Note there is deliberately no "clear the error on unmount" effect here.
    // `clearError` is a fresh closure on every AuthProvider render, so an
    // effect depending on it re-runs whenever `error` changes and its cleanup
    // would wipe the message before anyone read it. Nothing needs it anyway:
    // signIn and submitMfaCode both clear the error before they start, and the
    // fields below clear it as soon as the user edits them.
    useEffect(() => () => ssoAbort.current?.abort(), []);

    const status = useQuery({
        queryKey: onboardingKeys.setupStatus,
        queryFn: ({ signal }) => fetchSetupStatus(signal),
        // Pre-auth and effectively static for the life of a launch.
        staleTime: 5 * 60_000,
    });

    const providers = resolveProviders(
        stage.kind === 'signed-out' ? stage.oauthProviders : [],
        status.data ?? null,
    );
    // `allowPasswordLogin` is an operator kill switch (ALLOW_PASSWORD_LOGIN).
    // Until /auth/setup-status answers, assume the form is allowed — hiding it
    // and then showing it is worse than showing it and then hiding it.
    const passwordAllowed = status.data?.allowPasswordLogin !== false;
    const instanceName = status.data?.branding?.name;
    const serverUrl = getServerUrl();

    const submit = async () => {
        if (!username.trim() || !password) return;
        try {
            await signIn(username.trim(), password);
        } catch {
            // signIn already put a human-readable message on `error`; it
            // rethrows so callers can branch, which this one does not need to.
        }
    };

    const startSso = async (provider: SsoProvider) => {
        clearError();
        setSsoStranded(null);
        setSsoError(null);
        setSsoProvider(provider);
        const controller = new AbortController();
        ssoAbort.current = controller;
        try {
            const result = await startSsoLogin(provider, controller.signal);
            // The token IS the session — the bridge sets no cookie this app can
            // see, so nothing is signed in until this line has run. Awaited
            // before `refresh()`, because refresh() is what makes the first
            // authenticated request.
            await adoptSessionToken(result.sessionToken);
            await refresh();
            // `refresh()` moves the stage and the gate replaces this route, so
            // reaching the next line means the token was claimed and the server
            // still did not recognise the session. Rare — a bridge token that
            // expired between the pickup and here, or an instance running
            // without the shared Redis the bridge needs across processes — but
            // it has to say something a person can act on rather than leaving a
            // spinner up. (See src/features/onboarding/sso.ts.)
            setSsoStranded(result.user?.displayName ?? SSO_LABELS[provider]);
        } catch (err) {
            // Backing out is not a failure and needs no banner — the button
            // stopping its spinner is the whole story. Anything else does:
            // "the spinner stopped and nothing happened" is precisely the
            // failure a user cannot act on, and it is what this screen did for
            // every SSO problem before.
            const cancelled =
                err instanceof SsoCancelledError && err.reason === 'user-cancelled';
            if (!cancelled) {
                setSsoStranded(null);
                // Surfaced inline below rather than as a toast: an error the
                // user cannot re-read is an error they cannot act on.
                setSsoError(
                    err instanceof SsoCancelledError
                        ? `${SSO_LABELS[provider]} sign-in did not complete. Please try again.`
                        : describeError(err).message,
                );
            }
        } finally {
            setSsoProvider(null);
            ssoAbort.current = null;
        }
    };

    const forgot = useMutation({
        mutationFn: (email: string) => requestPasswordReset(email),
    });

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
            title={instanceName ? `Sign in to ${instanceName}` : 'Sign in'}
            subtitle={serverUrl ? serverUrl.replace(/^https?:\/\//, '') : undefined}
            footer={
                <TextLink
                    label="Connect to a different server"
                    tone="tertiary"
                    onPress={() => void forgetServer()}
                    accessibilityHint="Forgets this server and asks for another address"
                />
            }
        >
            {error ? <Banner tone="error">{error}</Banner> : null}
            {ssoError ? <Banner tone="error">{ssoError}</Banner> : null}
            {ssoStranded ? (
                <Banner tone="warning" icon="alert-triangle">
                    {`${ssoStranded} signed in, but the session had already expired by the time this app claimed it. Try again — it usually works second time.`}
                </Banner>
            ) : null}

            {passwordAllowed ? (
                <>
                    <TextField
                        label="Email or username"
                        value={username}
                        onChangeText={(value) => {
                            setUsername(value);
                            if (error) clearError();
                        }}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="email-address"
                        inputMode="email"
                        autoComplete="username"
                        textContentType="username"
                        returnKeyType="next"
                        editable={!busy}
                    />
                    <TextField
                        label="Password"
                        value={password}
                        onChangeText={(value) => {
                            setPassword(value);
                            if (error) clearError();
                        }}
                        secure
                        autoComplete="current-password"
                        textContentType="password"
                        returnKeyType="go"
                        onSubmitEditing={() => void submit()}
                        editable={!busy}
                    />
                    <Button
                        label="Sign in"
                        onPress={() => void submit()}
                        size="lg"
                        fullWidth
                        loading={busy}
                        disabled={!username.trim() || !password}
                    />
                    <TextLink
                        label="Forgot your password?"
                        onPress={() => {
                            clearError();
                            setView('forgot');
                        }}
                    />
                </>
            ) : (
                <Banner tone="info" icon="info">
                    This server has turned off password sign-in. Use one of the
                    options below.
                </Banner>
            )}

            {providers.length > 0 ? (
                <View style={{ gap: theme.spacing.md }}>
                    {passwordAllowed ? (
                        <View
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: theme.spacing.md,
                            }}
                        >
                            <View style={{ flex: 1 }}>
                                <Divider />
                            </View>
                            <Text variant="label" tone="tertiary">
                                OR
                            </Text>
                            <View style={{ flex: 1 }}>
                                <Divider />
                            </View>
                        </View>
                    ) : null}

                    {providers.map((provider) => (
                        <Button
                            key={provider}
                            label={`Continue with ${SSO_LABELS[provider]}`}
                            onPress={() => void startSso(provider)}
                            variant="secondary"
                            fullWidth
                            loading={ssoProvider === provider}
                            disabled={busy || (ssoProvider !== null && ssoProvider !== provider)}
                            icon={
                                <Feather
                                    name={provider === 'nextcloud' ? 'cloud' : 'log-in'}
                                    size={16}
                                    color={theme.colors.textPrimary}
                                />
                            }
                            accessibilityHint="Opens your browser to finish signing in"
                        />
                    ))}
                </View>
            ) : null}

            {status.data?.allowSignups && serverUrl ? (
                <View style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
                    <Text variant="caption" tone="tertiary" center>
                        {status.data.waitlistEnabled
                            ? 'New accounts on this server join a waiting list.'
                            : 'This server accepts new accounts.'}
                    </Text>
                    <TextLink
                        label="Create an account"
                        onPress={() => {
                            // Sign-up is a long form with plan selection and,
                            // on some instances, a captcha — all of it web-only.
                            // Handing it to the browser is honest; a half-port
                            // that cannot complete would not be.
                            void WebBrowser.openBrowserAsync(`${serverUrl}/login?signup=1`, {
                                createTask: false,
                            });
                        }}
                        accessibilityHint="Opens the sign-up form in your browser"
                    />
                </View>
            ) : null}
        </AuthShell>
    );
}

/**
 * Password reset by email.
 *
 * /auth/forgot-password always answers 200 whether or not the address exists —
 * deliberately, so this endpoint cannot be used to discover who has an account.
 * The confirmation is worded to match that exactly: promising "we sent you an
 * email" for an address with no account would be a lie the server took care
 * not to tell.
 */
function ForgotPassword({
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

    return (
        <AuthShell
            icon="mail"
            title="Reset your password"
            subtitle="We will email you a link. Opening it finishes the reset in your browser, then come back here to sign in."
            footer={<TextLink label="Back to sign in" tone="tertiary" onPress={onBack} />}
        >
            {error ? <Banner tone="error">{error}</Banner> : null}

            {sent ? (
                <Banner tone="success" icon="check-circle">
                    If that address belongs to a password account here, a reset link
                    is on its way. It is valid for one hour.
                </Banner>
            ) : (
                <>
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
                        autoFocus
                        returnKeyType="go"
                        onSubmitEditing={() => onSubmit(email.trim())}
                        editable={!busy}
                    />
                    <Button
                        label="Send the link"
                        onPress={() => onSubmit(email.trim())}
                        size="lg"
                        fullWidth
                        loading={busy}
                        disabled={!email.trim()}
                    />
                    <Text variant="caption" tone="tertiary" center>
                        Accounts that sign in with Google, Microsoft or Nextcloud do
                        not have a password to reset.
                    </Text>
                </>
            )}
        </AuthShell>
    );
}

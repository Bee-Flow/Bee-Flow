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

import { useMutation, useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import React, { useState } from 'react';
import { View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import {
    enableMfa,
    onboardingKeys,
    startMfaSetup,
    type MfaSetupResponse,
} from '../../src/features/onboarding/api';
import { AuthShell, TextLink } from '../../src/features/onboarding/AuthShell';
import { CodeField } from '../../src/features/onboarding/CodeField';
import { QrCode } from '../../src/features/onboarding/QrCode';
import { RecoveryKeyCard } from '../../src/features/onboarding/RecoveryKeyCard';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Button } from '../../src/ui/Button';
import { Banner, describeError, ErrorState, LoadingState } from '../../src/ui/Feedback';
import { Card } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

const CODE_LENGTH = 6;
/** TOTP tolerates ±30s. Past that, codes fail for a reason nobody guesses. */
const DRIFT_WARNING_MS = 45_000;

interface SetupData extends MfaSetupResponse {
    /** Device clock minus server clock, measured at the moment of the answer. */
    driftMs: number;
}

export default function MfaSetupScreen() {
    const theme = useTheme();
    const { refresh, signOut } = useAuth();
    const { toast } = useToast();

    const [code, setCode] = useState('');
    const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

    const setup = useQuery<SetupData>({
        queryKey: onboardingKeys.mfaSetup,
        queryFn: async () => {
            const res = await startMfaSetup(false);
            return { ...res, driftMs: Date.now() - res.serverTime };
        },
        // The secret is stable server-side for ten minutes and re-fetching it
        // is exactly the desync this screen exists to avoid.
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        retry: false,
    });

    const enable = useMutation({
        mutationFn: (value: string) => enableMfa(value),
        onSuccess: (result) => setRecoveryCodes(result.recoveryCodes),
        onError: () => setCode(''),
    });

    const startOver = useMutation({
        mutationFn: () => startMfaSetup(true),
        onSuccess: async () => {
            setCode('');
            enable.reset();
            await setup.refetch();
        },
    });

    if (recoveryCodes) {
        return (
            <AuthShell icon="check-circle" tone="success" title="Two-factor is on">
                <RecoveryKeyCard
                    secret={recoveryCodes}
                    title="Save your recovery codes"
                    description="Each of these signs you in once if you lose your phone. Without them, and without your authenticator, only an administrator can let you back in."
                    shareTitle="Bee Flow recovery codes"
                    confirmLabel="I have saved them — continue"
                    onConfirm={() => void refresh()}
                />
            </AuthShell>
        );
    }

    if (setup.isLoading) {
        return (
            <AuthShell icon="shield" title="Set up two-factor sign-in">
                <LoadingState label="Preparing your authenticator setup…" />
            </AuthShell>
        );
    }

    if (setup.isError || !setup.data) {
        return (
            <AuthShell icon="shield" title="Set up two-factor sign-in">
                <ErrorState error={setup.error} onRetry={() => void setup.refetch()} />
                <TextLink label="Sign out" tone="tertiary" onPress={() => void signOut()} />
            </AuthShell>
        );
    }

    const data = setup.data;
    // Base32 in groups of four: the difference between a key someone can type
    // and one they give up on.
    const grouped = data.secret.replace(/(.{4})/g, '$1 ').trim();
    const driftBad = Math.abs(data.driftMs) > DRIFT_WARNING_MS;

    return (
        <AuthShell
            icon="shield"
            title="Set up two-factor sign-in"
            subtitle="This server requires a second factor. Scan the code with an authenticator app — Google Authenticator, Aegis, 1Password, whichever you already use."
            footer={
                <>
                    <TextLink
                        label="Start over with a new code"
                        tone="tertiary"
                        onPress={() => void startOver.mutate()}
                        disabled={startOver.isPending}
                        accessibilityHint="Discards this secret and generates another"
                    />
                    <TextLink label="Sign out" tone="tertiary" onPress={() => void signOut()} />
                </>
            }
        >
            {driftBad ? (
                <Banner tone="warning" icon="clock">
                    {`This phone's clock is about ${Math.round(Math.abs(data.driftMs) / 1000)} seconds off the server's. Turn on automatic date and time, or every code you enter will be refused.`}
                </Banner>
            ) : null}

            <QrCode
                value={data.otpauthUrl}
                size={220}
                accessibilityLabel="QR code containing your two-factor setup key"
                // Our own encoder handles anything a TOTP URI can be; the
                // server's PNG is here for the payload it cannot, so the screen
                // degrades to a picture rather than to nothing.
                fallback={
                    data.qr ? (
                        <Image
                            source={{ uri: data.qr }}
                            style={{ width: 220, height: 220, alignSelf: 'center' }}
                            contentFit="contain"
                            accessibilityLabel="QR code containing your two-factor setup key"
                        />
                    ) : null
                }
            />

            <Card padded>
                <View style={{ gap: theme.spacing.sm }}>
                    <Text variant="caption" tone="secondary">
                        Can&apos;t scan? Enter this key by hand instead.
                    </Text>
                    <Text variant="code" selectable style={{ letterSpacing: 1 }}>
                        {grouped}
                    </Text>
                    <Button
                        label="Copy key"
                        variant="secondary"
                        onPress={() => {
                            void Clipboard.setStringAsync(data.secret);
                            toast('Setup key copied', 'success');
                        }}
                    />
                </View>
            </Card>

            {enable.isError ? (
                <Banner tone="error">{describeError(enable.error).message}</Banner>
            ) : null}

            <View style={{ gap: theme.spacing.sm }}>
                <Text variant="caption" tone="secondary">
                    Then enter the six digits your app shows.
                </Text>
                <CodeField
                    value={code}
                    onChangeText={(value) => {
                        setCode(value);
                        if (enable.isError) enable.reset();
                    }}
                    length={CODE_LENGTH}
                    editable={!enable.isPending}
                    onComplete={(value) => enable.mutate(value)}
                    accessibilityLabel="Six-digit code from your authenticator app"
                />
            </View>

            <Button
                label="Turn on two-factor"
                onPress={() => enable.mutate(code)}
                size="lg"
                fullWidth
                loading={enable.isPending}
                disabled={code.length !== CODE_LENGTH}
            />
        </AuthShell>
    );
}

/**
 * Security.
 *
 * This is the screen a privacy product is judged on, so it says what is true
 * rather than what sounds reassuring:
 *
 *   - App lock is a real boundary, not a "remember me". Turning it on puts the
 *     data-encryption key in the Android hardware keystore behind a biometric
 *     prompt (src/auth/vault.ts). Leaving it off means a cold start asks for
 *     your password again — which is the honest default for zero-knowledge
 *     encryption and is what the app does out of the box.
 *   - The encryption recovery key is shown exactly ONCE, when it is minted.
 *     There is no HTTP route to reissue it (server/auth/encryption.js exports
 *     `rotateRecoveryKey`, but nothing mounts it), so this screen does not
 *     offer a button that cannot work. Two-factor RECOVERY CODES are a
 *     different thing and can be regenerated, from here.
 *   - The server keeps sessions in a store keyed by cookie and exposes no
 *     list-my-sessions or revoke-all endpoint. Rather than invent one or leave
 *     a gap where people expect a control, the screen says what signing out
 *     actually does.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import * as LocalAuthentication from 'expo-local-authentication';
import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import * as vault from '../../src/auth/vault';
import {
    disableMfa,
    enableMfa,
    getMfaStatus,
    regenerateRecoveryCodes,
    settingsKeys,
    startMfaSetup,
} from '../../src/features/settings/api';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { ToggleRow } from '../../src/ui/Controls';
import { Banner, describeError, LoadingState } from '../../src/ui/Feedback';
import { Group, InfoRow, NoteRow } from '../../src/ui/Group';
import { TextField } from '../../src/ui/Input';
import { SettingRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Sheet } from '../../src/ui/Sheet';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function SecurityScreen() {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { user, signOut } = useAuth();

    const [lockAvailable, setLockAvailable] = useState<boolean | null>(null);
    const [lockEnabled, setLockEnabled] = useState(false);
    const [biometricKind, setBiometricKind] = useState('biometrics');
    const [lockError, setLockError] = useState<string | null>(null);

    const [enrolSheet, setEnrolSheet] = useState(false);
    const [codesSheet, setCodesSheet] = useState<string[] | null>(null);
    const [disableSheet, setDisableSheet] = useState(false);
    const [regenSheet, setRegenSheet] = useState(false);

    const mfa = useQuery({
        queryKey: settingsKeys.mfa,
        queryFn: ({ signal }) => getMfaStatus(signal),
        retry: false,
    });

    /**
     * Read the device's capability and this account's current opt-in state.
     *
     * Three independent platform reads, so they run together — and the `alive`
     * guard matters because `canUseBiometricAuthentication` can take a moment
     * on a cold keystore, which is long enough for the screen to be popped.
     */
    useEffect(() => {
        let alive = true;
        void (async () => {
            const [canPersist, owner, types] = await Promise.all([
                vault.canPersist(),
                vault.persistedOwner(),
                LocalAuthentication.supportedAuthenticationTypesAsync().catch(
                    (): LocalAuthentication.AuthenticationType[] => [],
                ),
            ]);
            if (!alive) return;
            setLockAvailable(canPersist);
            setLockEnabled(Boolean(owner && user && owner === user.id));
            setBiometricKind(describeBiometrics(types));
        })();
        return () => {
            alive = false;
        };
    }, [user]);

    /**
     * Turn app lock on or off.
     *
     * Turning it ON needs the DEK in memory, which is only true for a session
     * that actually unlocked (an OPAQUE sign-in, or a biometric unlock this
     * launch). A password-era session may be perfectly valid and still have no
     * DEK here, and the correct answer then is "sign out and back in", not a
     * silent failure that leaves the toggle looking on.
     */
    const toggleLock = async (next: boolean) => {
        setLockError(null);
        if (!next) {
            await vault.forget();
            setLockEnabled(false);
            toast('App lock turned off', 'neutral');
            return;
        }
        const dek = vault.getDek();
        if (!user || !dek) {
            setLockError(
                'Bee Flow does not have your encryption key in memory right now. Sign out and sign back in, then turn this on.',
            );
            return;
        }
        try {
            await vault.persist(user.id, dek);
            setLockEnabled(true);
            toast('App lock is on', 'success');
        } catch (err) {
            setLockError(describeError(err).message);
        }
    };

    const disable = useMutation({
        mutationFn: (code: string) => disableMfa(code),
        onSuccess: () => {
            setDisableSheet(false);
            void queryClient.invalidateQueries({ queryKey: settingsKeys.mfa });
            toast('Two-factor turned off', 'neutral');
        },
    });

    const regenerate = useMutation({
        mutationFn: (code: string) => regenerateRecoveryCodes(code),
        onSuccess: (result) => {
            setRegenSheet(false);
            void queryClient.invalidateQueries({ queryKey: settingsKeys.mfa });
            setCodesSheet(result?.recoveryCodes ?? []);
        },
    });

    const confirmSignOut = () => {
        Alert.alert(
            'Sign out of this device?',
            'Your encryption key is removed from this phone. Sessions on other devices are not affected — Bee Flow has no remote sign-out.',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
            ],
        );
    };

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="Security" subtitle="This device, and this account" />

            <ScrollView
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                <Group
                    title="On this phone"
                    footer={
                        lockAvailable === false
                            ? 'Your phone has no screen lock or enrolled fingerprint, so there is nowhere safe to keep the key. Set one up in Android settings and this becomes available.'
                            : 'With app lock off, Bee Flow asks for your password every time the app is started cold. With it on, the key is held in this phone’s hardware keystore and released only after ' +
                              biometricKind +
                              '. Android invalidates it if you enrol a new fingerprint.'
                    }
                >
                    <ToggleRow
                        label="Unlock with biometrics"
                        description={
                            lockEnabled
                                ? 'Your key is stored on this device, behind the keystore'
                                : 'Your key is never written to storage'
                        }
                        value={lockEnabled}
                        disabled={lockAvailable !== true}
                        onValueChange={(next) => void toggleLock(next)}
                        icon={
                            <Feather
                                name={lockEnabled ? 'unlock' : 'lock'}
                                size={16}
                                color={theme.colors.textSecondary}
                            />
                        }
                    />
                    {lockError ? (
                        <NoteRow>
                            <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                                {lockError}
                            </Text>
                        </NoteRow>
                    ) : null}
                    <InfoRow
                        label="Relocks after"
                        value="2 minutes in the background"
                    />
                </Group>

                <Group
                    title="Two-factor authentication"
                    footer="A code from an authenticator app, on top of your password. If your organisation requires it for administrators, turning it off may lock you out of admin screens."
                >
                    {mfa.isLoading ? (
                        <NoteRow>
                            <LoadingState />
                        </NoteRow>
                    ) : mfa.isError ? (
                        <NoteRow>
                            <Text variant="caption" tone="error">
                                {describeError(mfa.error).message}
                            </Text>
                        </NoteRow>
                    ) : (
                        <View
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: theme.spacing.md,
                                paddingHorizontal: theme.spacing.lg,
                                paddingVertical: theme.spacing.md,
                                minHeight: theme.minTouch,
                            }}
                        >
                            <Feather
                                name="shield"
                                size={16}
                                color={
                                    mfa.data?.enabled ? theme.colors.success : theme.colors.textMuted
                                }
                            />
                            <Text variant="body" style={{ flex: 1 }}>
                                Status
                            </Text>
                            <Badge
                                label={mfa.data?.enabled ? 'On' : 'Off'}
                                tone={mfa.data?.enabled ? 'success' : 'neutral'}
                            />
                        </View>
                    )}

                    {mfa.data?.enabled ? (
                        <InfoRow
                            label="Recovery codes left"
                            value={String(mfa.data.recoveryCodesRemaining)}
                            tone={mfa.data.recoveryCodesRemaining <= 2 ? 'warning' : 'tertiary'}
                        />
                    ) : null}

                    {mfa.data?.enabled ? (
                        <SettingRow
                            label="Generate new recovery codes"
                            icon={
                                <Feather
                                    name="refresh-cw"
                                    size={16}
                                    color={theme.colors.textSecondary}
                                />
                            }
                            onPress={() => setRegenSheet(true)}
                        />
                    ) : null}

                    {mfa.data?.enabled ? (
                        <SettingRow
                            label="Turn off two-factor"
                            destructive
                            icon={
                                <Feather name="shield-off" size={16} color={theme.colors.error} />
                            }
                            onPress={() => setDisableSheet(true)}
                        />
                    ) : (
                        <SettingRow
                            label="Set up two-factor"
                            icon={
                                <Feather
                                    name="shield"
                                    size={16}
                                    color={theme.colors.textSecondary}
                                />
                            }
                            onPress={() => setEnrolSheet(true)}
                        />
                    )}
                </Group>

                <Group
                    title="Encryption"
                    footer="Bee Flow is zero-knowledge: your data key is derived on your device and the server only ever holds it wrapped. Nobody at Bee Flow, and no administrator, can read your content."
                >
                    <InfoRow
                        label="Content encryption"
                        value={vault.getDek() ? 'Unlocked this session' : 'Locked'}
                        tone={vault.getDek() ? 'success' : 'tertiary'}
                    />
                    <InfoRow label="Key wrapping" value="AES-256-GCM, Argon2id" />
                    <InfoRow label="Sign-in protocol" value={user?.provider === 'local' ? 'OPAQUE' : 'Single sign-on'} />
                    <NoteRow>
                        <View style={{ gap: theme.spacing.xs }}>
                            <Text variant="body">Your recovery key</Text>
                            <Text variant="caption" tone="tertiary">
                                It was shown once, when your encryption was first set up or
                                migrated. It cannot be shown again and cannot be reissued from
                                here — the server has no route to rotate it. If you have lost it,
                                changing your password from a session you can still sign in to is
                                what re-wraps your key.
                            </Text>
                        </View>
                    </NoteRow>
                </Group>

                <Group
                    title="Sessions"
                    footer="Bee Flow keeps sessions server-side, keyed by a cookie, and exposes no way to list or revoke them remotely. Signing out here ends this device’s session and wipes its stored key."
                >
                    <SettingRow
                        label="Sign out of this device"
                        destructive
                        icon={<Feather name="log-out" size={16} color={theme.colors.error} />}
                        onPress={confirmSignOut}
                    />
                </Group>
            </ScrollView>

            <EnrolSheet
                visible={enrolSheet}
                onClose={() => setEnrolSheet(false)}
                onEnrolled={(codes) => {
                    setEnrolSheet(false);
                    void queryClient.invalidateQueries({ queryKey: settingsKeys.mfa });
                    setCodesSheet(codes);
                }}
            />

            <CodeSheet
                visible={disableSheet}
                onClose={() => setDisableSheet(false)}
                title="Turn off two-factor"
                subtitle="Enter a current code, or one of your recovery codes"
                actionLabel="Turn off"
                destructive
                pending={disable.isPending}
                error={disable.isError ? describeError(disable.error).message : null}
                onSubmit={(code) => disable.mutate(code)}
            />

            <CodeSheet
                visible={regenSheet}
                onClose={() => setRegenSheet(false)}
                title="New recovery codes"
                subtitle="Your existing codes stop working immediately"
                actionLabel="Generate"
                pending={regenerate.isPending}
                error={regenerate.isError ? describeError(regenerate.error).message : null}
                onSubmit={(code) => regenerate.mutate(code)}
            />

            <RecoveryCodesSheet codes={codesSheet} onClose={() => setCodesSheet(null)} />
        </Screen>
    );
}

/**
 * TOTP enrolment.
 *
 * `POST /auth/mfa/setup` is idempotent for ten minutes and returns a rendered
 * QR as a data URI, so the phone does not need a QR library — and re-opening
 * this sheet shows the SAME secret the authenticator already scanned.
 */
function EnrolSheet({
    visible,
    onClose,
    onEnrolled,
}: {
    visible: boolean;
    onClose: () => void;
    onEnrolled: (codes: string[]) => void;
}) {
    const theme = useTheme();
    const { toast } = useToast();
    const [code, setCode] = useState('');

    const setup = useQuery({
        queryKey: ['settings', 'mfa', 'setup'],
        queryFn: () => startMfaSetup(false),
        // Only mint a secret when the sheet is actually open — a pending
        // enrolment secret is session state, not something to create on a
        // screen visit.
        enabled: visible,
        staleTime: 5 * 60_000,
        retry: false,
    });

    const enable = useMutation({
        mutationFn: () => enableMfa(code.trim()),
        onSuccess: (result) => {
            setCode('');
            onEnrolled(result?.recoveryCodes ?? []);
        },
    });

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Set up two-factor"
            subtitle="Scan the code with your authenticator app"
            footer={
                <Button
                    label="Turn on two-factor"
                    onPress={() => enable.mutate()}
                    disabled={code.trim().length < 6}
                    loading={enable.isPending}
                    fullWidth
                />
            }
        >
            <View style={{ gap: theme.spacing.lg }}>
                {setup.isLoading ? (
                    <LoadingState label="Preparing your code" />
                ) : setup.isError ? (
                    <Banner tone="error">{describeError(setup.error).message}</Banner>
                ) : setup.data ? (
                    <>
                        <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
                            <Image
                                source={{ uri: setup.data.qr }}
                                accessibilityLabel="Two-factor setup QR code"
                                style={{
                                    width: 200,
                                    height: 200,
                                    borderRadius: theme.radii.md,
                                    // The QR is black-on-white; on a dark theme
                                    // it needs its own white ground or the
                                    // quiet zone vanishes and scanners fail.
                                    backgroundColor: '#ffffff',
                                }}
                                contentFit="contain"
                            />
                            <Button
                                label="Copy setup key instead"
                                variant="ghost"
                                onPress={() => {
                                    void Clipboard.setStringAsync(setup.data?.secret ?? '');
                                    toast('Setup key copied', 'success');
                                }}
                            />
                        </View>
                        {clockDriftWarning(setup.data.serverTime) ? (
                            <Banner tone="warning">
                                This phone&rsquo;s clock is more than a minute off the server&rsquo;s.
                                Time-based codes will be rejected until you fix it in Android&rsquo;s
                                date and time settings.
                            </Banner>
                        ) : null}
                    </>
                ) : null}

                {enable.isError ? (
                    <Banner tone="error">{describeError(enable.error).message}</Banner>
                ) : null}

                <TextField
                    label="Six-digit code from the app"
                    value={code}
                    onChangeText={setCode}
                    keyboardType="number-pad"
                    maxLength={6}
                    autoComplete="one-time-code"
                    textContentType="oneTimeCode"
                />
            </View>
        </Sheet>
    );
}

/** A one-field sheet for the actions that need a current TOTP or recovery code. */
function CodeSheet({
    visible,
    onClose,
    title,
    subtitle,
    actionLabel,
    onSubmit,
    pending,
    error,
    destructive = false,
}: {
    visible: boolean;
    onClose: () => void;
    title: string;
    subtitle: string;
    actionLabel: string;
    onSubmit: (code: string) => void;
    pending: boolean;
    error: string | null;
    destructive?: boolean;
}) {
    const theme = useTheme();
    const [code, setCode] = useState('');

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={title}
            subtitle={subtitle}
            footer={
                <Button
                    label={actionLabel}
                    variant={destructive ? 'destructive' : 'primary'}
                    onPress={() => onSubmit(code.trim())}
                    disabled={code.trim().length < 6}
                    loading={pending}
                    fullWidth
                />
            }
        >
            <View style={{ gap: theme.spacing.md }}>
                {error ? <Banner tone="error">{error}</Banner> : null}
                <TextField
                    label="Code"
                    value={code}
                    onChangeText={setCode}
                    keyboardType="default"
                    autoCapitalize="none"
                    autoComplete="one-time-code"
                    hint="A six-digit code from your authenticator, or one recovery code."
                />
            </View>
        </Sheet>
    );
}

/**
 * The one-time hand-off of recovery codes.
 *
 * Not dismissible by tapping the backdrop into oblivion without a warning:
 * these are the only way back in if the phone is lost, and the server has
 * already replaced the old set by the time this renders.
 */
function RecoveryCodesSheet({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
    const theme = useTheme();
    const { toast } = useToast();
    const [copied, setCopied] = useState(false);

    const close = () => {
        if (!copied) {
            Alert.alert(
                'Save these first',
                'These codes will not be shown again. If you lose your authenticator without them, an administrator has to reset your two-factor.',
                [
                    { text: 'Go back', style: 'cancel' },
                    { text: 'I have saved them', style: 'destructive', onPress: onClose },
                ],
            );
            return;
        }
        setCopied(false);
        onClose();
    };

    return (
        <Sheet
            visible={codes !== null}
            onClose={close}
            title="Your recovery codes"
            subtitle="Shown once. Store them somewhere you can reach without this phone."
            footer={<Button label="Done" onPress={close} fullWidth />}
        >
            <View style={{ gap: theme.spacing.md }}>
                <Banner tone="warning">
                    Each code works once. They are your only way in if you lose your authenticator.
                </Banner>
                <View
                    style={{
                        borderRadius: theme.radii.md,
                        backgroundColor: theme.colors.bgTertiary,
                        padding: theme.spacing.md,
                        gap: theme.spacing.xs,
                    }}
                >
                    {(codes ?? []).map((code) => (
                        <Text key={code} variant="code" selectable>
                            {code}
                        </Text>
                    ))}
                </View>
                <Button
                    label={copied ? 'Copied' : 'Copy all codes'}
                    variant="secondary"
                    onPress={() => {
                        void Clipboard.setStringAsync((codes ?? []).join('\n'));
                        setCopied(true);
                        toast('Recovery codes copied', 'success');
                    }}
                    fullWidth
                />
            </View>
        </Sheet>
    );
}

/** "a fingerprint", "your face", "biometrics" — used inside a sentence. */
function describeBiometrics(
    types: readonly LocalAuthentication.AuthenticationType[],
): string {
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
        return 'your face or fingerprint';
    }
    if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
        return 'your fingerprint';
    }
    return 'your device unlock';
}

/**
 * TOTP has a ±30s window; a phone more than a minute out will have every code
 * rejected and no idea why. The server sends its own clock for exactly this.
 */
function clockDriftWarning(serverTime: number): boolean {
    return Math.abs(Date.now() - serverTime) > 60_000;
}

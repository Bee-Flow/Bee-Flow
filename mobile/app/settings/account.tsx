/**
 * Account — who you are, and what happens to your data.
 *
 * Four things live here, in the order people need them:
 *   1. Profile. Display name and avatar, both writable via
 *      `POST /auth/update-profile`. The email is NOT: the server has no
 *      self-service email change (only an admin can, via PUT /auth/users/:id),
 *      so it is shown as a fact rather than as a field that does nothing.
 *   2. Password. `POST /auth/change-password` re-wraps the data encryption key
 *      under the new password — which is why the old one is required and why
 *      this cannot be done from a password-reset link alone.
 *   3. Your data. A GDPR data-subject request, filed against your own email
 *      through the public DSR channel. This is the honest surface: Bee Flow
 *      has no one-tap "download my data" endpoint, it has a request that a
 *      human fulfils within thirty days, and pretending otherwise would be a
 *      compliance claim the product does not make.
 *   4. Leaving. `POST /auth/users/me/leave-org` exists; account deletion does
 *      not, and is a DSR erasure request instead.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import {
    changePassword,
    getMfaStatus,
    settingsKeys,
    submitDsrRequest,
    updateProfile,
} from '../../src/features/settings/api';
import { humanise } from '../../src/features/settings/format';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Avatar } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { OptionRow } from '../../src/ui/Controls';
import { Banner, describeError } from '../../src/ui/Feedback';
import { Group, InfoRow, NoteRow } from '../../src/ui/Group';
import { TextField } from '../../src/ui/Input';
import { SettingRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Sheet } from '../../src/ui/Sheet';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

/** The request types dsrStore accepts, with the words a person would use. */
const DSR_TYPES: { id: string; label: string; description: string }[] = [
    {
        id: 'access',
        label: 'A copy of my data',
        description: 'Everything Bee Flow holds about you (GDPR Art. 15).',
    },
    {
        id: 'rectification',
        label: 'Correct something',
        description: 'Something stored about you is wrong (Art. 16).',
    },
    {
        id: 'erasure',
        label: 'Delete my data',
        description: 'Erase your account and its contents (Art. 17).',
    },
    {
        id: 'portability',
        label: 'Export to take elsewhere',
        description: 'A machine-readable copy you can move (Art. 20).',
    },
    {
        id: 'objection',
        label: 'Object to processing',
        description: 'Ask that a particular use of your data stops (Art. 21).',
    },
];

export default function AccountScreen() {
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { user, refresh } = useAuth();

    const [name, setName] = useState(user?.displayName ?? '');
    const [passwordSheet, setPasswordSheet] = useState(false);
    const [dsrSheet, setDsrSheet] = useState(false);

    const mfa = useQuery({
        queryKey: settingsKeys.mfa,
        queryFn: ({ signal }) => getMfaStatus(signal),
        retry: false,
        staleTime: 60_000,
    });

    const saveName = useMutation({
        mutationFn: (displayName: string) => updateProfile({ displayName }),
        onSuccess: async () => {
            // The session carries the display name, so the whole app has to
            // re-read the user rather than just this screen.
            await refresh();
            toast('Name updated', 'success');
        },
    });

    const saveAvatar = useMutation({
        mutationFn: (dataUri: string) => updateProfile({ avatar: dataUri, avatarType: 'image' }),
        onSuccess: async () => {
            await refresh();
            toast('Photo updated', 'success');
        },
    });

    /**
     * Pick a photo and send it as a data URI.
     *
     * `/auth/update-profile` stores whatever string it is given in the users
     * table's `avatar` column — the web app sends a base64 data URI from its
     * AvatarPicker, and Avatar in src/ui/Badge.tsx already renders one. So this
     * uploads nothing: no multipart endpoint is involved, which is also why the
     * image is squared and shrunk hard before encoding.
     */
    const pickAvatar = async () => {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
            Alert.alert(
                'Photos not allowed',
                'Bee Flow needs access to the photo you choose. You can grant it in Android settings.',
            );
            return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            // The avatar renders at 48dp; a 256px square is generous and keeps
            // the base64 blob well inside the server's 20 MB JSON body limit.
            quality: 0.7,
            base64: true,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        if (!asset?.base64) return;
        saveAvatar.mutate(`data:${asset.mimeType ?? 'image/jpeg'};base64,${asset.base64}`);
    };

    const nameDirty = name.trim() !== (user?.displayName ?? '').trim() && name.trim().length > 0;

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="Account" subtitle={user?.email ?? user?.id} />

            <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
                    <Avatar
                        name={user?.displayName ?? '?'}
                        uri={user?.avatar ?? null}
                        size={88}
                    />
                    <Button
                        label={saveAvatar.isPending ? 'Saving…' : 'Change photo'}
                        variant="secondary"
                        loading={saveAvatar.isPending}
                        onPress={() => void pickAvatar()}
                        icon={
                            <Feather name="camera" size={16} color={theme.colors.textPrimary} />
                        }
                    />
                    {saveAvatar.isError ? (
                        <Text variant="caption" tone="error" center accessibilityLiveRegion="polite">
                            {describeError(saveAvatar.error).message}
                        </Text>
                    ) : null}
                </View>

                <Group
                    title="Profile"
                    footer="Your display name is what colleagues see on shared chats and in your organisation's member list."
                >
                    <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
                        <TextField
                            label="Display name"
                            value={name}
                            onChangeText={setName}
                            autoCapitalize="words"
                            maxLength={200}
                            returnKeyType="done"
                            onSubmitEditing={() => nameDirty && saveName.mutate(name.trim())}
                            error={saveName.isError ? describeError(saveName.error).message : null}
                        />
                        {nameDirty ? (
                            <Button
                                label="Save name"
                                onPress={() => saveName.mutate(name.trim())}
                                loading={saveName.isPending}
                                fullWidth
                            />
                        ) : null}
                    </View>
                    <InfoRow label="Email" value={user?.email ?? 'Not set'} selectable />
                    <InfoRow label="Sign-in method" value={signInMethod(user?.provider)} />
                    <InfoRow label="Role" value={humanise(user?.orgRole ?? user?.role)} />
                    {user?.organizationId ? (
                        <InfoRow label="Organisation" value={user.organizationId} />
                    ) : null}
                </Group>

                <Group
                    title="Sign-in"
                    footer={
                        mfa.data && !mfa.data.hasPassword
                            ? 'This account signs in through your identity provider, so Bee Flow holds no password to change.'
                            : 'Changing your password re-encrypts your data key. Bee Flow never sees either one — which is why the current password is required.'
                    }
                >
                    <SettingRow
                        label="Change password"
                        icon={<Feather name="key" size={16} color={theme.colors.textSecondary} />}
                        disabled={mfa.data ? !mfa.data.hasPassword : false}
                        onPress={() => setPasswordSheet(true)}
                    />
                    <SettingRow
                        label="Security and two-factor"
                        value={mfa.data?.enabled ? 'On' : 'Off'}
                        icon={<Feather name="shield" size={16} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/settings/security')}
                    />
                </Group>

                <Group
                    title="Your data"
                    footer="Bee Flow answers a request within thirty days, as the GDPR requires. Requests are handled by your organisation's administrators, not by us."
                >
                    <SettingRow
                        label="Request a copy of my data"
                        icon={
                            <Feather name="download" size={16} color={theme.colors.textSecondary} />
                        }
                        onPress={() => setDsrSheet(true)}
                    />
                    <SettingRow
                        label="Privacy settings"
                        icon={<Feather name="eye-off" size={16} color={theme.colors.textSecondary} />}
                        onPress={() => router.push('/org/privacy')}
                    />
                    <NoteRow>
                        <View style={{ gap: theme.spacing.xs }}>
                            <Text variant="body">Deleting your account</Text>
                            <Text variant="caption" tone="tertiary">
                                There is no self-service delete, on purpose: your account may hold
                                records your organisation is legally required to keep. File an
                                erasure request above and an administrator will action it.
                            </Text>
                        </View>
                    </NoteRow>
                </Group>
            </ScrollView>

            <PasswordSheet visible={passwordSheet} onClose={() => setPasswordSheet(false)} />
            <DsrSheet
                visible={dsrSheet}
                onClose={() => setDsrSheet(false)}
                defaultEmail={user?.email ?? ''}
                onFiled={() => {
                    void queryClient.invalidateQueries({ queryKey: settingsKeys.dsr });
                    toast('Request filed', 'success');
                }}
            />
        </Screen>
    );
}

function PasswordSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const theme = useTheme();
    const { toast } = useToast();
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');

    const mutation = useMutation({
        mutationFn: () => changePassword(current, next),
        onSuccess: () => {
            toast('Password changed', 'success');
            setCurrent('');
            setNext('');
            setConfirm('');
            onClose();
        },
    });

    // Mirrors the server's validator (auth/passwordPolicy.js): eight characters
    // is the floor for a normal account. Checking here saves a round trip; the
    // server still decides, and its message is what gets shown on a refusal.
    const tooShort = next.length > 0 && next.length < 8;
    const mismatch = confirm.length > 0 && confirm !== next;
    const ready = current.length > 0 && next.length >= 8 && confirm === next;

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Change password"
            subtitle="Your data key is re-wrapped under the new password"
            footer={
                <Button
                    label="Change password"
                    onPress={() => mutation.mutate()}
                    disabled={!ready}
                    loading={mutation.isPending}
                    fullWidth
                />
            }
        >
            <View style={{ gap: theme.spacing.md }}>
                {mutation.isError ? (
                    <Banner tone="error">{describeError(mutation.error).message}</Banner>
                ) : null}
                <TextField
                    label="Current password"
                    value={current}
                    onChangeText={setCurrent}
                    secure
                    textContentType="password"
                    autoComplete="current-password"
                />
                <TextField
                    label="New password"
                    value={next}
                    onChangeText={setNext}
                    secure
                    textContentType="newPassword"
                    autoComplete="new-password"
                    hint="At least eight characters, and not built from your name or email."
                    error={tooShort ? 'Too short — eight characters minimum.' : null}
                />
                <TextField
                    label="Repeat new password"
                    value={confirm}
                    onChangeText={setConfirm}
                    secure
                    autoComplete="new-password"
                    error={mismatch ? 'These do not match.' : null}
                />
            </View>
        </Sheet>
    );
}

function DsrSheet({
    visible,
    onClose,
    defaultEmail,
    onFiled,
}: {
    visible: boolean;
    onClose: () => void;
    defaultEmail: string;
    onFiled: () => void;
}) {
    const theme = useTheme();
    const [type, setType] = useState('access');
    const [email, setEmail] = useState(defaultEmail);
    const [notes, setNotes] = useState('');
    const [reference, setReference] = useState<number | null>(null);

    const mutation = useMutation({
        mutationFn: () =>
            submitDsrRequest({ subject_email: email.trim(), request_type: type, notes: notes.trim() }),
        onSuccess: (result) => {
            // The reference number is the only thing the requester can quote
            // later, so it is shown in place of the form rather than toasted
            // away.
            setReference(result?.id ?? null);
            onFiled();
        },
    });

    const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

    const close = () => {
        setReference(null);
        setNotes('');
        onClose();
    };

    return (
        <Sheet
            visible={visible}
            onClose={close}
            title={reference === null ? 'Request your data' : 'Request received'}
            subtitle={
                reference === null
                    ? 'Handled by your organisation within thirty days'
                    : undefined
            }
            footer={
                reference === null ? (
                    <Button
                        label="File request"
                        onPress={() => mutation.mutate()}
                        disabled={!emailLooksValid}
                        loading={mutation.isPending}
                        fullWidth
                    />
                ) : (
                    <Button label="Done" variant="secondary" onPress={close} fullWidth />
                )
            }
        >
            {reference !== null ? (
                <View style={{ gap: theme.spacing.md }}>
                    <Banner tone="success" icon="check-circle">
                        Your request has been recorded. Bee Flow will respond within thirty days, as
                        the GDPR requires.
                    </Banner>
                    <Text variant="body">
                        Your reference number is{' '}
                        <Text variant="body" weight="semibold" selectable>
                            #{reference}
                        </Text>
                        . Quote it if you need to follow up.
                    </Text>
                </View>
            ) : (
                <View style={{ gap: theme.spacing.md }}>
                    {mutation.isError ? (
                        <Banner tone="error">{describeError(mutation.error).message}</Banner>
                    ) : null}

                    <View accessibilityRole="radiogroup" style={{ gap: 0 }}>
                        {DSR_TYPES.map((option) => (
                            <OptionRow
                                key={option.id}
                                label={option.label}
                                description={option.description}
                                selected={type === option.id}
                                onPress={() => setType(option.id)}
                            />
                        ))}
                    </View>

                    <TextField
                        label="Your email"
                        value={email}
                        onChangeText={setEmail}
                        keyboardType="email-address"
                        autoCapitalize="none"
                        autoComplete="email"
                        hint="The organisation is identified from this address, so use the one your account is under."
                        error={
                            email.length > 0 && !emailLooksValid
                                ? 'That does not look like an email address.'
                                : null
                        }
                    />
                    <TextField
                        label="Anything to add (optional)"
                        value={notes}
                        onChangeText={setNotes}
                        multiline
                        maxLines={5}
                        placeholder="Which data, or which period, if it helps narrow the request."
                    />
                </View>
            )}
        </Sheet>
    );
}

/** 'local' means a password or OPAQUE login; anything else is an SSO provider. */
function signInMethod(provider: string | undefined): string {
    if (!provider || provider === 'local') return 'Password';
    return `${humanise(provider)} single sign-on`;
}

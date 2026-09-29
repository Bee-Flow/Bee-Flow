/**
 * Server — which Bee Flow this install talks to.
 *
 * The web app never needs this screen: it is served BY the server, so its API
 * base is a relative path. An APK has no such anchor — the same binary is used
 * by a SaaS customer on beeflow.nl, by a company on ai.acme.example, and by
 * someone running ./selfhost.sh on a laptop — so the server URL is first-class
 * state (src/api/server.ts).
 *
 * Switching is destructive and the screen says so BEFORE the switch, not
 * after: `forgetServer()` wipes the vault, clears every cached query and
 * returns to the first-run screen. That is correct — a key derived for one
 * server is meaningless on another, and carrying cached content across would
 * be a cross-tenant leak — but it must never be a surprise.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';
import React, { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';

import {
    checkHealth,
    getServerUrl,
    isInsecure,
    isPrivateHost,
    normaliseServerUrl,
} from '../../src/api/server';
import { useAuth } from '../../src/auth/AuthProvider';
import { settingsKeys } from '../../src/features/settings/api';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { Banner, Spinner } from '../../src/ui/Feedback';
import { Group, InfoRow, NoteRow } from '../../src/ui/Group';
import { TextField } from '../../src/ui/Input';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Sheet } from '../../src/ui/Sheet';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function ServerScreen() {
    const theme = useTheme();
    const { toast } = useToast();
    const { user, chooseServer, forgetServer } = useAuth();

    const current = getServerUrl();
    const [switchSheet, setSwitchSheet] = useState(false);

    /**
     * Probe the server we are already on.
     *
     * `/api/health` is public and answers `{status:'ok', appVersion}`, so it
     * distinguishes "wrong address" from "right address, not signed in" — a
     * 401 from any other endpoint would not. Polled rather than fetched once,
     * because this is the screen someone opens WHILE things are broken.
     */
    const health = useQuery({
        queryKey: settingsKeys.health,
        queryFn: () => (current ? checkHealth(current) : Promise.resolve(null)),
        refetchInterval: 30_000,
        retry: false,
    });

    const buildDefault = String(
        (Constants.expoConfig?.extra as { defaultServerUrl?: string } | undefined)
            ?.defaultServerUrl ?? '',
    );

    const confirmForget = () => {
        Alert.alert(
            'Sign out and forget this server?',
            'Bee Flow will delete the encryption key stored on this phone and clear everything it has cached, then ask which server to use. Nothing on the server is deleted.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Forget server',
                    style: 'destructive',
                    onPress: () => void forgetServer(),
                },
            ],
        );
    };

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="Server" subtitle={hostOf(current) ?? 'Not configured'} />

            <ScrollView
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                {current && isInsecure(current) ? (
                    <Banner tone={isPrivateHost(current) ? 'info' : 'warning'}>
                        {isPrivateHost(current)
                            ? 'This is a plain HTTP address on a private network. That is normal for a self-hosted Bee Flow on your own LAN.'
                            : 'This is a plain HTTP address on the public internet. Your session cookie travels unencrypted — move this server to HTTPS.'}
                    </Banner>
                ) : null}

                <Group
                    title="Connected to"
                    footer="Everything in Bee Flow — your chats, your files, your encryption key — belongs to this server. Nothing is stored anywhere else."
                >
                    <InfoRow label="Address" value={current ?? 'Not configured'} selectable />
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
                        <Text variant="body" style={{ flex: 1 }}>
                            Reachable
                        </Text>
                        {health.isFetching && !health.data ? (
                            <Spinner />
                        ) : (
                            <Badge
                                label={health.data?.ok ? 'Healthy' : 'Unreachable'}
                                tone={health.data?.ok ? 'success' : 'error'}
                            />
                        )}
                    </View>
                    {health.data && !health.data.ok && health.data.error ? (
                        <NoteRow>
                            <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                                {health.data.error}
                            </Text>
                        </NoteRow>
                    ) : null}
                    <InfoRow
                        label="Server build"
                        value={health.data?.appVersion || 'Not reported'}
                        selectable
                    />
                    <InfoRow label="Connection" value={current && isInsecure(current) ? 'HTTP' : 'HTTPS'} />
                    {user ? <InfoRow label="Signed in as" value={user.displayName} /> : null}
                </Group>

                <Group
                    title="Change server"
                    footer="Switching signs you out and clears this phone’s cache and stored key. You can always come back — nothing on either server is deleted."
                >
                    <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
                        <Button
                            label="Connect to a different server"
                            variant="secondary"
                            onPress={() => setSwitchSheet(true)}
                            icon={
                                <Feather
                                    name="repeat"
                                    size={16}
                                    color={theme.colors.textPrimary}
                                />
                            }
                            fullWidth
                        />
                        <Button
                            label="Sign out and forget this server"
                            variant="destructive"
                            onPress={confirmForget}
                            fullWidth
                        />
                    </View>
                </Group>

                {buildDefault ? (
                    <Group title="This build">
                        <InfoRow label="Shipped default" value={buildDefault} />
                        <NoteRow>
                            This APK was built pointing at that address. A fresh install starts
                            there; you have changed it, which is expected and supported.
                        </NoteRow>
                    </Group>
                ) : (
                    <Group title="This build">
                        <NoteRow>
                            This APK ships with no default server, so a fresh install asks. That is
                            deliberate for a self-host-first product — it never quietly points a
                            self-hoster at the hosted service.
                        </NoteRow>
                    </Group>
                )}
            </ScrollView>

            <SwitchSheet
                visible={switchSheet}
                onClose={() => setSwitchSheet(false)}
                onConfirmed={async (url) => {
                    setSwitchSheet(false);
                    // forgetServer() first: it wipes the vault and query cache.
                    // chooseServer() then points at the new host and re-resolves
                    // the auth stage, which lands on that server's sign-in.
                    await forgetServer();
                    await chooseServer(url);
                    toast('Now connected to a different server', 'success');
                }}
            />
        </Screen>
    );
}

function SwitchSheet({
    visible,
    onClose,
    onConfirmed,
}: {
    visible: boolean;
    onClose: () => void;
    onConfirmed: (url: string) => Promise<void>;
}) {
    const theme = useTheme();
    const [input, setInput] = useState('');
    const [probing, setProbing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const normalised = normaliseServerUrl(input);

    /** Never remember an address that has not answered — a typo saved is a
     *  first-run screen the user cannot get out of without reinstalling. */
    const verifyAndSwitch = async () => {
        if (!normalised) {
            setError('That does not look like a web address.');
            return;
        }
        setError(null);
        setProbing(true);
        const result = await checkHealth(normalised);
        setProbing(false);
        if (!result.ok) {
            setError(result.error ?? 'That address did not answer.');
            return;
        }
        Alert.alert(
            'Switch server?',
            `You will be signed out and this phone’s cached data and encryption key will be removed before connecting to ${hostOf(normalised)}.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Switch',
                    style: 'destructive',
                    onPress: () => {
                        void onConfirmed(normalised);
                    },
                },
            ],
        );
    };

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Connect to a different server"
            subtitle="Bee Flow checks the address before it remembers it"
            footer={
                <Button
                    label="Check and switch"
                    onPress={() => void verifyAndSwitch()}
                    disabled={input.trim().length === 0}
                    loading={probing}
                    fullWidth
                />
            }
        >
            <View style={{ gap: theme.spacing.md }}>
                <TextField
                    label="Server address"
                    value={input}
                    onChangeText={setInput}
                    placeholder="beeflow.nl"
                    keyboardType="url"
                    autoCapitalize="none"
                    autoCorrect={false}
                    hint={
                        normalised
                            ? `Will connect to ${normalised}`
                            : 'Type a host name. https:// is assumed unless you type http:// yourself.'
                    }
                    error={error}
                />
                {normalised && isInsecure(normalised) && !isPrivateHost(normalised) ? (
                    <Banner tone="warning">
                        That is a plain HTTP address on the public internet. Your password and
                        session would travel in the clear.
                    </Banner>
                ) : null}
            </View>
        </Sheet>
    );
}

function hostOf(url: string | null): string | null {
    if (!url) return null;
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

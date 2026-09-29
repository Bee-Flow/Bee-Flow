/**
 * Integrations.
 *
 * Two halves, because the server has two:
 *
 *   CONNECTED ACCOUNTS — Google, Microsoft, LinkedIn, Withings, GitHub. Each
 *   has its own router with /status, /auth-url and /disconnect, and none of
 *   them share a response shape.
 *
 *   WHAT THE MODEL MAY USE — the per-user `enabledApps` allow-list on
 *   `/ai/user-settings`, intersected server-side with what the organisation
 *   permits. Turning one on does not connect anything; it decides whether the
 *   tool is offered to the model at all.
 *
 * On the OAuth flow, one honest caveat the screen states up front rather than
 * discovering for the user: the provider redirects back to the SERVER's
 * callback, which needs the Bee Flow session cookie. Android's Custom Tab has
 * its own cookie jar, separate from this app's, so the browser has to be
 * signed in to Bee Flow for the handshake to complete. Bee Flow does not
 * proxy the OAuth handshake through the app, and pretending the round trip is
 * seamless would just produce a mystery failure.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import React, { useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';

import {
    connectGithub,
    disconnectIntegration,
    getIntegrationAuthUrl,
    getIntegrationStatus,
    getUserSettings,
    saveUserSettings,
    settingsKeys,
} from '../../src/features/settings/api';
import {
    allowedByOrg,
    CONNECTORS,
    INTEGRATION_CATALOG,
    orderCategories,
    type Connector,
} from '../../src/features/settings/integrations';
import type { IntegrationStatus, UserSettings } from '../../src/features/settings/types';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { ToggleRow } from '../../src/ui/Controls';
import { Banner, describeError, ListSkeleton } from '../../src/ui/Feedback';
import { Group, NoteRow } from '../../src/ui/Group';
import { TextField } from '../../src/ui/Input';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Sheet } from '../../src/ui/Sheet';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function IntegrationsScreen() {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const [githubSheet, setGithubSheet] = useState(false);

    /**
     * One query per connector rather than one combined query: they are five
     * independent endpoints with five shapes, any of which may 403 on its own,
     * and a combined query would let one refusal blank the other four.
     */
    const statuses = useQueries({
        queries: CONNECTORS.map((connector) => ({
            queryKey: settingsKeys.integrationStatus(connector.provider),
            queryFn: ({ signal }: { signal: AbortSignal }) =>
                getIntegrationStatus(connector.provider, signal),
            staleTime: 30_000,
            retry: false,
        })),
    });

    const settings = useQuery({
        queryKey: settingsKeys.userSettings,
        queryFn: ({ signal }) => getUserSettings(signal),
        staleTime: 60_000,
    });

    const saveApps = useMutation({
        mutationFn: (enabledApps: string[]) => saveUserSettings({ enabledApps }),
        // Optimistic: the toggle has to move under the thumb. On failure the
        // invalidate below restores the server's answer.
        onMutate: async (enabledApps) => {
            await queryClient.cancelQueries({ queryKey: settingsKeys.userSettings });
            const previous = queryClient.getQueryData(settingsKeys.userSettings);
            queryClient.setQueryData(settingsKeys.userSettings, (old: unknown) =>
                old && typeof old === 'object' ? { ...old, enabledApps } : old,
            );
            return { previous };
        },
        onError: (_error, _vars, context) => {
            if (context?.previous !== undefined) {
                queryClient.setQueryData(settingsKeys.userSettings, context.previous);
            }
        },
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: settingsKeys.userSettings });
        },
    });

    const disconnect = useMutation({
        mutationFn: (provider: string) => disconnectIntegration(provider),
        onSuccess: (_data, provider) => {
            void queryClient.invalidateQueries({
                queryKey: settingsKeys.integrationStatus(provider),
            });
            void queryClient.invalidateQueries({ queryKey: settingsKeys.userSettings });
            toast('Disconnected', 'success');
        },
    });

    /**
     * Start an OAuth connect.
     *
     * `/auth-url` is fetched from the app (so the CSRF state and PKCE verifier
     * land in THIS session), then the URL is opened in a Custom Tab. When the
     * browser closes we refetch the status rather than trusting the result —
     * the app never sees the callback, so the server is the only source of
     * truth about whether it worked.
     */
    const connectOauth = async (connector: Connector) => {
        try {
            const url = await getIntegrationAuthUrl(connector.provider);
            if (!url) {
                Alert.alert(
                    `${connector.label} is not configured`,
                    'An administrator has to add this provider’s client credentials before anyone can connect.',
                );
                return;
            }
            await WebBrowser.openBrowserAsync(url);
        } catch (err) {
            Alert.alert(`Could not start ${connector.label}`, describeError(err).message);
        } finally {
            void queryClient.invalidateQueries({
                queryKey: settingsKeys.integrationStatus(connector.provider),
            });
        }
    };

    const confirmDisconnect = (connector: Connector) => {
        Alert.alert(
            `Disconnect ${connector.label}?`,
            'Your agents and automations lose access to it immediately. Anything already saved in Bee Flow stays.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Disconnect',
                    style: 'destructive',
                    onPress: () => disconnect.mutate(connector.provider),
                },
            ],
        );
    };

    // The org's allow-list narrows what is worth showing at all: a tool the
    // organisation forbids cannot be enabled, and a toggle that always fails
    // is worse than an absent one.
    const catalogue = useMemo(
        () => allowedByOrg(INTEGRATION_CATALOG, settings.data?.orgEnabledIntegrations),
        [settings.data?.orgEnabledIntegrations],
    );

    const categories = useMemo(
        () => orderCategories([...new Set(catalogue.map((entry) => entry.category))]),
        [catalogue],
    );

    /**
     * `enabledApps: null` from the server means "no explicit list" — which the
     * runtime reads as everything allowed. Materialising it into the full
     * catalogue on the first toggle keeps the switch honest: before the first
     * change every switch shows on, because everything IS on.
     */
    const enabled = settings.data?.enabledApps ?? catalogue.map((entry) => entry.id);
    const enabledSet = new Set(enabled);

    const toggleApp = (id: string) => {
        const next = enabledSet.has(id) ? enabled.filter((x) => x !== id) : [...enabled, id];
        saveApps.mutate(next);
    };

    const refreshing =
        statuses.some((query) => query.isRefetching) || settings.isRefetching;

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="Integrations" subtitle="Accounts, and what your agents may use" />

            <ScrollView
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={() => {
                            statuses.forEach((query) => void query.refetch());
                            void settings.refetch();
                        }}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                {disconnect.isError ? (
                    <Banner tone="error">{describeError(disconnect.error).message}</Banner>
                ) : null}

                <Group
                    title="Connected accounts"
                    footer="Connecting opens your browser, because the provider sends you back to Bee Flow’s own address. If the browser is not already signed in to Bee Flow, sign in there once and the connection sticks."
                >
                    {CONNECTORS.map((connector, index) => {
                        const query = statuses[index];
                        const status = (query?.data ?? null) as IntegrationStatus | null;
                        return (
                            <ConnectorRow
                                key={connector.provider}
                                connector={connector}
                                status={status}
                                loading={Boolean(query?.isLoading)}
                                busy={
                                    disconnect.isPending &&
                                    disconnect.variables === connector.provider
                                }
                                onConnect={() => {
                                    if (connector.flow === 'token') setGithubSheet(true);
                                    else void connectOauth(connector);
                                }}
                                onDisconnect={() => confirmDisconnect(connector)}
                            />
                        );
                    })}
                </Group>

                {settings.data?.orgEnabledIntegrations ? (
                    <Banner tone="info" icon="info">
                        Your organisation limits which tools may be used. Anything it has not
                        allowed is not listed below.
                    </Banner>
                ) : null}

                {settings.isLoading ? (
                    <ListSkeleton rows={6} />
                ) : (
                    categories.map((category) => (
                        <Group
                            key={category}
                            title={category}
                            footer={
                                category === 'Nextcloud'
                                    ? 'Nextcloud tools work through your organisation’s Nextcloud binding rather than a personal connection.'
                                    : undefined
                            }
                        >
                            {catalogue
                                .filter((entry) => entry.category === category)
                                .map((entry) => (
                                    <ToggleRow
                                        key={entry.id}
                                        label={entry.label}
                                        description={entry.description}
                                        value={enabledSet.has(entry.id)}
                                        onValueChange={() => toggleApp(entry.id)}
                                    />
                                ))}
                        </Group>
                    ))
                )}

                <Group title="Credentials Bee Flow already holds">
                    <NoteRow>
                        <View style={{ gap: theme.spacing.sm }}>
                            <Text variant="caption" tone="tertiary">
                                Some tools need an API key rather than a sign-in. Bee Flow stores
                                them encrypted and never returns them — only whether one exists.
                            </Text>
                            <View
                                style={{
                                    flexDirection: 'row',
                                    flexWrap: 'wrap',
                                    gap: theme.spacing.sm,
                                }}
                            >
                                {keyBadges(settings.data).map((badge) => (
                                    <Badge
                                        key={badge.label}
                                        label={badge.label}
                                        tone={badge.present ? 'success' : 'neutral'}
                                    />
                                ))}
                            </View>
                            <Text variant="caption" tone="tertiary">
                                Adding or replacing one of these keys is done in the web app — they
                                are long secrets that are pasted, not typed.
                            </Text>
                        </View>
                    </NoteRow>
                </Group>
            </ScrollView>

            <GithubSheet
                visible={githubSheet}
                onClose={() => setGithubSheet(false)}
                onConnected={() => {
                    setGithubSheet(false);
                    void queryClient.invalidateQueries({
                        queryKey: settingsKeys.integrationStatus('github'),
                    });
                    toast('GitHub connected', 'success');
                }}
            />
        </Screen>
    );
}

function ConnectorRow({
    connector,
    status,
    loading,
    busy,
    onConnect,
    onDisconnect,
}: {
    connector: Connector;
    status: IntegrationStatus | null;
    loading: boolean;
    busy: boolean;
    onConnect: () => void;
    onDisconnect: () => void;
}) {
    const theme = useTheme();

    const identity =
        connector.identityField && status ? (status[connector.identityField] ?? null) : null;
    // `configured: false` means an administrator has not set this provider's
    // client id and secret. Offering "Connect" then is offering a dead end.
    const notConfigured = connector.reportsConfigured && status?.configured === false;
    const needsReauth = Boolean(status?.needsReauth);

    return (
        <View
            style={{
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                gap: theme.spacing.sm,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
                <View style={{ flex: 1, gap: 2 }}>
                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: theme.spacing.sm,
                        }}
                    >
                        <Text variant="body" weight="medium">
                            {connector.label}
                        </Text>
                        {loading ? null : needsReauth ? (
                            <Badge label="Needs re-authorising" tone="warning" />
                        ) : status?.connected ? (
                            <Badge label="Connected" tone="success" />
                        ) : notConfigured ? (
                            <Badge label="Not set up" tone="neutral" />
                        ) : null}
                    </View>
                    <Text variant="caption" tone="tertiary">
                        {identity ?? connector.description}
                    </Text>
                </View>
                <Feather
                    name={status?.connected ? 'check-circle' : 'circle'}
                    size={18}
                    color={
                        status?.connected ? theme.colors.success : theme.colors.textMuted
                    }
                />
            </View>

            {notConfigured ? (
                <Text variant="caption" tone="tertiary">
                    An administrator has to add this provider&rsquo;s client credentials before
                    anyone in your organisation can connect it.
                </Text>
            ) : (
                <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                    {status?.connected && !needsReauth ? (
                        <Button
                            label="Disconnect"
                            variant="secondary"
                            onPress={onDisconnect}
                            loading={busy}
                            style={{ flex: 1 }}
                        />
                    ) : (
                        <Button
                            label={needsReauth ? 'Reconnect' : 'Connect'}
                            variant={needsReauth ? 'primary' : 'secondary'}
                            onPress={onConnect}
                            style={{ flex: 1 }}
                        />
                    )}
                </View>
            )}
        </View>
    );
}

function GithubSheet({
    visible,
    onClose,
    onConnected,
}: {
    visible: boolean;
    onClose: () => void;
    onConnected: () => void;
}) {
    const theme = useTheme();
    const [token, setToken] = useState('');

    const mutation = useMutation({
        mutationFn: () => connectGithub(token.trim()),
        onSuccess: () => {
            setToken('');
            onConnected();
        },
    });

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Connect GitHub"
            subtitle="A personal access token, checked before it is stored"
            footer={
                <Button
                    label="Connect"
                    onPress={() => mutation.mutate()}
                    disabled={token.trim().length === 0}
                    loading={mutation.isPending}
                    fullWidth
                />
            }
        >
            <View style={{ gap: theme.spacing.md }}>
                {mutation.isError ? (
                    <Banner tone="error">{describeError(mutation.error).message}</Banner>
                ) : null}
                <Text variant="caption" tone="tertiary">
                    Create a token at github.com under Settings → Developer settings → Personal
                    access tokens, with the scopes you want Bee Flow to have. Bee Flow validates it
                    against GitHub before storing it encrypted, and never returns it again.
                </Text>
                <TextField
                    label="Personal access token"
                    value={token}
                    onChangeText={setToken}
                    secure
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="ghp_…"
                />
                <Button
                    label="Open GitHub token settings"
                    variant="ghost"
                    onPress={() =>
                        void WebBrowser.openBrowserAsync('https://github.com/settings/tokens')
                    }
                />
            </View>
        </Sheet>
    );
}

/**
 * Which API-key integrations already have a key stored.
 *
 * `/ai/user-settings` reports presence only — the secrets themselves never
 * leave the server — so this is a set of badges rather than a set of fields.
 */
function keyBadges(
    settings: UserSettings | null | undefined,
): { label: string; present: boolean }[] {
    return [
        { label: 'Fireflies', present: Boolean(settings?.hasFirefliesKey) },
        { label: 'YouTrack', present: Boolean(settings?.hasYouTrackConfig) },
        { label: 'Gamma', present: Boolean(settings?.hasGammaKey) },
        { label: 'SignRequest', present: Boolean(settings?.hasSignRequestConfig) },
        { label: 'AFAS Profit', present: Boolean(settings?.hasAfasConfig) },
        { label: 'NMBRS', present: Boolean(settings?.hasNmbrsConfig) },
        { label: 'vPlan', present: Boolean(settings?.hasVplanConfig) },
        { label: 'n8n', present: Boolean(settings?.hasN8nConfig) },
    ];
}

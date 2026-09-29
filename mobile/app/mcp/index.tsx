/**
 * MCP — the two directions, kept apart.
 *
 * Bee Flow sits on both sides of the Model Context Protocol and the two are
 * unrelated surfaces with adjacent names, so this screen never merges them:
 *
 *   OUTBOUND — the servers Bee Flow calls. `GET /ai/mcp-servers` (note: the AI
 *     router is mounted at /ai, not /api/ai) lists what an administrator has
 *     configured, with the health of each. Installing one means a command line
 *     or a URL plus credentials, which is desktop work; what a phone is for is
 *     noticing that one of them has been failing since Tuesday.
 *
 *   INBOUND — Bee Flow served AS an MCP server, at /mcp, so Nextcloud's
 *     Assistant (or any other client) can call your integrations and routines.
 *     That needs a bearer token, because a static config file cannot hold a
 *     session cookie. One per user, minted here.
 *
 * The token is the reason this screen is worth having on a phone at all: it is
 * shown exactly once, minting a new one revokes the old one, and the sheet
 * that shows it cannot be dismissed by reflex (see SecretOnce).
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import {
    absoluteUrl,
    getMcpTokenStatus,
    listMcpServers,
    mintMcpToken,
    publishingKeys,
    refreshMcpServer,
    revokeMcpToken,
} from '../../src/features/publishing/api';
import { LinkActions } from '../../src/features/publishing/components/LinkActions';
import { SecretOnce } from '../../src/features/publishing/components/SecretOnce';
import { mcpStatus, mcpSubtitle } from '../../src/features/publishing/format';
import type { McpServer } from '../../src/features/publishing/types';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button, IconButton } from '../../src/ui/Button';
import { Banner, ListSkeleton, describeError } from '../../src/ui/Feedback';
import { ListRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet } from '../../src/ui/Sheet';
import { Card, Divider, Section } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function McpScreen() {
    const theme = useTheme();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [minted, setMinted] = useState<string | null>(null);
    const [confirmMint, setConfirmMint] = useState(false);
    const [confirmRevoke, setConfirmRevoke] = useState(false);

    const token = useQuery({
        queryKey: publishingKeys.mcpToken,
        queryFn: ({ signal }) => getMcpTokenStatus(signal),
    });

    const servers = useQuery({
        queryKey: publishingKeys.mcpServers,
        queryFn: ({ signal }) => listMcpServers(signal),
    });

    const mint = useMutation({
        mutationFn: () => mintMcpToken(),
        onSuccess: (result) => {
            setConfirmMint(false);
            if (!result?.token) {
                toast('The server did not return a token', 'error');
                return;
            }
            // Straight into the un-skippable sheet. The value is not held
            // anywhere else — not in the query cache, not in a ref — so the
            // only copy is the one on screen, which is the point.
            setMinted(result.token);
            void queryClient.invalidateQueries({ queryKey: publishingKeys.mcpToken });
        },
        onError: (err: unknown) => {
            setConfirmMint(false);
            toast(describeError(err).message, 'error');
        },
    });

    const revoke = useMutation({
        mutationFn: () => revokeMcpToken(),
        onSuccess: () => {
            setConfirmRevoke(false);
            toast('Token revoked', 'success');
            void queryClient.invalidateQueries({ queryKey: publishingKeys.mcpToken });
        },
        onError: (err: unknown) => {
            setConfirmRevoke(false);
            toast(describeError(err).message, 'error');
        },
    });

    const probe = useMutation({
        mutationFn: (id: string) => refreshMcpServer(id),
        onSuccess: (count) => {
            toast(count === 1 ? 'Found 1 tool' : `Found ${count} tools`, 'success');
            void queryClient.invalidateQueries({ queryKey: publishingKeys.mcpServers });
        },
        onError: (err: unknown) => toast(describeError(err).message, 'error'),
    });

    const endpoint = token.data ? safeAbsolute(token.data.url) : null;
    const rows = servers.data ?? [];

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title="MCP" subtitle="Model Context Protocol" />

            <ScrollView
                contentContainerStyle={{
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.xxxl,
                    gap: theme.spacing.xl,
                }}
                refreshControl={
                    <RefreshControl
                        refreshing={token.isRefetching || servers.isRefetching}
                        onRefresh={() => {
                            void token.refetch();
                            void servers.refetch();
                        }}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                <Section
                    title="Your access token"
                    subtitle="Lets an MCP client call Bee Flow as you"
                >
                    <Card>
                        <View style={{ gap: theme.spacing.md }}>
                            {token.isLoading ? (
                                <Text variant="body" tone="tertiary">
                                    Checking…
                                </Text>
                            ) : token.isError ? (
                                <Banner
                                    tone={describeError(token.error).retryable ? 'error' : 'info'}
                                    action={
                                        describeError(token.error).retryable ? (
                                            <Button
                                                label="Retry"
                                                variant="ghost"
                                                onPress={() => void token.refetch()}
                                            />
                                        ) : undefined
                                    }
                                >
                                    {describeError(token.error).message}
                                </Banner>
                            ) : (
                                <>
                                    <View
                                        style={{
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            gap: theme.spacing.sm,
                                        }}
                                    >
                                        <Badge
                                            label={token.data?.exists ? 'Active' : 'None'}
                                            tone={token.data?.exists ? 'success' : 'neutral'}
                                        />
                                        <Text variant="caption" tone="tertiary" style={{ flex: 1 }}>
                                            {token.data?.exists
                                                ? 'A client is holding a working token.'
                                                : 'No token yet — a client cannot reach Bee Flow.'}
                                        </Text>
                                    </View>

                                    <Text variant="caption" tone="tertiary">
                                        A token grants exactly what you can do in chat — no more.
                                        Your organisation&apos;s integration and group rules still
                                        apply on every call.
                                    </Text>

                                    {endpoint ? (
                                        <View style={{ gap: theme.spacing.sm }}>
                                            <Text variant="label" tone="tertiary">
                                                Endpoint · {token.data?.transport}
                                            </Text>
                                            <LinkActions
                                                url={endpoint}
                                                shareTitle="Bee Flow MCP endpoint"
                                                // It answers MCP over HTTP, not
                                                // HTML — opening it in a browser
                                                // shows a protocol error, not a page.
                                                allowOpen={false}
                                            />
                                        </View>
                                    ) : null}

                                    <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                                        <Button
                                            label={token.data?.exists ? 'Replace token' : 'Create token'}
                                            loading={mint.isPending}
                                            onPress={() => {
                                                if (token.data?.exists) setConfirmMint(true);
                                                else mint.mutate();
                                            }}
                                            style={{ flex: 1 }}
                                        />
                                        {token.data?.exists ? (
                                            <Button
                                                label="Revoke"
                                                variant="destructive"
                                                onPress={() => setConfirmRevoke(true)}
                                                style={{ flex: 1 }}
                                            />
                                        ) : null}
                                    </View>
                                </>
                            )}
                        </View>
                    </Card>
                </Section>

                <Section
                    title="Connected servers"
                    subtitle="What Bee Flow can call out to"
                >
                    {servers.isLoading ? (
                        <ListSkeleton rows={3} />
                    ) : servers.isError ? (
                        /* The marketplace is an Enterprise feature, so a 403
                           here is an answer about the licence rather than a
                           failure — and it must not take the token section,
                           which is ungated, down with it. */
                        <Banner
                            tone={describeError(servers.error).retryable ? 'error' : 'info'}
                            action={
                                describeError(servers.error).retryable ? (
                                    <Button
                                        label="Retry"
                                        variant="ghost"
                                        onPress={() => void servers.refetch()}
                                    />
                                ) : undefined
                            }
                        >
                            {describeError(servers.error).message}
                        </Banner>
                    ) : rows.length === 0 ? (
                        <Card>
                            <Text variant="body" tone="tertiary">
                                No MCP servers are configured. An administrator adds them in the
                                web app — each one needs a command or a URL, and usually a
                                credential.
                            </Text>
                        </Card>
                    ) : (
                        <Card padded={false}>
                            {rows.map((server, index) => (
                                <View key={server.id}>
                                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                    <ServerRow
                                        server={server}
                                        busy={probe.isPending && probe.variables === server.id}
                                        onProbe={() => probe.mutate(server.id)}
                                    />
                                </View>
                            ))}
                        </Card>
                    )}
                </Section>
            </ScrollView>

            <ConfirmSheet
                visible={confirmMint}
                title="Replace your token?"
                message="Minting a new token revokes the one you have now. Any client still configured with the old value stops working the moment this finishes."
                confirmLabel="Replace token"
                busy={mint.isPending}
                onConfirm={() => mint.mutate()}
                onCancel={() => setConfirmMint(false)}
            />

            <ConfirmSheet
                visible={confirmRevoke}
                title="Revoke your token?"
                message="Every client using it stops reaching Bee Flow straight away. You can mint a new one afterwards, but the old value can never be brought back."
                confirmLabel="Revoke token"
                busy={revoke.isPending}
                onConfirm={() => revoke.mutate()}
                onCancel={() => setConfirmRevoke(false)}
            />

            <SecretOnce
                visible={minted !== null}
                secret={minted}
                title="Your MCP token"
                description="Paste it into your client as the Authorization bearer value. Only half of it is stored on the server, so this is the only time it can be shown."
                shareTitle="Bee Flow MCP token"
                onDone={() => setMinted(null)}
            />
        </Screen>
    );
}

/**
 * The token endpoint answers a bare `/mcp` when PUBLIC_BASE_URL is unset, which
 * is the common self-host case. absoluteUrl fixes that against the server this
 * device is talking to — but it throws when no server is configured at all, and
 * a screen the user reached while signed in should not crash on a nicety.
 */
function safeAbsolute(url: string): string | null {
    try {
        return absoluteUrl(url);
    } catch {
        return null;
    }
}

function ServerRow({
    server,
    busy,
    onProbe,
}: {
    server: McpServer;
    busy: boolean;
    onProbe: () => void;
}) {
    const theme = useTheme();
    const status = mcpStatus(server);

    return (
        <View>
            <ListRow
                title={server.name}
                subtitle={mcpSubtitle(server)}
                meta={server.updatedAt ? relativeTime(server.updatedAt) : undefined}
                wrapTitle
                leading={
                    <View
                        style={{
                            width: 36,
                            height: 36,
                            borderRadius: theme.radii.md,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: theme.colors.bgTertiary,
                        }}
                    >
                        {server.icon ? (
                            <Text variant="body">{server.icon}</Text>
                        ) : (
                            <Feather name="share-2" size={16} color={theme.colors.textPrimary} />
                        )}
                    </View>
                }
                trailing={
                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: theme.spacing.sm,
                        }}
                    >
                        <Badge label={status.label} tone={status.tone} />
                        <IconButton
                            icon={
                                <Feather
                                    name="refresh-cw"
                                    size={16}
                                    color={
                                        busy ? theme.colors.textMuted : theme.colors.textSecondary
                                    }
                                />
                            }
                            accessibilityLabel={`Re-check ${server.name}`}
                            disabled={busy}
                            onPress={onProbe}
                        />
                    </View>
                }
            />
            {server.error ? (
                <Text
                    variant="caption"
                    tone="error"
                    style={{
                        paddingHorizontal: theme.spacing.lg,
                        paddingBottom: theme.spacing.md,
                    }}
                    numberOfLines={3}
                >
                    {server.error}
                </Text>
            ) : null}
        </View>
    );
}

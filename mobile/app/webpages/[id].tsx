/**
 * One webpage: is it out there, who can reach it, and how is it doing.
 *
 * Not an editor. The page's HTML, CSS and JS come down with this very request
 * and are deliberately thrown away in api.ts — there is no WebView to preview
 * them in and no reason to render a code editor on a 6" screen. What is left
 * is the part a phone is actually good at, in the order it gets asked about:
 *
 *   1. Who can see this      — the internal publish, and the external links.
 *   2. How is it doing       — views, from the only place views are counted.
 *   3. Make it reachable     — mint, refresh or revoke a link.
 *   4. Get rid of it         — behind a confirmation, at the bottom.
 *
 * Two audiences, never merged, because merging them is how a page meant for
 * five colleagues ends up on the open internet:
 *   - PUBLISH puts the page in front of signed-in colleagues in the owner's
 *     organisation (or specific groups within it), through the same sandboxed
 *     preview the author uses.
 *   - An EXTERNAL LINK publishes a sanitized, JavaScript-free snapshot at
 *     /share/<token> to whoever holds the address. Taken at creation time, so
 *     it goes stale until somebody refreshes it.
 *
 * `readOnly` on the detail response marks a page you can see because it was
 * published to you, but do not own. Every mutation below is owner-only on the
 * server, so the screen hides them rather than offering buttons that 404.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import {
    createWebpageShare,
    deleteWebpage,
    getWebpage,
    listWebpageShares,
    publishingKeys,
    refreshWebpageShare,
    revokeWebpageShare,
    setWebpagePublished,
} from '../../src/features/publishing/api';
import { LinkActions } from '../../src/features/publishing/components/LinkActions';
import {
    describeDeleteBlock,
    readDeleteBlock,
    type WebpageDeleteBlock,
} from '../../src/features/publishing/deleteBlock';
import { isShareLive, shareStatus } from '../../src/features/publishing/format';
import type { WebpageShare } from '../../src/features/publishing/types';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { Banner, ErrorState, LoadingState, describeError } from '../../src/ui/Feedback';
import { TextField } from '../../src/ui/Input';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { ConfirmSheet, Sheet } from '../../src/ui/Sheet';
import { Card, Divider, Section } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function WebpageDetailScreen() {
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const params = useLocalSearchParams<{ id: string }>();
    const id = typeof params.id === 'string' ? params.id : '';

    const [newLinkSheet, setNewLinkSheet] = useState(false);
    const [password, setPassword] = useState('');
    const [passwordError, setPasswordError] = useState<string | null>(null);
    const [revoking, setRevoking] = useState<WebpageShare | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    // What the server said when it refused the first, unconfirmed request. It
    // is the answer the second sheet shows, and holding it is what makes the
    // second press an INFORMED one rather than a retry.
    const [deleteBlock, setDeleteBlock] = useState<WebpageDeleteBlock | null>(null);
    const [createdUrl, setCreatedUrl] = useState<string | null>(null);

    const page = useQuery({
        queryKey: publishingKeys.webpage(id),
        queryFn: ({ signal }) => getWebpage(id, signal),
        enabled: id !== '',
    });

    const shares = useQuery({
        queryKey: publishingKeys.webpageShares(id),
        queryFn: ({ signal }) => listWebpageShares(id, signal),
        enabled: id !== '',
    });

    const owned = page.data ? !page.data.readOnly : false;

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: publishingKeys.webpage(id) });
        void queryClient.invalidateQueries({ queryKey: publishingKeys.webpageShares(id) });
        void queryClient.invalidateQueries({ queryKey: publishingKeys.webpages });
    };

    const publish = useMutation({
        mutationFn: (next: boolean) => setWebpagePublished(id, next),
        onSuccess: (isPublished) => {
            toast(isPublished ? 'Published to your organisation' : 'Withdrawn', 'success');
            invalidate();
        },
        onError: (err: unknown) => toast(describeError(err).message, 'error'),
    });

    const createLink = useMutation({
        mutationFn: () =>
            createWebpageShare(id, {
                password: password.trim() ? password.trim() : undefined,
                title: page.data?.webpage.name,
            }),
        onSuccess: (created) => {
            setNewLinkSheet(false);
            setPassword('');
            // Show the URL now rather than trusting the list to rebuild it.
            // It usually can — the raw token is kept encrypted alongside its
            // hash — but that copy is best-effort: an install with no
            // MASTER_ENCRYPTION_KEY stores nothing to decrypt and degrades to
            // the old show-once model (webpagePublicShareStore.createShare).
            // On those servers, this response is the only sighting of the
            // address, and a toast would have thrown it away.
            if (created?.url) setCreatedUrl(created.url);
            invalidate();
        },
        onError: (err: unknown) => toast(describeError(err).message, 'error'),
    });

    const refreshLink = useMutation({
        mutationFn: (shareId: string) => refreshWebpageShare(id, shareId),
        onSuccess: () => {
            toast('Snapshot updated', 'success');
            invalidate();
        },
        onError: (err: unknown) => toast(describeError(err).message, 'error'),
    });

    const revokeLink = useMutation({
        mutationFn: (shareId: string) => revokeWebpageShare(id, shareId),
        onSuccess: () => {
            setRevoking(null);
            toast('Link revoked', 'success');
            invalidate();
        },
        onError: (err: unknown) => {
            setRevoking(null);
            toast(describeError(err).message, 'error');
        },
    });

    /**
     * Deleting is TWO presses, because the server answers the question in
     * between.
     *
     * The first request goes out unconfirmed. The guard refuses it with 409 and
     * a payload naming what uses the page and which kinds it could not check —
     * and it refuses EVERY first request, because `chat` and `agent` are
     * structurally unanswerable, so `complete` is never true. Sending
     * `?confirm=1` straight away would make that refusal unreachable and skip
     * the check outright; never sending it would make the page undeletable from
     * this screen. So: ask, show the answer, ask again.
     *
     * A 409 is therefore not an error here — it is the expected first outcome,
     * and only a NON-409 failure reaches the toast.
     */
    const removePage = useMutation({
        mutationFn: (confirmedBreaking: boolean) => deleteWebpage(id, { confirmedBreaking }),
        onSuccess: () => {
            setConfirmDelete(false);
            setDeleteBlock(null);
            void queryClient.invalidateQueries({ queryKey: publishingKeys.webpages });
            toast('Page deleted', 'success');
            router.back();
        },
        onError: (err: unknown) => {
            const refused = readDeleteBlock(err);
            if (refused.blocked) {
                // Hand the first sheet over to the second, which names what the
                // guard found before it asks again.
                setConfirmDelete(false);
                setDeleteBlock(refused);
                return;
            }
            setConfirmDelete(false);
            setDeleteBlock(null);
            toast(describeError(err).message, 'error');
        },
    });

    /**
     * Views, and where they do NOT come from.
     *
     * The only view counter in this feature is on the external shares
     * (`view_count` on webpage_public_shares, bumped by the /share viewer). An
     * internal, org-published page is served through the authenticated preview
     * and is not counted anywhere — so the total is honestly labelled
     * "external links" rather than presented as the page's whole traffic.
     */
    const reach = useMemo(() => {
        const rows = shares.data ?? [];
        const views = rows.reduce((sum, share) => sum + share.viewCount, 0);
        const lastViewedAt = rows
            .map((share) => share.lastViewedAt)
            .filter((iso): iso is string => Boolean(iso))
            .sort()
            .pop();
        return {
            views,
            lastViewedAt: lastViewedAt ?? null,
            live: rows.filter((share) => isShareLive(share)).length,
        };
    }, [shares.data]);

    if (page.isLoading) {
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="Page" />
                <LoadingState />
            </Screen>
        );
    }

    if (page.isError || !page.data) {
        return (
            <Screen edges={['top', 'bottom']}>
                <ScreenHeader title="Page" />
                <ErrorState
                    error={page.error ?? new Error('This page no longer exists.')}
                    onRetry={() => void page.refetch()}
                />
            </Screen>
        );
    }

    const webpage = page.data.webpage;

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={webpage.name || 'Untitled page'}
                subtitle={webpage.tagline || webpage.description || undefined}
            />

            <ScrollView
                contentContainerStyle={{
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.xxxl,
                    gap: theme.spacing.xl,
                }}
                refreshControl={
                    <RefreshControl
                        refreshing={page.isRefetching || shares.isRefetching}
                        onRefresh={() => {
                            void page.refetch();
                            void shares.refetch();
                        }}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
            >
                <Banner tone="info" icon="edit-3">
                    Editing this page happens in the web app on a desktop. From here you can
                    publish it, share it and see how it is doing.
                </Banner>

                <Section title="Inside your organisation">
                    <Card>
                        <View style={{ gap: theme.spacing.md }}>
                            <View
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: theme.spacing.sm,
                                }}
                            >
                                <Badge
                                    label={webpage.isPublished ? 'Published' : 'Draft'}
                                    tone={webpage.isPublished ? 'success' : 'neutral'}
                                />
                                <Text variant="caption" tone="tertiary" style={{ flex: 1 }}>
                                    {webpage.isPublished
                                        ? webpage.sharedGroups.length > 0
                                            ? `Visible to ${webpage.sharedGroups.length} group${webpage.sharedGroups.length === 1 ? '' : 's'}`
                                            : 'Visible to everyone in your organisation'
                                        : 'Only you can see it'}
                                </Text>
                            </View>
                            <Text variant="caption" tone="tertiary">
                                Colleagues open it signed in, through the app. This is not the
                                public link — that is below.
                            </Text>
                            {owned ? (
                                <Button
                                    label={webpage.isPublished ? 'Withdraw' : 'Publish'}
                                    variant={webpage.isPublished ? 'secondary' : 'primary'}
                                    loading={publish.isPending}
                                    onPress={() => publish.mutate(!webpage.isPublished)}
                                    accessibilityHint={
                                        webpage.isPublished
                                            ? 'Stops colleagues seeing this page'
                                            : 'Lets colleagues in your organisation open this page'
                                    }
                                />
                            ) : (
                                <Text variant="caption" tone="tertiary">
                                    Someone else owns this page, so publishing is theirs to change.
                                </Text>
                            )}
                        </View>
                    </Card>
                </Section>

                <Section
                    title="Reach"
                    subtitle="Counted on external links only — visits from inside the app are not tracked"
                >
                    <Card>
                        <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
                            <Stat label="Views" value={String(reach.views)} />
                            <Stat label="Live links" value={String(reach.live)} />
                            <Stat
                                label="Last opened"
                                value={reach.lastViewedAt ? relativeTime(reach.lastViewedAt) : '—'}
                            />
                        </View>
                    </Card>
                </Section>

                <Section
                    title="External links"
                    subtitle="A snapshot of the page, without its JavaScript, for people outside Bee Flow"
                    action={
                        owned ? (
                            <Button
                                label="New link"
                                variant="ghost"
                                onPress={() => setNewLinkSheet(true)}
                            />
                        ) : undefined
                    }
                >
                    {shares.isError ? (
                        <Banner tone={describeError(shares.error).retryable ? 'error' : 'info'}>
                            {describeError(shares.error).message}
                        </Banner>
                    ) : (shares.data ?? []).length === 0 ? (
                        <Card>
                            <Text variant="body" tone="tertiary">
                                {owned
                                    ? 'No external links yet. One gives anyone who holds the address a read-only copy of this page.'
                                    : 'The owner has not created any external links for this page.'}
                            </Text>
                        </Card>
                    ) : (
                        <Card padded={false}>
                            {(shares.data ?? []).map((share, index) => (
                                <View key={share.id}>
                                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                    <ShareCard
                                        share={share}
                                        owned={owned}
                                        busy={
                                            refreshLink.isPending &&
                                            refreshLink.variables === share.id
                                        }
                                        onRefresh={() => refreshLink.mutate(share.id)}
                                        onRevoke={() => setRevoking(share)}
                                    />
                                </View>
                            ))}
                        </Card>
                    )}
                </Section>

                {owned ? (
                    <Section title="Danger zone">
                        <Card>
                            <View style={{ gap: theme.spacing.md }}>
                                <Text variant="caption" tone="tertiary">
                                    Deleting takes the page, every version of it, its external
                                    links and any knowledge base created for it. There is no undo.
                                </Text>
                                <Button
                                    label="Delete page"
                                    variant="destructive"
                                    onPress={() => setConfirmDelete(true)}
                                />
                            </View>
                        </Card>
                    </Section>
                ) : null}
            </ScrollView>

            <Sheet
                visible={newLinkSheet}
                onClose={() => setNewLinkSheet(false)}
                title="New external link"
                subtitle="Anyone with the address can open it"
                footer={
                    <Button
                        label="Create link"
                        size="lg"
                        fullWidth
                        loading={createLink.isPending}
                        onPress={() => {
                            const trimmed = password.trim();
                            // The store throws below six characters, and a
                            // 400 from a create is a worse way to learn that
                            // than a line under the field.
                            if (trimmed && trimmed.length < 6) {
                                setPasswordError('Use at least six characters, or leave it empty.');
                                return;
                            }
                            setPasswordError(null);
                            createLink.mutate();
                        }}
                    />
                }
            >
                <View style={{ gap: theme.spacing.md }}>
                    <Text variant="body" tone="secondary">
                        The link serves a copy of the page as it is right now, with its JavaScript
                        stripped. Refresh it later to publish newer content to the same address.
                    </Text>
                    <TextField
                        label="Password (optional)"
                        hint="Leave empty for a link that opens straight away."
                        value={password}
                        onChangeText={setPassword}
                        error={passwordError}
                        secure
                        autoCapitalize="none"
                    />
                    <Text variant="caption" tone="tertiary">
                        Restricting a link to named email addresses is a desktop job — typing a
                        list of colleagues here would be slower than sending them the link.
                    </Text>
                </View>
            </Sheet>

            <Sheet
                visible={createdUrl !== null}
                onClose={() => setCreatedUrl(null)}
                title="Link created"
                subtitle="Anyone with this address can open the page"
                footer={<Button label="Done" size="lg" fullWidth onPress={() => setCreatedUrl(null)} />}
            >
                <View style={{ gap: theme.spacing.md }}>
                    <LinkActions
                        url={createdUrl ?? ''}
                        shareTitle={webpage.name || 'Bee Flow page'}
                    />
                    <Text variant="caption" tone="tertiary">
                        Copy it now. It normally stays available in the list below, but on a server
                        without a master encryption key an address can only be shown once.
                    </Text>
                </View>
            </Sheet>

            <ConfirmSheet
                visible={revoking !== null}
                title="Revoke this link?"
                message="The address stops working immediately and the snapshot behind it is deleted. Anyone you sent it to will get a not-found page."
                confirmLabel="Revoke link"
                busy={revokeLink.isPending}
                onConfirm={() => {
                    if (revoking) revokeLink.mutate(revoking.id);
                }}
                onCancel={() => setRevoking(null)}
            />

            <ConfirmSheet
                visible={confirmDelete}
                title={`Delete ${webpage.name || 'this page'}?`}
                message="The page, its version history and all of its external links go with it. This cannot be undone."
                confirmLabel="Delete page"
                busy={removePage.isPending}
                onConfirm={() => removePage.mutate(false)}
                onCancel={() => setConfirmDelete(false)}
            />

            {/*
              * The guard's answer, and the only place the confirmed request is
              * sent from. Its message says what was found AND what could not be
              * checked — an empty list presented as a complete one is exactly
              * the sentence somebody presses through.
              */}
            <ConfirmSheet
                visible={deleteBlock !== null}
                title={`Delete ${webpage.name || 'this page'} anyway?`}
                message={deleteBlock ? describeDeleteBlock(deleteBlock) : ''}
                confirmLabel="Delete anyway"
                busy={removePage.isPending}
                onConfirm={() => removePage.mutate(true)}
                onCancel={() => setDeleteBlock(null)}
            />
        </Screen>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    const theme = useTheme();
    return (
        <View style={{ flex: 1, gap: theme.spacing.xxs }}>
            <Text variant="heading" numberOfLines={1}>
                {value}
            </Text>
            <Text variant="label" tone="tertiary">
                {label}
            </Text>
        </View>
    );
}

function ShareCard({
    share,
    owned,
    busy,
    onRefresh,
    onRevoke,
}: {
    share: WebpageShare;
    owned: boolean;
    busy: boolean;
    onRefresh: () => void;
    onRevoke: () => void;
}) {
    const theme = useTheme();
    const status = shareStatus(share);
    const live = isShareLive(share);

    return (
        <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                <Badge label={status.label} tone={status.tone} />
                <Text variant="caption" tone="tertiary" style={{ flex: 1 }} numberOfLines={1}>
                    {share.viewCount === 1 ? '1 view' : `${share.viewCount} views`}
                    {share.lastViewedAt ? ` · last ${relativeTime(share.lastViewedAt)}` : ''}
                </Text>
            </View>

            {share.expiresAt && live ? (
                <Text variant="caption" tone="tertiary">
                    Expires {relativeTime(share.expiresAt)}
                </Text>
            ) : null}

            {share.url ? (
                <LinkActions url={share.url} shareTitle={share.title || 'Bee Flow page'} />
            ) : (
                /* url is null whenever the raw token cannot be recovered:
                   revoked, expired, or a row created before tokens were
                   encrypted at rest. Nothing to retry — the address is gone
                   for good and a new link is the only way back. */
                <Text variant="caption" tone="tertiary">
                    {live
                        ? 'This link was made before Bee Flow could show addresses again. Create a new one to get a copyable link.'
                        : 'This address no longer works.'}
                </Text>
            )}

            {owned && live ? (
                <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                    <Button
                        label="Refresh"
                        variant="ghost"
                        loading={busy}
                        onPress={onRefresh}
                        icon={
                            <Feather
                                name="refresh-cw"
                                size={16}
                                color={theme.colors.textSecondary}
                            />
                        }
                        accessibilityHint="Publishes the page's current content to this same address"
                    />
                    <Button label="Revoke" variant="ghost" onPress={onRevoke} />
                </View>
            ) : null}
        </View>
    );
}

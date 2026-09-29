/**
 * The notification inbox.
 *
 * Reached from the bell in every tab header. Four things happen here: read,
 * mark read, delete, and go to whatever the notification is about.
 *
 * The routing is the interesting part. The server stores a WEB path in `link`
 * (`/app/studio/automations/<id>?view=runs`), because notifications were built
 * for agent-hub; this app is native and has a different route table, so every
 * link is translated by src/features/notifications/route.ts. A link that has
 * no native equivalent says so on the row rather than offering a tap that
 * silently does nothing.
 *
 * Importing `background` here is load-bearing, not incidental: it defines the
 * WorkManager task at module scope, and expo-router eagerly requires every
 * route file, so this import is what guarantees the task exists by the time
 * Android tries to run it.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, View } from 'react-native';

import {
    deleteNotification,
    listNotifications,
    markAllNotificationsRead,
    markNotificationRead,
    notificationKeys,
} from '../src/features/notifications/api';
import { registerNotificationPolling } from '../src/features/notifications/background';
import {
    BUCKET_LABELS,
    bucketFor,
    parseReauthToken,
    previewOf,
    unreadCount,
    type TimeBucket,
} from '../src/features/notifications/format';
import { targetForNotification } from '../src/features/notifications/route';
import type { AppNotification } from '../src/features/notifications/types';
import { presentationFor, RESULT_CATEGORIES } from '../src/features/notifications/types';
import { relativeTime } from '../src/lib/time';
import { useTheme } from '../src/theme/ThemeProvider';
import { Badge, Chip } from '../src/ui/Badge';
import { IconButton } from '../src/ui/Button';
import { Banner, EmptyState, ErrorState, ListSkeleton, describeError } from '../src/ui/Feedback';
import { Screen } from '../src/ui/Screen';
import { ScreenHeader } from '../src/ui/ScreenHeader';
import { Divider } from '../src/ui/Surface';
import { Text } from '../src/ui/Text';
import { useToast } from '../src/ui/Toast';

const BUCKET_ORDER: TimeBucket[] = ['today', 'this_week', 'older'];

export default function NotificationsScreen() {
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    const [unreadOnly, setUnreadOnly] = useState(false);
    /** The row whose full body is open. One at a time — this is a list, not a feed. */
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const query = useQuery({
        queryKey: notificationKeys.list(unreadOnly),
        queryFn: ({ signal }) => listNotifications({ unreadOnly, limit: 50 }, signal),
    });

    const notifications = useMemo(() => query.data ?? [], [query.data]);

    /**
     * Every mutation invalidates the badge as well as the list. The bell in
     * AppHeader polls `notificationKeys.unread` on a 60s interval, and without
     * this it would keep showing a count for things the user has just read.
     */
    const invalidate = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    }, [queryClient]);

    const markRead = useMutation({
        mutationFn: (id: string) => markNotificationRead(id),
        // Optimistic: marking read is the single most common gesture here and
        // a 300ms round-trip before the dot disappears makes the list feel
        // unresponsive. The invalidate below is the reconciliation.
        onMutate: async (id: string) => {
            const key = notificationKeys.list(unreadOnly);
            await queryClient.cancelQueries({ queryKey: key });
            const previous = queryClient.getQueryData<AppNotification[]>(key);
            queryClient.setQueryData<AppNotification[]>(key, (rows) =>
                (rows ?? []).map((row) => (row.id === id ? { ...row, read: true } : row)),
            );
            return { previous };
        },
        onError: (_error, _id, context) => {
            if (context?.previous) {
                queryClient.setQueryData(notificationKeys.list(unreadOnly), context.previous);
            }
        },
        onSettled: invalidate,
    });

    const markAll = useMutation({
        mutationFn: () => markAllNotificationsRead(),
        onSuccess: (marked) => {
            toast(
                marked === 0 ? 'Everything was already read' : `${marked} marked as read`,
                'success',
            );
            invalidate();
        },
    });

    const remove = useMutation({
        mutationFn: (id: string) => deleteNotification(id),
        onSuccess: () => {
            toast('Notification deleted', 'success');
            invalidate();
        },
    });

    const open = useCallback(
        (notification: AppNotification) => {
            if (!notification.read) markRead.mutate(notification.id);
            const target = targetForNotification(notification);
            if (target.href) {
                router.push(target.href as never);
                return;
            }
            // A result notification carries its whole output in `message`, so
            // "open" means "show me the rest of it", not "navigate".
            setExpandedId((current) => (current === notification.id ? null : notification.id));
        },
        [markRead, router],
    );

    const sections = useMemo(() => {
        const buckets = new Map<TimeBucket, AppNotification[]>();
        for (const item of notifications) {
            const bucket = bucketFor(item.created_at);
            const list = buckets.get(bucket);
            if (list) list.push(item);
            else buckets.set(bucket, [item]);
        }
        return BUCKET_ORDER.filter((bucket) => (buckets.get(bucket)?.length ?? 0) > 0).map(
            (bucket) => ({
                key: bucket,
                title: BUCKET_LABELS[bucket],
                data: buckets.get(bucket) ?? [],
            }),
        );
    }, [notifications]);

    const unread = unreadCount(notifications);
    const mutationError = markAll.error ?? remove.error ?? markRead.error ?? null;
    const failure = mutationError ? describeError(mutationError) : null;

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />

            <ScreenHeader
                title="Notifications"
                subtitle={unread === 0 ? 'All caught up' : `${unread} unread`}
                actions={
                    <>
                        <IconButton
                            icon={<Feather name="check-circle" size={20} color={theme.colors.textPrimary} />}
                            accessibilityLabel="Mark all as read"
                            disabled={unread === 0 || markAll.isPending}
                            onPress={() => markAll.mutate()}
                        />
                    </>
                }
            />

            <View
                style={{
                    flexDirection: 'row',
                    gap: theme.spacing.sm,
                    paddingHorizontal: theme.spacing.lg,
                    paddingBottom: theme.spacing.sm,
                }}
            >
                <Chip label="All" selected={!unreadOnly} onPress={() => setUnreadOnly(false)} />
                <Chip label="Unread" selected={unreadOnly} onPress={() => setUnreadOnly(true)} />
            </View>

            {/* A failed mutation gets a real, re-readable line on the screen.
                Toasts here only ever confirm — an error that scrolls away
                after two seconds is an error the user cannot act on. */}
            {failure ? (
                <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
                    <Banner tone="error" action={
                        <IconButton
                            icon={<Feather name="x" size={16} color={theme.colors.textMuted} />}
                            accessibilityLabel="Dismiss this message"
                            onPress={() => {
                                markAll.reset();
                                remove.reset();
                                markRead.reset();
                            }}
                        />
                    }>
                        {`${failure.title}. ${failure.message}`}
                    </Banner>
                </View>
            ) : null}

            {query.isLoading ? (
                <ListSkeleton rows={6} />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : notifications.length === 0 ? (
                <EmptyState
                    icon="bell"
                    title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}
                    message={
                        unreadOnly
                            ? 'Everything here has been read.'
                            : 'Bee Flow tells you here when a routine finishes, an approval is waiting, or a connector needs reconnecting.'
                    }
                    actionLabel={unreadOnly ? 'Show all' : 'Turn on background alerts'}
                    onAction={
                        unreadOnly
                            ? () => setUnreadOnly(false)
                            : () => {
                                  void registerNotificationPolling().then((ok) =>
                                      toast(
                                          ok
                                              ? 'Bee Flow will check for updates in the background'
                                              : 'Android is not allowing background work for Bee Flow',
                                          ok ? 'success' : 'error',
                                      ),
                                  );
                              }
                    }
                />
            ) : (
                <SectionList
                    sections={sections}
                    keyExtractor={(item) => item.id}
                    stickySectionHeadersEnabled={false}
                    contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
                    refreshControl={
                        <RefreshControl
                            refreshing={query.isRefetching}
                            onRefresh={() => void query.refetch()}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                    renderSectionHeader={({ section }) => (
                        <Text
                            variant="label"
                            tone="tertiary"
                            accessibilityRole="header"
                            style={{
                                paddingHorizontal: theme.spacing.lg,
                                paddingTop: theme.spacing.lg,
                                paddingBottom: theme.spacing.xs,
                            }}
                        >
                            {section.title.toUpperCase()}
                        </Text>
                    )}
                    ItemSeparatorComponent={() => <Divider inset={theme.spacing.lg} />}
                    renderItem={({ item }) => (
                        <NotificationRow
                            notification={item}
                            expanded={expandedId === item.id}
                            onPress={() => open(item)}
                            onToggleRead={() => markRead.mutate(item.id)}
                            onDelete={() => remove.mutate(item.id)}
                            deleting={remove.isPending && remove.variables === item.id}
                        />
                    )}
                />
            )}
        </Screen>
    );
}

function NotificationRow({
    notification,
    expanded,
    onPress,
    onToggleRead,
    onDelete,
    deleting,
}: {
    notification: AppNotification;
    expanded: boolean;
    onPress: () => void;
    onToggleRead: () => void;
    onDelete: () => void;
    deleting: boolean;
}) {
    const theme = useTheme();
    const presentation = presentationFor(notification.category);
    const target = targetForNotification(notification);
    const { provider, body } = parseReauthToken(notification.message);
    const isResult = RESULT_CATEGORIES.has(notification.category);

    const tint = {
        neutral: theme.colors.textMuted,
        accent: theme.colors.accentPrimary,
        success: theme.colors.success,
        warning: theme.colors.warning,
        error: theme.colors.error,
    }[presentation.tone];

    // Not a ListRow: this row has an unread dot, a category mark, an expandable
    // body and two trailing actions, which is more than that component's shape
    // carries. The touch target, padding and pressed state still match it.
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`${presentation.label}: ${notification.title}`}
            accessibilityHint={
                target.href
                    ? 'Opens the item this is about'
                    : 'Shows the full message'
            }
            accessibilityState={{ expanded, selected: !notification.read }}
            style={({ pressed }) => ({
                flexDirection: 'row',
                gap: theme.spacing.md,
                minHeight: 64,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                backgroundColor: pressed
                    ? theme.colors.itemHoverBg
                    : notification.read
                      ? 'transparent'
                      : theme.colors.itemActiveBg,
            })}
        >
            <View style={{ paddingTop: 2 }}>
                <Feather name={presentation.icon as keyof typeof Feather.glyphMap} size={18} color={tint} />
            </View>

            <View style={{ flex: 1, gap: theme.spacing.xxs }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                    <Text variant="subheading" numberOfLines={2} style={{ flex: 1 }}>
                        {notification.title}
                    </Text>
                    {!notification.read ? (
                        <View
                            accessibilityElementsHidden
                            style={{
                                width: 8,
                                height: 8,
                                borderRadius: 4,
                                backgroundColor: theme.colors.accentPrimary,
                            }}
                        />
                    ) : null}
                </View>

                {body ? (
                    <Text variant="caption" tone="tertiary" numberOfLines={expanded ? undefined : 2}>
                        {expanded ? body : previewOf(body)}
                    </Text>
                ) : null}

                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: theme.spacing.sm,
                        marginTop: theme.spacing.xxs,
                    }}
                >
                    <Text variant="label" tone="tertiary">
                        {relativeTime(notification.created_at, { suffix: true })}
                    </Text>
                    <Badge label={presentation.label} tone={presentation.tone} />
                    {target.unavailableReason ? (
                        <Text variant="label" tone="tertiary" style={{ flex: 1 }}>
                            {target.unavailableReason}
                        </Text>
                    ) : null}
                </View>

                {/* A routine whose credentials expired writes `routine_reauth:<provider>`
                    at the head of the body. Reconnecting is an OAuth flow with a
                    popup and a vault write — it belongs on the desktop, and
                    saying so beats a button that half-works. */}
                {provider ? (
                    <Text variant="caption" tone="warning">
                        Reconnect {provider} from Settings → Connections on the web app to
                        restart this routine.
                    </Text>
                ) : null}

                {isResult && !expanded && body.length > 140 ? (
                    <Text variant="label" tone="accent">
                        Tap to read the full result
                    </Text>
                ) : null}
            </View>

            <View style={{ gap: theme.spacing.xs }}>
                <IconButton
                    icon={
                        <Feather
                            name={notification.read ? 'circle' : 'check'}
                            size={16}
                            color={theme.colors.textMuted}
                        />
                    }
                    accessibilityLabel={
                        notification.read ? 'Already read' : `Mark “${notification.title}” as read`
                    }
                    disabled={notification.read}
                    onPress={onToggleRead}
                />
                <IconButton
                    icon={<Feather name="trash-2" size={16} color={theme.colors.error} />}
                    accessibilityLabel={`Delete “${notification.title}”`}
                    tone="destructive"
                    disabled={deleting}
                    onPress={onDelete}
                />
            </View>
        </Pressable>
    );
}

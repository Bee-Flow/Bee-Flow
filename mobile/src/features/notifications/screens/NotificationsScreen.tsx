/**
 * The notification inbox.
 *
 * Reached from the bell in every tab header. Four things happen here: read,
 * mark read, delete, and go to whatever the notification is about.
 *
 * The routing is the interesting part. The server stores a WEB path in `link`
 * (`/app/studio/automations/<id>?view=runs`), because notifications were built
 * for agent-hub; this app is native and has a different route table, so every
 * link is translated by model/route.ts. A link that has no native equivalent
 * says so on the row rather than offering a tap that silently does nothing.
 */

import { Stack } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { Chip, ErrorState, Icon, IconButton, ListSkeleton, Screen, ScreenHeader } from '@/shared/ui';

import { NotificationList } from '../components/NotificationList';
import { NotificationsEmpty } from '../components/NotificationsEmpty';
import { NotificationsFailure } from '../components/NotificationsFailure';
import { useNotificationInbox } from '../hooks/useNotificationInbox';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        filters: {
            flexDirection: 'row',
            gap: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
            paddingBottom: theme.spacing.sm,
        },
    });

export function NotificationsScreen() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const inbox = useNotificationInbox();
    const { query, unreadOnly, setUnreadOnly, unread, markAll, markRead, remove } = inbox;
    const refresh = useUserRefresh(() => query.refetch());

    let body: React.ReactElement;
    if (query.isLoading) {
        body = <ListSkeleton rows={6} />;
    } else if (query.isError) {
        body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    } else if (inbox.notifications.length === 0) {
        body = <NotificationsEmpty unreadOnly={unreadOnly} onShowAll={() => setUnreadOnly(false)} />;
    } else {
        body = (
            <NotificationList
                sections={inbox.sections}
                expandedId={inbox.expandedId}
                refreshing={refresh.refreshing}
                onRefresh={refresh.onRefresh}
                onOpen={inbox.open}
                onFollow={inbox.follow}
                onMarkRead={(id) => markRead.mutate(id)}
                onDelete={(id) => remove.mutate(id)}
                deletingId={remove.isPending ? remove.variables : undefined}
            />
        );
    }

    return (
        <Screen edges={['top', 'bottom']}>
            <Stack.Screen options={{ headerShown: false }} />
            <ScreenHeader
                title="Notifications"
                subtitle={unread === 0 ? 'All caught up' : `${unread} unread`}
                actions={
                    <IconButton
                        icon={<Icon name="CircleCheckBig" size={20} color={theme.colors.textPrimary} />}
                        accessibilityLabel="Mark all as read"
                        disabled={unread === 0 || markAll.isPending}
                        onPress={() => markAll.mutate()}
                    />
                }
            />
            <View style={styles.filters}>
                <Chip label="All" selected={!unreadOnly} onPress={() => setUnreadOnly(false)} />
                <Chip label="Unread" selected={unreadOnly} onPress={() => setUnreadOnly(true)} />
            </View>
            {inbox.failure ? <NotificationsFailure failure={inbox.failure} onDismiss={inbox.dismissFailure} /> : null}
            {body}
        </Screen>
    );
}

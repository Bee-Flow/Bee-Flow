/**
 * Activity — the project's durable trail, newest first, a page at a time (the
 * web's Activity tab). Virtualised, and the next page is asked for on
 * reaching the end rather than behind a "load more" button.
 */

import React from 'react';
import { FlatList, RefreshControl, StyleSheet, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, InsetDivider, ListSkeleton, Spinner } from '@/shared/ui';

import { ActivityRow } from './ActivityRow';
import { useDirectory, useProjectActivity } from '../hooks/queries';
import { nameResolver } from '../model/people';
import type { ActivityItem } from '../model/types';

const itemKey = (item: ActivityItem) => item.id;

export function ActivityTab({ id }: { id: string }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const activity = useProjectActivity(id);
    const refresh = useUserRefresh(() => activity.refetch());
    const directory = useDirectory();
    const nameFor = nameResolver(directory.data);

    if (activity.isLoading) return <ListSkeleton />;
    if (activity.isError) return <ErrorState error={activity.error} onRetry={() => void activity.refetch()} />;
    const items = activity.data?.pages.flatMap((page) => page.items) ?? [];
    if (items.length === 0) {
        return <EmptyState icon="History" title={t('projects.recent_activity', 'Recent activity')} message={t('projects.section_empty', 'Nothing here yet.')} />;
    }
    const renderItem: ListRenderItem<ActivityItem> = ({ item }) => <ActivityRow item={item} nameFor={nameFor} />;
    return (
        <FlatList
            data={items}
            keyExtractor={itemKey}
            renderItem={renderItem}
            ItemSeparatorComponent={InsetDivider}
            contentContainerStyle={styles.content}
            onEndReachedThreshold={0.5}
            onEndReached={() => {
                if (activity.hasNextPage && !activity.isFetchingNextPage) void activity.fetchNextPage();
            }}
            ListFooterComponent={activity.isFetchingNextPage ? <Spinner /> : null}
            refreshControl={
                <RefreshControl
                    refreshing={refresh.refreshing}
                    onRefresh={refresh.onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            testID="activity-list"
        />
    );
}

const makeStyles = (theme: Theme) => StyleSheet.create({ content: { paddingBottom: theme.spacing.xxxl } });

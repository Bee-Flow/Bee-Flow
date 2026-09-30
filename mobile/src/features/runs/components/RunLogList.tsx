/**
 * The log itself: a virtualised FlatList that asks for the next page as the
 * end comes into view, with the strip and the filters as its header so the
 * whole screen scrolls as one. Skeleton on the first read, the error with a
 * retry, and an empty state that says the filters are why — each in place of
 * the rows, UNDER the header: the chip just tapped stays on screen while its
 * read loads, and stays there to tap again when that read fails.
 */

import { useRouter } from 'expo-router';
import React, { type ReactElement } from 'react';
import { FlatList, RefreshControl, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, InsetDivider, ListSkeleton, Spinner } from '@/shared/ui';

import { RunLogRow } from './RunLogRow';
import type { useRunLog } from '../hooks/queries';
import { canOpenRun, runHref } from '../model/filters';
import type { LogRun, RunScope } from '../model/types';

const keyOf = (run: LogRun) => run.id;

type RunLog = ReturnType<typeof useRunLog>;

/** In place of the rows: the first read, its failure, or nothing that matches. */
function NoRows({ list }: { list: RunLog }) {
    const t = useTranslation();
    if (list.isLoading) return <ListSkeleton />;
    if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
    return (
        <EmptyState
            icon="History"
            title={t('mobile.runs.empty_title', 'No runs match')}
            message={t('mobile.runs.empty_body', 'Nothing ran that fits these filters. Widen the range or show everything.')}
        />
    );
}

export function RunLogList({
    scope,
    list,
    header,
    onRefresh,
}: {
    scope: RunScope;
    list: RunLog;
    header: ReactElement;
    /** What a pull runs; return its promise (the spinner waits for it). */
    onRefresh: () => unknown;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const refresh = useUserRefresh(onRefresh);
    // While a new filter loads, the previous filter's rows stand in
    // (useRunLog's placeholder); a failed read shows its error instead.
    const rows = list.isError ? [] : (list.data?.pages.flatMap((p) => p.runs) ?? []);
    const open = (run: LogRun) => router.push(runHref(run));
    const renderItem: ListRenderItem<LogRun> = ({ item }) => (
        <RunLogRow run={item} openable={canOpenRun(scope, item)} onOpen={open} />
    );
    return (
        <FlatList
            data={rows}
            keyExtractor={keyOf}
            renderItem={renderItem}
            ItemSeparatorComponent={InsetDivider}
            ListHeaderComponent={header}
            ListEmptyComponent={<NoRows list={list} />}
            ListFooterComponent={list.isFetchingNextPage || list.isPlaceholderData ? <Spinner /> : null}
            onEndReached={() => {
                // Stand-in rows have no next page of their own to ask for.
                if (list.hasNextPage && !list.isFetchingNextPage && !list.isPlaceholderData) void list.fetchNextPage();
            }}
            onEndReachedThreshold={0.5}
            refreshControl={
                <RefreshControl
                    refreshing={refresh.refreshing}
                    onRefresh={refresh.onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            contentContainerStyle={styles.content}
        />
    );
}

const makeStyles = (theme: Theme) => ({
    content: { paddingBottom: theme.spacing[8] },
});

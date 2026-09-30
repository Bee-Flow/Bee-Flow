/**
 * The library list under the Meeting Notes tab's start bar: the header (outbox and
 * filters), one row per meeting, and the right empty state — a failed load,
 * filters that match nothing, or no meetings yet.
 */

import { useRouter } from 'expo-router';
import React, { type ReactElement } from 'react';
import { FlatList, RefreshControl, StyleSheet } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState } from '@/shared/ui';

import { TranscriptionRow } from './TranscriptionRow';
import type { Library } from '../hooks/useLibrary';
import { DEFAULT_FILTER } from '../model/library';
import type { TranscriptionSummary } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        list: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.xxxl },
    });

const keyOf = (item: TranscriptionSummary) => item.id;

interface ListQuery {
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
}

function Empty({ query, library, total }: { query: ListQuery; library: Library; total: number }) {
    const t = useTranslation();
    if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    if (total > 0) {
        return (
            <EmptyState
                icon="Search"
                title={t('meetings.no_match', 'No meetings match your filters.')}
                actionLabel={t('mobile.recording.clear_filters', 'Clear filters')}
                onAction={() => library.update(DEFAULT_FILTER)}
            />
        );
    }
    // Deliberately actionless: the Start button is pinned ON SCREEN above
    // this list, and an empty state whose action duplicates it only asks
    // which button is the real one.
    return (
        <EmptyState
            icon="Mic"
            title={t('mobile.recording.empty_title', 'No meetings yet')}
            message={t(
                'mobile.recording.empty_message',
                'Record one in the room with the button above, or import audio you already have. You get a transcript with speakers, a summary and the action items.',
            )}
        />
    );
}

export function MeetingLibraryList({
    query,
    library,
    total,
    header,
}: {
    query: ListQuery;
    library: Library;
    total: number;
    header: ReactElement;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    // The person's pull only: a processing meeting polls every few seconds.
    const refresh = useUserRefresh(() => query.refetch());
    return (
        <FlatList<TranscriptionSummary>
            data={library.rows}
            keyExtractor={keyOf}
            ListHeaderComponent={header}
            contentContainerStyle={styles.list}
            refreshControl={
                <RefreshControl
                    refreshing={refresh.refreshing}
                    onRefresh={refresh.onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            extraData={library.selecting ? library.selected : null}
            renderItem={({ item }) =>
                library.selecting ? (
                    <TranscriptionRow
                        item={item}
                        selection={{ selected: library.selected.includes(item.id) }}
                        onPress={() => library.toggle(item)}
                    />
                ) : (
                    <TranscriptionRow item={item} onPress={() => router.push(`/recordings/${item.id}`)} />
                )
            }
            ListEmptyComponent={<Empty query={query} library={library} total={total} />}
        />
    );
}

/** The memory sheet's rows: one server-searched page, each row readable in full. */

import React from 'react';
import { FlatList, RefreshControl, StyleSheet } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, ListSkeleton } from '@/shared/ui';

import { MemorySheetRow } from './MemorySheetRow';
import type { useMemorySheetList } from '../hooks/queries';
import type { Memory } from '../model/types';

const makeStyles = (theme: Theme) => StyleSheet.create({ content: { paddingBottom: theme.spacing.xl } });

export function MemorySheetList({
    query,
    searching,
    onDelete,
}: {
    query: ReturnType<typeof useMemorySheetList>;
    searching: boolean;
    onDelete: (memory: Memory) => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const memories = query.data?.memories ?? [];
    const refresh = useUserRefresh(() => query.refetch());

    if (query.isLoading) return <ListSkeleton rows={5} />;
    if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    if (memories.length === 0) {
        return (
            <EmptyState
                icon="Cpu"
                title={searching ? 'Nothing matches that' : 'Nothing remembered yet'}
                message={
                    searching
                        ? 'Try a different word.'
                        : 'Bee Flow saves things you tell it to remember, and things it works out from your chats.'
                }
            />
        );
    }

    return (
        <FlatList
            data={memories}
            keyExtractor={(m) => m.id}
            refreshControl={
                <RefreshControl
                    refreshing={refresh.refreshing}
                    onRefresh={refresh.onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            contentContainerStyle={styles.content}
            renderItem={({ item }) => <MemorySheetRow memory={item} onDelete={() => onDelete(item)} />}
        />
    );
}

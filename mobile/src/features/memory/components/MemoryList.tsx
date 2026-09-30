/**
 * The Memory screen's rows, paged in as the person scrolls. Selection mode
 * starts with a long press; outside it, a tap reads a row in full.
 */

import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { QueryList } from '@/shared/patterns';
import { Spinner, Text } from '@/shared/ui';

import { MemoryRow } from './MemoryRow';
import type { useMemoryPages } from '../hooks/queries';
import type { Memory } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        matches: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
        footer: { paddingVertical: theme.spacing.lg },
    });

export function MemoryList({
    list,
    filtered,
    selected,
    onToggle,
    onDelete,
    onClearFilter,
}: {
    list: ReturnType<typeof useMemoryPages>;
    /** A search or a type is applied: an empty list is a miss. */
    filtered: boolean;
    selected: ReadonlySet<string>;
    onToggle: (id: string) => void;
    onDelete: (memory: Memory) => void;
    onClearFilter: () => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const memories = useMemo(() => (list.data?.pages ?? []).flatMap((page) => page.memories), [list.data]);
    const matchCount = list.data?.pages[0]?.total ?? memories.length;
    const selecting = selected.size > 0;

    return (
        <QueryList
            query={{
                // Nothing loaded yet stays undefined, so a failed first load is an error, not a stale list.
                data: list.data ? memories : undefined,
                isLoading: list.isLoading,
                isError: list.isError,
                error: list.error,
                refetch: list.refetch,
            }}
            keyExtractor={(memory) => memory.id}
            separator="none"
            renderItem={({ item }) => (
                <MemoryRow
                    memory={item}
                    expanded={expandedId === item.id}
                    selecting={selecting}
                    selected={selected.has(item.id)}
                    onPress={() => (selecting ? onToggle(item.id) : setExpandedId(expandedId === item.id ? null : item.id))}
                    onLongPress={() => onToggle(item.id)}
                    onDelete={() => onDelete(item)}
                />
            )}
            ListHeaderComponent={
                filtered ? (
                    <Text variant="caption" tone="tertiary" style={styles.matches}>
                        {matchCount === 1 ? '1 match' : `${matchCount} matches`}
                    </Text>
                ) : null
            }
            ListFooterComponent={
                list.isFetchingNextPage ? (
                    <View style={styles.footer}>
                        <Spinner />
                    </View>
                ) : null
            }
            listProps={{
                onEndReachedThreshold: 0.4,
                onEndReached: () => {
                    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
                },
            }}
            empty={{
                icon: 'Cpu',
                title: filtered ? 'Nothing matches that' : 'Nothing remembered yet',
                message: filtered
                    ? 'Try another word, or clear the filter.'
                    : 'Bee Flow writes things down as you chat — a preference, a project, how you like an answer — and reuses them later. Anything it stores will show up here, and you can delete it.',
                actionLabel: filtered ? 'Clear the filter' : undefined,
                onAction: filtered ? onClearFilter : undefined,
            }}
        />
    );
}

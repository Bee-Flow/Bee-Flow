/** Narrow the Indexed tab to one knowledge base. Only drawn when there is more than one. */

import React from 'react';
import { FlatList, StyleSheet } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { KnowledgeBase } from '@/features/knowledge';
import { Chip } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexGrow: 0 },
        content: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm, paddingBottom: theme.spacing.md },
    });

export function KbFilterChips({
    bases,
    selected,
    onSelect,
}: {
    bases: KnowledgeBase[];
    selected: string | null;
    onSelect: (kbId: string | null) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    if (bases.length <= 1) return null;

    return (
        <FlatList
            horizontal
            data={[null, ...bases]}
            keyExtractor={(kb, i) => kb?.id ?? `all-${i}`}
            showsHorizontalScrollIndicator={false}
            style={styles.row}
            contentContainerStyle={styles.content}
            renderItem={({ item }) => (
                <Chip
                    label={item?.name ?? 'All'}
                    selected={item ? selected === item.id : selected === null}
                    onPress={() => onSelect(item?.id ?? null)}
                />
            )}
        />
    );
}

/** The memory sheet's type filter: All, then the seven types the server writes. */

import React from 'react';
import { FlatList, StyleSheet } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip } from '@/shared/ui';

import { capitalise } from '../model/format';
import { MEMORY_TYPES } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm, paddingBottom: theme.spacing.md },
    });

export function SheetTypeChips({ type, onChange }: { type: string | null; onChange: (type: string | null) => void }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <FlatList
            horizontal
            data={['all', ...MEMORY_TYPES]}
            keyExtractor={(t) => t}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.content}
            renderItem={({ item }) => (
                <Chip
                    label={item === 'all' ? 'All' : capitalise(item)}
                    selected={item === 'all' ? type === null : type === item}
                    onPress={() => onChange(item === 'all' ? null : item)}
                />
            )}
        />
    );
}

/**
 * Filter by type, with a count on each chip. Only types that have rows get a
 * chip; the list is the handful of types the stats name, so a ScrollView.
 */

import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip } from '@/shared/ui';

import type { TypeChip } from '../model/format';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm, gap: theme.spacing.sm },
    });

export function MemoryTypeChips({
    chips,
    type,
    onChange,
}: {
    chips: TypeChip[];
    type: string | null;
    onChange: (type: string | null) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    if (chips.length === 0) return null;

    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content}>
            <Chip label="Everything" selected={type === null} onPress={() => onChange(null)} />
            {chips.map((chip) => (
                <Chip
                    key={chip.id}
                    label={`${chip.label} (${chip.count})`}
                    selected={type === chip.id}
                    onPress={() => onChange(type === chip.id ? null : chip.id)}
                />
            ))}
        </ScrollView>
    );
}

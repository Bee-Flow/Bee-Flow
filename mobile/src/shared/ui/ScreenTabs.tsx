/**
 * The pills under a screen's header that switch what the screen shows —
 * Sources or Chat, Indexed or Generated: two halves a phone has room for one
 * of at a time. FilterPills, inset to the screen's gutter.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { FilterPills, type FilterPillOption } from './FilterPills';

export function ScreenTabs<T extends string>({
    value,
    onChange,
    options,
}: {
    value: T;
    onChange: (next: T) => void;
    options: readonly FilterPillOption<T>[];
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            <FilterPills value={value} onChange={onChange} options={options} />
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
    });

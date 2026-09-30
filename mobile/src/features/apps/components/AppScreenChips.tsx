/** The app's own navigation, as chips — shown only when it has more than one screen. */

import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip } from '@/shared/ui';

import type { AppScreen } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { gap: theme.spacing.sm, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
    });

export function AppScreenChips({
    screens,
    selectedId,
    onSelect,
}: {
    screens: AppScreen[];
    selectedId: string | undefined;
    onSelect: (id: string) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    if (screens.length <= 1) return null;
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
            {screens.map((screen) => (
                <Chip
                    key={screen.id}
                    label={screen.name ?? 'Screen'}
                    selected={selectedId === screen.id}
                    onPress={() => onSelect(screen.id)}
                />
            ))}
        </ScrollView>
    );
}

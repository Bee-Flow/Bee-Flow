/**
 * How many results, as a live region: after typing, the only feedback a
 * screen-reader user gets is this line.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ line: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xs } });

export function ResultCount({ total, searching }: { total: number; searching: boolean }) {
    const styles = useThemedStyles(makeStyles);
    const idle = searching ? 'Searching…' : 'No matches';
    return (
        <View accessibilityLiveRegion="polite" style={styles.line}>
            <Text variant="label" tone="tertiary">
                {total === 0 ? idle : `${total} result${total === 1 ? '' : 's'}`}
            </Text>
        </View>
    );
}

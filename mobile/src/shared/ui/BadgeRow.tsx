/**
 * A fact whose value is a mark rather than text: the label on the left, a
 * Badge (or a Spinner while the answer is still coming) on the right.
 *
 * InfoRow's sibling, for a Group. The settings, organisation, usage and admin
 * screens each drew this row by hand — the same flex row, touch height and
 * padding, nine times.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Text } from './Text';

export function BadgeRow({
    label,
    leading,
    children,
}: {
    label: string;
    /** An icon before the label. */
    leading?: ReactNode;
    /** The mark on the right. */
    children: ReactNode;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            {leading}
            <Text variant="body" style={styles.label}>
                {label}
            </Text>
            {children}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            minHeight: theme.minTouch,
        },
        label: { flex: 1 },
    });

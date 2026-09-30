/** One label/value line in a run's facts card. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.md,
            minHeight: 28,
        },
    });

export function RunFact({
    label,
    text,
    value,
}: {
    label: string;
    text?: string;
    value?: React.ReactNode;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            <Text variant="caption" tone="tertiary">
                {label}
            </Text>
            {value ?? (
                <Text variant="caption" weight="medium" numberOfLines={1}>
                    {text}
                </Text>
            )}
        </View>
    );
}

/**
 * The placeholder a rich block shows while its fence is still streaming in —
 * the web's BlockLoading: a spinner and a line saying what is being built, on
 * the tertiary surface.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { perTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Spinner, Text } from '@/shared/ui';

const sheet = perTheme((theme: Theme) =>
    StyleSheet.create({
        box: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing[3],
            padding: theme.spacing[4],
            borderRadius: theme.radii.md,
            backgroundColor: theme.colors.bgTertiary,
        },
    }),
);

export function BlockLoading({ label }: { label: string }) {
    const styles = useThemedStyles(sheet);
    return (
        <View style={styles.box} accessibilityLiveRegion="polite">
            <Spinner />
            <Text variant="caption" tone="tertiary">
                {label}
            </Text>
        </View>
    );
}

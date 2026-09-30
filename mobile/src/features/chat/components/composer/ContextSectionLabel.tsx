/** A section heading in the ＋ sheet, with an optional line under it. */

import React from 'react';
import { View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    label: { gap: 2, marginBottom: theme.spacing.sm },
});

export function ContextSectionLabel({ children, hint }: { children: string; hint?: string }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.label}>
            <Text variant="label" tone="tertiary">
                {children.toUpperCase()}
            </Text>
            {hint ? (
                <Text variant="caption" tone="tertiary">
                    {hint}
                </Text>
            ) : null}
        </View>
    );
}

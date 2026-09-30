/**
 * A titled group. `action` is the trailing affordance (usually "See all").
 * Titles are sentence case: this is a product, not a filing cabinet.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Text } from './Text';

export function Section({
    title,
    subtitle,
    action,
    children,
    style,
}: {
    title?: string;
    subtitle?: string;
    action?: ReactNode;
    children: ReactNode;
    style?: StyleProp<ViewStyle>;
}) {
    const themed = useThemedStyles(makeStyles);
    return (
        <View style={[themed.column, style]}>
            {title || action ? (
                <View style={styles.sectionHeader}>
                    <View style={styles.sectionTitles}>
                        {title ? <Text variant="heading">{title}</Text> : null}
                        {subtitle ? (
                            <Text variant="caption" tone="tertiary">
                                {subtitle}
                            </Text>
                        ) : null}
                    </View>
                    {action}
                </View>
            ) : null}
            {children}
        </View>
    );
}

const styles = StyleSheet.create({
    sectionHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
    sectionTitles: { flex: 1, gap: 2 },
});

const makeStyles = (theme: Theme) => ({ column: { gap: theme.spacing.md } satisfies ViewStyle });

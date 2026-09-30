/** The frame a generated file sits in: an icon tile, its name and what is known about it, and actions. */

import React, { type ReactNode } from 'react';
import { View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text, type IconName } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    card: {
        marginTop: theme.spacing.md,
        padding: theme.spacing.md,
        gap: theme.spacing.sm,
        borderRadius: theme.radii.lg,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgTertiary,
    },
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing.md },
    tile: {
        width: 36,
        height: 36,
        borderRadius: theme.radii.md,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        backgroundColor: theme.colors.bgSecondary,
    },
    words: { flex: 1, gap: theme.spacing.xxs },
    actions: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: theme.spacing.sm },
});

export function MediaCardFrame({
    icon,
    title,
    meta,
    children,
}: {
    icon: IconName;
    title: string;
    meta?: string;
    children?: ReactNode;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.card}>
            <View style={styles.head}>
                <View style={styles.tile}>
                    <Icon name={icon} size={18} color={theme.colors.textSecondary} />
                </View>
                <View style={styles.words}>
                    <Text variant="body" weight="medium" numberOfLines={1}>
                        {title}
                    </Text>
                    {meta ? (
                        <Text variant="caption" tone="secondary" numberOfLines={1}>
                            {meta}
                        </Text>
                    ) : null}
                </View>
            </View>
            {children ? <View style={styles.actions}>{children}</View> : null}
        </View>
    );
}

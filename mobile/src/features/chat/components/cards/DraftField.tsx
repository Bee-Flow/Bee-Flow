/** One labelled line of a draft — "To:", "Subject:" — or an icon and a value. */

import React from 'react';
import { View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text, type IconName } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row' as const, alignItems: 'flex-start' as const, gap: theme.spacing.sm },
    label: { width: 64 },
    value: { flex: 1 },
});

export function DraftField({ label, icon, value, strong = false }: { label?: string; icon?: IconName; value: string; strong?: boolean }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    if (!value) return null;
    return (
        <View style={styles.row}>
            {icon ? <Icon name={icon} size={14} color={theme.colors.textTertiary} /> : null}
            {label ? (
                <Text variant="caption" tone="tertiary" weight="medium" style={styles.label}>
                    {label}
                </Text>
            ) : null}
            <Text variant="caption" weight={strong ? 'medium' : 'regular'} style={styles.value} selectable>
                {value}
            </Text>
        </View>
    );
}

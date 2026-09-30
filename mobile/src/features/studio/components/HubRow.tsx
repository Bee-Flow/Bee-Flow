/**
 * One row of the Studio hub's cards: a glyph, a name, an optional count, and
 * a chevron — or, for a locked section, a lock and the reason under the name.
 * A locked row is a signpost, never a door: it announces itself disabled and
 * says what would open it.
 *
 * The name says enough on its own (the web's Studio rail draws no
 * descriptions either), so the description is read out as the row's hint
 * rather than drawn: one line per row keeps the hub light.
 *
 * The Workspace links and the builder sections (SectionRow) both draw this,
 * so the two groups read as one surface.
 */

import React from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text, type IconName } from '@/shared/ui';

export interface HubRowProps {
    icon: IconName;
    iconColor?: string;
    label: string;
    /** Read out as the hint; not drawn. */
    description?: string;
    /** The count as shown ("4", "99+"), or null for none. */
    count?: string | null;
    /** Why the row is closed, in words; a locked row does not press. */
    lockHint?: string | null;
    onPress: () => void;
    testID?: string;
}

export function HubRow({ icon, iconColor, label, description, count, lockHint, onPress, testID }: HubRowProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const locked = Boolean(lockHint);
    const shown = locked ? null : count;
    return (
        <Pressable
            testID={testID}
            onPress={locked ? undefined : onPress}
            accessibilityRole="button"
            accessibilityLabel={shown ? `${label}, ${shown}` : label}
            accessibilityHint={lockHint ?? description}
            accessibilityState={{ disabled: locked }}
            style={({ pressed }) => [styles.row, locked ? styles.locked : pressed ? styles.pressed : null]}
        >
            <Icon name={icon} size={18} color={iconColor ?? theme.colors.textSecondary} />
            <View style={styles.words}>
                <Text variant="body" weight="medium" numberOfLines={1}>
                    {label}
                </Text>
                {lockHint ? (
                    <Text variant="label" tone="tertiary" numberOfLines={2}>
                        {lockHint}
                    </Text>
                ) : null}
            </View>
            {shown ? (
                <Text variant="caption" tone="tertiary" style={styles.count}>
                    {shown}
                </Text>
            ) : null}
            <Icon name={locked ? 'Lock' : 'ChevronRight'} size={locked ? 14 : 16} color={theme.colors.textTertiary} />
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[3],
        minHeight: 48,
        paddingHorizontal: theme.spacing[3.5],
        paddingVertical: theme.spacing[2],
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    locked: { opacity: 0.6 } satisfies ViewStyle,
    words: { flex: 1, gap: 2 } satisfies ViewStyle,
    count: { fontVariant: ['tabular-nums'] } satisfies TextStyle,
});

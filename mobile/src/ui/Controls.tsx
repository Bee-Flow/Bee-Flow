/**
 * The three controls the kit was missing: a themed switch, a switch row and a
 * radio row.
 *
 * These lived in features/settings/components/Controls.tsx, built there
 * because settings was the only consumer at the time and the author was not
 * allowed to touch src/ui. Six other screens then needed a switch, could not
 * import across feature folders either, and so hand-rolled React Native's raw
 * `Switch` with the theme colours passed in by hand at each call site — five
 * times in features/skills, app/skills, app/chat and app/automations. Four of
 * those five agreed on the colours; the automation detail screen's thumb was
 * `bgCard` rather than `accentPrimaryFg`, and the chat details screen passed no
 * thumbColor at all and got Android's stock green. Three paint jobs for one
 * control, on screens a person moves between.
 *
 * Accessibility is the whole reason the rows are components and not inline
 * JSX: a switch needs `accessibilityRole="switch"` and a checked state, a radio
 * needs `accessibilityRole="radio"` and a selected state, and both need the
 * whole row — not just the control — to be the touch target. Getting that right
 * once beats getting it wrong in fourteen screens.
 */

import { Feather } from '@expo/vector-icons';
import React, { type ReactNode } from 'react';
import { Pressable, Switch as RNSwitch, View } from 'react-native';

import { Text } from './Text';
import { useTheme } from '../theme/ThemeProvider';


/**
 * React Native's Switch, painted in the current theme.
 *
 * A bare RN Switch renders in Android's own accent, which is the one colour on
 * screen that does not move when the user changes theme — and this app ships
 * eight of them. The colours are here rather than at fourteen call sites so
 * that stays true by construction.
 */
export function Switch({
    value,
    onValueChange,
    disabled = false,
    decorative = false,
    accessibilityLabel,
    testID,
}: {
    value: boolean;
    onValueChange: (next: boolean) => void;
    disabled?: boolean;
    /**
     * Set when the row around the switch already carries the switch role and
     * label. Without it a screen reader reaches the row, announces it, then
     * reaches the switch inside and announces the same thing again.
     */
    decorative?: boolean;
    /** Required unless `decorative` — an unlabelled switch announces nothing. */
    accessibilityLabel?: string;
    testID?: string;
}) {
    const theme = useTheme();
    return (
        <RNSwitch
            testID={testID}
            value={value}
            onValueChange={onValueChange}
            disabled={disabled}
            {...(decorative
                ? {
                      accessibilityElementsHidden: true,
                      importantForAccessibility: 'no-hide-descendants' as const,
                  }
                : {
                      accessibilityLabel,
                      accessibilityState: { checked: value, disabled },
                  })}
            trackColor={{ false: theme.colors.bgTertiary, true: theme.colors.accentPrimary }}
            thumbColor={value ? theme.colors.accentPrimaryFg : theme.colors.textMuted}
        />
    );
}

export function ToggleRow({
    label,
    description,
    value,
    onValueChange,
    disabled = false,
    /** Shown instead of the switch while a save is in flight is NOT done here:
     *  the switch stays interactive and the screen shows the failure inline. */
    icon,
    gutter = true,
    testID,
}: {
    label: string;
    description?: string;
    value: boolean;
    onValueChange: (next: boolean) => void;
    disabled?: boolean;
    icon?: ReactNode;
    /**
     * Off for a row inside a container that already has horizontal padding —
     * a sheet's column, say. The settings screens want the gutter because
     * their rows run edge to edge inside an unpadded Group.
     */
    gutter?: boolean;
    testID?: string;
}) {
    const theme = useTheme();

    return (
        <Pressable
            testID={testID}
            // The row toggles, not just the switch — a 44px switch inside a
            // 64px row leaves most of the row dead to the touch otherwise.
            onPress={() => !disabled && onValueChange(!value)}
            disabled={disabled}
            accessibilityRole="switch"
            accessibilityLabel={label}
            accessibilityHint={description}
            accessibilityState={{ checked: value, disabled }}
            style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                minHeight: theme.minTouch,
                paddingHorizontal: gutter ? theme.spacing.lg : 0,
                paddingVertical: theme.spacing.md,
                gap: theme.spacing.md,
                opacity: disabled ? 0.5 : 1,
                backgroundColor: pressed ? theme.colors.itemHoverBg : 'transparent',
            })}
        >
            {icon}
            <View style={{ flex: 1, gap: 2 }}>
                <Text variant="body">{label}</Text>
                {description ? (
                    <Text variant="caption" tone="tertiary">
                        {description}
                    </Text>
                ) : null}
            </View>
            <Switch value={value} onValueChange={onValueChange} disabled={disabled} decorative />
        </Pressable>
    );
}

/**
 * One option in a mutually exclusive set.
 *
 * A check mark rather than a filled circle: Android's Material radio is a
 * separate control that fights the row for the touch target, and a check on
 * the trailing edge is what every list-of-choices in this app already looks
 * like.
 */
export function OptionRow({
    label,
    description,
    selected,
    onPress,
    leading,
    disabled = false,
    testID,
}: {
    label: string;
    description?: string;
    selected: boolean;
    onPress: () => void;
    leading?: ReactNode;
    disabled?: boolean;
    testID?: string;
}) {
    const theme = useTheme();

    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityHint={description}
            accessibilityState={{ selected, disabled }}
            style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                minHeight: theme.minTouch,
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.md,
                gap: theme.spacing.md,
                opacity: disabled ? 0.5 : 1,
                backgroundColor: pressed ? theme.colors.itemHoverBg : 'transparent',
            })}
        >
            {leading}
            <View style={{ flex: 1, gap: 2 }}>
                <Text variant="body">{label}</Text>
                {description ? (
                    <Text variant="caption" tone="tertiary">
                        {description}
                    </Text>
                ) : null}
            </View>
            {selected ? (
                <Feather name="check" size={18} color={theme.colors.accentPrimary} />
            ) : (
                // A fixed-width spacer keeps every label on the same left edge
                // whether or not it is the selected one.
                <View style={{ width: 18 }} />
            )}
        </Pressable>
    );
}

/**
 * The card: the one place that knows how a surface is painted — radius,
 * hairline, fill and elevation — so no screen has to care which theme it is
 * drawn in. Tappable when given `onPress`.
 */

import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

export interface CardProps {
    children: ReactNode;
    /** Makes the whole card a button. Adds the pressed state and a11y role. */
    onPress?: () => void;
    onLongPress?: () => void;
    padded?: boolean;
    /**
     * Raises it further off the page (the web's `--shadow-md`); every card
     * already wears `--shadow-card`. Use sparingly — everything raised is
     * nothing raised.
     */
    elevated?: boolean;
    style?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
    /**
     * What tapping it does, when the label alone does not say. A tappable Card
     * has no affordance of its own — no chevron, no button chrome — so for a
     * screen reader the hint is the only thing that distinguishes it from a
     * decorative box.
     */
    accessibilityHint?: string;
    testID?: string;
}

export function Card({
    children,
    onPress,
    onLongPress,
    padded = true,
    elevated = false,
    style,
    accessibilityLabel,
    accessibilityHint,
    testID,
}: CardProps) {
    const styles = useThemedStyles(makeStyles);
    const surface = [styles.surface, padded ? styles.padded : null, elevated ? styles.elevated : null];

    // Was a blur plus an OPAQUE absoluteFill over it, for the glass themes.
    // The blur never rendered on Android and the fill painted over the Card's
    // own press state, so a tappable card gave no feedback in two of the eight
    // themes. Both are gone with the themes that needed them.
    if (!onPress && !onLongPress) {
        return (
            <View testID={testID} style={[surface, style]}>
                {children}
            </View>
        );
    }

    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={accessibilityHint}
            style={({ pressed }) => [surface, pressed ? styles.pressed : null, style]}
        >
            {children}
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    surface: {
        // 12, the web's `rounded-xl` card (DashCard, StatTile, DataTable) —
        // it was 16 here, one step rounder than every card it mirrors.
        borderRadius: theme.radii.md,
        borderWidth: StyleSheet.hairlineWidth,
        // `cardBorder`: on obsidian, bgCard and bgSecondary are the same
        // value, so a hairline at 6% alpha left the card an invisible
        // rectangle. Derived rather than fixed, because that sameness is a
        // faithful port of the web app's index.css and the token must not move.
        borderColor: theme.colors.cardBorder,
        backgroundColor: theme.colors.bgCard,
        overflow: 'hidden',
        // The web's `--shadow-card`, per theme: a soft drop on most, a 1px
        // ring on obsidian and high-contrast.
        boxShadow: theme.shadows.card,
    } satisfies ViewStyle,
    padded: { padding: theme.spacing.lg } satisfies ViewStyle,
    elevated: { boxShadow: theme.shadows.md } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.bgCardHover } satisfies ViewStyle,
});

/**
 * Buttons.
 *
 * Four variants, no more. The web app has drifted to a dozen button shapes;
 * this deliberately does not, because on a phone the only distinctions that
 * survive at thumb size are "the main action", "another action", "a quiet
 * action" and "this will destroy something".
 *
 * Two rules baked in rather than left to call sites:
 *   - Minimum 48dp height, always. Android's own guidance, and the reason the
 *     web app's 32px controls cannot be ported verbatim.
 *   - Haptics on press for primary and destructive. A phone confirms with
 *     touch; a button that does something irreversible should be felt.
 */

import * as Haptics from 'expo-haptics';
import React, { type ReactNode } from 'react';
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import { Text } from './Text';
import { useTheme } from '../theme/ThemeProvider';


export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps {
    label: string;
    onPress: () => void;
    variant?: ButtonVariant;
    size?: ButtonSize;
    disabled?: boolean;
    loading?: boolean;
    /** Rendered before the label. Pass an icon element, not a name. */
    icon?: ReactNode;
    /** Fills the available width. Default for primary actions in a form. */
    fullWidth?: boolean;
    style?: StyleProp<ViewStyle>;
    accessibilityHint?: string;
    testID?: string;
}

export function Button({
    label,
    onPress,
    variant = 'primary',
    size = 'md',
    disabled = false,
    loading = false,
    icon,
    fullWidth = false,
    style,
    accessibilityHint,
    testID,
}: ButtonProps) {
    const theme = useTheme();
    const inert = disabled || loading;

    const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
        primary: {
            // `accentFill`, not `accentPrimary` — see deriveContrast in
            // ThemeProvider. The raw brand accent is an 11%-saturation grey,
            // and a grey slab reads as a disabled control however well its
            // label contrasts.
            bg: theme.colors.accentFill,
            fg: theme.colors.accentFillFg,
            border: 'transparent',
        },
        secondary: {
            bg: theme.colors.bgTertiary,
            fg: theme.colors.textPrimary,
            border: theme.colors.borderDefault,
        },
        ghost: { bg: 'transparent', fg: theme.colors.textSecondary, border: 'transparent' },
        destructive: { bg: theme.colors.error, fg: '#ffffff', border: 'transparent' },
    };
    const colors = palette[variant];

    const handlePress = () => {
        if (inert) return;
        if (variant === 'primary') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        if (variant === 'destructive') {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        }
        onPress();
    };

    return (
        <Pressable
            testID={testID}
            onPress={handlePress}
            disabled={inert}
            accessibilityRole="button"
            accessibilityState={{ disabled: inert, busy: loading }}
            accessibilityHint={accessibilityHint}
            style={({ pressed }) => [
                styles.base,
                {
                    minHeight: size === 'lg' ? 56 : theme.minTouch,
                    paddingHorizontal: size === 'lg' ? theme.spacing.xl : theme.spacing.lg,
                    borderRadius: theme.radii.md,
                    backgroundColor: colors.bg,
                    borderColor: colors.border,
                    borderWidth: variant === 'secondary' ? StyleSheet.hairlineWidth : 0,
                    // Opacity rather than a muted palette: a disabled button has
                    // to stay recognisably the same button, or people hunt for
                    // the one that vanished.
                    opacity: inert ? 0.45 : pressed ? 0.85 : 1,
                },
                fullWidth ? styles.fullWidth : null,
                style,
            ]}
        >
            {loading ? (
                <ActivityIndicator color={colors.fg} size="small" />
            ) : (
                <View style={styles.row}>
                    {icon ? <View style={{ marginRight: theme.spacing.sm }}>{icon}</View> : null}
                    <Text
                        variant="subheading"
                        style={{ color: colors.fg }}
                        numberOfLines={1}
                        maxFontSizeMultiplier={1.3}
                    >
                        {label}
                    </Text>
                </View>
            )}
        </Pressable>
    );
}

/**
 * A square, icon-only button. Separate component rather than a Button prop
 * because the sizing rules are different: an icon button is square and its
 * label lives in accessibilityLabel, which is not optional.
 */
export function IconButton({
    icon,
    onPress,
    accessibilityLabel,
    disabled = false,
    tone = 'default',
    style,
    testID,
}: {
    icon: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    disabled?: boolean;
    tone?: 'default' | 'accent' | 'destructive';
    style?: StyleProp<ViewStyle>;
    testID?: string;
}) {
    const theme = useTheme();
    const bg =
        tone === 'accent'
            ? theme.colors.itemActiveBg
            : tone === 'destructive'
              ? 'transparent'
              : 'transparent';

    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled }}
            hitSlop={theme.hitSlop}
            style={({ pressed }) => [
                {
                    width: theme.minTouch,
                    height: theme.minTouch,
                    borderRadius: theme.radii.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: pressed ? theme.colors.itemHoverBg : bg,
                    opacity: disabled ? 0.4 : 1,
                },
                style,
            ]}
        >
            {icon}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    base: { alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
    row: { flexDirection: 'row', alignItems: 'center' },
    fullWidth: { alignSelf: 'stretch' },
});

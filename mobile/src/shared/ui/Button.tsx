/**
 * Buttons: the web's six variants (agent-hub/src/components/shared/Button.tsx)
 * in the web's recipes, at a phone's touch size.
 *
 *   primary    the ACCENT recipe — `accentPrimary` under `accentPrimaryFg`,
 *              the web's PRIMARY_ACTION_STYLE and its 428 accent-filled
 *              buttons. Not an ink fill: the web rejected ink-filled buttons
 *              (StudioSectionHeader.jsx, "Primary actions"), so a grey accent
 *              paints a grey button with black text here too.
 *   secondary  bgTertiary with a default border.
 *   ghost      no fill, secondary text.
 *   success    a solid success fill; its label is readableForeground(fill),
 *              the web's rule for text on a colour.
 *   danger     TINTED, not solid: the error colour at 10% with a 30% border
 *              and the error ink as text (`rose-600/10 … text-rose-400`).
 *   warning    the same tinted recipe in the warning colour.
 *
 * Sizes follow the web's sm/md/lg (semibold label; `rounded-md` on sm and
 * `rounded-lg` on md/lg, so sm's corner is three quarters of the others' —
 * 6 against 8 — and both follow the org's roundness dial) but never drop
 * below a thumb: `md` is 44dp tall and `sm` 36dp, and hitSlop extends both to
 * the 48dp touch target.
 *
 * Haptics on press for primary and danger. A phone confirms with touch; a
 * button that does something irreversible should be felt.
 */

import * as Haptics from 'expo-haptics';
import React, { type ReactNode } from 'react';
import {
    ActivityIndicator,
    Pressable,
    View,
    type StyleProp,
    type TextStyle,
    type ViewStyle,
} from 'react-native';

import { readableForeground } from '@/core/theme/color';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { Palette } from '@/core/theme/tokens';

import { Icon, type IconName } from './icons/Icon';
import { Text } from './Text';
import { tint } from './tint';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'success' | 'danger' | 'warning';
export type ButtonSize = 'sm' | 'md' | 'lg';

export const BUTTON_VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'ghost', 'success', 'danger', 'warning'];
const SIZES: readonly ButtonSize[] = ['sm', 'md', 'lg'];

export interface ButtonProps {
    label: string;
    onPress: () => void;
    variant?: ButtonVariant;
    size?: ButtonSize;
    disabled?: boolean;
    loading?: boolean;
    /** Rendered before the label. Pass an element; or `iconName` for a glyph in the label's colour. */
    icon?: ReactNode;
    /** A Lucide glyph before the label, drawn in the variant's text colour. */
    iconName?: IconName;
    /** Fills the available width. Default for primary actions in a form. */
    fullWidth?: boolean;
    /** The web's pill call to action (EmptyState, StatusActionPill): full radius, wider gutter. */
    pill?: boolean;
    style?: StyleProp<ViewStyle>;
    accessibilityHint?: string;
    testID?: string;
}

/** A variant's fill, label and border colours — the web's recipe per variant. */
export function buttonColors(colors: Palette, variant: ButtonVariant): { bg: string; fg: string; border: string } {
    switch (variant) {
        case 'secondary':
            return { bg: colors.bgTertiary, fg: colors.textPrimary, border: colors.borderDefault };
        case 'ghost':
            return { bg: 'transparent', fg: colors.textSecondary, border: 'transparent' };
        case 'success':
            return { bg: colors.success, fg: readableForeground(colors.success), border: 'transparent' };
        case 'danger':
            return { bg: tint(colors.error, 10), fg: colors.errorInk, border: tint(colors.error, 30) };
        case 'warning':
            return { bg: tint(colors.warning, 10), fg: colors.warningInk, border: tint(colors.warning, 30) };
        default:
            return { bg: colors.accentPrimary, fg: colors.accentPrimaryFg, border: 'transparent' };
    }
}

/** Height and padding per size; the hitSlop tops each one up to 48dp. */
const SIZE_METRICS: Record<ButtonSize, { minHeight: number; pad: 2.5 | 3.5 | 5; gap: 1 | 1.5 | 2 }> = {
    sm: { minHeight: 36, pad: 2.5, gap: 1 },
    md: { minHeight: 44, pad: 3.5, gap: 1.5 },
    lg: { minHeight: 48, pad: 5, gap: 2 },
};

/** The corner per size: the web's rounded-md (sm) is three quarters of its rounded-lg (md, lg). */
export function buttonRadius(size: ButtonSize, lg: number): number {
    return size === 'sm' ? Math.round((lg * 3) / 4) : lg;
}

export function buttonHitSlop(size: ButtonSize, minTouch: number) {
    const v = Math.max(0, Math.ceil((minTouch - SIZE_METRICS[size].minHeight) / 2));
    return { top: v, bottom: v, left: 4, right: 4 };
}

export function Button({
    label,
    onPress,
    variant = 'primary',
    size = 'md',
    disabled = false,
    loading = false,
    icon,
    iconName,
    fullWidth = false,
    pill = false,
    style,
    accessibilityHint,
    testID,
}: ButtonProps) {
    const styles = useThemedStyles(makeStyles);
    const inert = disabled || loading;
    const fg = styles.label[variant].color as string;

    const handlePress = () => {
        if (inert) return;
        if (variant === 'primary') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        if (variant === 'danger') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        onPress();
    };

    return (
        <Pressable
            testID={testID}
            onPress={handlePress}
            disabled={inert}
            hitSlop={styles.hitSlop[size]}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: inert, busy: loading }}
            accessibilityHint={accessibilityHint}
            style={({ pressed }) => [
                styles.base,
                styles.size[size],
                styles.surface[variant],
                fullWidth ? styles.fullWidth : null,
                pill ? styles.pill : null,
                // Opacity rather than a muted palette: a disabled button has to
                // stay recognisably the same button, or people hunt for the one
                // that vanished.
                inert ? styles.inert : pressed ? styles.pressed : null,
                style,
            ]}
        >
            {loading ? (
                <ActivityIndicator color={fg} size="small" />
            ) : (
                <View style={[styles.row, styles.gap[size]]}>
                    {iconName ? <Icon name={iconName} size={size === 'sm' ? 14 : 16} color={fg} /> : null}
                    {icon}
                    <Text
                        variant={size === 'sm' ? 'caption' : 'subheading'}
                        weight="semibold"
                        style={styles.label[variant]}
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

function byKey<K extends string, V>(keys: readonly K[], value: (key: K) => V): Record<K, V> {
    return Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, V>;
}

const makeStyles = (theme: Theme) => ({
    base: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radii.sm,
        borderWidth: 1,
    } satisfies ViewStyle,
    row: { flexDirection: 'row', alignItems: 'center' } satisfies ViewStyle,
    fullWidth: { alignSelf: 'stretch' } satisfies ViewStyle,
    pill: { borderRadius: theme.radii.pill, paddingHorizontal: theme.spacing[5] } satisfies ViewStyle,
    pressed: { opacity: 0.85 } satisfies ViewStyle,
    inert: { opacity: 0.45 } satisfies ViewStyle,
    size: byKey(SIZES, (size): ViewStyle => ({
        minHeight: SIZE_METRICS[size].minHeight,
        paddingHorizontal: theme.spacing[SIZE_METRICS[size].pad],
        borderRadius: buttonRadius(size, theme.radii.sm),
    })),
    gap: byKey(SIZES, (size): ViewStyle => ({ gap: theme.spacing[SIZE_METRICS[size].gap] })),
    hitSlop: byKey(SIZES, (size) => buttonHitSlop(size, theme.minTouch)),
    surface: byKey(BUTTON_VARIANTS, (variant): ViewStyle => {
        const { bg, border } = buttonColors(theme.colors, variant);
        return { backgroundColor: bg, borderColor: border };
    }),
    label: byKey(BUTTON_VARIANTS, (variant): TextStyle => ({ color: buttonColors(theme.colors, variant).fg })),
});

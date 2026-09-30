/**
 * A selectable pill — filters, model tiers, label pickers. The web's
 * FilterPill (shared/FilterPills.jsx), at a phone's touch height.
 *
 * Its recipe, per tone:
 *   neutral  idle = hairline border + secondary text; selected = the accent
 *            at 14% with an accent edge and accent words. Never an ink fill:
 *            the web rejected black-block active pills (2026-09-03).
 *   success · warning · error
 *            the tone's raw colour as the edge and its ink as the words, with
 *            the raw colour at 14% underneath once selected — the status keeps
 *            carrying the meaning.
 *   muted    tertiary words on a hairline; selected fills with bgTertiary.
 *
 * A `count` follows the label; `undefined`/`null` renders nothing, so a filter
 * nobody has counted yet never says 0 (an explicit 0 does render).
 */

import React from 'react';
import { Pressable, Text as RNText, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { Palette } from '@/core/theme/tokens';

import { Text } from './Text';
import { tint } from './tint';
import { tonePair } from './tones';

export type ChipTone = 'neutral' | 'success' | 'warning' | 'error' | 'muted';

const CHIP_TONES: readonly ChipTone[] = ['neutral', 'success', 'warning', 'error', 'muted'];

export interface PillColors {
    background: string;
    border: string;
    text: string;
    count: string;
}

/** The four colours of a pill in a tone and state (the web's `pillStyle`). */
export function pillColors(colors: Palette, tone: ChipTone, active: boolean): PillColors {
    if (tone === 'success' || tone === 'warning' || tone === 'error') {
        const { raw, ink } = tonePair(colors, tone);
        return { background: active ? tint(raw, 14) : 'transparent', border: raw, text: ink, count: ink };
    }
    if (tone === 'muted') {
        const text = colors.textTertiary;
        return { background: active ? colors.bgTertiary : 'transparent', border: colors.borderDefault, text, count: text };
    }
    return {
        background: active ? tint(colors.accentPrimary, 14) : 'transparent',
        border: active ? colors.accentText : colors.borderDefault,
        text: active ? colors.accentText : colors.textSecondary,
        count: active ? colors.accentText : colors.textTertiary,
    };
}

export interface ChipProps {
    label: string;
    selected?: boolean;
    onPress?: () => void;
    icon?: React.ReactNode;
    /** Shown after the label in tabular figures. Nullish renders nothing. */
    count?: number | null;
    tone?: ChipTone;
    disabled?: boolean;
    style?: StyleProp<ViewStyle>;
    /**
     * What tapping it does, when that is not obvious from the label.
     *
     * A chip is a label in a rounded box, so a screen reader announces
     * "Contracts, button, selected" whether tapping it selects, deselects or
     * removes. For a chip that REMOVES something the difference is the whole
     * meaning, and the little × is invisible to TalkBack.
     */
    accessibilityHint?: string;
    testID?: string;
}

export function Chip({
    label,
    selected = false,
    onPress,
    icon,
    count,
    tone = 'neutral',
    disabled = false,
    style,
    accessibilityHint,
    testID,
}: ChipProps) {
    const styles = useThemedStyles(makeStyles);
    const state = `${tone}_${selected ? 'on' : 'off'}`;
    const hasCount = count !== undefined && count !== null;
    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            disabled={!onPress || disabled}
            hitSlop={styles.hitSlop}
            accessibilityRole={onPress ? 'button' : undefined}
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={hasCount ? `${label}, ${count}` : label}
            accessibilityHint={accessibilityHint}
            style={({ pressed }) => [
                styles.pill,
                styles.surface[state],
                pressed && !selected ? styles.pressed : null,
                disabled ? styles.disabled : null,
                style,
            ]}
        >
            {icon}
            <Text variant="caption" weight="medium" style={styles.text[state]} numberOfLines={1}>
                {label}
                {hasCount ? <RNText style={styles.count[state]}>{` ${count}`}</RNText> : null}
            </Text>
        </Pressable>
    );
}

function eachState<V>(make: (tone: ChipTone, active: boolean) => V): Record<string, V> {
    const out: Record<string, V> = {};
    for (const tone of CHIP_TONES) {
        out[`${tone}_on`] = make(tone, true);
        out[`${tone}_off`] = make(tone, false);
    }
    return out;
}

const makeStyles = (theme: Theme) => ({
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[1],
        minHeight: 32,
        paddingHorizontal: theme.spacing[2.5],
        borderRadius: theme.radii.pill,
        borderWidth: 1,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    disabled: { opacity: 0.5 } satisfies ViewStyle,
    hitSlop: { top: 8, bottom: 8, left: 2, right: 2 },
    surface: eachState((tone, active): ViewStyle => {
        const c = pillColors(theme.colors, tone, active);
        return { backgroundColor: c.background, borderColor: c.border };
    }),
    text: eachState((tone, active): TextStyle => ({ color: pillColors(theme.colors, tone, active).text })),
    count: eachState((tone, active): TextStyle => ({
        color: pillColors(theme.colors, tone, active).count,
        fontVariant: ['tabular-nums'],
    })),
});

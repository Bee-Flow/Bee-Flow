/**
 * Themed text.
 *
 * Every string in the app goes through here rather than through RN's <Text>,
 * for three reasons that each caused a visible bug in the web app at some
 * point and are cheap to prevent up front:
 *
 *   - Colour. RN's default text colour is black, so a component that forgets to
 *     set one is invisible on the dark theme and fine on the light one — a bug
 *     that only half the reviewers can see.
 *   - Scale. `variant` is the type scale from core/theme/fonts.ts (title 22
 *     semibold, heading 18, subheading 15 semibold, body 15, caption 13,
 *     label 11, code 13 mono — the web's sizes, a step up for a phone where
 *     the web's 12/14 would be read at arm's length); there is no prop for
 *     an arbitrary font size, because "just this one at 14" is how a type
 *     system dies.
 *   - Font scaling. Android users can set system font size to 130%; text that
 *     ignores it fails accessibility, and text that follows it without a cap
 *     destroys dense layouts. `maxFontSizeMultiplier` splits the difference at
 *     1.4 for body copy and 1.2 for chrome.
 */

import React from 'react';
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import type { TYPE } from '@/core/theme/tokens';

export type TextVariant = keyof typeof TYPE;

/**
 * Semantic colour roles. Named by meaning so a theme swap cannot break them.
 *
 * There is deliberately no `muted`. It mapped to `textMuted`, which is #64748b
 * in both default themes and lands at 3.6:1 on the dark card and 4.4:1 on the
 * light one — under AA either way — and 242 call sites had reached for it
 * against 6 for `tertiary`, so nearly every subtitle, timestamp, footnote and
 * empty-state sentence in the app was below the line. Deleting the union
 * member rather than recolouring the call sites is the point: the compiler now
 * refuses the mistake instead of a reviewer having to catch it.
 *
 * `textMuted` itself survives in the palette — it is fine for icons and
 * borders, where the 4.5:1 text rule does not apply.
 */
export type TextTone =
    | 'primary'
    | 'secondary'
    | 'tertiary'
    | 'accent'
    | 'onAccent'
    | 'success'
    | 'warning'
    | 'error'
    | 'info';

export interface TextProps extends Omit<RNTextProps, 'style'> {
    variant?: TextVariant;
    tone?: TextTone;
    /** Convenience for the common one-off weight bump within a variant. */
    weight?: 'regular' | 'medium' | 'semibold' | 'bold';
    center?: boolean;
    style?: RNTextProps['style'];
}

export function Text({
    variant = 'body',
    tone = 'primary',
    weight,
    center,
    style,
    maxFontSizeMultiplier,
    ...rest
}: TextProps) {
    const theme = useTheme();
    const base = theme.type[variant];

    const color: Record<TextTone, string> = {
        primary: theme.colors.textPrimary,
        secondary: theme.colors.textSecondary,
        tertiary: theme.colors.textTertiary,
        // `accentText`, not `accentPrimary`: the raw accent is #9ca3af by
        // default, which is 2.8:1 on a card — every inline link and every
        // "Try again" in the app was drawn below the line. ThemeProvider
        // derives the first accent shade that clears 4.5:1, so a custom org
        // accent is fixed too.
        accent: theme.colors.accentText,
        onAccent: theme.colors.accentPrimaryFg,
        // The `-ink` step, never the raw status colour: the raw one is for
        // borders, dots and tints, and as words it measures 2.7–3.8:1 on the
        // light themes (index.css's ink docblock). On the dark themes the ink
        // is the lighter shade the web used to spell `dark:text-emerald-400`.
        success: theme.colors.successInk,
        warning: theme.colors.warningInk,
        error: theme.colors.errorInk,
        info: theme.colors.infoInk,
    };

    const resolved: TextStyle = {
        ...base,
        color: color[tone],
        // `code` is the one variant whose face is not a weight of the org's
        // font, so a weight override must not silently turn code into body text.
        ...(weight && variant !== 'code' ? theme.fonts[weight] : {}),
        ...(center ? { textAlign: 'center' } : {}),
    };

    return (
        <RNText
            {...rest}
            maxFontSizeMultiplier={
                maxFontSizeMultiplier ?? (variant === 'body' || variant === 'caption' ? 1.4 : 1.2)
            }
            style={[resolved, style]}
        />
    );
}

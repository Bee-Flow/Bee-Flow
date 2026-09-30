/**
 * Inline banner for a non-blocking problem — a failed background sync, say, or
 * a save that did not go through. Errors belong inline next to what failed,
 * never only in a toast.
 *
 * The web's `subtle` recipe (statusTokens.ts): the tone's raw colour at 10%
 * as the fill, a 30% edge, and the glyph in the tone's ink. `info` is the
 * web's `--info` blue, not the org accent — a notice is not a brand moment.
 */

import React, { type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Icon, type IconName } from './icons/Icon';
import { Text } from './Text';
import { tint } from './tint';
import { tonePair } from './tones';

export type BannerTone = 'warning' | 'error' | 'info' | 'success';

const BANNER_TONES: readonly BannerTone[] = ['warning', 'error', 'info', 'success'];

const FALLBACK_ICON: Record<BannerTone, IconName> = {
    warning: 'TriangleAlert',
    error: 'OctagonAlert',
    info: 'Info',
    success: 'CircleCheckBig',
};

export interface BannerProps {
    tone?: BannerTone;
    /** Overrides the tone's own glyph. */
    icon?: IconName;
    /** A string renders as a caption; anything else renders as given. */
    children: ReactNode;
    /** Trailing element, usually a small button. */
    action?: ReactNode;
}

export function Banner({ tone = 'warning', icon, children, action }: BannerProps) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View accessibilityLiveRegion="polite" style={[styles.banner, styles.tone[tone]]}>
            <Icon name={icon ?? FALLBACK_ICON[tone]} size={18} color={styles.ink[tone]} />
            <View style={styles.body}>
                {typeof children === 'string' ? <Text variant="caption">{children}</Text> : children}
            </View>
            {action}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    banner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        padding: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
    } satisfies ViewStyle,
    body: { flex: 1 } satisfies ViewStyle,
    tone: Object.fromEntries(
        BANNER_TONES.map((tone) => {
            const { raw } = tonePair(theme.colors, tone);
            return [tone, { backgroundColor: tint(raw, 10), borderColor: tint(raw, 30) }];
        }),
    ) as Record<BannerTone, ViewStyle>,
    ink: Object.fromEntries(BANNER_TONES.map((tone) => [tone, tonePair(theme.colors, tone).ink])) as Record<
        BannerTone,
        string
    >,
});

/**
 * One deadline, one look (web: shared/DeadlineClock.jsx): 30 days, 72 hours,
 * 24 hours. The maths is model/deadlineMath (the server's state and pct win),
 * the words model/clockLabels, and the clock re-renders each minute.
 *
 *   inline  the compact words in the tone's ink ('3 d left', '5 h overdue');
 *           a closed clock says its full sentence ('completed in 2 days')
 *   row     the words plus a bar of the elapsed share
 *   block   a record's headline: bigger words, the bar, a meta slot, on a
 *           tint of the tone
 *
 * A quiet clock (`clock.quiet`) reads in neutral ink and is never red; a
 * string there replaces the words ('closed · not notified').
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { ProgressBar, Text, tint, tonePair, type Tone } from '@/shared/ui';

import { useNow } from '../hooks/useNow';
import { clockLabel, clockRowLabel } from '../model/clockLabels';
import { resolveClock, type ClockResult } from '../model/deadlineMath';
import type { ClockSpec } from '../model/types';

type ClockTone = 'success' | 'warning' | 'error' | 'neutral';

const TONE_OF: Record<ClockResult['state'], ClockTone> = { ok: 'success', urgent: 'warning', overdue: 'error', done: 'neutral', none: 'neutral' };
const INK = { success: 'success', warning: 'warning', error: 'error', neutral: 'secondary' } as const;

export interface DeadlineClockProps {
    clock: ClockSpec;
    variant: 'inline' | 'row' | 'block';
    /** The block's meta line. */
    children?: ReactNode;
    testID?: string;
}

/** The resolved clock, its tone and its words (full and compact). */
export function useClockView(clock: ClockSpec) {
    const t = useTranslation();
    const now = useNow();
    const c = resolveClock({ ...clock, now });
    const closed = c.state === 'done' || c.state === 'none';
    const quiet = Boolean(clock.quiet) && c.state !== 'overdue';
    const tone: ClockTone = quiet ? 'neutral' : TONE_OF[c.state];
    const prefix = clock.label ? `${clock.label} · ` : '';
    const own = typeof clock.quiet === 'string' && quiet ? clock.quiet : null;
    const full = prefix + (own ?? clockLabel(t, c));
    const short = prefix + (own ?? (closed ? clockLabel(t, c) : clockRowLabel(t, c)));
    return { c, closed, tone, full, short };
}

export function DeadlineClock({ clock, variant, children, testID = 'deadline-clock' }: DeadlineClockProps) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { c, closed, tone, full, short } = useClockView(clock);
    const raw = tonePair(theme.colors, tone as Tone).raw;
    const words = (
        <Text
            testID={`${testID}-label`}
            variant={variant === 'block' ? 'subheading' : 'label'}
            weight={variant === 'block' ? 'bold' : 'semibold'}
            tone={closed ? 'tertiary' : INK[tone]}
            numberOfLines={variant === 'block' ? undefined : 1}
            accessibilityLabel={full}
        >
            {variant === 'block' ? full : short}
        </Text>
    );
    if (variant === 'inline') return <View testID={testID}>{words}</View>;
    return (
        <View testID={testID} style={variant === 'block' ? [styles.block, styles[tone]] : styles.row}>
            {words}
            {closed ? null : <ProgressBar fraction={c.pct} label={full} tint={raw} />}
            {variant === 'block' && children ? (
                <Text variant="label" tone="secondary">
                    {children}
                </Text>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => {
    const bg = (tone: Tone) => ({ backgroundColor: tint(tonePair(theme.colors, tone).raw, 8) });
    return StyleSheet.create({
        row: { gap: theme.spacing.xs, minWidth: 72 },
        block: { gap: theme.spacing.sm, padding: theme.spacing.md, borderRadius: theme.radii.md },
        success: bg('success'),
        warning: bg('warning'),
        error: bg('error'),
        neutral: bg('neutral'),
    });
};

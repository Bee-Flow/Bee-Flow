/**
 * A determinate progress bar, and the arithmetic it draws with.
 *
 * Determinate only: an indeterminate bar is a Spinner with extra steps, and
 * this exists for the one job a spinner cannot do — say how far through a long
 * upload you are. The accessibility is the hard part: a screen reader needs the
 * `progressbar` role and a real `accessibilityValue`, and the live region
 * belongs on the text beside it so TalkBack reads "63 per cent" once instead of
 * on every repaint.
 */

import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

/**
 * How full the bar is, in whole per cent, and how wide to draw it.
 *
 * Every part is a boundary someone gets wrong: a fraction of 1.02 from a byte
 * counter that overshoots, a NaN from a division by a zero total, and the floor
 * — a bar that has genuinely started is held at 2% so it never renders as a
 * hairline of nothing.
 */
export function progressPercent(fraction: number): { percent: number; width: `${number}%` } {
    const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    const percent = Math.round(clamped * 100);
    return { percent, width: `${Math.max(2, percent)}%` };
}

export interface ProgressBarProps {
    /** 0 to 1. Out-of-range and NaN are clamped rather than trusted. */
    fraction: number;
    /** What is progressing — "Uploading Monday standup", not "Progress". */
    label: string;
    tint?: string;
}

export function ProgressBar({ fraction, label, tint }: ProgressBarProps) {
    const theme = useTheme();
    const { percent, width } = progressPercent(fraction);
    return (
        <View
            accessibilityRole="progressbar"
            accessibilityLabel={label}
            accessibilityValue={{ now: percent, min: 0, max: 100 }}
            style={{
                height: 6,
                borderRadius: 3,
                backgroundColor: theme.colors.bgTertiary,
                overflow: 'hidden',
            }}
        >
            <View
                style={{
                    width,
                    height: '100%',
                    backgroundColor: tint ?? theme.colors.accentPrimary,
                }}
            />
        </View>
    );
}

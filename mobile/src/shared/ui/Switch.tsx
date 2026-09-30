/**
 * The themed switch.
 *
 * Six screens once hand-rolled React Native's raw `Switch` with the theme
 * colours passed in by hand, and ended up with three paint jobs for one
 * control (one got Android's stock green). The colours live here so that
 * cannot happen again.
 */

import React from 'react';
import { Switch as RNSwitch } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';

/**
 * React Native's Switch, painted in the current theme.
 *
 * A bare RN Switch renders in Android's own accent, which is the one colour on
 * screen that does not move when the user changes theme — and this app ships
 * eight of them. The colours are here rather than at fourteen call sites so
 * that stays true by construction.
 */
/** The web Toggle's knob: white in every theme and in both states. */
const KNOB = '#ffffff';

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
            // The web's Toggle: a bgTertiary track that turns emerald
            // (`--success`) when on, under a white knob. The accent is grey by
            // default, and a grey "on" reads as disabled.
            trackColor={{ false: theme.colors.bgTertiary, true: theme.colors.success }}
            thumbColor={KNOB}
        />
    );
}

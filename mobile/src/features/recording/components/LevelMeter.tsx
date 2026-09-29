/**
 * The input meter.
 *
 * Not decoration: it is the only evidence, during the hour you are recording,
 * that the microphone is hearing the room rather than a covered port, a dead
 * bluetooth headset, or a phone face-down on a soft table.
 *
 * A pure function of its props — the sampling, smoothing and the silence
 * verdict all happen in useRecorder, where the samples actually arrive. The
 * bars are hidden from accessibility (a value changing ten times a second
 * would make TalkBack unusable) and the verdict is announced instead, because
 * "very quiet" is the part that actually matters.
 */

import React from 'react';
import { View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Text } from '../../../ui/Text';

export function LevelMeter({
    history,
    quiet,
    paused,
}: {
    /** Normalised 0..1 samples, oldest first. */
    history: number[];
    quiet: boolean;
    paused: boolean;
}) {
    const theme = useTheme();

    return (
        <View style={{ gap: theme.spacing.sm, alignItems: 'center', width: '100%' }}>
            <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 3,
                    height: 72,
                }}
            >
                {history.map((value, index) => {
                    // Newest bar is on the right and fully opaque; older ones
                    // fade, so the eye reads the direction of time without a
                    // label saying so.
                    const age = (index + 1) / history.length;
                    return (
                        <View
                            key={index}
                            style={{
                                width: 4,
                                height: paused ? 3 : Math.max(3, value * 68),
                                borderRadius: 2,
                                backgroundColor: paused
                                    ? theme.colors.borderDefault
                                    : theme.colors.accentPrimary,
                                opacity: paused ? 0.6 : 0.25 + age * 0.75,
                            }}
                        />
                    );
                })}
            </View>

            {/* A live region, so the verdict is announced when it changes and
                only then. */}
            <View accessibilityLiveRegion="polite" style={{ minHeight: 18 }}>
                {paused ? (
                    <Text variant="caption" tone="tertiary" center>
                        Paused — nothing is being recorded
                    </Text>
                ) : quiet ? (
                    <Text variant="caption" tone="warning" center>
                        Very quiet. Check the microphone is not covered.
                    </Text>
                ) : (
                    <Text variant="caption" tone="tertiary" center>
                        Hearing the room
                    </Text>
                )}
            </View>
        </View>
    );
}

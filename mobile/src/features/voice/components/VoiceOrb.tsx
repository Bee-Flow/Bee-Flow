/**
 * The one control.
 *
 * A voice screen has exactly one thing you should be able to hit without
 * looking: this. It is 200dp across — four times the minimum touch target —
 * because the whole point of talking to a phone is that you are not looking at
 * it, and it does the phase-appropriate thing rather than showing four buttons
 * of which three are always wrong.
 *
 * The halo is a pure function of the mic level, which arrives ten times a
 * second while listening. That is the only proof, before the transcript lands,
 * that the microphone is hearing you at all — the exact failure (covered mic,
 * a bluetooth headset that grabbed the input) that otherwise reads as "the
 * assistant is ignoring me".
 */

import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, Text, type IconName } from '@/shared/ui';

import type { VoicePhase } from '../model/types';

const CORE = 132;
const HALO_MAX = 200;

interface OrbCopy {
    /** Under the orb, in a size you can read at arm's length. */
    state: string;
    /** What a tap does right now. Also the accessibility hint. */
    action: string;
    icon: IconName;
}

const COPY: Record<VoicePhase, OrbCopy> = {
    offline: { state: 'Not connected', action: 'Start talking', icon: 'PhoneCall' },
    connecting: { state: 'Connecting', action: 'Connecting to the server', icon: 'Loader' },
    listening: { state: 'Listening', action: 'Send now', icon: 'Mic' },
    thinking: { state: 'Thinking', action: 'Cancel this turn', icon: 'Ellipsis' },
    speaking: { state: 'Speaking', action: 'Interrupt', icon: 'Volume2' },
};

export function VoiceOrb({
    phase,
    level,
    elapsed,
    onPress,
}: {
    phase: VoicePhase;
    /** 0..1. Ignored unless listening. */
    level: number;
    /** Seconds captured in this utterance. */
    elapsed: number;
    onPress: () => void;
}) {
    const theme = useTheme();
    const copy = COPY[phase];

    const listening = phase === 'listening';
    const halo = listening ? CORE + Math.min(1, Math.max(0, level)) * (HALO_MAX - CORE) : CORE + 12;

    const ring =
        phase === 'speaking'
            ? theme.colors.success
            : phase === 'thinking'
              ? theme.colors.warning
              : theme.colors.accentPrimary;

    return (
        <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
            <View
                style={{
                    width: HALO_MAX,
                    height: HALO_MAX,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                {/* Decoration. TalkBack reads the button below, not a ring
                    whose size changes ten times a second. */}
                <View
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    pointerEvents="none"
                    style={{
                        position: 'absolute',
                        width: halo,
                        height: halo,
                        borderRadius: halo / 2,
                        backgroundColor: ring,
                        opacity: phase === 'offline' ? 0.08 : 0.18,
                    }}
                />
                <Pressable
                    onPress={onPress}
                    accessibilityRole="button"
                    accessibilityLabel={copy.action}
                    accessibilityState={{ busy: phase === 'thinking' || phase === 'connecting' }}
                    accessibilityHint={
                        listening ? 'Or just stop talking — it sends after a short pause.' : undefined
                    }
                    style={({ pressed }) => ({
                        width: CORE,
                        height: CORE,
                        borderRadius: CORE / 2,
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: theme.spacing.xs,
                        borderWidth: 2,
                        borderColor: ring,
                        backgroundColor:
                            phase === 'offline' ? theme.colors.bgTertiary : theme.colors.bgCard,
                        opacity: pressed ? 0.85 : 1,
                    })}
                >
                    {phase === 'connecting' || phase === 'thinking' ? (
                        <ActivityIndicator size="large" color={ring} />
                    ) : (
                        <Icon name={copy.icon} size={38} color={ring} />
                    )}
                    {listening && elapsed >= 1 ? (
                        <Text variant="label" tone="tertiary">
                            {formatSeconds(elapsed)}
                        </Text>
                    ) : null}
                </Pressable>
            </View>

            {/* Announced on change, so someone not watching the screen still
                hears when it starts listening again. */}
            <View accessibilityLiveRegion="polite" style={{ alignItems: 'center', gap: 2 }}>
                <Text variant="heading">{copy.state}</Text>
                <Text variant="caption" tone="tertiary" center>
                    {phase === 'listening'
                        ? 'Just talk. It sends when you pause.'
                        : phase === 'offline'
                          ? 'Tap to start a spoken conversation.'
                          : `Tap to ${copy.action.toLowerCase()}.`}
                </Text>
            </View>
        </View>
    );
}

function formatSeconds(seconds: number): string {
    const whole = Math.floor(seconds);
    const mm = Math.floor(whole / 60);
    const ss = whole % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
}

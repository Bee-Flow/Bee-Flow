/**
 * The screen you are looking at while a meeting is being recorded.
 *
 * It takes over the whole tab rather than sitting in a card, because for the
 * next hour this is the only thing the app is doing and any other content on
 * screen is either a distraction or a mis-tap waiting to happen.
 *
 * Three things earn their place here:
 *   - The elapsed time, large and tabular, so it can be read from across a
 *     table without picking the phone up.
 *   - The meter, which is the only proof the microphone is working.
 *   - An explicit promise that locking the screen is safe. People put the
 *     phone face-down in a meeting; without being told, they assume that stops
 *     the recording, and they are right to assume it — most apps do.
 *
 * Stop is a large, unambiguous target and Discard is deliberately not: one is
 * the end of the task, the other throws away something irreplaceable.
 */

import React from 'react';
import { Alert, Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, Text, type IconName } from '@/shared/ui';

import { LevelMeter } from './LevelMeter';
import type { Recorder } from '../hooks/useRecorder';
import { formatElapsed } from '../model/format';

export function LiveRecorder({
    recorder,
    onStop,
    onDiscard,
    saving,
}: {
    recorder: Recorder;
    onStop: () => void;
    onDiscard: () => void;
    saving: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const paused = recorder.phase === 'paused';

    const confirmDiscard = () => {
        Alert.alert(
            'Discard this recording?',
            `${formatElapsed(recorder.elapsed)} of audio will be deleted. This cannot be undone.`,
            [
                { text: 'Keep recording', style: 'cancel' },
                { text: 'Discard', style: 'destructive', onPress: onDiscard },
            ],
        );
    };

    return (
        <View
            style={{
                flex: 1,
                paddingHorizontal: theme.spacing.lg,
                paddingBottom: theme.spacing.xl,
                justifyContent: 'space-between',
            }}
        >
            <View style={{ alignItems: 'center', gap: theme.spacing.sm, paddingTop: theme.spacing.xl }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                    <View
                        style={{
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            backgroundColor: paused ? theme.colors.textMuted : theme.colors.error,
                        }}
                    />
                    <Text variant="label" tone={paused ? 'tertiary' : 'error'}>
                        {paused ? 'PAUSED' : 'RECORDING'}
                    </Text>
                </View>

                {/* The timer is the screen's headline. `accessibilityLiveRegion`
                    is off here on purpose — announcing every second would make
                    the screen unusable with TalkBack; the elapsed time is
                    readable on demand instead. */}
                <Text
                    variant="title"
                    style={{ fontSize: 56, lineHeight: 64, fontVariant: ['tabular-nums'] }}
                    accessibilityLabel={`Recorded so far: ${formatElapsed(recorder.elapsed)}`}
                >
                    {formatElapsed(recorder.elapsed)}
                </Text>
            </View>

            <View style={{ gap: theme.spacing.xl, alignItems: 'center' }}>
                <LevelMeter history={recorder.history} quiet={recorder.quiet} paused={paused} />

                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.spacing.md,
                        paddingHorizontal: theme.spacing.md,
                        paddingVertical: theme.spacing.sm,
                        borderRadius: theme.radii.pill,
                        backgroundColor: theme.colors.bgTertiary,
                    }}
                >
                    <Icon name="Lock" size={14} color={theme.colors.textMuted} />
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.recording.lock_safe', 'Keeps recording with the screen locked')}
                    </Text>
                </View>
            </View>

            <View style={{ gap: theme.spacing.lg, alignItems: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xxl }}>
                    <CircleButton
                        icon={paused ? 'Play' : 'Pause'}
                        label={paused ? 'Resume recording' : 'Pause recording'}
                        onPress={paused ? recorder.resume : recorder.pause}
                        disabled={saving}
                    />

                    <Pressable
                        onPress={onStop}
                        disabled={saving}
                        accessibilityRole="button"
                        accessibilityLabel="Stop recording and save"
                        accessibilityState={{ disabled: saving, busy: saving }}
                        style={({ pressed }) => ({
                            width: 88,
                            height: 88,
                            borderRadius: 44,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: theme.colors.error,
                            opacity: saving ? 0.5 : pressed ? 0.85 : 1,
                            ...theme.elevation.raised,
                        })}
                    >
                        <Icon name="Square" size={30} color="#ffffff" />
                    </Pressable>

                    <CircleButton
                        icon="Trash2"
                        label="Discard this recording"
                        onPress={confirmDiscard}
                        disabled={saving}
                    />
                </View>

                <Text variant="caption" tone="tertiary" center>
                    {saving ? 'Saving the recording…' : 'Stop to save it and start transcribing.'}
                </Text>
            </View>
        </View>
    );
}

function CircleButton({
    icon,
    label,
    onPress,
    disabled,
}: {
    icon: IconName;
    label: string;
    onPress: () => void;
    disabled?: boolean;
}) {
    const theme = useTheme();
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: Boolean(disabled) }}
            hitSlop={theme.hitSlop}
            style={({ pressed }) => ({
                width: 56,
                height: 56,
                borderRadius: 28,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? theme.colors.bgCardHover : theme.colors.bgTertiary,
                opacity: disabled ? 0.4 : 1,
            })}
        >
            <Icon name={icon} size={22} color={theme.colors.textPrimary} />
        </Pressable>
    );
}

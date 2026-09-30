/**
 * The meeting's recording: back 10 s, play/pause, forward 10 s, the seek bar,
 * the time, and the speed chip — the transport of agent-hub WaveformPlayer.jsx
 * without the waveform (drawing one would mean decoding the whole file).
 *
 * The only component that subscribes to the player's status, so the ticks
 * re-render this card and nothing else on the meeting screen.
 */

import { useAudioPlayerStatus } from 'expo-audio';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Card, Chip, Icon, IconButton, Spinner, Text } from '@/shared/ui';

import { SeekBar } from './SeekBar';
import type { MeetingAudio } from '../hooks/useMeetingAudio';
import { formatDuration } from '../model/format';
import { effectiveDuration, progressOf, SKIP_SECONDS, skipTarget } from '../model/player';

const styles = StyleSheet.create({
    body: { gap: 6 },
    transport: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    time: { flex: 1, fontVariant: ['tabular-nums'] },
});

export function AudioPlayerCard({ audio, storedDuration }: { audio: MeetingAudio; storedDuration: number | null }) {
    const t = useTranslation();
    const theme = useTheme();
    const status = useAudioPlayerStatus(audio.player);
    const ready = audio.phase === 'ready';
    const playing = ready && Boolean(status.playing);
    const current = ready ? status.currentTime || 0 : 0;
    const duration = effectiveDuration(ready ? status.duration : 0, storedDuration);
    const skip = (delta: number) => audio.seek(skipTarget(current, delta, duration));
    const glyph = (name: 'RotateCcw' | 'RotateCw' | 'Play' | 'Pause', color = theme.colors.textSecondary) => (
        <Icon name={name} size={20} color={color} />
    );

    return (
        <Card>
            <View style={styles.body}>
                <View style={styles.transport}>
                    <IconButton
                        icon={glyph('RotateCcw')}
                        accessibilityLabel={t('mobile.recording.back_10', 'Back 10 seconds')}
                        disabled={!ready}
                        onPress={() => skip(-SKIP_SECONDS)}
                    />
                    {audio.phase === 'loading' ? (
                        <Spinner />
                    ) : (
                        <IconButton
                            tone="accent"
                            icon={glyph(playing ? 'Pause' : 'Play', theme.colors.accentPrimary)}
                            accessibilityLabel={
                                playing ? t('mobile.recording.pause', 'Pause') : t('mobile.recording.play', 'Play')
                            }
                            onPress={() => audio.toggle(playing)}
                        />
                    )}
                    <IconButton
                        icon={glyph('RotateCw')}
                        accessibilityLabel={t('mobile.recording.forward_10', 'Forward 10 seconds')}
                        disabled={!ready}
                        onPress={() => skip(SKIP_SECONDS)}
                    />
                    <Text variant="caption" tone="secondary" style={styles.time}>
                        {`${formatDuration(current)} / ${formatDuration(duration)}`}
                    </Text>
                    <Chip
                        label={`${audio.rate}×`}
                        selected={audio.rate !== 1}
                        accessibilityHint={t('mobile.recording.speed', 'Playback speed')}
                        onPress={audio.cycleRate}
                    />
                </View>
                <SeekBar
                    progress={progressOf(current, duration)}
                    disabled={!ready || duration <= 0}
                    onSeek={(fraction) => audio.seek(fraction * duration)}
                />
                {audio.phase === 'error' ? (
                    <Text variant="caption" tone="error">
                        {describeError(audio.error).message}
                    </Text>
                ) : null}
            </View>
        </Card>
    );
}

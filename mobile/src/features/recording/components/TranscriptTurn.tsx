/**
 * One turn in the transcript.
 *
 * Rendered as a row in the detail screen's FlatList rather than inside a
 * ScrollView: an hour-long meeting is a few thousand turns, and the difference
 * between virtualised and not is the difference between a screen that scrolls
 * and one that drops half its frames.
 *
 * A `gap` segment is a stretch of audio the engine could not transcribe (a
 * failed chunk). It is drawn as an explicit hole rather than skipped, because
 * a transcript that silently omits four minutes is worse than one that admits
 * it: the reader would otherwise assume nothing was said.
 *
 * With `onSeek` (the note still has its audio) a turn is a button: a tap
 * plays the recording from where that turn starts, as a click on a line does
 * on the web.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text } from '@/shared/ui';

import { formatDuration } from '../model/format';
import type { TranscriptSegment } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        gap: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.md },
        gapText: { flex: 1 },
        turn: { paddingVertical: theme.spacing.sm },
        continued: { paddingVertical: theme.spacing.xs },
        pressed: { backgroundColor: theme.colors.itemHoverBg },
        head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, marginBottom: theme.spacing.xs },
        dot: { width: 8, height: 8, borderRadius: 4 },
        body: { paddingLeft: theme.spacing.lg },
    });

export function TranscriptTurn({
    segment,
    colour,
    continued,
    onSeek,
}: {
    segment: TranscriptSegment;
    colour: string;
    /** True when the previous turn was the same speaker — hides a repeat name. */
    continued: boolean;
    onSeek?: (seconds: number) => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    // The speaker's colour is data, so these two are computed per turn.
    const dotInk = { backgroundColor: colour };
    const nameInk = { color: colour };

    if (segment.gap) {
        return (
            <View style={styles.gap}>
                <Icon name="CircleAlert" size={14} color={theme.colors.warning} />
                <Text variant="caption" tone="warning" style={styles.gapText}>
                    {t('mobile.recording.gap', '{from} – {to}: this part could not be transcribed.', {
                        from: formatDuration(segment.start),
                        to: formatDuration(segment.end),
                    })}
                </Text>
            </View>
        );
    }

    return (
        <Pressable
            disabled={!onSeek}
            onPress={() => onSeek?.(segment.start)}
            accessibilityHint={onSeek ? t('mobile.recording.play_from_here', 'Plays the recording from here') : undefined}
            style={({ pressed }) => [continued ? styles.continued : styles.turn, pressed ? styles.pressed : null]}
        >
            {continued ? null : (
                <View style={styles.head}>
                    <View style={[styles.dot, dotInk]} />
                    <Text variant="label" style={nameInk} numberOfLines={1}>
                        {segment.speaker.toUpperCase()}
                    </Text>
                    <Text variant="label" tone="tertiary">
                        {formatDuration(segment.start)}
                    </Text>
                </View>
            )}
            <Text variant="body" tone="secondary" selectable={!onSeek} style={styles.body}>
                {segment.text}
            </Text>
        </Pressable>
    );
}

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
 */

import { Feather } from '@expo/vector-icons';
import React from 'react';
import { View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Text } from '../../../ui/Text';
import { formatDuration } from '../format';
import type { TranscriptSegment } from '../types';

export function TranscriptTurn({
    segment,
    colour,
    /** True when the previous turn was the same speaker — hides a repeat name. */
    continued,
}: {
    segment: TranscriptSegment;
    colour: string;
    continued: boolean;
}) {
    const theme = useTheme();

    if (segment.gap) {
        return (
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.sm,
                    paddingVertical: theme.spacing.md,
                }}
            >
                <Feather name="alert-circle" size={14} color={theme.colors.warning} />
                <Text variant="caption" tone="warning" style={{ flex: 1 }}>
                    {formatDuration(segment.start)} – {formatDuration(segment.end)}: this part could
                    not be transcribed.
                </Text>
            </View>
        );
    }

    return (
        <View style={{ paddingVertical: continued ? theme.spacing.xs : theme.spacing.sm }}>
            {continued ? null : (
                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.spacing.sm,
                        marginBottom: theme.spacing.xs,
                    }}
                >
                    <View
                        style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colour }}
                    />
                    <Text variant="label" style={{ color: colour }} numberOfLines={1}>
                        {segment.speaker.toUpperCase()}
                    </Text>
                    <Text variant="label" tone="tertiary">
                        {formatDuration(segment.start)}
                    </Text>
                </View>
            )}
            <Text variant="body" tone="secondary" selectable style={{ paddingLeft: theme.spacing.lg }}>
                {segment.text}
            </Text>
        </View>
    );
}

/**
 * The transcript is the FlatList's data rather than content inside a
 * ScrollView: an hour-long meeting is a few thousand turns, and everything
 * above it (MeetingOverview) rides along as the list header.
 */

import React, { type ReactElement } from 'react';
import { FlatList, RefreshControl } from 'react-native';

import { useTheme, useThemedStyles } from '@/core/theme/ThemeProvider';

import { makeMeetingStyles } from './meetingStyles';
import { TranscriptTurn } from './TranscriptTurn';
import { buildSpeakerColors } from '../model/format';
import type { Transcription, TranscriptSegment } from '../model/types';

const keyOf = (segment: TranscriptSegment, index: number) => `${index}-${segment.start}`;

export function TranscriptList({
    meeting,
    header,
    refreshing,
    onRefresh,
    onSeek,
}: {
    meeting: Transcription;
    header: ReactElement;
    refreshing: boolean;
    onRefresh: () => void;
    /** Present when the note has audio: a tap on a turn plays from there. */
    onSeek?: (seconds: number) => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeMeetingStyles);
    const segments = meeting.segments;
    const colours = buildSpeakerColors(meeting.speakers);
    return (
        <FlatList<TranscriptSegment>
            data={segments}
            keyExtractor={keyOf}
            contentContainerStyle={styles.transcript}
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
            ListHeaderComponent={header}
            renderItem={({ item, index }) => (
                <TranscriptTurn
                    segment={item}
                    colour={colours[item.speaker] ?? theme.colors.textMuted}
                    continued={index > 0 && segments[index - 1]?.speaker === item.speaker}
                    onSeek={onSeek}
                />
            )}
            ListEmptyComponent={null}
        />
    );
}

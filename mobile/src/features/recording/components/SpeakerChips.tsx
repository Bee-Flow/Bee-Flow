/**
 * The people in the meeting, each in their transcript colour.
 *
 * Airtime is shown only when the org allows per-person insights: that switch
 * exists so colleagues are not RANKED by how long they talked.
 */

import React from 'react';
import { View } from 'react-native';

import { useTheme, useThemedStyles } from '@/core/theme/ThemeProvider';
import { Chip, Icon } from '@/shared/ui';

import { makeMeetingStyles } from './meetingStyles';
import { buildSpeakerColors } from '../model/format';
import type { Transcription } from '../model/types';

export function SpeakerChips({ meeting, onEdit }: { meeting: Transcription; onEdit: () => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeMeetingStyles);
    const colours = buildSpeakerColors(meeting.speakers);
    return (
        <View style={styles.wrapRow}>
            {meeting.speakers.map((speaker) => (
                <Chip
                    key={speaker.id}
                    label={
                        meeting.perPersonInsights && speaker.speakingTime
                            ? `${speaker.id} · ${speaker.speakingTime}`
                            : speaker.id
                    }
                    onPress={meeting.isOwner ? onEdit : undefined}
                    icon={
                        <View
                            style={[styles.speakerDot, { backgroundColor: colours[speaker.id] ?? theme.colors.textMuted }]}
                        />
                    }
                />
            ))}
            {meeting.isOwner ? (
                <Chip
                    label="Edit speakers"
                    onPress={onEdit}
                    icon={<Icon name="Pen" size={12} color={theme.colors.textSecondary} />}
                />
            ) : null}
        </View>
    );
}

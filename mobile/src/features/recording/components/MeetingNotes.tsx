/**
 * A finished note: the recording's player, tags, speakers, the Insights
 * headline (details in a sheet), summary, action items, decisions, open
 * questions and chapters — everything that sits above the transcript.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles } from '@/core/theme/ThemeProvider';
import { Markdown } from '@/shared/markdown/Markdown';
import { Banner, Button, Card, Section, Text } from '@/shared/ui';

import { ActionItemsSection } from './ActionItemsSection';
import { AudioPlayerCard } from './AudioPlayerCard';
import { ChaptersSection } from './ChaptersSection';
import { InsightsSection } from './insights/InsightsSection';
import { makeMeetingStyles } from './meetingStyles';
import { MeetingTags } from './MeetingTags';
import { NoteLinesSection } from './NoteLinesSection';
import { SpeakerChips } from './SpeakerChips';
import type { MeetingAudio } from '../hooks/useMeetingAudio';
import type { Transcription } from '../model/types';

export interface MeetingNotesProps {
    meeting: Transcription;
    /** The recording's player, when the note still has its audio. */
    audio?: MeetingAudio;
    onEditSpeakers: () => void;
    onEditTags: () => void;
    onRegenerate: () => void;
    onToggleActionItem: (index: number) => void;
}

export function MeetingNotes({
    meeting,
    audio,
    onEditSpeakers,
    onEditTags,
    onRegenerate,
    onToggleActionItem,
}: MeetingNotesProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeMeetingStyles);
    const openQuestions = meeting.questions.filter((q) => q.open !== false);

    return (
        <View style={styles.notesFrame}>
            {/* An honest word about the audio, but only when there is something
                worth saying — a note whose recording is durably backed up does
                not need to talk about storage. */}
            {meeting.audio.localOnly ? (
                <Banner tone="warning" icon="HardDrive">
                    <Text variant="caption" tone="secondary">
                        {t(
                            'mobile.recording.audio_local_only',
                            'The recording has no backup copy on the server yet. The transcript and notes below are safe either way.',
                        )}
                    </Text>
                </Banner>
            ) : null}

            {audio && meeting.audio.available ? (
                <AudioPlayerCard audio={audio} storedDuration={meeting.durationSeconds} />
            ) : null}

            <MeetingTags tags={meeting.tags} onEdit={meeting.isOwner ? onEditTags : undefined} />

            <SpeakerChips meeting={meeting} onEdit={onEditSpeakers} />

            <InsightsSection meeting={meeting} onSeek={audio && meeting.audio.available ? audio.seek : undefined} />

            {meeting.summary ? (
                <Section
                    title={t('mobile.recording.summary', 'Summary')}
                    action={
                        meeting.isOwner ? (
                            <Button
                                label={t('mobile.recording.rewrite', 'Rewrite')}
                                variant="ghost"
                                onPress={onRegenerate}
                            />
                        ) : undefined
                    }
                >
                    <Card>
                        <Markdown value={meeting.summary} />
                    </Card>
                </Section>
            ) : null}

            <ActionItemsSection
                items={meeting.actionItems}
                onToggle={meeting.isOwner ? onToggleActionItem : undefined}
            />
            <NoteLinesSection
                title={t('mobile.recording.decisions', 'Decisions')}
                lines={meeting.decisions}
                icon="CircleCheckBig"
                colour={theme.colors.success}
            />
            <NoteLinesSection
                title={t('mobile.recording.still_open', 'Still open')}
                lines={openQuestions}
                icon="CircleQuestionMark"
                colour={theme.colors.warning}
            />
            <ChaptersSection chapters={meeting.chapters} />

            {meeting.segments.length > 0 ? (
                <Text variant="label" tone="tertiary">
                    {t('mobile.recording.transcript_label', 'TRANSCRIPT')}
                </Text>
            ) : null}
        </View>
    );
}

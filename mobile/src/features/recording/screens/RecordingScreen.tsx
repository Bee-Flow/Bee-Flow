/**
 * One meeting: the transcript, the notes, and everything you can do to them.
 *
 * The screen has to be right in three quite different states, and treating any
 * of them as an afterthought makes the feature untrustworthy:
 *
 *   - PROCESSING. The upload route answers 202 and finishes the pipeline in
 *     the background, so a note is openable for minutes before it has any
 *     content. That state gets a real explanation and a poll, not a spinner.
 *   - FAILED. The pipeline stashes its reason in `summary`, the ONLY place the
 *     client ever learns why. So the reason is shown, and Retry re-runs from
 *     the saved audio.
 *   - COMPLETED. Summary, action items, decisions, open questions, chapters,
 *     speakers and the transcript itself.
 *
 * Not QueryScreen: the transcript brings its own FlatList, and a note that is
 * gone has its own sentence.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useUserRefresh } from '@/shared/patterns';
import { ErrorState, GuardedDeleteSheet, LoadingState, Screen } from '@/shared/ui';

import { AskMeetingSheet } from '../components/AskMeetingSheet';
import { MeetingActionsSheet } from '../components/MeetingActionsSheet';
import { MeetingOverview } from '../components/MeetingOverview';
import { MeetingScreenHeader } from '../components/MeetingScreenHeader';
import { RegenerateSheet } from '../components/RegenerateSheet';
import { RenameMeetingSheet } from '../components/RenameMeetingSheet';
import { SpeakersSheet } from '../components/SpeakersSheet';
import { TagsSheet } from '../components/TagsSheet';
import { TranscriptList } from '../components/TranscriptList';
import { useMeetingScreen } from '../hooks/useMeetingScreen';

export function RecordingScreen({ id }: { id: string }) {
    const t = useTranslation();
    const screen = useMeetingScreen(id);
    const { query, sheet, setSheet, close, edits, retry, remove } = screen;
    // The person's pull only: a meeting being transcribed polls every few seconds.
    const refresh = useUserRefresh(() => query.refetch());
    const meeting = query.data ?? null;

    const header = (
        <MeetingScreenHeader meeting={meeting} onAsk={() => setSheet('ask')} onMore={() => setSheet('actions')} />
    );

    if (query.isLoading) {
        return (
            <Screen edges={['top', 'bottom']}>
                {header}
                <LoadingState label={t('mobile.recording.opening', 'Opening the meeting')} />
            </Screen>
        );
    }

    if (query.isError || !meeting) {
        return (
            <Screen edges={['top', 'bottom']}>
                {header}
                <ErrorState
                    error={query.error ?? new Error(t('mobile.recording.gone', 'This meeting no longer exists.'))}
                    onRetry={() => void query.refetch()}
                />
            </Screen>
        );
    }

    return (
        <Screen edges={['top', 'bottom']}>
            {header}
            <TranscriptList
                meeting={meeting}
                refreshing={refresh.refreshing}
                onRefresh={refresh.onRefresh}
                onSeek={meeting.audio.available ? screen.audio.seek : undefined}
                header={
                    <MeetingOverview
                        meeting={meeting}
                        audio={screen.audio}
                        retrying={retry.isPending}
                        onRetry={() => retry.mutate()}
                        onEditSpeakers={() => setSheet('speakers')}
                        onEditTags={() => setSheet('tags')}
                        onRegenerate={() => setSheet('regenerate')}
                        onToggleActionItem={(index) => screen.toggleItem(meeting, index)}
                    />
                }
            />
            <MeetingActionsSheet visible={sheet === 'actions'} meeting={meeting} onClose={close} {...screen.menu(meeting)} />
            <RenameMeetingSheet
                visible={sheet === 'rename'}
                value={screen.titleDraft}
                onChange={screen.setTitleDraft}
                saving={edits.rename.isPending}
                onSave={(title) => edits.rename.mutate(title)}
                onClose={close}
            />
            <SpeakersSheet
                visible={sheet === 'speakers'}
                meeting={meeting}
                saving={edits.editSpeakers.isPending}
                reidentifying={edits.reidentify.isPending}
                error={edits.speakerError}
                onSave={(edit) => edits.editSpeakers.mutate(edit)}
                onReidentify={(roster) => edits.reidentify.mutate(roster)}
                onClose={() => {
                    edits.clearSpeakerError();
                    close();
                }}
            />
            <RegenerateSheet
                visible={sheet === 'regenerate'}
                busy={edits.regenerate.isPending}
                onChoose={(choice) => edits.regenerate.mutate(choice)}
                onClose={close}
            />
            <AskMeetingSheet visible={sheet === 'ask'} meeting={meeting} onClose={close} />
            <TagsSheet visible={sheet === 'tags'} noteId={meeting.id} tags={meeting.tags} onClose={close} />
            {/* The delete guard's answer; the only place `?confirm=1` is sent from. */}
            <GuardedDeleteSheet
                guard={remove.guard}
                name={meeting.title}
                requireName
                busy={remove.busy}
                onConfirm={remove.confirmBreaking}
                onCancel={remove.dismiss}
            />
        </Screen>
    );
}

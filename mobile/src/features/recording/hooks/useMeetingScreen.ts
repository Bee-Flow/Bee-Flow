/**
 * Everything the meeting screen does, so the screen itself only lays it out:
 * the note, which sheet is open, the edits, retry and delete, and the actions
 * menu's handlers. Hooks run before the screen's loading and error returns, so
 * a refetch that fails does not throw away a pending delete or edit.
 */

import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { useToast } from '@/shared/ui';

import { useToggleActionItem } from './mutations';
import { useTranscription } from './queries';
import { useMeetingAudio } from './useMeetingAudio';
import { useMeetingDelete } from './useMeetingDelete';
import { useMeetingEdits } from './useMeetingEdits';
import { useMeetingRetry } from './useMeetingRetry';
import { useShareMeetingNotes } from './useShareMeetingNotes';
import type { Transcription } from '../model/types';

export type MeetingSheet = 'none' | 'actions' | 'rename' | 'speakers' | 'regenerate' | 'ask' | 'tags';

export function useMeetingScreen(id: string) {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const confirm = useConfirm();
    const query = useTranscription(id);
    const [sheet, setSheet] = useState<MeetingSheet>('none');
    const [titleDraft, setTitleDraft] = useState('');
    const close = () => setSheet('none');

    const edits = useMeetingEdits(id, close);
    const retry = useMeetingRetry(id);
    const remove = useMeetingDelete(id, () => router.back());
    const toggleActionItem = useToggleActionItem(id, { onError: (err) => toast(describeError(err).message, 'error') });
    const share = useShareMeetingNotes();
    const audio = useMeetingAudio(id);

    /**
     * A finished note asks first, with the web's words: a run that succeeds
     * replaces the transcript, the speakers, the summary and the AI's action
     * items, and bills the provider again. Only a failed note has nothing to
     * lose (the failed card's Try again stays one tap).
     */
    const retranscribe = async (meeting: Transcription) => {
        if (meeting.status !== 'failed') {
            const ok = await confirm({
                title: t('meetings.reprocess_title', 'Re-transcribe this recording?'),
                message: t('meetings.reprocess_desc', 'The existing transcript, summary and action items will be replaced.'),
                confirmLabel: t('meetings.retranscribe', 'Re-transcribe'),
            });
            if (!ok) return;
        }
        retry.mutate();
    };

    /** The actions menu. Each one closes the menu before it acts. */
    const menu = (meeting: Transcription) => ({
        onRename: () => {
            setTitleDraft(meeting.title || '');
            setSheet('rename');
        },
        onShare: () => {
            close();
            void share(meeting);
        },
        onCopy: () => {
            void Clipboard.setStringAsync(meeting.transcript || meeting.fullText);
            close();
            toast(t('meetings.transcript_copied', 'Transcript copied'), 'success');
        },
        onRetranscribe: () => {
            close();
            void retranscribe(meeting);
        },
        onDelete: () => {
            close();
            void remove.request();
        },
    });

    const toggleItem = (meeting: Transcription, index: number) => toggleActionItem(index, meeting.actionItems);

    return { query, sheet, setSheet, close, titleDraft, setTitleDraft, edits, retry, remove, menu, toggleItem, audio };
}

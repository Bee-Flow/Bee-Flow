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
import { useToast } from '@/shared/ui';

import { useSetActionItems } from './mutations';
import { useTranscription } from './queries';
import { useMeetingAudio } from './useMeetingAudio';
import { useMeetingDelete } from './useMeetingDelete';
import { useMeetingEdits } from './useMeetingEdits';
import { useMeetingRetry } from './useMeetingRetry';
import { useShareMeetingNotes } from './useShareMeetingNotes';
import { toggleActionItem } from '../model/actionItems';
import type { Transcription } from '../model/types';

export type MeetingSheet = 'none' | 'actions' | 'rename' | 'speakers' | 'regenerate' | 'ask' | 'tags';

export function useMeetingScreen(id: string) {
    const router = useRouter();
    const { toast } = useToast();
    const query = useTranscription(id);
    const [sheet, setSheet] = useState<MeetingSheet>('none');
    const [titleDraft, setTitleDraft] = useState('');
    const close = () => setSheet('none');

    const edits = useMeetingEdits(id, close);
    const retry = useMeetingRetry(id);
    const remove = useMeetingDelete(id, () => router.back());
    const setItems = useSetActionItems(id, { onError: (err) => toast(describeError(err).message, 'error') });
    const share = useShareMeetingNotes();
    const audio = useMeetingAudio(id);

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
            toast('Transcript copied', 'success');
        },
        onRetranscribe: () => {
            close();
            retry.mutate();
        },
        onDelete: () => {
            close();
            void remove.request();
        },
    });

    const toggleItem = (meeting: Transcription, index: number) =>
        setItems.mutate(toggleActionItem(meeting.actionItems, index));

    return { query, sheet, setSheet, close, titleDraft, setTitleDraft, edits, retry, remove, menu, toggleItem, audio };
}

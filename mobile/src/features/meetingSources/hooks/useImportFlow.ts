/**
 * One import at a time, whichever source it comes from: which row is busy,
 * the last failure, and what happens after — the library is re-read and the
 * new note opens.
 *
 * A Nextcloud import answers with the note. A Meet import answers 202 with a
 * background job: its row stays busy while useMeetImportFollow polls the job,
 * then the note opens, the job's failure is shown with its reason, or (Google
 * has not finished the recording) the person is told it arrives by itself.
 *
 * The lock is not only this screen's state: a Nextcloud import keeps running
 * on the server when the person leaves, so a screen mounted again reads the
 * running import from the mutation cache and keeps its row busy, instead of
 * offering a second (paid) transcription of the same file.
 */

import { useMutationState, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useRefreshMeetings } from '@/features/recording';
import { useToast } from '@/shared/ui';

import { useImportFromMeet, useImportFromNextcloud } from './mutations';
import { importErrorText, useMeetImportFollow } from './useMeetImportFollow';
import { importMutationKeys, sourceKeys } from '../api/keys';
import type { ImportAnswer } from '../api/readers';
import { titleFromFileName } from '../model/imports';
import type { MeetRecording } from '../model/types';

/** The Nextcloud paths whose import is still running, whichever mount started it. */
function useRunningNextcloudImports(): string[] {
    return useMutationState({
        filters: { mutationKey: importMutationKeys.nextcloud, status: 'pending' },
        select: (mutation) => (mutation.state.variables as { path?: string } | undefined)?.path ?? '',
    }).filter(Boolean);
}

export function useImportFlow() {
    const t = useTranslation();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const refresh = useRefreshMeetings();
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<unknown>(null);
    const nextcloud = useImportFromNextcloud(refresh);
    const meet = useImportFromMeet(refresh);
    const running = useRunningNextcloudImports();

    const meetJob = useMeetImportFollow({
        onDone: (noteId) => {
            refresh();
            void queryClient.invalidateQueries({ queryKey: sourceKeys.meetRecordings });
            void queryClient.invalidateQueries({ queryKey: sourceKeys.meetImports });
            if (noteId) router.push(`/recordings/${noteId}`);
        },
        onWaiting: () => {
            void queryClient.invalidateQueries({ queryKey: sourceKeys.meetImports });
            toast(
                t(
                    'mobile.recording.meet_pending',
                    'Google is still preparing this recording. It is imported by itself once it is ready.',
                ),
                'neutral',
            );
        },
        onFailed: (code) => {
            void queryClient.invalidateQueries({ queryKey: sourceKeys.meetImports });
            setError(new Error(importErrorText(t, code)));
        },
    });

    const handlers = (follow?: (jobId: string) => void) => ({
        onSuccess: (result: ImportAnswer) => {
            if (result.id) router.push(`/recordings/${result.id}`);
            else if (result.jobId && follow) follow(result.jobId);
        },
        onError: (err: unknown) => setError(err),
        onSettled: () => setBusy(null),
    });

    const start = (key: string) => {
        setBusy(key);
        setError(null);
    };

    return {
        /** The row that is importing: this screen's request, a followed Meet job, or a Nextcloud import still running. */
        busy: busy ?? meetJob.following ?? running[0] ?? null,
        error,
        clearError: () => setError(null),
        fromNextcloud: (file: { path: string; name: string }) => {
            start(file.path);
            nextcloud.mutate({ path: file.path, title: titleFromFileName(file.name) }, handlers());
        },
        fromMeet: (recording: MeetRecording) => {
            start(recording.eventId);
            meet.mutate(recording, handlers((jobId) => meetJob.follow(recording.eventId, jobId)));
        },
    };
}

export type ImportFlow = ReturnType<typeof useImportFlow>;

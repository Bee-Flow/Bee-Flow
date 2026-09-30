/**
 * One import at a time, whichever source it comes from: which row is busy,
 * the last failure, and what happens after — the library is re-read and the
 * new note opens, or (a Meet recording Google has not finished) the person is
 * told it will arrive by itself.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useRefreshMeetings } from '@/features/recording';
import { useToast } from '@/shared/ui';

import { useImportFromMeet, useImportFromNextcloud } from './mutations';
import { titleFromFileName } from '../model/imports';
import type { ImportResult, MeetRecording } from '../model/types';

export function useImportFlow() {
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const refresh = useRefreshMeetings();
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<unknown>(null);
    const nextcloud = useImportFromNextcloud(refresh);
    const meet = useImportFromMeet(refresh);

    const handlers = {
        onSuccess: (result: ImportResult) => {
            if (result.id) router.push(`/recordings/${result.id}`);
            else if (result.pending) {
                toast(
                    t(
                        'mobile.recording.meet_pending',
                        'Google is still preparing this recording. It is imported by itself once it is ready.',
                    ),
                    'neutral',
                );
            }
        },
        onError: (err: unknown) => setError(err),
        onSettled: () => setBusy(null),
    };

    const start = (key: string) => {
        setBusy(key);
        setError(null);
    };

    return {
        busy,
        error,
        clearError: () => setError(null),
        fromNextcloud: (file: { path: string; name: string }) => {
            start(file.path);
            nextcloud.mutate({ path: file.path, title: titleFromFileName(file.name) }, handlers);
        },
        fromMeet: (recording: MeetRecording) => {
            start(recording.eventId);
            meet.mutate(recording, handlers);
        },
    };
}

export type ImportFlow = ReturnType<typeof useImportFlow>;

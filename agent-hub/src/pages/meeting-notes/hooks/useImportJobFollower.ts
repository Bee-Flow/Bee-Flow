import { useCallback, useEffect, useRef, useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { useMeetingImportJob, type MeetingImportProvider } from '@/api/queries/meetingImportJobs';
import { importJobPhase } from '@/utils/meetingImportJob';
import { importErrorText } from '../lib/importErrorText';
import type { UploadOutcome } from './RecorderContext';

interface Callbacks {
    /** A stage line while the import runs, `null` when it has ended. */
    onUploading: (stage: string | null) => void;
    /** The job ended with a note. */
    onDone: (noteId: string | null) => void;
    /** The job ended with an error carrying the job's stable `code`. */
    onFailed: (error: Error & { code: string }) => void;
}

/**
 * Follow a background meeting import (Teams, Google Meet) after the server
 * answered 202 with its job id: poll the job until it is done, failed or
 * waiting for the provider, then settle the returned promise.
 */
export function useImportJobFollower(callbacks: Callbacks) {
    const { t } = useTranslation();
    // Latest callbacks, so callers can pass inline functions without the effect and the returned function changing identity every render.
    const latest = useRef(callbacks);
    useEffect(() => { latest.current = callbacks; });
    const [watched, setWatched] = useState<{ provider: MeetingImportProvider; jobId: string } | null>(null);
    const settleWatched = useRef<((outcome: UploadOutcome) => void) | null>(null);
    const importJob = useMeetingImportJob(watched?.provider ?? null, watched?.jobId ?? null);

    useEffect(() => {
        if (!watched || !settleWatched.current) return;
        const phase = importJob.timedOut ? 'failed' : importJobPhase(importJob.data);
        if (phase === 'running') return;
        const settle = settleWatched.current;
        settleWatched.current = null;
        latest.current.onUploading(null);
        if (phase === 'done') {
            const noteId = importJob.data?.transcriptionId ?? null;
            latest.current.onDone(noteId);
            settle({ ok: true, result: { id: noteId ?? undefined } });
        } else if (phase === 'waiting') {
            settle({ ok: false, pending: true, result: { jobId: watched.jobId } });
        } else {
            const code = importJob.timedOut ? 'timeout' : importJob.data?.errorCode;
            const error = Object.assign(new Error(importErrorText(t, code)), { code: code || 'failed' });
            latest.current.onFailed(error);
            settle({ ok: false, error });
        }
    }, [watched, importJob.data, importJob.timedOut, t]);

    return useCallback((provider: MeetingImportProvider, jobId: string): Promise<UploadOutcome> => {
        latest.current.onUploading(t('meetings.import_running', 'Importing the meeting. This can take a few minutes…'));
        return new Promise<UploadOutcome>((resolve) => {
            settleWatched.current = resolve;
            setWatched({ provider, jobId });
        });
    }, [t]);
}

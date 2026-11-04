/**
 * Following a Google Meet import after POST /from-gmeet answered 202
 * `{ jobId }`: the server downloads, transcribes and summarises in the
 * background, and the job row on GET /gmeet-imports carries the outcome. This
 * polls that row until it is done (the note), failed (with its stable
 * `errorCode`) or waiting for Google to finish the recording, then reports
 * which — once per follow. The web's useImportJobFollower and
 * utils/meetingImportJob do the same.
 */

import { useEffect, useRef, useState } from 'react';

import type { TranslateFn } from '@/core/i18n';

import { useMeetImportJob } from './queries';
import type { MeetImportJob } from '../model/types';

/**
 * running  the server is importing (or about to), also while it retries: a
 *          `pending` row is still queued, its `errorCode` only counts attempts
 * waiting  Google has not finished the recording yet; the server keeps checking
 * done     the note exists (`transcriptionId`)
 * failed   `errorCode` says why
 */
export type MeetImportPhase = 'running' | 'waiting' | 'done' | 'failed';

/** `undefined` is "not read yet" (running), `null` is "the list no longer has the job" (failed). */
export function meetImportPhase(job: MeetImportJob | null | undefined): MeetImportPhase {
    if (job === undefined) return 'running';
    if (job === null) return 'failed';
    if (job.transcriptionId || job.status === 'ingested') return 'done';
    if (job.status === 'awaiting_artifacts') return 'waiting';
    if (job.status === 'pending') return 'running';
    return 'failed';
}

/**
 * The sentence for the failure code an import job carries (server:
 * gmeetAutoImport), with the web's keys. One literal t() call per code.
 */
export function importErrorText(t: TranslateFn, code: string | null | undefined): string {
    switch (code) {
        case 'not_connected':
            return t('meetings.import_error_not_connected', 'Your account is not connected any more. Reconnect it and try again.');
        case 'needs_reauth':
            return t('meetings.import_error_needs_reauth', 'Access expired. Reconnect your account and try again.');
        case 'needs_teams_scopes':
        case 'needs_meet_scopes':
            return t('meetings.import_error_needs_scopes', 'Meeting access has not been granted. Reconnect your account to add it.');
        case 'not_organizer':
            return t('meetings.import_error_not_organizer', 'Only the organiser of a meeting can import it.');
        case 'no_recording':
        case 'no_conference':
            return t('meetings.import_error_no_recording', 'This meeting has no recording or transcript.');
        case 'recording_too_large':
            return t('meetings.import_error_too_large', 'The recording is too large to import.');
        case 'transcript_access_disabled':
        case 'speaker_attribution_disabled':
        case 'no_drive_access':
            return t('meetings.import_error_access_disabled', 'Your organisation does not allow access to this recording.');
        case 'empty_transcription':
            return t('meetings.import_error_empty', 'The recording contained no speech to transcribe.');
        case 'timeout':
            return t('meetings.import_error_timeout', 'The import took too long. Check the meeting notes later, or try again.');
        default:
            return t('meetings.import_error_failed', 'The import failed. Try again in a moment.');
    }
}

/** A job still running after this long is reported as failed: nothing is going to finish it. */
export const MEET_IMPORT_GIVE_UP_MS = 2 * 60 * 60 * 1000;

export interface MeetImportOutcome {
    /** The job ended with a note (its id, when the row carries it). */
    onDone: (noteId: string | null) => void;
    /** Google is still preparing the recording; the server imports it by itself later. */
    onWaiting: () => void;
    /** The job failed; `code` is the job's errorCode, `timeout` or `failed`. */
    onFailed: (code: string) => void;
}

const stillRunning = (job: MeetImportJob | null | undefined) => meetImportPhase(job) === 'running';

/**
 * Follow one job at a time. `follow(eventId, jobId)` starts; `following` is
 * the event whose import is still running (its row stays busy), null once
 * it has an outcome.
 */
export function useMeetImportFollow(outcome: MeetImportOutcome) {
    // Latest callbacks, so callers can pass inline functions.
    const latest = useRef(outcome);
    useEffect(() => {
        latest.current = outcome;
    });
    // `attempt` counts the follows: a re-import of a failed job gets the SAME
    // job id back (gmeet.js reuses the row) and must not settle on the old row.
    const attempts = useRef(0);
    const [watched, setWatched] = useState<{ eventId: string; jobId: string; attempt: number } | null>(null);
    const [timedOutFor, setTimedOutFor] = useState<number | null>(null);
    useEffect(() => {
        if (!watched) return undefined;
        const timer = setTimeout(() => setTimedOutFor(watched.attempt), MEET_IMPORT_GIVE_UP_MS);
        return () => clearTimeout(timer);
    }, [watched]);
    const timedOut = watched !== null && timedOutFor === watched.attempt;
    const job = useMeetImportJob(watched && !timedOut ? watched : null, stillRunning);
    let phase: MeetImportPhase | null = null;
    if (watched) phase = timedOut ? 'failed' : meetImportPhase(job.data);

    // The attempt whose outcome has been reported: each follow reports once.
    const reported = useRef(0);
    useEffect(() => {
        if (!watched || phase === null || phase === 'running' || reported.current === watched.attempt) return;
        reported.current = watched.attempt;
        if (phase === 'done') latest.current.onDone(job.data?.transcriptionId ?? null);
        else if (phase === 'waiting') latest.current.onWaiting();
        else latest.current.onFailed(timedOut ? 'timeout' : job.data?.errorCode || 'failed');
    }, [watched, phase, job.data, timedOut]);

    return {
        following: watched && phase === 'running' ? watched.eventId : null,
        follow: (eventId: string, jobId: string) => {
            attempts.current += 1;
            setWatched({ eventId, jobId, attempt: attempts.current });
        },
    };
}

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

type Sentence = (t: TranslateFn) => string;

const NEEDS_SCOPES: Sentence = (t) => t('meetings.import_error_needs_scopes', 'Meeting access has not been granted. Reconnect your account to add it.');
const NO_RECORDING: Sentence = (t) => t('meetings.import_error_no_recording', 'This meeting has no recording or transcript.');
const FAILED: Sentence = (t) => t('meetings.import_error_failed', 'The import failed. Try again in a moment.');

/** One literal t() call per code, with the web's keys (pages/meeting-notes/lib/importErrorText). */
const SENTENCES: Record<string, Sentence> = {
    not_connected: (t) => t('meetings.import_error_not_connected', 'Your account is not connected any more. Reconnect it and try again.'),
    needs_reauth: (t) => t('meetings.import_error_needs_reauth', 'Access expired. Reconnect your account and try again.'),
    needs_teams_scopes: NEEDS_SCOPES,
    needs_meet_scopes: NEEDS_SCOPES,
    not_organizer: (t) => t('meetings.import_error_not_organizer', 'Only the organiser of a meeting can import it.'),
    no_recording: NO_RECORDING,
    no_conference: NO_RECORDING,
    recording_too_large: (t) => t('meetings.import_error_too_large', 'The recording is too large to import.'),
    transcript_access_disabled: (t) => t('meetings.import_error_transcript_api_off', 'Your Teams admin has switched off API access to meeting transcripts.'),
    speaker_attribution_disabled: (t) => t('meetings.import_error_speaker_attribution_off', 'Your Teams admin does not allow speaker names in transcripts, so this transcript cannot be imported. A recording would work.'),
    no_drive_access: (t) => t('meetings.import_error_access_disabled', 'Your organisation does not allow access to this recording.'),
    graph_forbidden: (t) => t('meetings.import_error_graph_forbidden', 'Microsoft refused access to this meeting. A permission, licence or Teams policy blocks it. Your admin can run the Teams test.'),
    meeting_not_available: (t) => t('meetings.import_error_meeting_not_available', 'Microsoft has no online meeting for this calendar entry. It may have expired.'),
    application_access_policy_missing: (t) => t('meetings.import_error_access_policy', 'Your organisation\'s Teams application access policy does not allow Bee Flow for this account.'),
    calendar_forbidden: (t) => t('meetings.import_error_calendar_forbidden', 'Microsoft refused access to your calendar.'),
    graph_throttled: (t) => t('meetings.import_error_throttled', 'Microsoft is limiting requests right now. Try again in a few minutes.'),
    graph_unavailable: (t) => t('meetings.import_error_graph_unavailable', 'Microsoft Graph did not answer properly. Try again in a few minutes.'),
    download_failed: (t) => t('meetings.import_error_download_failed', 'The recording could not be downloaded from Microsoft. Try again.'),
    too_many_imports: (t) => t('meetings.import_error_too_many', 'Too many imports are running. Wait for one to finish.'),
    empty_transcription: (t) => t('meetings.import_error_empty', 'The recording contained no speech to transcribe.'),
    timeout: (t) => t('meetings.import_error_timeout', 'The import took too long. Check the meeting notes later, or try again.'),
    already_imported: (t) => t('meetings.import_error_already_imported', 'Someone else already imported this meeting. Ask them to share the meeting note with you.'),
    provider_not_allowed: (t) => t('meetings.import_error_provider_not_allowed', 'That transcription engine is not enabled for this workspace.'),
};

/**
 * The sentence for the failure code an import job carries (server:
 * gmeetAutoImport, teamsAutoImport). An unknown code gets the generic failure
 * sentence.
 */
export function importErrorText(t: TranslateFn, code: string | null | undefined): string {
    const sentence = code && Object.prototype.hasOwnProperty.call(SENTENCES, code) ? SENTENCES[code] : undefined;
    return (sentence ?? FAILED)(t);
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

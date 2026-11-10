/**
 * Meeting-source endpoints, all under /api/transcriptions (so behind the
 * Meeting Notes module and capability, like the rest of the feature).
 *
 * The Nextcloud import is SYNCHRONOUS on the server — it downloads,
 * transcribes and summarises before it answers (the route raises its own
 * timeout to ten minutes) — so it gets that deadline and never retries: a
 * retried import is a second transcription run. The Meet import runs in the
 * background: the server answers 202 with a job id at once and the job row on
 * GET /gmeet-imports carries the outcome (hooks/useMeetImportFollow). Both
 * dedup a recording already ingested and answer with that note instead.
 */

import { api } from '@/core/api/client';

import {
    readImportResult,
    readMeetImports,
    type ImportAnswer,
    readMeetMeetings,
    readMeetRecordings,
    readNextcloudConnected,
    readNextcloudFiles,
    readRecordAnswer,
    readTalkMeetings,
    readTalkRooms,
} from './readers';
import type {
    MeetConnection,
    MeetImportJob,
    MeetMeetings,
    MeetRecording,
    NextcloudFile,
    RecordAnswer,
    TalkMeetings,
    TalkRoom,
} from '../model/types';

const BASE = '/api/transcriptions';
const IMPORT_DEADLINE = 10 * 60_000;

export async function listTalkMeetings(signal?: AbortSignal): Promise<TalkMeetings> {
    return readTalkMeetings(await api.get<unknown>(`${BASE}/talk-meetings`, { signal }));
}

export async function listMeetMeetings(signal?: AbortSignal): Promise<MeetMeetings> {
    return readMeetMeetings(await api.get<unknown>(`${BASE}/gmeet-meetings`, { signal }));
}

/**
 * Whether this account has Nextcloud connected, from the per-user Talk
 * settings (outside /api/transcriptions). The Upcoming screen only warns about
 * Talk's recording backend to an account that has Nextcloud at all.
 */
export async function getNextcloudConnected(signal?: AbortSignal): Promise<boolean> {
    return readNextcloudConnected(await api.get<unknown>('/api/talk-notes-settings/user/me', { signal }));
}

/** Switch one Talk meeting's auto-record, by room token (and the calendar uid when known). */
export async function setTalkRecord(token: string, record: boolean, eventUid: string | null): Promise<RecordAnswer> {
    const body = { record, ...(eventUid ? { eventUid } : {}) };
    const res = await api.patch<unknown>(`${BASE}/talk-meetings/${encodeURIComponent(token)}`, body, { retry: false });
    return readRecordAnswer(res, record);
}

/** Switch one Meet meeting's auto-import, by calendar event id. */
export async function setMeetRecord(eventId: string, record: boolean, meetingCode: string | null): Promise<RecordAnswer> {
    const body = { record, ...(meetingCode ? { meetingCode } : {}) };
    const res = await api.patch<unknown>(`${BASE}/gmeet-meetings/${encodeURIComponent(eventId)}`, body, { retry: false });
    return readRecordAnswer(res, record);
}

/** Talk call recordings, grouped by conversation, newest first. */
export async function listTalkRecordings(signal?: AbortSignal): Promise<TalkRoom[]> {
    return readTalkRooms(await api.get<unknown>(`${BASE}/nextcloud-talk-recordings`, { signal }));
}

/** Audio files in one Nextcloud folder, newest first. */
export async function listNextcloudFiles(folder: string, signal?: AbortSignal): Promise<NextcloudFile[]> {
    return readNextcloudFiles(await api.get<unknown>(`${BASE}/nextcloud-audio-files`, { signal, query: { folder } }));
}

/**
 * Recently ended Meet meetings (a week back) and whether each has a
 * recording. Without Google (or without the Meet scopes) the list is empty
 * and `connection` says why.
 */
export async function listMeetRecordings(
    signal?: AbortSignal,
): Promise<{ connection: MeetConnection; items: MeetRecording[] }> {
    return readMeetRecordings(await api.get<unknown>(`${BASE}/gmeet-recordings`, { signal }));
}

/** The auto-import jobs of the last week. */
export async function listMeetImports(signal?: AbortSignal): Promise<MeetImportJob[]> {
    return readMeetImports(await api.get<unknown>(`${BASE}/gmeet-imports`, { signal }));
}

/** Pull one Nextcloud file (a Talk recording or any audio file) into the pipeline. */
export async function importFromNextcloud(path: string, title: string): Promise<ImportAnswer> {
    const res = await api.post<unknown>(`${BASE}/from-nextcloud`, { nextcloud_path: path, title }, {
        retry: false,
        timeoutMs: IMPORT_DEADLINE,
    });
    return readImportResult(res);
}

/**
 * Import one Meet recording: the note when it was already imported, else a
 * 202 with the background job (`pending`, `jobId`) to follow.
 */
export async function importFromMeet(recording: Pick<MeetRecording, 'eventId' | 'meetingCode' | 'title'>): Promise<ImportAnswer> {
    const body = {
        event_id: recording.eventId,
        ...(recording.meetingCode ? { meeting_code: recording.meetingCode } : {}),
        ...(recording.title ? { title: recording.title } : {}),
    };
    return readImportResult(await api.post<unknown>(`${BASE}/from-gmeet`, body, { retry: false, timeoutMs: IMPORT_DEADLINE }));
}

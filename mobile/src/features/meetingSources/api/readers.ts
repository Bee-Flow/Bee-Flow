/**
 * Contract readers for the meeting-source routes, each traced to the handler
 * that serialises it:
 *
 *   /talk-meetings              nextcloud.js — `{ ...talkCalendar row, isModerator,
 *                               recordingNow, excluded, tags, recordReason,
 *                               recordDecided, recordedNoteId, status }`
 *   /gmeet-meetings             gmeet.js — `{ ...gmeetCalendar row, excluded, tags,
 *                               recordReason, recordDecided, organizerSelf,
 *                               recordingControlledByHost, importedNoteId, status }`
 *   PATCH either                `{ effectiveRecord, overridden }`
 *   /nextcloud-talk-recordings  `{ folder, count, rooms: [{ token, name?, recordings }] }`
 *   /nextcloud-audio-files      `{ folder, count, items: [{ name, path, size, contentType, lastModified }] }`
 *   /gmeet-recordings           `{ connection, items: [...] }`
 *   /gmeet-imports              `{ items: [...] }`
 *   /from-nextcloud             the ingested note (`{ id, title, … }`)
 *   /from-gmeet                 the note, or 202 `{ jobId, status }`
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type {
    ImportResult,
    MeetConnection,
    MeetImportJob,
    MeetMeetings,
    MeetRecording,
    NextcloudFile,
    RecordAnswer,
    TalkMeetings,
    TalkRoom,
} from '../model/types';

const UPCOMING_BASE = {
    title: field.str(''),
    start: field.strOrNull,
    end: field.strOrNull,
    excluded: field.bool(false),
    recordReason: field.strOrNull,
    recordDecided: field.bool(true),
    tags: field.strArray,
    attendees: (v: unknown): unknown[] => (Array.isArray(v) ? v : []),
    participantCount: field.numOrNull,
};

const readTalkMeeting = shapeOf({
    ...UPCOMING_BASE,
    uid: field.strOrNull,
    talkToken: field.str(''),
    organizer: field.raw,
    isModerator: (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null),
    status: field.oneOf(
        ['recording_now', 'recorded', 'not_moderator', 'will_record', 'decides_at_start', 'upcoming'] as const,
        'upcoming',
    ),
    recordedNoteId: field.strOrNull,
});

export const readTalkMeetings: (raw: unknown) => TalkMeetings = shapeOf({
    recordingEnabled: field.bool(false),
    autoRecord: field.bool(false),
    recordingMode: field.str('audio'),
    postSummaryBack: field.optBool,
    meetings: field.list(readTalkMeeting),
});

const readConnection: (raw: unknown) => MeetConnection = shapeOf({
    googleConnected: field.bool(false),
    meetScopesGranted: field.bool(false),
    hasSettingsScope: field.bool(false),
    needsReauth: field.bool(false),
});

const readMeetMeeting = shapeOf({
    ...UPCOMING_BASE,
    eventId: field.str(''),
    meetingCode: field.strOrNull,
    organizerEmail: field.strOrNull,
    organizerSelf: field.bool(false),
    recordingControlledByHost: field.bool(false),
    importedNoteId: field.strOrNull,
    status: field.str('upcoming'),
});

export const readMeetMeetings: (raw: unknown) => MeetMeetings = shapeOf({
    connection: readConnection,
    autoImport: field.bool(false),
    autoRecordConfig: field.bool(false),
    meetings: field.list(readMeetMeeting),
});

/**
 * The toggle's answer. A body without `effectiveRecord` (an older server)
 * falls back to what was asked, as the web does.
 */
export function readRecordAnswer(raw: unknown, asked: boolean): RecordAnswer {
    const effective = pick(raw, 'effectiveRecord');
    return {
        effectiveRecord: typeof effective === 'boolean' ? effective : asked,
        overridden: pick(raw, 'overridden') === true,
    };
}

const readRecording = shapeOf({
    name: field.str(''),
    path: field.str(''),
    size: field.numOrNull,
    lastModified: field.strOrNull,
    kind: field.str('audio'),
});

const readRooms: (raw: unknown) => TalkRoom[] = shapeListOf({
    token: field.str(''),
    name: field.strOrNull,
    recordings: field.list(readRecording),
});

export function readTalkRooms(raw: unknown): TalkRoom[] {
    return readRooms(pick(raw, 'rooms')).filter((room) => room.recordings.length > 0);
}

const readFiles: (raw: unknown) => NextcloudFile[] = shapeListOf({
    name: field.str(''),
    path: field.str(''),
    size: field.numOrNull,
    lastModified: field.strOrNull,
});

export function readNextcloudFiles(raw: unknown): NextcloudFile[] {
    return readFiles(pick(raw, 'items')).filter((file) => file.path);
}

const readMeetRows: (raw: unknown) => MeetRecording[] = shapeListOf({
    eventId: field.str(''),
    meetingCode: field.strOrNull,
    title: field.str(''),
    start: field.strOrNull,
    end: field.strOrNull,
    recordingState: field.oneOf(['available', 'processing', 'none'] as const, 'none'),
    importedNoteId: field.strOrNull,
});

export function readMeetRecordings(raw: unknown): { connection: MeetConnection; items: MeetRecording[] } {
    return { connection: readConnection(pick(raw, 'connection')), items: readMeetRows(pick(raw, 'items')) };
}

const readJobs: (raw: unknown) => MeetImportJob[] = shapeListOf({
    id: field.str(''),
    title: field.strOrNull,
    meetingStart: field.strOrNull,
    status: field.str(''),
    errorCode: field.strOrNull,
    transcriptionId: field.strOrNull,
});

export function readMeetImports(raw: unknown): MeetImportJob[] {
    return readJobs(pick(raw, 'items'));
}

/** A note id, or — for a Meet recording Google has not finished — a pending job. */
export function readImportResult(raw: unknown): ImportResult {
    const id = pick(raw, 'id');
    if (typeof id === 'string' && id) return { id, pending: false };
    return { id: null, pending: typeof pick(raw, 'jobId') === 'string' };
}

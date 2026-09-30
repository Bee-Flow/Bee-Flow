/**
 * The live-meeting sources of Meeting Notes: Nextcloud Talk and Google Meet,
 * both for what is coming up (auto-record toggles) and for what already
 * happened (recordings to import), plus plain Nextcloud audio files.
 *
 * Traced to server/routes/transcriptions/nextcloud.js and gmeet.js; a Talk
 * meeting's calendar fields are core/meetingNotes/talkCalendar.js, a Meet
 * one's gmeetCalendar.js. Microsoft Teams has no source here: the server has
 * no Teams recording source and no teams-meetings route (see the header of
 * agent-hub UpcomingMeetings.jsx), so a Teams row would switch nothing on.
 */

/** Why a meeting is (not) recorded by default: meetingPrefsStore `decide`. */
export type RecordReason = 'opted_in' | 'opted_out' | 'small_meeting' | 'unknown_size' | string;

/** The fields both providers' upcoming rows share, as the row renders them. */
export interface UpcomingBase {
    title: string;
    /** ISO time, or a bare date for an all-day event, or null when unknown. */
    start: string | null;
    end: string | null;
    /** The EFFECTIVE switch: true means "will not be recorded". */
    excluded: boolean;
    recordReason: RecordReason | null;
    /** False while the outcome waits on a head count at the start of the call. */
    recordDecided: boolean;
    /** The tags on the calendar event's preferences (not a note's tags). */
    tags: string[];
    attendees: unknown[];
    participantCount?: number | null;
}

export type TalkStatus =
    | 'recording_now'
    | 'recorded'
    | 'not_moderator'
    | 'will_record'
    | 'decides_at_start'
    | 'upcoming';

export interface TalkMeeting extends UpcomingBase {
    uid: string | null;
    talkToken: string;
    organizer: unknown;
    /** Null when the room list did not answer. */
    isModerator: boolean | null;
    status: TalkStatus;
    recordedNoteId: string | null;
}

export interface TalkMeetings {
    /** The Talk recording backend is configured; without it nothing can auto-record. */
    recordingEnabled: boolean;
    autoRecord: boolean;
    recordingMode: 'audio' | 'video' | string;
    /** Undefined when the server did not say — not the same as false. */
    postSummaryBack: boolean | undefined;
    meetings: TalkMeeting[];
}

export interface MeetConnection {
    googleConnected: boolean;
    meetScopesGranted: boolean;
    hasSettingsScope: boolean;
    needsReauth: boolean;
}

export interface MeetMeeting extends UpcomingBase {
    eventId: string;
    meetingCode: string | null;
    organizerEmail: string | null;
    organizerSelf: boolean;
    recordingControlledByHost: boolean;
    importedNoteId: string | null;
    status: string;
}

export interface MeetMeetings {
    connection: MeetConnection;
    autoImport: boolean;
    autoRecordConfig: boolean;
    meetings: MeetMeeting[];
}

/** What a record toggle answers: the state that holds after the write. */
export interface RecordAnswer {
    effectiveRecord: boolean;
    /** A wider rule (org-wide, or the series) kept it from what was asked. */
    overridden: boolean;
}

export interface TalkRecording {
    name: string;
    path: string;
    size: number | null;
    lastModified: string | null;
    kind: 'audio' | 'video' | string;
}

export interface TalkRoom {
    token: string;
    /** The conversation's display name; absent when Talk did not answer. */
    name: string | null;
    recordings: TalkRecording[];
}

export interface NextcloudFile {
    name: string;
    path: string;
    size: number | null;
    lastModified: string | null;
}

export type MeetRecordingState = 'available' | 'processing' | 'none';

export interface MeetRecording {
    eventId: string;
    meetingCode: string | null;
    title: string;
    start: string | null;
    end: string | null;
    recordingState: MeetRecordingState;
    importedNoteId: string | null;
}

export interface MeetImportJob {
    id: string;
    title: string | null;
    meetingStart: string | null;
    status: string;
    errorCode: string | null;
    transcriptionId: string | null;
}

/** What an import answers: a note id, or (Meet only) a job still waiting on Google. */
export interface ImportResult {
    id: string | null;
    pending: boolean;
}

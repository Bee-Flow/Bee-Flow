/**
 * One list out of the two providers' upcoming meetings, as agent-hub
 * UpcomingMeetings.jsx builds it: Talk and Meet rows together, by start time,
 * each carrying the status its chip shows and what its switch may do.
 */

import type { MeetMeeting, MeetMeetings, TalkMeeting, TalkMeetings } from './types';

export type UpcomingRow =
    | { provider: 'talk'; key: string; status: string; noteId: string | null; toggleable: boolean; meeting: TalkMeeting }
    | { provider: 'gmeet'; key: string; status: string; noteId: string | null; toggleable: boolean; meeting: MeetMeeting };

/**
 * A Meet row's chip, derived here so a flipped switch updates the chip
 * without a round trip — the server's status plus the host-controls-recording
 * refinement (a meeting you do not organise is recorded by its host).
 */
export function meetChipStatus(m: MeetMeeting, autoImport: boolean): string {
    if (m.status === 'not_organizer') return 'not_organizer';
    if (m.importedNoteId || m.status === 'imported') return 'recorded';
    if (m.excluded || !autoImport) return 'upcoming';
    return m.recordingControlledByHost ? 'manual_record' : 'will_record';
}

/**
 * The calendar uid as well as the room: two events in one Talk room (the
 * server keeps one row per uid and token) are two rows, and each keeps its
 * own busy, error and override state. The web keys its list the same way.
 */
export const talkKey = (m: TalkMeeting) => `talk:${m.uid ?? ''}:${m.talkToken}`;
export const meetKey = (m: MeetMeeting) => `gmeet:${m.eventId}`;

const startOf = (start: string | null) => new Date(start || 0).getTime() || 0;

export function upcomingRows(talk: TalkMeetings | null, meet: MeetMeetings | null): UpcomingRow[] {
    const rows: UpcomingRow[] = [];
    for (const m of talk?.meetings ?? []) {
        rows.push({
            provider: 'talk',
            key: talkKey(m),
            status: m.status,
            noteId: m.recordedNoteId,
            // No recording backend, or not a moderator: the switch can change nothing.
            toggleable: Boolean(talk?.recordingEnabled) && m.isModerator !== false,
            meeting: m,
        });
    }
    for (const m of meet?.meetings ?? []) {
        rows.push({
            provider: 'gmeet',
            key: meetKey(m),
            status: meetChipStatus(m, Boolean(meet?.autoImport)),
            noteId: m.importedNoteId,
            toggleable: meet?.connection.meetScopesGranted === true,
            meeting: m,
        });
    }
    return rows.sort((a, b) => startOf(a.meeting.start) - startOf(b.meeting.start));
}

/** The meeting as it stands after a toggle: the server's effective answer, not the request. */
export function applyRecordAnswer<M extends { excluded: boolean; recordReason: string | null; recordDecided: boolean }>(
    meeting: M,
    effectiveRecord: boolean,
): M {
    return {
        ...meeting,
        excluded: !effectiveRecord,
        recordReason: effectiveRecord ? 'opted_in' : 'opted_out',
        recordDecided: true,
    };
}

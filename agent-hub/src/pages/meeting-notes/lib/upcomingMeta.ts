/**
 * The meta line of a Scheduled row: `time · duration · participants` (the provider stands as a chip behind those pieces), plus the footer line about what happens to the OTHER participants. Pure functions, so that the rules that matter here can be tested without the DOM.
 *
 * ── WHAT WE DO NOT KNOW, WE DO NOT SAY ─────────────────────────────────
 * No single provider supplies a DURATION (gmeetCalendar.js:29-49 and talkCalendar.js:66-75 give only start/end), so that is derived here from `end - start`. If `end` is missing, or the appointment is a whole day (a DATE without a time), the duration is UNKNOWN and nothing is shown — not "0 min".
 * The same goes for participants: Talk reads them from the ICS ATTENDEE property (nextcloudCalendarTools.js:205-208), and an ad-hoc room without a calendar appointment supplies an EMPTY list; empty means "the calendar told us nothing", not "zero people". A zero that is actually unknown has been a finding in this program three times already.
 */

import { nOf } from '@/components/admin/Studio/KnowledgeStudio/plural';
import type { TranslateFn } from '@/hooks/useTranslation';
import { parseWhen, meetingDurationMinutes, dateBlockParts, timeRange } from './upcomingWhen';

// The date rules sit in an IMPORT-FREE sibling module, so that the whole-day fix
// can be tested in a child process under a negative time zone — in UTC the good
// and the bad implementation give the same answer. Re-exported here so that
// callers and tests notice nothing.
export { parseWhen, meetingDurationMinutes, dateBlockParts, timeRange };

/**
 * The number of participants, or NULL if the calendar said nothing about it.
 *
 * This mirrors `meetingPrefsStore.participantCountOf` (server) — the same count, because the server uses it to decide the 1-on-1 default, and a row that shows "4 participants" while the server counted 5 does not explain the state of the toggle. The server module is CommonJS in `server/` and so cannot be imported into the SPA; if a `participantCount` ever appears in the payload, that wins, and this derivation is then only the fallback.
 *
 * An EMPTY participant list yields NULL: that is "the calendar told us nothing".
 * A 0 from the payload is unknown for the same reason, not zero people.
 */
export interface Attendee {
    email?: string;
    cn?: string;
    displayName?: string;
    name?: string;
}

/** A calendar meeting as Talk, Meet and Teams hand it over (the fields this module and the Upcoming panel read). */
export interface UpcomingMeeting {
    title?: string;
    start?: string | null;
    end?: string | null;
    participantCount?: number | null;
    attendees?: (Attendee | string | null)[];
    organizerEmail?: string;
    organizer?: Attendee | string | null;
    tags?: string[];
    status?: string;
    excluded?: boolean;
    recordReason?: string | null;
    recordDecided?: boolean;
    importedNoteId?: string | null;
    organizerSelf?: boolean;
    isModerator?: boolean;
    uid?: string;
    seriesMasterId?: string;
    meetingCode?: string;
}

export interface MetaSegment {
    key: string;
    text: string;
    title?: string;
    dim?: boolean;
}

export interface AttendeeNotice {
    key: string;
    en: string;
}

export interface NoticeRow {
    provider: string;
    m?: UpcomingMeeting;
    status?: string;
}

export interface AttendeeNoticeInput {
    rows?: NoticeRow[];
    postSummaryBack?: boolean;
    meetAutoRecordArmed?: boolean;
    teamsAutoRecordArmed?: boolean;
}

export interface RecordHintOptions {
    recordDecided?: boolean;
    overridden?: boolean;
}

function identityOf(entry: Attendee | string | null | undefined): string | null {
    if (entry && typeof entry === 'object') return entry.email || entry.cn || entry.displayName || entry.name || null;
    return typeof entry === 'string' ? entry : null;
}

function organizerIdentityOf(meeting: UpcomingMeeting): string | null {
    if (meeting.organizerEmail) return meeting.organizerEmail;          // Meet
    const organizer = meeting.organizer;                                 // Talk (ICS ORGANIZER)
    if (organizer && typeof organizer === 'object') return organizer.email || organizer.cn || null;
    return typeof organizer === 'string' ? organizer : null;
}

export function attendeeCountOf(meeting: UpcomingMeeting | null | undefined): number | null {
    if (!meeting || typeof meeting !== 'object') return null;

    const explicit = meeting.participantCount;
    if (explicit !== undefined && explicit !== null) {
        if (typeof explicit !== 'number' || !Number.isFinite(explicit) || explicit < 0) return null;
        const n = Math.floor(explicit);
        return n > 0 ? n : null;
    }

    if (!Array.isArray(meeting.attendees)) return null;
    const ids = new Set<string>();
    let anon = 0;
    for (const entry of meeting.attendees) {
        const ident = identityOf(entry);
        if (ident) ids.add(String(ident).trim().toLowerCase());
        else anon += 1;   // a participant without a name is still a participant
    }
    const organizer = organizerIdentityOf(meeting);
    if (organizer) ids.add(String(organizer).trim().toLowerCase());

    const total = ids.size + anon;
    return total > 0 ? total : null;
}

/** The tags of this meeting (meeting_prefs). Anything that is not text is dropped. */
export function meetingTags(m: UpcomingMeeting | null | undefined): string[] {
    return (Array.isArray(m?.tags) ? m.tags : []).filter((x: string) => typeof x === 'string' && x.trim()).map((x: string) => x.trim());
}

/** '30 min' / '2 hr' / '1 hr 30 min'; '' als de duur onbekend is. */
export function durationPhrase(minutes: number | null | undefined, t: TranslateFn): string {
    if (minutes == null) return '';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h && m) return t('meetings.upcoming_duration_hm', '{hours} hr {minutes} min', { hours: h, minutes: m });
    if (h) return t('meetings.upcoming_duration_h', '{count} hr', { count: h });
    return t('meetings.upcoming_duration_m', '{count} min', { count: m });
}

/**
 * The pieces of the meta line: time · duration · participants.
 *
 * A piece we do not know is NOT shown. The only exception is the number of participants: that becomes "participants unknown", because it is precisely the reason the toggle is off by default (`recordReason: 'unknown_size'`), and an empty spot would leave that state unexplained.
 *
 * `nOf` places the ternary AROUND the KEY (base + `_plural`), never a "participant(s)" in the sentence.
 */
export function metaSegments(m: UpcomingMeeting | null | undefined, t: TranslateFn): MetaSegment[] {
    const out: MetaSegment[] = [];
    const when = parseWhen(m?.start);
    if (when && when.dateOnly) out.push({ key: 'time', text: t('meetings.upcoming_all_day', 'All day') });
    else {
        const range = timeRange(m?.start, m?.end);
        if (range) out.push({ key: 'time', text: range });
    }

    const duration = durationPhrase(meetingDurationMinutes(m?.start, m?.end), t);
    if (duration) out.push({ key: 'duration', text: duration });

    const count = attendeeCountOf(m);
    out.push(count === null
        ? {
            key: 'attendees',
            text: t('meetings.upcoming_attendees_unknown', 'participants unknown'),
            title: t('meetings.upcoming_attendees_unknown_hint', "This calendar invite doesn't list who is coming."),
            dim: true,
        }
        : { key: 'attendees', text: nOf(t, 'meetings.upcoming_attendees', count, '{count} participant', '{count} participants') });

    return out;
}

/**
 * Why is this toggle off? Only if the server sent a reason.
 *
 * `recordDecided === false` means: the server is still going to look at it (Talk counts who is really in the call at its start). Then "off" is the wrong sentence — that state has not yet been decided.
 *
 * `opted_out` gets an explanation as soon as the choice did NOT come from the reader themselves (`overridden`): an organisation-wide exclusion, or the series row beside the occurrence. Without that distinction a user saw his own click jump back without a single word of why.
 */
export function recordReasonHint(reason: string | null | undefined, record: boolean, t: TranslateFn, opts: RecordHintOptions = {}): string | undefined {
    const { recordDecided, overridden } = opts;
    if (record) return undefined;
    if (recordDecided === false) {
        return t('meetings.upcoming_undecided_hint', 'Not decided yet: Bee Flow counts who is in the call when it starts. Switch this on to record it either way.');
    }
    if (!reason) return undefined;
    if (reason === 'opted_out') {
        return overridden
            ? t('meetings.upcoming_off_by_admin', "Kept off by a wider rule — your organisation, or the whole recurring series. Your own switch can't override it.")
            : undefined;
    }
    if (reason === 'small_meeting') return t('meetings.upcoming_off_one_on_one', 'Off by default: this looks like a one-on-one.');
    if (reason === 'unknown_size') return t('meetings.upcoming_off_unknown_size', "Off by default: the calendar doesn't say who is coming.");
    return undefined;
}

/**
 * The word under the toggle. "Skip" is a CLAIM that nothing happens; with a decision not yet taken, that is untrue.
 */
export function toggleStateLabel(record: boolean, recordDecided: boolean | undefined, t: TranslateFn): string {
    if (record) return t('meetings.upcoming_record', 'Record');
    // Dezelfde sleutel als de statuschip: één woord, één vertaling.
    if (recordDecided === false) return t('meetings.upcoming_decides', 'Decides at start');
    return t('meetings.upcoming_skip', 'Skip');
}

/**
 * What happens to the OTHER participants, and only what is true.
 *
 * Claim / deny / stay silent:
 *   - Talk posts the summary back only if `postSummaryBack` is on (default OFF, talkNotesSettings.js) — and even then with `silent: true` (ingestNextcloudRecording.js), so the message stands in the conversation WITHOUT a notification. "Participants receive a notification" is therefore not true there either; the sentence says what really happens.
 *   - If `postSummaryBack` is false, we may deny that.
 *   - If the payload says NOTHING about it (the field is missing), we stay silent: unknown is neither a promise nor a denial.
 *   - Meet itself says nothing about the NOTE, but it does share read rights with participants who have their own Bee Flow account on the same Google address (ingestGmeetRecording.js → resolveSharedWith). Read rights are not a notification — that difference is in the sentence.
 *
 * ── THE GOOGLE MEET RECORDING NOTICE ITSELF ─────────────────────────
 * The Meet sentence ended on "They are not notified", while THIS SAME toggle can switch on Google Meet's OWN auto-recording: with `record: true` and a meetingCode, the PATCH calls `setAutoRecording(...)`, which does `spaces.patch` with `autoRecordingGeneration: 'ON'` (gmeetArtifacts.js). Meet ALWAYS announces an ongoing recording to all participants. That sentence therefore denied a notification that the button beneath it actually causes.
 * Hence the second Meet line, and only when it truly applies: the org/user has `autoRecordConfig` on, the Google connection has the settings scope, and the reader organises at least one of the rows that are actually imported. With Talk the recording notice is deliberately NOT there: Nextcloud Talk sets that itself, on the customer's server — that is behaviour of another product, not a promise from us. Here Bee Flow sets the flag ITSELF, from this button, so here it IS our statement.
 *
 * ── ONLY ABOUT ROWS THAT ACTUALLY YIELD A NOTE ──────────────────────
 * `!excluded` is the state of the SWITCH, not the outcome: the route computes it with `fallback: true` and for `will_record` also needs the global switch, the recording back-end and the moderator status (Meet: `autoImport` plus the scopes). Going by `!excluded` set the promise "the summary will be posted back" under a list where the banner above reported that the recording back-end is not configured at all. Therefore the STATUS that the row itself already carries counts here.
 */
export const NOTICE_TALK_POST = Object.freeze({
    key: 'meetings.upcoming_notice_talk_post',
    en: 'Nextcloud Talk: the summary is posted back into the conversation afterwards, as a silent message — nobody gets a notification.',
});
export const NOTICE_TALK_QUIET = Object.freeze({
    key: 'meetings.upcoming_notice_talk_quiet',
    en: 'Nextcloud Talk: Bee Flow posts nothing back into the conversation, so the other participants never hear about the note from us.',
});
export const NOTICE_MEET_SHARE = Object.freeze({
    key: 'meetings.upcoming_notice_meet_share',
    en: 'Google Meet: participants who have a Bee Flow account on the same Google address can read the note afterwards. Bee Flow does not notify them.',
});
export const NOTICE_MEET_AUTORECORD = Object.freeze({
    key: 'meetings.upcoming_notice_meet_autorecord',
    en: 'Google Meet: switching a meeting you organise on also turns on Meet’s own auto-recording, and Meet announces a running recording to everyone in the call.',
});

export const NOTICE_TEAMS_SHARE = Object.freeze({
    key: 'meetings.upcoming_notice_teams_share',
    en: 'Microsoft Teams: colleagues in your organisation who were invited can read the note afterwards. Bee Flow does not notify them.',
});
export const NOTICE_TEAMS_AUTORECORD = Object.freeze({
    key: 'meetings.upcoming_notice_teams_autorecord',
    en: 'Microsoft Teams: switching a meeting you organise on also turns on Teams’ own automatic recording, and Teams shows everyone in the call that it is being recorded.',
});

/** The states in which a note will really come out of this row. */
const PRODUCES_NOTE = new Set<string | undefined>(['will_record', 'recording_now', 'will_import', 'manual_record', 'manual_record_teams']);

export function producesNote(row: NoticeRow | null | undefined): boolean {
    return PRODUCES_NOTE.has(row?.status);
}

/**
 * `rows` is [{ provider, m, status }] — `status` is the EFFECTIVE chip status of the row, not `!excluded`. `postSummaryBack` undefined = the payload said nothing. `meetAutoRecordArmed`: Meet's own auto-recording can be switched on by this button (autoRecordConfig on, settings scope present).
 * `teamsAutoRecordArmed`: same for Teams' "record automatically" (autoRecordConfig on, OnlineMeetings.ReadWrite granted).
 */
export function attendeeNotices({ rows = [], postSummaryBack, meetAutoRecordArmed = false, teamsAutoRecordArmed = false }: AttendeeNoticeInput = {}): AttendeeNotice[] {
    const on = (provider: string) => rows.some((r: NoticeRow) => r && r.provider === provider && producesNote(r));
    const notices: AttendeeNotice[] = [];
    if (on('talk')) {
        if (postSummaryBack === true) notices.push(NOTICE_TALK_POST);
        else if (postSummaryBack === false) notices.push(NOTICE_TALK_QUIET);
        // undefined → the payload did not say it; then we do not say it either.
    }
    if (on('gmeet')) {
        notices.push(NOTICE_MEET_SHARE);
        // Only if the button can actually cause that notice: the flag is set
        // exclusively for a meeting that the reader ORGANISES.
        const organises = rows.some((r: NoticeRow) => r && r.provider === 'gmeet' && producesNote(r) && r.m?.organizerSelf === true);
        if (meetAutoRecordArmed && organises) notices.push(NOTICE_MEET_AUTORECORD);
    }
    // Teams rows only produce a note for meetings the reader organises, so the
    // auto-record line needs no extra organiser check.
    if (on('teams')) {
        notices.push(NOTICE_TEAMS_SHARE);
        if (teamsAutoRecordArmed) notices.push(NOTICE_TEAMS_AUTORECORD);
    }
    return notices;
}

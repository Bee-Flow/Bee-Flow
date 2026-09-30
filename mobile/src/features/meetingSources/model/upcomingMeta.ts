/**
 * What an upcoming meeting's row may say, a port of agent-hub
 * pages/meeting-notes/lib/upcomingMeta.js (held to it by
 * upcomingMeta.lockstep.test.ts, which runs both on the same fixtures).
 *
 * The rule the web file is built on, and so this one: what we do not know we
 * do not say. No provider sends a duration (it is `end - start`, and unknown
 * for an all-day event); an empty attendee list means "the calendar told us
 * nothing", never "nobody is coming". A zero that was really an unknown has
 * been a finding three times on the web.
 */

import type { TranslateFn } from '@/core/i18n';

import type { RecordReason } from './types';
import { meetingDurationMinutes, parseWhen, timeRange } from './when';

function identityOf(entry: unknown): string | null {
    if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const id = e.email || e.cn || e.displayName || e.name;
        return typeof id === 'string' && id ? id : null;
    }
    return typeof entry === 'string' ? entry : null;
}

function organizerIdentityOf(meeting: Record<string, unknown>): string | null {
    if (typeof meeting.organizerEmail === 'string' && meeting.organizerEmail) return meeting.organizerEmail;
    const organizer = meeting.organizer;
    if (organizer && typeof organizer === 'object') {
        const o = organizer as Record<string, unknown>;
        const id = o.email || o.cn;
        return typeof id === 'string' && id ? id : null;
    }
    return typeof organizer === 'string' ? organizer : null;
}

/** How many people, or null when the calendar does not say. */
export function attendeeCountOf(meeting: unknown): number | null {
    if (!meeting || typeof meeting !== 'object') return null;
    const m = meeting as Record<string, unknown>;
    const explicit = m.participantCount;
    if (explicit !== undefined && explicit !== null) {
        if (typeof explicit !== 'number' || !Number.isFinite(explicit) || explicit < 0) return null;
        const n = Math.floor(explicit);
        return n > 0 ? n : null;
    }
    if (!Array.isArray(m.attendees)) return null;
    const ids = new Set<string>();
    let anonymous = 0;
    for (const entry of m.attendees) {
        const ident = identityOf(entry);
        if (ident) ids.add(ident.trim().toLowerCase());
        else anonymous += 1;
    }
    const organizer = organizerIdentityOf(m);
    if (organizer) ids.add(organizer.trim().toLowerCase());
    const total = ids.size + anonymous;
    return total > 0 ? total : null;
}

export function durationPhrase(minutes: number | null, t: TranslateFn): string {
    if (minutes == null) return '';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h && m) return t('meetings.upcoming_duration_hm', '{hours} hr {minutes} min', { hours: h, minutes: m });
    if (h) return t('meetings.upcoming_duration_h', '{count} hr', { count: h });
    return t('meetings.upcoming_duration_m', '{count} min', { count: m });
}

export interface MetaSegment {
    key: 'time' | 'duration' | 'attendees';
    text: string;
    /** The explanation behind an unknown. */
    title?: string;
    dim?: boolean;
}

function attendeeSegment(count: number | null, t: TranslateFn): MetaSegment {
    if (count === null) {
        return {
            key: 'attendees',
            text: t('meetings.upcoming_attendees_unknown', 'participants unknown'),
            title: t('meetings.upcoming_attendees_unknown_hint', "This calendar invite doesn't list who is coming."),
            dim: true,
        };
    }
    const text =
        count === 1
            ? t('meetings.upcoming_attendees', '{count} participant', { count })
            : t('meetings.upcoming_attendees_plural', '{count} participants', { count });
    return { key: 'attendees', text };
}

/** `time · duration · participants`, leaving out what is unknown (but never the head count). */
export function metaSegments(m: { start: unknown; end: unknown }, t: TranslateFn): MetaSegment[] {
    const out: MetaSegment[] = [];
    const when = parseWhen(m.start);
    if (when && when.dateOnly) out.push({ key: 'time', text: t('meetings.upcoming_all_day', 'All day') });
    else {
        const range = timeRange(m.start, m.end);
        if (range) out.push({ key: 'time', text: range });
    }
    const duration = durationPhrase(meetingDurationMinutes(m.start, m.end), t);
    if (duration) out.push({ key: 'duration', text: duration });
    out.push(attendeeSegment(attendeeCountOf(m), t));
    return out;
}

export function meetingTags(m: { tags?: unknown }): string[] {
    return (Array.isArray(m.tags) ? m.tags : [])
        .filter((x): x is string => typeof x === 'string' && Boolean(x.trim()))
        .map((x) => x.trim());
}

/** Why a switch is off, when that is worth saying. Undefined when it is on. */
export function recordReasonHint(
    reason: RecordReason | null,
    record: boolean,
    t: TranslateFn,
    opts: { recordDecided?: boolean; overridden?: boolean } = {},
): string | undefined {
    if (record) return undefined;
    if (opts.recordDecided === false) {
        return t(
            'meetings.upcoming_undecided_hint',
            'Not decided yet: Bee Flow counts who is in the call when it starts. Switch this on to record it either way.',
        );
    }
    if (reason === 'opted_out') {
        return opts.overridden
            ? t(
                  'meetings.upcoming_off_by_admin',
                  "Kept off by a wider rule — your organisation, or the whole recurring series. Your own switch can't override it.",
              )
            : undefined;
    }
    if (reason === 'small_meeting') return t('meetings.upcoming_off_one_on_one', 'Off by default: this looks like a one-on-one.');
    if (reason === 'unknown_size') {
        return t('meetings.upcoming_off_unknown_size', "Off by default: the calendar doesn't say who is coming.");
    }
    return undefined;
}

export function toggleStateLabel(record: boolean, recordDecided: boolean | undefined, t: TranslateFn): string {
    if (record) return t('meetings.upcoming_record', 'Record');
    if (recordDecided === false) return t('meetings.upcoming_decides', 'Decides at start');
    return t('meetings.upcoming_skip', 'Skip');
}

/** A footer sentence, carried as its catalogue key and English. */
export interface Notice {
    i18nKey: string;
    en: string;
}

export const NOTICE_TALK_POST: Notice = {
    i18nKey: 'meetings.upcoming_notice_talk_post',
    en: 'Nextcloud Talk: the summary is posted back into the conversation afterwards, as a silent message — nobody gets a notification.',
};
export const NOTICE_TALK_QUIET: Notice = {
    i18nKey: 'meetings.upcoming_notice_talk_quiet',
    en: 'Nextcloud Talk: Bee Flow posts nothing back into the conversation, so the other participants never hear about the note from us.',
};
export const NOTICE_MEET_SHARE: Notice = {
    i18nKey: 'meetings.upcoming_notice_meet_share',
    en: 'Google Meet: participants who have a Bee Flow account on the same Google address can read the note afterwards. Bee Flow does not notify them.',
};
export const NOTICE_MEET_AUTORECORD: Notice = {
    i18nKey: 'meetings.upcoming_notice_meet_autorecord',
    en: 'Google Meet: switching a meeting you organise on also turns on Meet’s own auto-recording, and Meet announces a running recording to everyone in the call.',
};

const PRODUCES_NOTE = new Set(['will_record', 'recording_now', 'will_import', 'manual_record']);

export interface NoticeRow {
    provider: 'talk' | 'gmeet';
    status: string;
    organizerSelf?: boolean;
}

export function producesNote(row: { status: string }): boolean {
    return PRODUCES_NOTE.has(row.status);
}

/** The footer: what the other participants get, per provider, only for rows that will make a note. */
export function attendeeNotices(input: {
    rows: readonly NoticeRow[];
    postSummaryBack: boolean | undefined;
    meetAutoRecordArmed: boolean;
}): Notice[] {
    const on = (provider: NoticeRow['provider']) => input.rows.some((r) => r.provider === provider && producesNote(r));
    const notices: Notice[] = [];
    if (on('talk')) {
        if (input.postSummaryBack === true) notices.push(NOTICE_TALK_POST);
        else if (input.postSummaryBack === false) notices.push(NOTICE_TALK_QUIET);
    }
    if (on('gmeet')) {
        notices.push(NOTICE_MEET_SHARE);
        const organises = input.rows.some((r) => r.provider === 'gmeet' && producesNote(r) && r.organizerSelf === true);
        if (input.meetAutoRecordArmed && organises) notices.push(NOTICE_MEET_AUTORECORD);
    }
    return notices;
}

/**
 * What an approved draft posts back, per kind — built from an ALLOW-LIST of
 * the fields each route's `.strict()` schema reads, never by posting the
 * streamed record as it came. The web posts the record verbatim (with the
 * `status` it added on arrival), which a strict schema refuses as a 400; and
 * a field the draft builder grows next year must not reach a route that
 * would refuse it, or one that would forward it.
 *
 * The schemas: routes/integrations/gmail.js and outlook.js `EmailBody`,
 * calendar.js `CalendarAction`, contacts.js `ContactsAction`, keep.js
 * `KeepAction`, linkedin.js `PostBody` (pinned in serverContract.test.ts).
 */

import type { DraftKind, DraftRecord } from './types';

export const GMAIL_KEYS = ['to', 'subject', 'body', 'cc', 'bcc', 'threadId', 'inReplyTo', 'references', 'replyToMessageId'] as const;
export const OUTLOOK_KEYS = ['to', 'subject', 'body', 'cc', 'bcc', 'replyToMessageId', 'conversationId', '_provider'] as const;
export const CALENDAR_KEYS = [
    'action', '_provider', 'eventId', 'title', 'startTime', 'endTime', 'timeZone',
    'description', 'location', 'attendees', 'allDay', 'addGoogleMeet', 'isOnlineMeeting',
] as const;
export const CONTACTS_KEYS = [
    'action', '_provider', 'resourceName', 'firstName', 'lastName', 'email', 'company', 'notes',
    'contactId', 'givenName', 'surname', 'emailAddress', 'companyName', 'phone', 'jobTitle',
] as const;
export const KEEP_KEYS = ['action', 'type', 'title', 'content', 'listItems', 'noteId'] as const;

/** Exactly `keys`, and only the ones the draft carries. */
export function pickFields(draft: DraftRecord, keys: readonly string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (draft[key] !== undefined) out[key] = draft[key];
    return out;
}

/** An Outlook draft says so in `_provider`; anything else is Gmail's. */
export function isOutlook(draft: DraftRecord): boolean {
    return draft._provider === 'microsoft';
}

export function emailBody(draft: DraftRecord): Record<string, unknown> {
    return pickFields(draft, isOutlook(draft) ? OUTLOOK_KEYS : GMAIL_KEYS);
}

/**
 * BFSF-254: a CREATE drafted before drafts carried a zone would reach Google
 * as a bare local time. The phone's own zone stands in, at confirm time; an
 * update keeps the event's stored zone.
 */
export function calendarBody(draft: DraftRecord, zone = Intl.DateTimeFormat().resolvedOptions().timeZone): Record<string, unknown> {
    const body = pickFields(draft, CALENDAR_KEYS);
    if (body.action === 'create' && !body.allDay && !body.timeZone) body.timeZone = zone;
    return body;
}

export function contactsBody(draft: DraftRecord): Record<string, unknown> {
    return pickFields(draft, CONTACTS_KEYS);
}

/** A checklist item is `{ text, checked }` and nothing else (the schema is strict one level down too). */
export function keepBody(draft: DraftRecord): Record<string, unknown> {
    const body = pickFields(draft, KEEP_KEYS);
    if (Array.isArray(body.listItems)) {
        body.listItems = body.listItems.map((item) => {
            const i = (item ?? {}) as { text?: unknown; checked?: unknown };
            return { text: typeof i.text === 'string' ? i.text : '', ...(typeof i.checked === 'boolean' ? { checked: i.checked } : {}) };
        });
    }
    return body;
}

export function linkedInBody(draft: DraftRecord): { text: string } {
    return { text: typeof draft.text === 'string' ? draft.text : '' };
}

/** The execute route of the three kinds that have one. */
export const EXECUTE_PATH: Readonly<Partial<Record<DraftKind, string>>> = {
    calendar: '/api/integrations/calendar/execute',
    contacts: '/api/integrations/contacts/execute',
    keep: '/api/integrations/keep/execute',
};

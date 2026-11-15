/**
 * The Nextcloud calendar.* trigger events, split out of declared/nextcloud.js
 * to keep that file small (spread into that provider's `events`, in order).
 * Not under declared/ on purpose: everything there is loaded as a provider.
 *
 * `upcoming` is read by the poller and carries the event body; the others
 * are pushed by the connector (automationEventsWebhook.js normalisePayload)
 * and carry object metadata only: no summary, start or end.
 */

export const CALENDAR_EVENTS = [
    {
        id: 'calendar.event.upcoming',
        label: 'Calendar event upcoming (lead-time before start)',
        fields: ['uid', 'calendarId', 'calendarUri', 'summary', 'startsAt', 'endsAt', 'location', 'attendees', 'minutesUntilStart', 'actor', 'datetime'],
        sample: {
            uid: 'evt-9f2a',
            calendarId: 'personal',
            calendarUri: 'personal',
            summary: 'Kickoff with Nextcloud',
            startsAt: '2026-05-13T15:00:00+02:00',
            endsAt: '2026-05-13T15:30:00+02:00',
            location: 'Online',
            attendees: ['alice@example.com', 'bob@example.com'],
            minutesUntilStart: 15,
            actor: 'me',
            datetime: '2026-05-13T14:45:00Z',
        },
        scope: 'org',
        source: {
            kind: 'poller',
        },
    },
    {
        id: 'calendar.event.created',
        label: 'Calendar event created',
        fields: ['uid', 'calendarId', 'calendarUri', 'objectUri', 'summary', 'startsAt', 'endsAt', 'location', 'actor', 'datetime'],
        sample: {
            calendarUri: 'personal',
            objectUri: 'event-1.ics',
            uid: 'evt-9f2b',
            calendarId: 'personal',
            summary: 'Design review',
            startsAt: '2026-05-14T10:00:00+02:00',
            endsAt: '2026-05-14T11:00:00+02:00',
            location: '',
            actor: 'alice',
            datetime: '2026-05-13T09:00:00Z',
        },
        scope: 'org',
        source: {
            kind: 'push',
        },
    },
    {
        id: 'calendar.event.changed',
        label: 'Calendar event changed',
        fields: ['uid', 'calendarId', 'calendarUri', 'objectUri', 'summary', 'startsAt', 'endsAt', 'location', 'actor', 'datetime'],
        sample: {
            calendarUri: 'personal',
            objectUri: 'event-1.ics',
            uid: 'evt-9f2b',
            calendarId: 'personal',
            summary: 'Design review (moved)',
            startsAt: '2026-05-14T11:00:00+02:00',
            endsAt: '2026-05-14T12:00:00+02:00',
            location: 'Room 2',
            actor: 'alice',
            datetime: '2026-05-13T09:30:00Z',
        },
        scope: 'org',
        source: {
            kind: 'push',
        },
    },
    {
        // CalendarObjectDeletedEvent: with the calendar trash bin on
        // (Nextcloud's default) it fires when the event leaves the
        // trash bin for good, not when it is moved into it.
        id: 'calendar.event.deleted',
        label: 'Calendar event deleted permanently',
        fields: ['uid', 'calendarId', 'calendarUri', 'objectUri', 'actor', 'datetime'],
        sample: {
            calendarUri: 'personal',
            objectUri: 'event-1.ics',
            uid: 'evt-9f2b',
            calendarId: 'personal',
            actor: 'alice',
            datetime: '2026-05-13T10:00:00Z',
        },
        scope: 'org',
        source: {
            kind: 'push',
        },
    },
    {
        // CalendarObjectMovedEvent: `calendarId` / `calendarUri` name
        // the calendar it landed in (automationEventsWebhook.js).
        id: 'calendar.event.moved',
        label: 'Calendar event moved to another calendar',
        fields: ['uid', 'calendarId', 'calendarUri', 'objectUri', 'sourceCalendarId', 'targetCalendarId', 'actor', 'datetime'],
        sample: {
            calendarUri: 'work',
            objectUri: 'event-1.ics',
            uid: 'evt-9f2b',
            calendarId: 7,
            sourceCalendarId: 3,
            targetCalendarId: 7,
            actor: 'alice',
            datetime: '2026-05-13T10:05:00Z',
        },
        scope: 'org',
        source: {
            kind: 'push',
        },
    },
];

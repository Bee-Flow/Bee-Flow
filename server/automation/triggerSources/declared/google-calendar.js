/**
 * Google Calendar. Hand-written pollers in triggerBus.js (events.list with a
 * syncToken cursor; the upcoming-event poller keeps a fired-id set in its
 * cursor instead).
 *
 * Migrated verbatim from the hardcoded TRIGGER_PROVIDERS array and the
 * TRIGGER_FIELDS_BY_EVENT / TRIGGER_OUTPUT_SAMPLES maps. The catalog payload is
 * guarded byte-for-byte by triggerRegistry.golden.test.js.
 */
module.exports = { TRIGGER_SOURCES: [{
        id: 'google-calendar',
        label: 'Google Calendar',
        order: 20,
        defaultEvent: 'event.changed',
        availability: {
            kind: 'tools',
            apps: ['google-calendar'],
        },
        events: [
            {
                id: 'event.changed',
                label: 'Event changed',
                fields: [
                    'eventId',
                    'summary',
                    'description',
                    'start',
                    'end',
                    'status',
                    'calendarId',
                    'organizer',
                    'attendees',
                    'htmlLink',
                ],
                sample: {
                    eventId: 'evt-abc',
                    summary: 'Team standup',
                    description: 'Daily sync',
                    start: '2026-05-13T09:00:00+02:00',
                    end: '2026-05-13T09:30:00+02:00',
                    status: 'confirmed',
                    calendarId: 'primary',
                    organizer: {
                        email: 'me@example.com',
                        displayName: 'Me',
                    },
                    attendees: [
                        {
                            email: 'alice@example.com',
                            responseStatus: 'accepted',
                        },
                    ],
                    htmlLink: 'https://calendar.google.com/event?eid=…',
                },
                scope: 'user',
                source: {
                    kind: 'poller',
                },
            },
            {
                id: 'event.upcoming',
                label: 'Event upcoming (lead-time before start)',
                fields: [
                    'eventId',
                    'summary',
                    'description',
                    'start',
                    'end',
                    'status',
                    'calendarId',
                    'organizer',
                    'attendees',
                    'htmlLink',
                    'minutesUntilStart',
                ],
                sample: {
                    eventId: 'evt-abc',
                    summary: 'Team standup',
                    description: 'Daily sync',
                    start: '2026-05-13T09:00:00+02:00',
                    end: '2026-05-13T09:30:00+02:00',
                    status: 'confirmed',
                    calendarId: 'primary',
                    organizer: {
                        email: 'me@example.com',
                        displayName: 'Me',
                    },
                    attendees: [
                        {
                            email: 'alice@example.com',
                            responseStatus: 'accepted',
                        },
                    ],
                    htmlLink: 'https://calendar.google.com/event?eid=…',
                    minutesUntilStart: 15,
                },
                scope: 'user',
                source: {
                    kind: 'poller',
                },
            },
        ],
    }] };

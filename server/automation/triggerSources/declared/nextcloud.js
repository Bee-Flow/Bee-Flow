/**
 * Nextcloud triggers.
 *
 * Two delivery mechanisms, and which one an event uses is not a free choice:
 *
 *   push  — Nextcloud's bundled `webhook_listeners` app calls the Bee Flow
 *           connector. Only available for event classes that implement
 *           `OCP\\EventDispatcher\\IWebhookCompatibleEvent`: Files, SystemTag,
 *           Calendar, Forms and Tables. (The connector previously used AppAPI's
 *           `events_listener` API, which Nextcloud has since removed — that is
 *           why these events were all marked undeliverable.)
 *   bot    — Talk chat events, delivered by the Bee Flow Talk bot. Talk exposes
 *           no webhook-compatible event class, so a bot is the supported route
 *           — and it only sees conversations a moderator added the bot to.
 *   poller — everything else. Share and Deck events are NOT webhook-compatible
 *           upstream and have no bot equivalent, so they are read off the
 *           activity feed instead. Do not "upgrade" them to push without
 *           checking the interface first; registering an incompatible class
 *           makes Nextcloud fatal inside a background job.
 *
 * Events arrive for bot/federated actors with no userId, so fan-out is scoped
 * by organisation. The catalog payload is guarded byte-for-byte by
 * triggerRegistry.golden.test.js — regenerate the golden when editing this file.
 */
module.exports = { TRIGGER_SOURCES: [{
        id: 'nextcloud',
        label: 'Nextcloud',
        order: 40,
        defaultEvent: 'file.new',
        availability: {
            kind: 'tools',
            appPrefix: 'nextcloud',
        },
        events: [
            {
                id: 'file.new',
                label: 'New file',
                fields: ['activityId', 'path', 'name', 'extension', 'kind', 'actor', 'datetime', 'link'],
                sample: {
                    activityId: 12345,
                    path: '/Documents/Invoices/Invoice-2026-001.pdf',
                    name: 'Invoice-2026-001.pdf',
                    extension: 'pdf',
                    kind: 'file',
                    actor: 'alice',
                    datetime: '2026-05-13T09:15:00Z',
                    link: 'https://cloud.example.com/f/12345',
                },
                scope: 'org',
                source: {
                    kind: 'poller',
                },
            },
            {
                id: 'file.changed',
                label: 'File changed',
                fields: ['activityId', 'path', 'name', 'extension', 'kind', 'actor', 'datetime', 'link'],
                sample: {
                    activityId: 12346,
                    path: '/Documents/Invoices/Invoice-2026-001.pdf',
                    name: 'Invoice-2026-001.pdf',
                    extension: 'pdf',
                    kind: 'file',
                    actor: 'alice',
                    datetime: '2026-05-13T10:20:00Z',
                    link: 'https://cloud.example.com/f/12345',
                },
                scope: 'org',
                source: {
                    kind: 'poller',
                },
            },
            {
                id: 'file.deleted',
                label: 'File deleted',
                fields: ['activityId', 'path', 'name', 'extension', 'kind', 'actor', 'datetime', 'link'],
                sample: {
                    activityId: 12348,
                    path: '/Documents/Old/Draft.docx',
                    name: 'Draft.docx',
                    extension: 'docx',
                    kind: 'file',
                    actor: 'alice',
                    datetime: '2026-05-13T11:30:00Z',
                    link: 'https://cloud.example.com/f/12348',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'file.renamed',
                label: 'File renamed',
                fields: ['activityId', 'path', 'oldPath', 'name', 'extension', 'kind', 'actor', 'datetime', 'link'],
                sample: {
                    activityId: 12349,
                    path: '/Documents/Invoices/Invoice-2026-001.pdf',
                    oldPath: '/Documents/Invoices/draft.pdf',
                    name: 'Invoice-2026-001.pdf',
                    extension: 'pdf',
                    kind: 'file',
                    actor: 'alice',
                    datetime: '2026-05-13T11:45:00Z',
                    link: 'https://cloud.example.com/f/12345',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'share.received',
                label: 'Share received',
                fields: ['activityId', 'path', 'name', 'kind', 'actor', 'datetime', 'link'],
                sample: {
                    activityId: 12347,
                    path: '/Shared/Project.docx',
                    name: 'Project.docx',
                    kind: 'file',
                    actor: 'bob',
                    datetime: '2026-05-13T11:00:00Z',
                    link: 'https://cloud.example.com/f/22345',
                },
                scope: 'org',
                source: {
                    kind: 'poller',
                },
            },
            {
                id: 'share.created',
                label: 'Share created',
                fields: ['shareId', 'shareType', 'path', 'name', 'kind', 'actor', 'datetime', 'link'],
                sample: {
                    shareId: 778,
                    shareType: 'link',
                    path: '/Shared/Report.pdf',
                    name: 'Report.pdf',
                    kind: 'file',
                    actor: 'alice',
                    datetime: '2026-05-13T13:00:00Z',
                    link: 'https://cloud.example.com/s/AbCdEf',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
                deliverability: 'connector',
                deliverabilityNote: 'Nextcloud does not expose this event to webhooks (the underlying event class is not IWebhookCompatibleEvent), so it is read from the activity feed on the polling interval rather than delivered instantly.',
            },
            {
                id: 'activity.new',
                label: 'Any activity (advanced)',
                fields: ['activityId', 'type', 'subject', 'message', 'actor', 'objectName', 'link', 'datetime'],
                sample: {
                    activityId: 12350,
                    type: 'file_created',
                    subject: 'alice created Invoice-2026-001.pdf',
                    message: '',
                    actor: 'alice',
                    objectName: 'Invoice-2026-001.pdf',
                    link: 'https://cloud.example.com/f/12345',
                    datetime: '2026-05-13T09:15:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'poller',
                },
            },
            {
                id: 'notification.new',
                label: 'Notification received',
                fields: ['notificationId', 'app', 'subject', 'message', 'link', 'datetime'],
                sample: {
                    notificationId: 9876,
                    app: 'comments',
                    subject: 'alice mentioned you',
                    message: '@me please take a look',
                    link: 'https://cloud.example.com/comment/9876',
                    datetime: '2026-05-13T12:00:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'poller',
                },
            },
            {
                id: 'calendar.event.upcoming',
                label: 'Calendar event upcoming (lead-time before start)',
                fields: [
                    'uid',
                    'calendarId',
                    'summary',
                    'startsAt',
                    'endsAt',
                    'location',
                    'attendees',
                    'minutesUntilStart',
                    'actor',
                    'datetime',
                ],
                sample: {
                    uid: 'evt-9f2a',
                    calendarId: 'personal',
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
                fields: ['uid', 'calendarId', 'summary', 'startsAt', 'endsAt', 'location', 'actor', 'datetime'],
                sample: {
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
                fields: ['uid', 'calendarId', 'summary', 'startsAt', 'endsAt', 'location', 'actor', 'datetime'],
                sample: {
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
                id: 'deck.card.created',
                label: 'Deck card created',
                fields: ['cardId', 'boardId', 'stackId', 'title', 'description', 'done', 'archived', 'duedate', 'labels', 'assignedUsers', 'actor', 'datetime'],
                sample: {
                    cardId: 4521,
                    boardId: 12,
                    stackId: 34,
                    title: 'Follow up with Nextcloud',
                    description: 'Prep the integration demo',
                    done: null,
                    archived: false,
                    duedate: '2026-05-20T00:00:00+00:00',
                    labels: ['urgent'],
                    assignedUsers: ['bob'],
                    actor: 'alice',
                    datetime: '2026-05-13T09:20:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'deck.card.changed',
                label: 'Deck card changed',
                fields: ['cardId', 'boardId', 'stackId', 'previousStackId', 'title', 'description', 'done', 'archived', 'duedate', 'labels', 'assignedUsers', 'actor', 'datetime'],
                sample: {
                    cardId: 4521,
                    boardId: 12,
                    stackId: 34,
                    previousStackId: 34,
                    title: 'Follow up with Nextcloud',
                    description: 'Prep the integration demo',
                    done: null,
                    archived: false,
                    duedate: '2026-05-20T00:00:00+00:00',
                    labels: ['urgent'],
                    assignedUsers: ['bob'],
                    actor: 'alice',
                    datetime: '2026-05-13T10:00:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'deck.card.deleted',
                label: 'Deck card deleted',
                fields: ['cardId', 'boardId', 'stackId', 'title', 'actor', 'datetime'],
                sample: {
                    cardId: 4521,
                    boardId: 12,
                    stackId: 34,
                    title: 'Follow up with Nextcloud',
                    actor: 'alice',
                    datetime: '2026-05-13T10:15:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'deck.card.moved',
                label: 'Deck card moved to another list',
                // `previousStackId` is recovered by the connector from the last
                // state it saw for this card — Deck serialises only the current
                // card, so there is no "before" on the wire. Absent on a card's
                // very first sighting, which is also when no move can fire.
                fields: ['cardId', 'boardId', 'stackId', 'previousStackId', 'title', 'done', 'labels', 'assignedUsers', 'actor', 'datetime'],
                sample: {
                    cardId: 4521,
                    boardId: 12,
                    stackId: 36,
                    previousStackId: 34,
                    title: 'Follow up with Nextcloud',
                    done: null,
                    labels: ['urgent'],
                    assignedUsers: ['bob'],
                    actor: 'alice',
                    datetime: '2026-05-13T10:30:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'deck.card.completed',
                label: 'Deck card marked done',
                // `done` is Deck's completion TIMESTAMP, not a boolean — more
                // useful downstream, and still truthy where a boolean was
                // expected.
                fields: ['cardId', 'boardId', 'stackId', 'title', 'done', 'archived', 'duedate', 'labels', 'assignedUsers', 'actor', 'datetime'],
                sample: {
                    cardId: 4521,
                    boardId: 12,
                    stackId: 36,
                    title: 'Follow up with Nextcloud',
                    done: '2026-05-13T11:00:00+00:00',
                    archived: false,
                    duedate: '2026-05-20T00:00:00+00:00',
                    labels: ['urgent'],
                    assignedUsers: ['bob'],
                    actor: 'alice',
                    datetime: '2026-05-13T11:00:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'file.tagged',
                label: 'Tag assigned to a file',
                fields: ['fileId', 'objectIds', 'tagId', 'tagIds', 'objectType', 'actor', 'datetime'],
                sample: {
                    fileId: '437',
                    objectIds: ['437', '438'],
                    tagId: 3,
                    tagIds: [3, 17],
                    objectType: 'files',
                    actor: 'alice',
                    datetime: '2026-05-13T09:15:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'forms.submitted',
                label: 'Form submitted (Nextcloud Forms)',
                fields: [
                    'formId',
                    'formHash',
                    'formTitle',
                    'formOwner',
                    'submissionId',
                    'submittedBy',
                    'submittedAt',
                    'actor',
                    'datetime',
                ],
                sample: {
                    formId: 51,
                    formHash: 'abc123def456',
                    formTitle: 'Employee Feedback',
                    formOwner: 'alice',
                    submissionId: 220,
                    submittedBy: 'bob',
                    submittedAt: '2026-05-13T09:15:00Z',
                    actor: 'bob',
                    datetime: '2026-05-13T09:15:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'tables.row.added',
                label: 'Row added to a Nextcloud Table',
                fields: ['tableId', 'rowId', 'values', 'actor', 'datetime'],
                sample: {
                    tableId: 34,
                    rowId: 7,
                    values: { 0: 'Project X', 1: 2026, 2: 'active' },
                    actor: 'carol',
                    datetime: '2026-05-13T09:15:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'tables.row.updated',
                label: 'Row updated in a Nextcloud Table',
                fields: ['tableId', 'rowId', 'values', 'previousValues', 'actor', 'datetime'],
                sample: {
                    tableId: 34,
                    rowId: 7,
                    values: { 0: 'Project X', 2: 'done' },
                    previousValues: { 2: 'active' },
                    actor: 'carol',
                    datetime: '2026-05-13T09:20:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'talk.message.received',
                label: 'Talk message received',
                fields: ['messageId', 'roomToken', 'roomName', 'actor', 'actorName', 'message', 'isMarkdown', 'inReplyTo', 'datetime'],
                sample: {
                    messageId: 88123,
                    roomToken: 'a1b2c3d4',
                    roomName: 'Demo team',
                    actor: 'alice',
                    actorName: 'Alice',
                    message: 'Can someone post the latest invoice summary?',
                    isMarkdown: true,
                    inReplyTo: null,
                    datetime: '2026-05-13T12:30:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'talk.reaction.added',
                label: 'Talk reaction added',
                fields: ['messageId', 'roomToken', 'roomName', 'actor', 'actorName', 'reaction', 'removed', 'datetime'],
                sample: {
                    messageId: 88123,
                    roomToken: 'a1b2c3d4',
                    roomName: 'Demo team',
                    actor: 'alice',
                    actorName: 'Alice',
                    reaction: '\u{1F44D}',
                    removed: false,
                    datetime: '2026-05-13T12:31:00Z',
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
        ],
    }] };

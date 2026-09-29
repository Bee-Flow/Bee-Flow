/**
 * Gmail. Produced by the hand-written pollers in triggerBus.js (Gmail
 * history.list with a historyId cursor); delivery is per-user, so an inbound
 * event must always identify its subscriber.
 *
 * Migrated verbatim from the hardcoded TRIGGER_PROVIDERS array and the
 * TRIGGER_FIELDS_BY_EVENT / TRIGGER_OUTPUT_SAMPLES maps. The catalog payload is
 * guarded byte-for-byte by triggerRegistry.golden.test.js.
 */
module.exports = { TRIGGER_SOURCES: [{
        id: 'gmail',
        label: 'Gmail',
        order: 10,
        defaultEvent: 'mail.new',
        availability: {
            kind: 'tools',
            apps: ['gmail'],
        },
        events: [
            {
                id: 'mail.new',
                label: 'New email',
                fields: [
                    'messageId',
                    'threadId',
                    'from',
                    'to',
                    'cc',
                    'subject',
                    'snippet',
                    'labelIds',
                    'date',
                    'sizeEstimate',
                    'historyId',
                ],
                sample: {
                    messageId: 'msg-abc123',
                    threadId: 'th-abc123',
                    from: 'alice@example.com',
                    to: 'me@example.com',
                    cc: '',
                    subject: 'Project update — Q2',
                    snippet: 'Hi, attached is the latest deck for the kickoff…',
                    labelIds: ['INBOX', 'UNREAD'],
                    date: 'Wed, 13 May 2026 09:15:00 +0200',
                    sizeEstimate: 12345,
                    historyId: '987654',
                },
                scope: 'user',
                source: {
                    kind: 'poller',
                },
            },
            {
                id: 'label.added',
                label: 'Label added',
                fields: [
                    'messageId',
                    'threadId',
                    'addedLabelIds',
                    'from',
                    'to',
                    'subject',
                    'snippet',
                    'labelIds',
                    'date',
                ],
                sample: {
                    messageId: 'msg-abc123',
                    threadId: 'th-abc123',
                    addedLabelIds: ['Label_3'],
                    from: 'alice@example.com',
                    to: 'me@example.com',
                    subject: 'Project update — Q2',
                    snippet: 'Hi, attached is the latest deck…',
                    labelIds: ['INBOX', 'Label_3'],
                    date: 'Wed, 13 May 2026 09:15:00 +0200',
                },
                scope: 'user',
                source: {
                    kind: 'poller',
                },
            },
        ],
    }] };

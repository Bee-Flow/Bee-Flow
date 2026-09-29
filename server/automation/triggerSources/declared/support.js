/**
 * Support Inbox. Dispatched in-process by the inbox sync engine, org-scoped.
 *
 * Migrated verbatim from the hardcoded TRIGGER_PROVIDERS array and the
 * TRIGGER_FIELDS_BY_EVENT / TRIGGER_OUTPUT_SAMPLES maps. The catalog payload is
 * guarded byte-for-byte by triggerRegistry.golden.test.js.
 */
module.exports = { TRIGGER_SOURCES: [{
        id: 'support',
        label: 'Support Inbox',
        order: 60,
        defaultEvent: 'ticket.resolved',
        availability: {
            kind: 'check',
            check: 'support',
        },
        events: [
            {
                id: 'ticket.resolved',
                label: 'Ticket resolved',
                fields: [
                    'threadId',
                    'inboxId',
                    'subject',
                    'category',
                    'priority',
                    'tags',
                    'resolvedBy',
                    'requesterEmail',
                    'messageCount',
                    'transcript',
                    'genuineContact',
                ],
                sample: {
                    threadId: 'thr-42',
                    inboxId: 'inbox-1',
                    subject: 'Cannot log in after password reset',
                    category: 'authentication',
                    priority: 'high',
                    tags: ['login', 'password'],
                    resolvedBy: 'ai',
                    requesterEmail: 'customer@example.com',
                    messageCount: 4,
                    transcript: 'Customer: I cannot log in after resetting my password.\nSupport: Please clear your browser cache and try the reset link again.\nCustomer: That worked, thanks!',
                    genuineContact: true,
                },
                scope: 'org',
                source: {
                    kind: 'push',
                },
            },
        ],
    }] };

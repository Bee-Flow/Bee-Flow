/**
 * The Nextcloud Mail trigger event, `mail.new` (the id Gmail and Microsoft
 * use too), split out of declared/nextcloud.js like nextcloudCalendarEvents.mts.
 * Not under declared/ on purpose: everything there is loaded as a provider.
 *
 * Two producers, one payload (triggerBus/ncPayload.mts normaliseMailPayload):
 *   - the connector (2.1.0+) forwards Mail's NewMessageReceivedEvent with ids
 *     and the subject only; the trigger bus finds the mailbox's owner among
 *     the subscribers (their own account list, triggerBus/ncMailVisibility.mts)
 *     and reads the sender and the attachment flag as that owner;
 *   - the poller (triggerBus/pollers/nextcloudMail.mts) reads the inbox, or
 *     the mailbox the filter names, through Mail's API: for a user without
 *     the connector, an older connector or Mail, and as the backstop when no
 *     push came for a while.
 * Never the body: an automation reads it with nextcloud_mail_read.
 */

export const MAIL_EVENTS = [
    {
        id: 'mail.new',
        label: 'New email (Nextcloud Mail)',
        fields: ['accountId', 'mailboxId', 'messageId', 'from', 'subject', 'hasAttachments', 'receivedAt', 'datetime'],
        sample: {
            accountId: 3,
            mailboxId: 12,
            messageId: 4711,
            from: 'alice@example.com',
            subject: 'Invoice 2026-114',
            hasAttachments: true,
            receivedAt: '2026-05-13T09:15:00Z',
            datetime: '2026-05-13T09:15:00Z',
        },
        scope: 'org',
        source: {
            kind: 'push',
        },
    },
];

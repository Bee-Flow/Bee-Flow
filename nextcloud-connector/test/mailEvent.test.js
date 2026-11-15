/**
 * Nextcloud Mail's new-message event (`mail.new`).
 *
 * `OCA\Mail\Events\NewMessageReceivedEvent` implements IWebhookCompatibleEvent
 * (nextcloud/mail lib/Events/NewMessageReceivedEvent.php; the namespace is the
 * plural `Events`). Its webhook serialisation is ids, RFC ids, the thread
 * root, the send date, the message's OCS address and the subject. The
 * connector forwards an allow-list of that: the three ids, the subject and
 * when it came in.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = process.env.APP_SECRET || 'ci-test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';

const wl = require('../src/webhookListeners');
const hook = require('../src/automationEventsWebhook');

const MAIL_CLASS = 'OCA\\Mail\\Events\\NewMessageReceivedEvent';

/** What Mail's getWebhookSerializable() puts under `event`, plus the class. */
function mailEnvelope(extra = {}) {
    return {
        event: {
            class: MAIL_CLASS,
            accountId: 3,
            inReplyToRfcMessageId: '<parent@mail.example>',
            mailboxId: 12,
            messageId: 4711,
            messageUri: 'https://cloud.example/ocs/v2.php/apps/mail/message/4711',
            rfcMessageId: '<4711@mail.example>',
            sentAt: 1763200000,
            subject: 'Invoice 2026-114',
            threadRootId: '<root@mail.example>',
            ...extra,
        },
        user: null,
        time: 1763200060,
    };
}

test('the Mail class is registered as mail.new, and optional (Mail may be missing or too old)', () => {
    const entry = wl.EVENTS.find((e) => e.class === MAIL_CLASS);
    assert.ok(entry, 'registered under the plural Events namespace');
    assert.equal(entry.event, 'mail.new');
    assert.equal(entry.optional, true);
    assert.equal(hook.mapEvent(MAIL_CLASS), 'mail.new');
    assert.equal(hook.mapEvent('OCA\\Mail\\Event\\NewMessageReceivedEvent'), null, 'the singular namespace does not exist in Mail');
});

test('the payload is built from an allow-list: ids, subject and when it came in', () => {
    const payload = hook.normalisePayload('mail.new', mailEnvelope());
    assert.deepEqual(payload, {
        accountId: 3,
        mailboxId: 12,
        messageId: 4711,
        subject: 'Invoice 2026-114',
        receivedAt: '2025-11-15T09:47:40.000Z',
        actor: null,
        actorName: null,
        datetime: '2025-11-15T09:47:40.000Z',
    });
    for (const key of ['messageUri', 'rfcMessageId', 'inReplyToRfcMessageId', 'threadRootId', 'sentAt', 'class']) {
        assert.equal(key in payload, false, `${key} is not forwarded`);
    }
});

test('a key Mail adds later does not travel, and ids that are not ids read as null', () => {
    const payload = hook.normalisePayload('mail.new', mailEnvelope({
        from: 'someone@example.com', body: 'secret text', accountId: '3', mailboxId: -1, messageId: 1.5, subject: 42,
    }));
    assert.equal('from' in payload, false);
    assert.equal('body' in payload, false);
    assert.equal(payload.accountId, null);
    assert.equal(payload.mailboxId, null);
    assert.equal(payload.messageId, null);
    assert.equal(payload.subject, '');
});

test('a session user, when Mail synced inside a request, is the actor', () => {
    const payload = hook.normalisePayload('mail.new', { ...mailEnvelope(), user: { uid: 'alice', displayName: 'Alice' } });
    assert.equal(payload.actor, 'alice');
    assert.equal(payload.actorName, 'Alice');
});

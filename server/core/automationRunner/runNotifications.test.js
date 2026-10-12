/**
 * core/automationRunner/runNotifications: a run event through the automation's
 * notification policy. Everything is injected through makeRunNotifier; no
 * module mocking, no database.
 *
 * Proven:
 *   - defaults: an error rings the owner's bell and mails them; nothing to Talk
 *   - Nextcloud bell for people with a Nextcloud account, carrying the automation
 *     name, the event and a link only; the Bee Flow bell when that fails
 *   - recipients: users and groups inside the organisation, approvers
 *   - throttle: over maxPerHour the message is held as bundled, not sent
 *   - summary mode: recorded for the digest, sent nowhere
 *   - Talk: one message per conversation, no run data; the approval card
 *   - the working copy's settings decide, also for a run of the live copy
 *   - every attempt is in the ledger; nothing throws
 *
 * Run: cd server && node --test core/automationRunner/runNotifications.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRunNotifier, emailSkipOf } = require('./runNotifications');

const NOW = Date.parse('2026-09-28T10:00:00Z');

function env(opts = {}) {
    const rec = { bells: [], nc: [], mails: [], talk: [], cards: [], rows: [], counts: [] };
    const users = {
        owner: { id: 'owner', email: 'owner@example.com', organizationId: 'org1', groups: [] },
        ann: { id: 'ann', email: 'ann@example.com', organizationId: 'org1', groups: ['g-fin'], nc_uid: 'ann-nc' },
        bob: { id: 'bob', email: null, organizationId: 'org1', groups: ['g-fin'] },
        eve: { id: 'eve', email: 'eve@example.com', organizationId: 'org2', groups: ['g-fin'] },
        ...(opts.users || {}),
    };
    const deps = {
        now: () => NOW,
        getAutomation: async () => opts.stored || null,
        getUser: async (id) => users[id] || null,
        listUsers: async () => Object.values(users),
        events: {
            countRecentMessages: async (q) => { rec.counts.push(q); return typeof opts.recent === 'function' ? opts.recent(q) : (opts.recent || 0); },
            recordNotificationEvents: async (rows) => { rec.rows.push(...rows); return rows.length; },
        },
        createBell: async (o) => { if (opts.bellThrows) throw new Error('bell down'); rec.bells.push(o); },
        emailConfig: async () => ({ configured: opts.email !== false }),
        sendEmail: async (o) => { rec.mails.push(o); },
        resolveNcContext: async () => (opts.nc === false ? null : { fetch: () => {}, baseUrl: 'https://nc.example' }),
        sendNcNotification: async (o) => { rec.nc.push(o); return { ok: opts.ncOk !== false }; },
        resolveTalkRoom: async () => (opts.room === undefined ? 'orgroom' : opts.room),
        postTalk: async (o) => { rec.talk.push(o); return { ok: true }; },
        deliverApprovalCard: async (o) => { rec.cards.push(o); return { talk: { ok: true } }; },
        absoluteUrl: (p) => `https://bee.example${p}`,
        appPaths: require('../../utils/appPaths'),
        ...(opts.deps || {}),
    };
    return { notifier: makeRunNotifier(deps), rec };
}

function automation(notificationSettings) {
    return { id: 'a1', userId: 'owner', organizationId: 'org1', title: 'Invoices', definition: { notificationSettings } };
}

const ERROR_PAYLOAD = { title: '⚠️ Automation failed: Invoices', message: 'HTTP 403 from https://api.example/x?customer=Jansen', runId: 'r1' };

test('defaults: an error rings the owner and mails them, and nothing goes to Talk', async () => {
    const { notifier, rec } = env();
    const report = await notifier.notifyRunEvent(automation(undefined), 'onError', ERROR_PAYLOAD);
    assert.deepEqual(report.recipients, ['owner']);
    assert.equal(rec.bells.length, 1);
    assert.equal(rec.bells[0].userId, 'owner');
    assert.equal(rec.bells[0].category, 'urgent');
    assert.equal(rec.bells[0].title, ERROR_PAYLOAD.title, 'the Bee Flow bell keeps the detail');
    assert.equal(rec.bells[0].link, '/app/studio/automations/a1?view=runs&run=r1');
    assert.equal(rec.mails.length, 1);
    assert.equal(rec.mails[0].to, 'owner@example.com');
    assert.match(rec.mails[0].text, /https:\/\/bee\.example\/app\/studio\/automations\/a1\?view=runs&run=r1/);
    assert.equal(rec.talk.length, 0);
    assert.deepEqual(rec.rows.map(r => [r.recipient, r.channel, r.delivered, !!r.bundled, r.event, r.runId]), [
        ['owner', 'bell', true, false, 'onError', 'r1'],
        ['owner', 'email', true, false, 'onError', 'r1'],
    ]);
    assert.equal(new Set(rec.rows.map(r => +r.createdAt)).size, 1, 'one message, one timestamp');
});

test('a Nextcloud user gets the Nextcloud bell with the name, the event and a link only', async () => {
    const { notifier, rec } = env();
    await notifier.notifyRunEvent(automation({ onError: { enabled: true, channels: ['bell'], recipients: [{ type: 'user', id: 'ann' }], urgency: 'urgent' } }), 'onError', ERROR_PAYLOAD);
    assert.equal(rec.bells.length, 0);
    assert.equal(rec.nc.length, 1);
    assert.equal(rec.nc[0].ncUid, 'ann-nc');
    assert.equal(rec.nc[0].subject, 'Invoices stopped with an error');
    assert.equal(rec.nc[0].message, 'Open it in Bee Flow.');
    assert.equal(rec.nc[0].link, 'https://bee.example/app/studio/automations/a1?view=runs&run=r1');
    assert.doesNotMatch(JSON.stringify(rec.nc), /Jansen|403/, 'no run data leaves Bee Flow');
});

test('when the Nextcloud bell fails the Bee Flow bell rings instead', async () => {
    const { notifier, rec } = env({ ncOk: false });
    const report = await notifier.notifyRunEvent(automation({ onError: { enabled: true, channels: ['bell'], recipients: [{ type: 'user', id: 'ann' }], urgency: 'normal' } }), 'onError', ERROR_PAYLOAD);
    assert.equal(rec.nc.length, 1);
    assert.equal(rec.bells.length, 1);
    assert.equal(report.delivered[0].via, 'inapp');
});

test('groups resolve inside the organisation; people without an address get no mail', async () => {
    const { notifier, rec } = env();
    const report = await notifier.notifyRunEvent(automation({ onError: {
        enabled: true, channels: ['email'], recipients: [{ type: 'group', id: 'g-fin' }, { type: 'user', id: 'eve' }], urgency: 'urgent',
    } }), 'onError', ERROR_PAYLOAD);
    assert.deepEqual(report.recipients, ['ann', 'bob'], 'eve is in another organisation');
    assert.deepEqual(rec.mails.map(m => m.to), ['ann@example.com']);
    assert.deepEqual(rec.rows.map(r => [r.recipient, r.delivered]), [['ann', true], ['bob', false]]);
    assert.match(rec.mails[0].text, /the Bee Flow automation/, 'a non-owner is not told it is their automation');
});

test('throttle: at the cap the message is held as bundled on every channel', async () => {
    const { notifier, rec } = env({ recent: 1 });
    const report = await notifier.notifyRunEvent(automation(undefined), 'onError', ERROR_PAYLOAD);
    assert.equal(rec.bells.length, 0);
    assert.equal(rec.mails.length, 0);
    assert.equal(report.bundled, 1);
    assert.deepEqual(rec.rows.map(r => [r.channel, !!r.bundled, !!r.delivered]), [['bell', true, false], ['email', true, false]]);
    assert.equal(rec.counts[0].recipient, 'owner');
    assert.equal(+rec.counts[0].since, NOW - 3600_000, 'a rolling hour');
});

test('throttle: under the cap it is sent; no cap means no ledger lookup', async () => {
    const under = env({ recent: 1 });
    await under.notifier.notifyRunEvent(automation({ onError: { enabled: true, channels: ['bell'], urgency: 'urgent', throttle: { maxPerHour: 2 } } }), 'onError', ERROR_PAYLOAD);
    assert.equal(under.rec.bells.length, 1);
    const none = env({ recent: 99 });
    await none.notifier.notifyRunEvent(automation({ onError: { enabled: true, channels: ['bell'], urgency: 'urgent', throttle: { maxPerHour: null } } }), 'onError', ERROR_PAYLOAD);
    assert.equal(none.rec.bells.length, 1);
    assert.equal(none.rec.counts.length, 0);
});

test('a ledger that cannot be read never silences a notification', async () => {
    const { notifier, rec } = env({ recent: () => { throw new Error('db down'); } });
    await notifier.notifyRunEvent(automation(undefined), 'onError', ERROR_PAYLOAD);
    assert.equal(rec.bells.length, 1);
});

test('summary mode: a success is recorded for the digest and sent nowhere', async () => {
    const { notifier, rec } = env();
    const report = await notifier.notifyRunEvent(automation({
        onSuccess: { enabled: true, channels: ['bell', 'email'], urgency: 'silent', delivery: 'digest' },
        digest: { enabled: true, time: '17:00' },
    }), 'onSuccess', { title: 'Invoices', message: 'done', runId: 'r2' });
    assert.equal(report.digest, 1);
    assert.equal(rec.bells.length + rec.mails.length + rec.talk.length, 0);
    assert.deepEqual(rec.rows.map(r => [r.recipient, r.channel, r.bundled]), [['owner', 'digest', true]]);
});

test('summary mode without a summary switched on is delivered directly', async () => {
    const { notifier, rec } = env();
    await notifier.notifyRunEvent(automation({ onSuccess: { enabled: true, channels: ['bell'], urgency: 'silent', delivery: 'digest' } }), 'onSuccess', { title: 'Invoices', runId: 'r2' });
    assert.equal(rec.bells.length, 1);
    assert.equal(rec.bells[0].category, 'info');
});

test('Talk: one message into the conversation, the line and the link, silent when silent', async () => {
    const { notifier, rec } = env();
    await notifier.notifyRunEvent(automation({ onError: {
        enabled: true, channels: ['talk'], recipients: [{ type: 'group', id: 'g-fin' }], urgency: 'silent', talkRoom: 'room42',
    } }), 'onError', ERROR_PAYLOAD);
    assert.equal(rec.talk.length, 1, 'not once per person');
    assert.equal(rec.talk[0].roomToken, 'room42');
    assert.equal(rec.talk[0].message, 'Invoices stopped with an error\nhttps://bee.example/app/studio/automations/a1?view=runs&run=r1');
    assert.equal(rec.talk[0].silent, true);
    assert.equal(rec.talk[0].ownerId, 'owner');
    assert.deepEqual(rec.rows.map(r => [r.recipient, r.channel, r.delivered]), [['talk:room42', 'talk', true]]);
});

test('Talk without a conversation is recorded as not delivered', async () => {
    const { notifier, rec } = env({ room: null });
    const report = await notifier.notifyRunEvent(automation({ onError: { enabled: true, channels: ['talk'], urgency: 'urgent' } }), 'onError', ERROR_PAYLOAD);
    assert.equal(rec.talk.length, 0);
    assert.deepEqual(rec.rows.map(r => [r.recipient, r.delivered]), [['talk:unconfigured', false]]);
    assert.equal(report.delivered[0].via, 'no_room');
});

test('an approval: bells to every approver, ONE reactable card with them attached', async () => {
    const { notifier, rec } = env();
    const approval = { id: 'apr_1', prompt: 'Pay Jansen €1200?' };
    await notifier.notifyRunEvent(automation(undefined), 'onApproval', {
        title: '🛂 Approval needed: Invoices', message: 'Pay Jansen €1200? — open it', link: '/app/studio/approvals/apr_1',
        runId: 'r3', approverIds: ['bob', 'owner'], approval,
    });
    assert.deepEqual(rec.bells.map(b => b.userId), ['bob', 'owner']);
    assert.equal(rec.bells[0].link, '/app/studio/approvals/apr_1');
    assert.equal(rec.cards.length, 1);
    assert.deepEqual(rec.cards[0].channels, ['nc_talk']);
    assert.deepEqual(rec.cards[0].recipientIds, ['bob', 'owner']);
    assert.equal(rec.cards[0].automation.definition.notificationSettings.onApproval.talkRoom, 'orgroom');
    assert.equal(rec.talk.length, 0);
});

test('the working copy decides, also for a run of the live copy', async () => {
    const live = { ...automation({ onError: { enabled: false, channels: ['bell'], urgency: 'urgent' } }), runsLiveVersion: true };
    const stored = automation({ onError: { enabled: true, channels: ['bell'], urgency: 'urgent' } });
    const on = env({ stored });
    await on.notifier.notifyRunEvent(live, 'onError', ERROR_PAYLOAD);
    assert.equal(on.rec.bells.length, 1);

    const off = env({ stored: automation({ onError: { enabled: false, channels: ['bell'], urgency: 'urgent' } }) });
    const report = await off.notifier.notifyRunEvent({ ...automation(undefined), runsLiveVersion: true }, 'onError', ERROR_PAYLOAD);
    assert.equal(report.skipped, 'disabled');
    assert.equal(off.rec.rows.length, 0);
});

test('a failing bell is recorded, never thrown', async () => {
    const { notifier, rec } = env({ bellThrows: true });
    const report = await notifier.notifyRunEvent(automation(undefined), 'onError', ERROR_PAYLOAD);
    assert.equal(rec.mails.length, 1, 'the other channel still goes');
    assert.deepEqual(rec.rows.map(r => [r.channel, r.delivered]), [['bell', false], ['email', true]]);
    assert.equal(report.delivered[0].ok, false);
});

test('no service mailbox: the mail is recorded as not delivered', async () => {
    const { notifier, rec } = env({ email: false });
    const report = await notifier.notifyRunEvent(automation(undefined), 'onError', ERROR_PAYLOAD);
    assert.equal(rec.mails.length, 0);
    assert.deepEqual(report.delivered.find(d => d.channel === 'email'), { recipient: 'owner', channel: 'email', ok: false, via: 'email:no_service_email' });
});

test('compat: dispatchRunNotification with an old-shape policy and one addressee', async () => {
    const { notifier, rec } = env();
    await notifier.dispatchRunNotification(automation(undefined), { enabled: true, level: 'heads_up', channels: ['inapp'] }, { title: 'T', message: 'M', userId: 'bob' });
    assert.deepEqual(rec.bells.map(b => [b.userId, b.category]), [['bob', 'heads_up']]);
    assert.equal(rec.mails.length, 0);
    const none = env();
    assert.equal(await none.notifier.dispatchRunNotification(automation(undefined), { enabled: false, channels: ['inapp'] }, { title: 'T' }), null);
});

test('compat: a tagged policy follows the stored settings for its event', async () => {
    const { notifier, rec } = env();
    const a = automation(undefined);
    await notifier.dispatchRunNotification(a, notifier.resolveNotificationPolicy(a, 'onError'), { title: 'T', message: 'M' });
    assert.equal(rec.bells.length, 1);
    assert.equal(rec.mails.length, 1);
    assert.equal(notifier.resolveNotificationPolicy(a, 'onApproval').event, 'onApproval');
});

test('sendRunEmail reports why nothing was sent', async () => {
    const noMailbox = env({ email: false });
    assert.deepEqual(await noMailbox.notifier.sendRunEmail(automation(undefined), { subject: 's', message: 'm' }), { sent: false, reason: 'no_service_email' });
    const noAddress = env();
    assert.deepEqual(await noAddress.notifier.sendRunEmail(automation(undefined), { subject: 's', message: 'm', userId: 'bob' }), { sent: false, reason: 'no_owner_email' });
    assert.equal(emailSkipOf({ sent: false, reason: 'no_service_email' }).reason, 'no_service_email');
    assert.equal(emailSkipOf({ sent: true }), null);
});

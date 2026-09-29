/**
 * End-of-run notifications for a routine saved BEFORE handoff 5: its old
 * `notificationSettings` ({ enabled, level, channels: inapp|email|nc_talk|
 * nc_notification }) must keep doing what it did. The new behaviour is in
 * core/automationRunner/runNotifications.test.js; this file pins the old
 * routines. Built on makeRunNotifier with injected channels, no module mocks.
 *
 * Run: node --test core/automationRunner.notifications.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRunNotifier } = require('./automationRunner/runNotifications');

function env({ emailConfigured = true, ownerEmail = 'owner@example.com' } = {}) {
    const rec = { bells: [], mails: [], talk: [], cards: [], rows: [] };
    const notifier = makeRunNotifier({
        now: () => Date.parse('2026-09-28T10:00:00Z'),
        getAutomation: async () => null,
        getUser: async (id) => (id === 'u1' ? { id: 'u1', email: ownerEmail, organizationId: 'org1' } : { id, organizationId: 'org1' }),
        listUsers: async () => [],
        events: {
            countRecentMessages: async () => { throw new Error('an old routine has no throttle'); },
            recordNotificationEvents: async (rows) => { rec.rows.push(...rows); },
        },
        createBell: async (o) => { rec.bells.push(o); },
        emailConfig: async () => ({ configured: emailConfigured }),
        sendEmail: async (o) => { rec.mails.push(o); },
        resolveNcContext: async () => null,
        sendNcNotification: async () => ({ ok: false }),
        resolveTalkRoom: async () => 'room1',
        postTalk: async (o) => { rec.talk.push(o); return { ok: true }; },
        deliverApprovalCard: async (o) => { rec.cards.push(o); return { talk: { ok: true } }; },
        absoluteUrl: (p) => p,
        appPaths: require('../utils/appPaths'),
    });
    return { notifier, rec };
}

const OLD = (settings) => ({ id: 'a1', userId: 'u1', organizationId: 'org1', title: 'Weekly digest', definition: { notificationSettings: settings } });

test('old onError with only the bell: the bell, no email, no throttle', async () => {
    const { notifier, rec } = env();
    await notifier.notifyRunEvent(OLD({ onError: { enabled: true, level: 'urgent', channels: ['inapp'] } }), 'onError', { title: 'Failed', message: 'boom', runId: 'r1' });
    assert.deepEqual(rec.bells.map(b => [b.userId, b.category, b.title, b.message]), [['u1', 'urgent', 'Failed', 'boom']]);
    assert.equal(rec.mails.length, 0);
});

test('old bell + email: both, to the owner', async () => {
    const { notifier, rec } = env();
    await notifier.notifyRunEvent(OLD({ onError: { enabled: true, level: 'urgent', channels: ['inapp', 'email'] } }), 'onError', { title: 'Failed', message: 'boom' });
    assert.equal(rec.bells.length, 1);
    assert.equal(rec.mails.length, 1);
    assert.equal(rec.mails[0].to, 'owner@example.com');
    assert.equal(rec.mails[0].subject, 'Failed');
    assert.match(rec.mails[0].text, /boom/);
});

test('old disabled success stays silent', async () => {
    const { notifier, rec } = env();
    const r = await notifier.notifyRunEvent(OLD({ onSuccess: { enabled: false, level: 'ai_task', channels: ['inapp'] } }), 'onSuccess', { title: 'Done' });
    assert.equal(r.skipped, 'disabled');
    assert.equal(rec.bells.length + rec.mails.length, 0);
});

test('old enabled success rings the bell directly with its old category', async () => {
    const { notifier, rec } = env();
    await notifier.notifyRunEvent(OLD({ onSuccess: { enabled: true, level: 'ai_task', channels: ['inapp'] } }), 'onSuccess', { title: '🤖 Weekly digest', message: 'ok' });
    assert.deepEqual(rec.bells.map(b => b.category), ['ai_task']);
});

test('old approval with nc_talk and its room: the card goes to that room', async () => {
    const { notifier, rec } = env();
    await notifier.notifyRunEvent(
        OLD({ onApproval: { enabled: true, level: 'heads_up', channels: ['inapp', 'nc_talk'], ncTalkRoom: 'legacy-room' } }),
        'onApproval',
        { title: 'Approval needed', link: '/app/studio/approvals/apr_1', approverIds: ['lead'], approval: { id: 'apr_1' } },
    );
    assert.deepEqual(rec.bells.map(b => [b.userId, b.category]), [['lead', 'heads_up']]);
    assert.equal(rec.cards.length, 1);
    assert.equal(rec.cards[0].automation.definition.notificationSettings.onApproval.talkRoom, 'legacy-room');
});

test('email without a service mailbox is a quiet skip; the bell still rings', async () => {
    const { notifier, rec } = env({ emailConfigured: false });
    await notifier.notifyRunEvent(OLD({ onError: { enabled: true, level: 'urgent', channels: ['inapp', 'email'] } }), 'onError', { title: 'Failed', message: 'boom' });
    assert.equal(rec.bells.length, 1);
    assert.equal(rec.mails.length, 0);
    assert.deepEqual(rec.rows.map(r => [r.channel, r.delivered]), [['bell', true], ['email', false]]);
});

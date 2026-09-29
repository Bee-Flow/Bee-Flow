/**
 * automation/notificationDefaults: the handoff 5 policy shape, its defaults,
 * the reader that turns the older shape into it, and the hand-kept UI mirror.
 *
 * Run: cd server && node --test automation/notificationDefaults.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
    NOTIFICATION_DEFAULTS, NOTIFICATION_CHANNELS, NOTIFICATION_URGENCIES, NOTIFICATION_EVENTS,
    RECIPIENT_TYPES, DELIVERY_MODES, LEGACY_CHANNEL_MAP, LEGACY_LEVEL_TO_URGENCY, MAX_RECIPIENTS,
    normalizeNotificationSettings, normalizeEventSettings, urgencyToCategory, foldsIntoDigest,
} = require('./notificationDefaults');

test('defaults follow the design: errors loud, approvals to the approver, success off', () => {
    assert.deepEqual(NOTIFICATION_DEFAULTS.onError, {
        enabled: true, channels: ['bell', 'email'], recipients: [{ type: 'owner' }],
        urgency: 'urgent', throttle: { maxPerHour: 1 }, delivery: 'direct',
    });
    assert.deepEqual(NOTIFICATION_DEFAULTS.onApproval, {
        enabled: true, channels: ['bell', 'talk'], recipients: [{ type: 'approver' }],
        urgency: 'normal', throttle: { maxPerHour: null }, delivery: 'direct',
    });
    assert.equal(NOTIFICATION_DEFAULTS.onSuccess.enabled, false);
    assert.equal(NOTIFICATION_DEFAULTS.onSuccess.delivery, 'digest');
    assert.deepEqual(NOTIFICATION_DEFAULTS.digest, { enabled: false, time: '17:00' });
    assert.ok(Object.isFrozen(NOTIFICATION_DEFAULTS.onError.channels));
});

test('the channels are the three with a backend; no "soon" channels', () => {
    assert.deepEqual([...NOTIFICATION_CHANNELS], ['bell', 'email', 'talk']);
    for (const gone of ['slack', 'push', 'inapp', 'nc_talk']) assert.ok(!NOTIFICATION_CHANNELS.includes(gone));
});

test('nothing stored reads as the defaults, as fresh copies', () => {
    const s = normalizeNotificationSettings(undefined);
    assert.deepEqual(s, JSON.parse(JSON.stringify(NOTIFICATION_DEFAULTS)));
    s.onError.channels.push('talk');
    assert.deepEqual([...NOTIFICATION_DEFAULTS.onError.channels], ['bell', 'email'], 'defaults are not mutated');
});

test('old shape: levels become urgency, channel names are mapped, recipients are the old ones', () => {
    const s = normalizeNotificationSettings({
        onError: { enabled: true, level: 'urgent', channels: ['inapp'] },
        onApproval: { enabled: true, level: 'heads_up', channels: ['inapp', 'nc_talk', 'nc_notification', 'email'], ncTalkRoom: ' room1 ' },
        onSuccess: { enabled: true, level: 'info', channels: ['inapp', 'email', 'slack'] },
    });
    assert.deepEqual(s.onError, {
        enabled: true, channels: ['bell'], recipients: [{ type: 'owner' }],
        urgency: 'urgent', throttle: { maxPerHour: null }, delivery: 'direct',
    }, 'an old routine gets no email and no throttle it did not have');
    assert.deepEqual(s.onApproval.channels, ['bell', 'email', 'talk']);
    assert.deepEqual(s.onApproval.recipients, [{ type: 'approver' }]);
    assert.equal(s.onApproval.urgency, 'normal');
    assert.equal(s.onApproval.talkRoom, 'room1', 'ncTalkRoom becomes talkRoom');
    assert.equal(s.onSuccess.urgency, 'silent');
    assert.deepEqual(s.onSuccess.channels, ['bell', 'email']);
    assert.equal(s.onSuccess.delivery, 'direct', 'an old success notification stays a direct one');
    assert.equal(s.digest.enabled, false);
});

test('every old level has an urgency', () => {
    for (const level of ['info', 'heads_up', 'urgent', 'ai_task']) {
        assert.equal(normalizeEventSettings({ level }, 'onError').urgency, LEGACY_LEVEL_TO_URGENCY[level]);
    }
    assert.equal(normalizeEventSettings({ level: 'nonsense', channels: ['inapp'] }, 'onError').urgency, 'urgent');
});

test('urgency maps back onto the Bee Flow bell categories', () => {
    assert.equal(urgencyToCategory('urgent', 'onError'), 'urgent');
    assert.equal(urgencyToCategory('silent', 'onSuccess'), 'info');
    assert.equal(urgencyToCategory('normal', 'onApproval'), 'heads_up');
    assert.equal(urgencyToCategory('normal', 'onSuccess'), 'ai_task');
});

test('new shape: kept as saved, junk dropped', () => {
    const s = normalizeNotificationSettings({
        onError: {
            enabled: true,
            channels: ['talk', 'bell', 'bell', 'slack'],
            recipients: [
                { type: 'owner' }, { type: 'owner' }, { type: 'user', id: 'u2' }, { type: 'group', id: 'g1' },
                { type: 'user' }, { type: 'robot', id: 'x' }, null, 'owner',
            ],
            urgency: 'normal',
            throttle: { maxPerHour: 3.7 },
            talkRoom: 'abc',
        },
        digest: { enabled: true, time: '07:30' },
    });
    assert.deepEqual(s.onError.channels, ['bell', 'talk'], 'known channels, canonical order');
    assert.deepEqual(s.onError.recipients, [{ type: 'owner' }, { type: 'user', id: 'u2' }, { type: 'group', id: 'g1' }]);
    assert.equal(s.onError.throttle.maxPerHour, 3);
    assert.equal(s.onError.talkRoom, 'abc');
    assert.equal(s.onError.delivery, 'direct');
    assert.deepEqual(s.digest, { enabled: true, time: '07:30' });
});

test('throttle: null and zero mean no cap, huge is capped, missing is the default', () => {
    assert.equal(normalizeEventSettings({ urgency: 'urgent', throttle: { maxPerHour: null } }, 'onError').throttle.maxPerHour, null);
    assert.equal(normalizeEventSettings({ urgency: 'urgent', throttle: { maxPerHour: 0 } }, 'onError').throttle.maxPerHour, null);
    assert.equal(normalizeEventSettings({ urgency: 'urgent', throttle: { maxPerHour: 9999 } }, 'onError').throttle.maxPerHour, 60);
    assert.equal(normalizeEventSettings({ urgency: 'urgent' }, 'onError').throttle.maxPerHour, 1);
    assert.equal(normalizeEventSettings({ urgency: 'urgent', throttle: { maxPerHour: 'x' } }, 'onError').throttle.maxPerHour, 1);
});

test('recipients are capped', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ type: 'user', id: `u${i}` }));
    assert.equal(normalizeEventSettings({ urgency: 'normal', recipients: many }, 'onError').recipients.length, MAX_RECIPIENTS);
});

test('a bad digest time falls back to 17:00; only true switches it on', () => {
    assert.deepEqual(normalizeNotificationSettings({ digest: { enabled: 'yes', time: '25:00' } }).digest, { enabled: false, time: '17:00' });
    assert.deepEqual(normalizeNotificationSettings({ digest: { enabled: true, time: '7:00' } }).digest, { enabled: true, time: '17:00' });
});

test('summary mode folds only when the summary is on', () => {
    const on = normalizeNotificationSettings({ onSuccess: { enabled: true, urgency: 'silent', delivery: 'digest' }, digest: { enabled: true } });
    const off = normalizeNotificationSettings({ onSuccess: { enabled: true, urgency: 'silent', delivery: 'digest' } });
    assert.equal(foldsIntoDigest(on, 'onSuccess'), true);
    assert.equal(foldsIntoDigest(off, 'onSuccess'), false, 'without a summary it is delivered directly');
    assert.equal(foldsIntoDigest(on, 'onError'), false);
});

test('an unknown event is a programming error', () => {
    assert.throws(() => normalizeEventSettings({}, 'onWhatever'));
});

test('the hand-mirrored UI copy agrees on vocabulary and defaults', async () => {
    const mirrorPath = path.resolve(__dirname, '../../agent-hub/src/components/automation/Builder/notificationDefaults.js');
    const mirror = await import(require('url').pathToFileURL(mirrorPath).href);
    assert.deepEqual([...mirror.NOTIFICATION_EVENTS], [...NOTIFICATION_EVENTS]);
    assert.deepEqual([...mirror.NOTIFICATION_CHANNELS], [...NOTIFICATION_CHANNELS]);
    assert.deepEqual([...mirror.NOTIFICATION_URGENCIES], [...NOTIFICATION_URGENCIES]);
    assert.deepEqual([...mirror.RECIPIENT_TYPES], [...RECIPIENT_TYPES]);
    assert.deepEqual([...mirror.DELIVERY_MODES], [...DELIVERY_MODES]);
    assert.deepEqual(JSON.parse(JSON.stringify(mirror.NOTIFICATION_DEFAULTS)), JSON.parse(JSON.stringify(NOTIFICATION_DEFAULTS)));
    assert.deepEqual({ ...mirror.LEGACY_CHANNEL_MAP }, { ...LEGACY_CHANNEL_MAP });
    assert.deepEqual({ ...mirror.LEGACY_LEVEL_TO_URGENCY }, { ...LEGACY_LEVEL_TO_URGENCY });
    assert.equal(mirror.MAX_RECIPIENTS, MAX_RECIPIENTS);
    // The notification STEP's pills: the bell and email, nothing "soon".
    assert.deepEqual(mirror.CHANNEL_OPTIONS.map(o => o.key), ['inapp', 'email']);
    assert.ok(!mirror.CHANNEL_OPTIONS.some(o => o.comingSoon));
});

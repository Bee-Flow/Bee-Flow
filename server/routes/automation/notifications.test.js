/**
 * GET /api/automation/:id/notifications: the Settings page's read of a
 * automation's notification policy, channel availability and latest attempts.
 * The router is built with makeNotificationsRouter and fakes; no module mocks.
 *
 * Run: cd server && node --test routes/automation/notifications.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { makeNotificationsRouter } = require('./notifications');
const { NOTIFICATION_DEFAULTS } = require('../../automation/notificationDefaults');

const USERS = {
    owner: { id: 'owner', organizationId: 'org1', groups: [], nc_uid: 'owner-nc' },
    viewer: { id: 'viewer', organizationId: 'org1', groups: [] },
    stranger: { id: 'stranger', organizationId: 'org1', groups: [] },
};
const AUTOMATIONS = {
    a1: { id: 'a1', userId: 'owner', organizationId: 'org1', definition: {
        notificationSettings: { onApproval: { enabled: true, level: 'heads_up', channels: ['inapp', 'nc_talk'], ncTalkRoom: 'r1' } },
    } },
    a2: { id: 'a2', userId: 'owner', organizationId: 'org1', definition: {} },
};

let server;
let base;
let currentUser = 'owner';
let mail = true;

before(async () => {
    const app = express();
    app.use((req, _res, next) => { req.session = { isAuthenticated: true, user: { id: currentUser, organizationId: 'org1' } }; next(); });
    app.use(makeNotificationsRouter({
        store: {
            async getAutomation(id) { return AUTOMATIONS[id] ? { ...AUTOMATIONS[id] } : null; },
            async listSharesForAutomation(id) { return id === 'a1' ? [{ principalType: 'user', principalId: 'viewer', role: 'view' }] : []; },
        },
        events: {
            async listRecentNotificationEvents(id) {
                return id === 'a1' ? [{
                    id: 'ane_1', automationId: 'a1', runId: 'r9', event: 'onError', recipient: 'owner', channel: 'bell',
                    urgency: 'urgent', createdAt: '2026-09-28T10:00:00.000Z', deliveredAt: '2026-09-28T10:00:00.000Z', bundled: false,
                }] : [];
            },
        },
        getUser: async (id) => USERS[id] || null,
        hasPermission: async () => false,
        emailConfigured: async () => mail,
        talkStatus: async ({ settings }) => ({ room: settings.onApproval.talkRoom || null, bot: true }),
    }));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function get(path) {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, body: await r.json() };
}

test('an old-shape automation comes back in the new shape, with channels and recent attempts', async () => {
    currentUser = 'owner';
    mail = true;
    const { status, body } = await get('/a1/notifications');
    assert.equal(status, 200);
    assert.deepEqual(body.settings.onApproval.channels, ['bell', 'talk']);
    assert.equal(body.settings.onApproval.talkRoom, 'r1');
    assert.deepEqual(body.settings.onError, JSON.parse(JSON.stringify(NOTIFICATION_DEFAULTS.onError)));
    assert.deepEqual(body.defaults, JSON.parse(JSON.stringify(NOTIFICATION_DEFAULTS)));
    assert.deepEqual(body.channels, {
        bell: { available: true, nextcloud: true },
        email: { available: true },
        talk: { available: true, room: 'r1', bot: true },
    });
    assert.deepEqual(body.recent, [{
        event: 'onError', channel: 'bell', recipient: 'owner', urgency: 'urgent',
        createdAt: '2026-09-28T10:00:00.000Z', delivered: true, bundled: false, runId: 'r9',
    }]);
});

test('channels that cannot deliver say why', async () => {
    currentUser = 'owner';
    mail = false;
    const { body } = await get('/a2/notifications');
    assert.deepEqual(body.channels.email, { available: false, reason: 'no_service_email' });
    assert.deepEqual(body.channels.talk, { available: false, room: null, bot: true, reason: 'no_talk_room' });
    assert.deepEqual(body.recent, []);
});

test('a viewer may read it; someone without access may not', async () => {
    currentUser = 'viewer';
    assert.equal((await get('/a1/notifications')).status, 200);
    currentUser = 'stranger';
    const denied = await get('/a1/notifications');
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, { error: 'Forbidden', code: 'automation_forbidden', need: 'view' });
});

test('an unknown automation is a 404', async () => {
    currentUser = 'owner';
    assert.equal((await get('/nope/notifications')).status, 404);
});

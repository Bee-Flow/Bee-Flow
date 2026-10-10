/**
 * Notification preferences and project mutes against a real Postgres (PGlite).
 *
 * Run: cd server && node --test stores/notificationPrefsStore.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeNotificationPrefsStore, DDL, EVENTS, CHANNELS } = require('./notificationPrefsStore');

const { pg, db } = pgliteDb();
const store = makeNotificationPrefsStore(db);

before(() => pg.exec(DDL));
after(async () => { await pg.close(); });

test('the schema can be created again without changes', async () => {
    await pg.exec(DDL);
    assert.deepStrictEqual(CHANNELS, ['bell', 'email']);
    assert.strictEqual(EVENTS.length, 8);
});

test('defaults apply until a row says otherwise', async () => {
    const p = await store.getPrefs('u1');
    assert.strictEqual(p.email.role_changed, false);
    assert.strictEqual(p.bell.chat_mention, true);
    assert.strictEqual(p.bell.role_changed, true);
    await store.setPrefs('u1', { email: { role_changed: true } });
    assert.strictEqual((await store.getPrefs('u1')).email.role_changed, true);
    await store.setPrefs('u1', { email: { role_changed: false } });
    assert.strictEqual((await store.getPrefs('u1')).email.role_changed, false);
});

test('unknown events and channels are refused', async () => {
    await assert.rejects(() => store.setPrefs('u1', { bell: { fireworks: true } }), TypeError);
    await assert.rejects(() => store.setPrefs('u1', { sms: { added: true } }), TypeError);
    await assert.rejects(() => store.setPrefs('u1', { bell: { added: 'yes' } }), TypeError);
});

test('muting a project is per user and can be undone', async () => {
    assert.strictEqual(await store.isMuted('m1', 'p9'), false);
    await store.setMuted('m1', 'p9', true);
    await store.setMuted('m1', 'p9', true);
    assert.strictEqual(await store.isMuted('m1', 'p9'), true);
    assert.strictEqual(await store.isMuted('m2', 'p9'), false);
    await store.setMuted('m1', 'p9', false);
    assert.strictEqual(await store.isMuted('m1', 'p9'), false);
});

test('filterRecipients honours prefs and mutes per channel', async () => {
    await store.setPrefs('u2', { email: { chat_mention: false } });
    await store.setMuted('u3', 'p1', true);
    assert.deepStrictEqual(
        await store.filterRecipients(['u1', 'u2', 'u3'], 'p1', 'chat_mention'),
        { bell: ['u1', 'u2'], email: ['u1'] },
    );
    assert.deepStrictEqual(await store.filterRecipients([], 'p1', 'chat_mention'), { bell: [], email: [] });
    await assert.rejects(() => store.filterRecipients(['u1'], 'p1', 'nope'), TypeError);
});

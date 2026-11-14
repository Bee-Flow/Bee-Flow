// @typecheck
/**
 * notificationStore — tenancy scoping on the single-row mutations, against a
 * real Postgres (PGlite; the pool handed to createNotificationStore answers
 * through testUtils/pglitePool.js).
 *
 * `markRead(id)` / `deleteNotification(id)` keyed on the id alone would let a
 * leaked notification id (logs, a Referer, a shared screen) silence or destroy
 * another user's alert, and those alerts are how the AI-task and cowork
 * runners report failures. Both REQUIRE a `userId` scope and match on it; a
 * missing scope throws instead of degrading to the global statement.
 *
 * Run: cd server && node --test server/stores/notificationStore.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, query, close } = usePglitePool();
const { createNotificationStore } = require('./notificationStore');

const store = createNotificationStore(/** @type {any} */ ({ query }));

before(() => store.initDB());
after(close);

let victim = '';
let mine = '';
beforeEach(async () => {
    await pg.exec('DELETE FROM notifications');
    victim = (await store.createNotification({ userId: 'victim', title: 'Automation failed' })).id;
    mine = (await store.createNotification({ userId: 'attacker', title: 'Mine' })).id;
});

const rowOf = async (id) => (await pg.query('SELECT read FROM notifications WHERE id = $1', [id])).rows[0];

test("markRead(id, userId) will not touch another user's notification", async () => {
    assert.strictEqual(await store.markRead(victim, 'attacker'), false, 'reports "not found" rather than success');
    assert.strictEqual((await rowOf(victim)).read, false, 'victim alert still unread');
});

test("markRead(id, userId) still marks the caller's own notification", async () => {
    assert.strictEqual(await store.markRead(mine, 'attacker'), true);
    assert.strictEqual((await rowOf(mine)).read, true);
});

test("deleteNotification(id, userId) will not delete another user's notification", async () => {
    assert.strictEqual(await store.deleteNotification(victim, 'attacker'), false);
    assert.ok(await rowOf(victim), 'victim row survives');
});

test("deleteNotification(id, userId) still deletes the caller's own notification", async () => {
    assert.strictEqual(await store.deleteNotification(mine, 'attacker'), true);
    assert.strictEqual(await rowOf(mine), undefined);
});

test('an empty-string userId is a scope, not a bypass', async () => {
    assert.strictEqual(await store.markRead(victim, ''), false);
    assert.strictEqual((await rowOf(victim)).read, false);
});

test('a call with no scope fails closed: it never runs unscoped', async () => {
    await assert.rejects(() => /** @type {any} */ (store.markRead)(victim), /requires a userId scope/);
    await assert.rejects(() => /** @type {any} */ (store.deleteNotification)(victim), /requires a userId scope/);
    for (const missing of [null, undefined]) {
        await assert.rejects(() => store.markRead(victim, /** @type {any} */ (missing)), /requires a userId scope/);
        await assert.rejects(() => store.deleteNotification(victim, /** @type {any} */ (missing)), /requires a userId scope/);
    }
    assert.strictEqual((await rowOf(victim)).read, false);
});

test('markAllRead and deleteUserNotifications stay with their user', async () => {
    await store.markAllRead('victim');
    assert.strictEqual((await rowOf(victim)).read, true);
    assert.strictEqual((await rowOf(mine)).read, false);
    await store.deleteUserNotifications('victim');
    assert.strictEqual(await rowOf(victim), undefined);
    assert.ok(await rowOf(mine));
});

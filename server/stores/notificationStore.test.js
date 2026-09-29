/**
 * notificationStore — tenancy scoping on the single-row mutations. The fake pg
 * `pool` is handed to createNotificationStore, so no Postgres is involved and
 * nothing is parked in require.cache for a later suite to trip over.
 *
 * Regression: `markRead(id)` / `deleteNotification(id)` were keyed on the id
 * alone (`WHERE id = $1`) while every other statement in this store carries a
 * `user_id` predicate. A notification id that leaks (logs, a Referer, a shared
 * screen) was therefore enough to silence or destroy another user's alert —
 * and those alerts are how the AI-task and cowork runners report failures.
 *
 * Both functions now REQUIRE a `userId` scope and always emit `AND user_id =
 * $2`. It is required, not optional, because a security predicate must fail
 * closed: an optional scope that a caller forgets — or supplies as an absent
 * session value — silently degrades to the global statement, which is the very
 * bug above. A missing scope throws instead.
 *
 * Run: node --test server/stores/notificationStore.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { createNotificationStore } = require('./notificationStore');

let table = [];
const issued = [];

const pool = {
    query: async (sql, params = []) => {
        if (/CREATE TABLE|ALTER TABLE|CREATE INDEX/.test(sql)) return { rows: [], rowCount: 0 };
        issued.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const scoped = /user_id = \$2/.test(sql);
        const match = (r) => r.id === params[0] && (!scoped || r.user_id === params[1]);
        if (/^UPDATE notifications SET read = TRUE WHERE id = \$1/.test(sql)) {
            const hit = table.filter(match);
            hit.forEach(r => { r.read = true; });
            return { rows: [], rowCount: hit.length };
        }
        if (/^DELETE FROM notifications WHERE id = \$1/.test(sql)) {
            const before = table.length;
            table = table.filter(r => !match(r));
            return { rows: [], rowCount: before - table.length };
        }
        return { rows: [], rowCount: 0 };
    },
};

const store = createNotificationStore(pool);

beforeEach(() => {
    issued.length = 0;
    table = [
        { id: 'n-victim', user_id: 'victim', title: 'Routine failed', read: false },
        { id: 'n-mine', user_id: 'attacker', title: 'Mine', read: false },
    ];
});

test('markRead(id, userId) will not touch another user\'s notification', async () => {
    const ok = await store.markRead('n-victim', 'attacker');
    assert.strictEqual(ok, false, 'reports "not found" rather than success');
    assert.strictEqual(table.find(r => r.id === 'n-victim').read, false, 'victim alert still unread');
    assert.match(issued.at(-1).sql, /WHERE id = \$1 AND user_id = \$2/);
    assert.deepStrictEqual(issued.at(-1).params, ['n-victim', 'attacker']);
});

test('markRead(id, userId) still marks the caller\'s own notification', async () => {
    assert.strictEqual(await store.markRead('n-mine', 'attacker'), true);
    assert.strictEqual(table.find(r => r.id === 'n-mine').read, true);
});

test('deleteNotification(id, userId) will not delete another user\'s notification', async () => {
    const ok = await store.deleteNotification('n-victim', 'attacker');
    assert.strictEqual(ok, false);
    assert.ok(table.some(r => r.id === 'n-victim'), 'victim row survives');
    assert.match(issued.at(-1).sql, /DELETE FROM notifications WHERE id = \$1 AND user_id = \$2/);
    assert.deepStrictEqual(issued.at(-1).params, ['n-victim', 'attacker']);
});

test('deleteNotification(id, userId) still deletes the caller\'s own notification', async () => {
    assert.strictEqual(await store.deleteNotification('n-mine', 'attacker'), true);
    assert.strictEqual(table.filter(r => r.id === 'n-mine').length, 0);
});

test('an empty-string userId is a scope, not a bypass', async () => {
    assert.strictEqual(await store.markRead('n-victim', ''), false);
    assert.match(issued.at(-1).sql, /AND user_id = \$2/);
    assert.strictEqual(table.find(r => r.id === 'n-victim').read, false);
});

test('a call with no scope fails closed — it never runs unscoped', async () => {
    // Previously this test asserted the opposite (`markRead('n-victim')` -> true,
    // `WHERE id = $1`, no user_id). That pinned a fail-OPEN default: a caller
    // that meant to scope but had no session value got the GLOBAL statement.
    // The id-only form is now a TypeError, so such a caller breaks loudly.
    await assert.rejects(() => store.markRead('n-victim'), /requires a userId scope/);
    await assert.rejects(() => store.deleteNotification('n-victim'), /requires a userId scope/);
    assert.deepStrictEqual(issued, [], 'no SQL reached the pool at all');
    assert.strictEqual(table.find(r => r.id === 'n-victim').read, false);
    assert.ok(table.some(r => r.id === 'n-victim'), 'victim row survives');
});

test('an explicitly-missing scope value fails closed too (null/undefined)', async () => {
    // The realistic shape of the hazard: markRead(req.params.id, req.session?.user?.id)
    // written after the route helper is deleted, with the session absent.
    for (const missing of [null, undefined]) {
        await assert.rejects(() => store.markRead('n-victim', missing), /requires a userId scope/);
        await assert.rejects(() => store.deleteNotification('n-victim', missing), /requires a userId scope/);
    }
    assert.deepStrictEqual(issued, []);
    assert.strictEqual(table.find(r => r.id === 'n-victim').read, false);
    assert.ok(table.some(r => r.id === 'n-victim'));
});

test('markAllRead and deleteUserNotifications remain user-scoped', async () => {
    await store.markAllRead('victim');
    assert.match(issued.at(-1).sql, /WHERE user_id = \$1/);
    await store.deleteUserNotifications('victim');
    assert.match(issued.at(-1).sql, /DELETE FROM notifications WHERE user_id = \$1/);
});

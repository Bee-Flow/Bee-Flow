// @typecheck
/**
 * reminderStore.processDueReminders against a real Postgres (pglite): a due
 * reminder is claimed in the database before it is sent, so two passes that
 * read the same row (two replicas on the same minute) fire it once, a
 * repeating reminder advances once, a reminder whose notification failed is
 * handed back, and the pass itself never rejects.
 *
 * Run: cd server && node --test stores/reminderStore.claim.pg.test.js
 */

'use strict';

process.env.TZ = 'UTC';
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const db = require('../db');
const reminders = require('./reminderStore');
const notificationStore = require('./notificationStore');

before(async () => { await reminders.initDB(); });
after(close);
beforeEach(async () => { await pg.query('DELETE FROM reminders'); });

const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms);
/** Microseconds on purpose: a timestamp a JS Date cannot hold exactly. */
async function due(id, { repeat = null, at = ago(HOUR) } = {}) {
    await pg.query(
        `INSERT INTO reminders (id, user_id, title, message, remind_at, repeat_interval) VALUES ($1, 'u1', $1, '', $2::timestamptz + interval '123 microseconds', $3)`,
        [id, at, repeat],
    );
}
const row = async (id) => (await pg.query('SELECT * FROM reminders WHERE id = $1', [id])).rows[0];

/** Record what is sent instead of writing notifications. */
function capture(t, impl = async (_n) => {}) {
    const sent = [];
    t.mock.method(notificationStore, 'createNotification', async (n) => { sent.push(n.title); return impl(n); });
    return sent;
}

test('two passes at once fire each due reminder once', async (t) => {
    await due('one-off');
    await due('daily', { repeat: 'daily' });
    const sent = capture(t);

    await Promise.all([reminders.processDueReminders(), reminders.processDueReminders(), reminders.processDueReminders()]);

    assert.deepEqual([...sent].sort(), ['🔔 Reminder: daily', '🔔 Reminder: one-off']);
    assert.equal((await row('one-off')).is_completed, true);
});

test('a repeating reminder advances once, to its next occurrence', async (t) => {
    const at = ago(HOUR);
    await due('daily', { repeat: 'daily', at });
    capture(t);
    await Promise.all([reminders.processDueReminders(), reminders.processDueReminders()]);

    const r = await row('daily');
    assert.equal(r.is_completed, false);
    assert.equal(new Date(r.remind_at).getTime(), at.getTime() + 24 * HOUR, 'one day on, not two');
});

test('a long-overdue repeating reminder catches up one occurrence per pass, never two in one', async (t) => {
    const at = ago(3 * 24 * HOUR);
    await due('daily', { repeat: 'daily', at });
    const sent = capture(t);
    await Promise.all([reminders.processDueReminders(), reminders.processDueReminders()]);
    assert.equal(sent.length, 1, 'the next occurrence is still in the past, and still only one pass fired');
    assert.equal(new Date((await row('daily')).remind_at).getTime(), at.getTime() + 24 * HOUR);
});

test('a reminder whose notification failed is handed back and sent by the next pass', async (t) => {
    await due('one-off');
    await due('weekly', { repeat: 'weekly' });
    const before = { oneOff: await row('one-off'), weekly: await row('weekly') };
    let failing = true;
    const sent = capture(t, async () => { if (failing) throw new Error('notification store is down'); });

    await reminders.processDueReminders();
    assert.equal((await row('one-off')).is_completed, false, 'still open');
    assert.deepEqual((await row('weekly')).remind_at, before.weekly.remind_at, 'still due at the same time');

    failing = false;
    sent.length = 0;
    await reminders.processDueReminders();
    assert.deepEqual([...sent].sort(), ['🔔 Reminder: one-off', '🔔 Reminder: weekly']);
    assert.equal((await row('one-off')).is_completed, true);
});

test('a pass never rejects, also when the database is down (it runs under setInterval)', async (t) => {
    await due('one-off');
    const sent = capture(t);
    t.mock.method(db.pool, 'query', async () => { throw new Error('connection refused'); });
    await assert.doesNotReject(() => reminders.processDueReminders());
    assert.deepEqual(sent, []);
});

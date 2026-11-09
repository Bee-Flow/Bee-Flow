// @typecheck
/**
 * reminderStore.processDueReminders: where a repeating reminder goes next.
 *
 * A monthly reminder advanced with a bare setMonth, which overflows on a day
 * the next month does not have: one set for 31 January moved to 3 March,
 * skipping February, and stayed on the 3rd from then on.
 *
 * Run: cd server && node --test stores/reminderStore.repeat.test.js
 */

'use strict';

process.env.TZ = 'UTC';
process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { recordDb } = require('../testUtils/routeHarness');

let due = [];
const db = recordDb((sql) => (/FROM reminders WHERE remind_at <= NOW\(\)/.test(sql) ? { rows: due } : undefined));
const reminders = require('./reminderStore');

beforeEach(db.reset);

const moved = () => db.calls.filter((q) => /^UPDATE reminders SET remind_at/.test(q.sql.trim())).map((q) => q.params);

const reminder = (id, remindAt, repeat) => ({ id, user_id: 'u1', title: 'Synthetic', message: '', remind_at: new Date(remindAt), repeat_interval: repeat });

test('a monthly reminder on the 31st goes to the last day of the next month', async () => {
    due = [reminder('r1', '2026-01-31T08:00:00.000Z', 'monthly'), reminder('r2', '2026-05-31T08:00:00.000Z', 'monthly')];
    await reminders.processDueReminders();
    assert.deepEqual(moved(), [['2026-02-28T08:00:00.000Z', 'r1'], ['2026-06-30T08:00:00.000Z', 'r2']]);
});

test('ordinary monthly, weekly and daily repeats are unchanged', async () => {
    due = [
        reminder('r1', '2026-01-15T08:00:00.000Z', 'monthly'),
        reminder('r2', '2026-12-10T08:00:00.000Z', 'monthly'),
        reminder('r3', '2026-01-31T08:00:00.000Z', 'weekly'),
        reminder('r4', '2026-01-31T08:00:00.000Z', 'daily'),
    ];
    await reminders.processDueReminders();
    assert.deepEqual(moved(), [
        ['2026-02-15T08:00:00.000Z', 'r1'], ['2027-01-10T08:00:00.000Z', 'r2'],
        ['2026-02-07T08:00:00.000Z', 'r3'], ['2026-02-01T08:00:00.000Z', 'r4'],
    ]);
});

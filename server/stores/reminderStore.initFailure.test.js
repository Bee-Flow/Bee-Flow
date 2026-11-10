// @typecheck
/**
 * reminderStore.processDueReminders runs under setInterval, so it must not
 * reject. A schema init that fails (the database is not up yet) is logged
 * like any other failure of the pass.
 *
 * Run: cd server && node --test stores/reminderStore.initFailure.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const reminders = require('./reminderStore');

test('a pass whose schema init fails does not reject', async (t) => {
    const down = async () => { throw new Error('connect ECONNREFUSED'); };
    t.mock.method(db.pool, 'query', down);
    t.mock.method(db.pool, 'connect', down);
    await assert.rejects(() => reminders.initDB(), 'the init itself fails in this setup');
    await assert.doesNotReject(() => reminders.processDueReminders());
});

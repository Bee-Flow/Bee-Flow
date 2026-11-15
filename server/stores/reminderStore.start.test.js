// @typecheck strict
/**
 * The reminder checker runs once boot calls start(), not because the store was
 * required: a script, a generator or a test that loads the store must not run
 * a job against the database it happens to point at.
 *
 * Run: node --test stores/reminderStore.start.test.js
 */

process.env.NODE_ENV = 'test';

const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { useMockedTimers } = require('../testUtils/mockedTimers');

// Before the store loads: a timer it armed at require time would fire in the first test.
const timers = useMockedTimers();
const db = require('../db');
const reminders = require('./reminderStore');

/** The SQL the store sent. */
/** @type {string[]} */
let queries = [];
const duePasses = () => queries.filter((sql) => sql.includes('FROM reminders')).length;

beforeEach(() => {
    queries = [];
    // A database double under the real store: every statement succeeds and no
    // reminder is due, so a pass is its schema init and one SELECT.
    const query = async (/** @type {unknown} */ sql) => {
        queries.push(String(sql));
        return { rows: [], rowCount: 0 };
    };
    mock.method(db.pool, 'query', query);
    mock.method(db.pool, 'connect', async () => ({ query, release: () => {} }));
});

afterEach(() => {
    reminders.stop();
    mock.restoreAll();
});

test('requiring the store starts no checker', async () => {
    await timers.advance(10 * 60_000);
    assert.equal(queries.length, 0);
});

test('start() runs a first pass after 5 s and one every minute after that', async () => {
    assert.equal(reminders.start(), true);

    await timers.advance(4_999);
    assert.equal(duePasses(), 0, 'nothing before the first pass is due');

    await timers.advance(1);
    assert.equal(duePasses(), 1, 'the first pass, 5 s after the start');

    await timers.advance(55_000);
    assert.equal(duePasses(), 2, 'the first tick of the 60 s interval');

    await timers.advance(60_000);
    assert.equal(duePasses(), 3);
});

test('start() is idempotent: a second call arms nothing', async () => {
    assert.equal(reminders.start(), true);
    assert.equal(reminders.start(), false);

    await timers.advance(5_000);
    assert.equal(duePasses(), 1, 'one pass, not one per call');
});

test('stop() calls the checker off, and start() arms it again', async () => {
    reminders.start();
    reminders.stop();
    await timers.advance(10 * 60_000);
    assert.equal(duePasses(), 0);

    assert.equal(reminders.start(), true);
    await timers.advance(5_000);
    assert.equal(duePasses(), 1);
});

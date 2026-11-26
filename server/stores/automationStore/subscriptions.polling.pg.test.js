// @typecheck
'use strict';
/**
 * Which subscriptions a polling pass looks at, against a real Postgres
 * (PGlite): a healthy one every interval, and one that keeps failing at its
 * own, longer interval, so a sign-in that expired is not asked for again
 * every tick until its owner reconnects.
 * Run: cd server && node --test stores/automationStore/subscriptions.polling.pg.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { POLLING_SUBSCRIPTIONS_SQL } = require('./subscriptions');

const { pg } = pgliteDb();

const MINUTE = 60_000;
/** The pass as triggerBus runs it: every minute, failing from 5 failures on, then every 15 minutes. */
const due = async ({ olderThanMs = MINUTE, webhookStaleMs = 15 * MINUTE, failureThreshold = 5, failingPollIntervalMs = 15 * MINUTE } = {}) => (
    await pg.query(POLLING_SUBSCRIPTIONS_SQL, [olderThanMs, webhookStaleMs, failureThreshold, failingPollIntervalMs])
).rows.map((/** @type {{ id: string }} */ r) => r.id);

/**
 * @param {string} id
 * @param {{ mode?: string, polledMinutesAgo?: number | null, pushedMinutesAgo?: number | null, failures?: number }} [row]
 */
async function seed(id, { mode = 'polling', polledMinutesAgo = null, pushedMinutesAgo = null, failures = 0 } = {}) {
    await pg.query(
        `INSERT INTO automation_event_subscriptions (id, mode, last_polled_at, last_push_at, consecutive_failures)
         VALUES ($1, $2,
                 CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - ($3::int * INTERVAL '1 minute') END,
                 CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() - ($4::int * INTERVAL '1 minute') END,
                 $5)`,
        [id, mode, polledMinutesAgo, pushedMinutesAgo, failures],
    );
}

before(async () => {
    // The columns the query reads.
    await pg.exec(`CREATE TABLE automation_event_subscriptions (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'webhook', last_polled_at TIMESTAMPTZ, last_push_at TIMESTAMPTZ,
        consecutive_failures INTEGER NOT NULL DEFAULT 0)`);
});
after(async () => { await pg.close(); });
beforeEach(async () => { await pg.exec('TRUNCATE automation_event_subscriptions'); });

test('a healthy polling subscription is due after the poll interval, a never-polled one at once', async () => {
    await seed('new');
    await seed('due', { polledMinutesAgo: 2 });
    await seed('just-polled', { polledMinutesAgo: 0 });
    assert.deepStrictEqual(await due(), ['new', 'due']);
});

test('a subscription that keeps failing is polled every 15 minutes, not every tick', async () => {
    await seed('failing-recent', { polledMinutesAgo: 2, failures: 5 });
    await seed('failing-long', { polledMinutesAgo: 9, failures: 400 });
    await seed('failing-due', { polledMinutesAgo: 16, failures: 5 });
    // Below the threshold it is still a hiccup (a rate limit), polled as usual.
    await seed('hiccup', { polledMinutesAgo: 2, failures: 4 });
    assert.deepStrictEqual(await due(), ['failing-due', 'hiccup']);
});

test('the first success puts it back on the normal interval', async () => {
    await seed('recovered', { polledMinutesAgo: 2, failures: 5 });
    assert.deepStrictEqual(await due(), []);
    await pg.exec(`UPDATE automation_event_subscriptions SET consecutive_failures = 0`);
    assert.deepStrictEqual(await due(), ['recovered']);
});

test('a webhook subscription is polled only after its push has been silent, and a failing one at the longer interval too', async () => {
    await seed('pushing', { mode: 'webhook', pushedMinutesAgo: 1, polledMinutesAgo: 30 });
    await seed('silent', { mode: 'webhook', pushedMinutesAgo: 20, polledMinutesAgo: 2 });
    await seed('silent-failing', { mode: 'webhook', pushedMinutesAgo: 20, polledMinutesAgo: 2, failures: 6 });
    await seed('never-pushed', { mode: 'webhook' });
    assert.deepStrictEqual(await due(), ['never-pushed', 'silent']);
});

test('the oldest-considered come first and the window is 50', async () => {
    for (let i = 0; i < 55; i++) await seed(`s${String(i).padStart(2, '0')}`, { polledMinutesAgo: 100 - i });
    const ids = await due();
    assert.strictEqual(ids.length, 50);
    assert.strictEqual(ids[0], 's00');
    assert.strictEqual(ids[49], 's49');
});

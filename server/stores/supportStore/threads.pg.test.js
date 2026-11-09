// @typecheck
/**
 * support_threads against a REAL Postgres (@electric-sql/pglite, in-process)
 * and the store's own schema.
 *
 *   A. A staff reply moves the ticket to awaiting_user. The SLA clock pauses
 *      while a ticket waits on the customer (updateThread derives sla_paused
 *      from the status), but firstStaffReplyTransition set the status without
 *      the pause, so the resolution SLA of an answered ticket kept running and
 *      was flagged as breached while the customer had the ball.
 *   B. The inbox search text went into ILIKE as it was typed, so "100%" or
 *      "a_b" matched as wildcards and returned tickets that do not contain it.
 *
 * Run: cd server && node --test stores/supportStore/threads.pg.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { newPglite } = require('../../testUtils/pgliteTemplate');
const { usePglitePool } = require('../../testUtils/pglitePool');

const pg = newPglite();
const { query, restore: restorePool } = usePglitePool(pg);
const threads = require('./threads');
const sla = require('./sla');

async function newThread(subject = 'Synthetic subject') {
    const row = await threads.createThread({ requesterEmail: 'requester@example.test', source: 'in_app', subject });
    return row.id;
}

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await threads.getThread('00000000-0000-0000-0000-000000000000'); // the store's own schema init
});

beforeEach(async () => { await query('DELETE FROM support_threads'); });

after(async () => {
    restorePool();
    await pg.close();
});

test('A: a staff reply pauses the SLA clock, like every other move to awaiting_user', async () => {
    const id = await newThread();
    const row = await threads.firstStaffReplyTransition(id, 'staff-1');
    assert.strictEqual(row.status, 'awaiting_user');
    assert.strictEqual(row.sla_paused, true);
    assert.strictEqual(row.assignee_user_id, 'staff-1');
    assert.ok(row.first_response_at);
});

test('A: an answered ticket whose resolution deadline passes is not flagged while it waits on the customer', async () => {
    const answered = await newThread('answered');
    const untouched = await newThread('untouched');
    await query(`UPDATE support_threads SET sla_resolution_due_at = now() - interval '1 hour'`);
    await threads.firstStaffReplyTransition(answered, 'staff-1');

    const flagged = await sla.flagResolutionBreaches();
    assert.deepStrictEqual(flagged.map((r) => r.id), [untouched]);

    // The customer answers: the clock runs again and the breach is seen.
    await threads.updateThread(answered, { status: 'awaiting_agent' });
    assert.deepStrictEqual((await sla.flagResolutionBreaches()).map((r) => r.id), [answered]);
});

test('B: % and _ in the inbox search are text, not wildcards', async () => {
    await newThread('Discount 100% off');
    await newThread('Discount 1000 off');
    await newThread('file a_b.txt');
    await newThread('file axb.txt');

    assert.deepStrictEqual((await threads.listThreads({ q: '100%' })).map((t) => t.subject), ['Discount 100% off']);
    assert.deepStrictEqual((await threads.listThreads({ q: 'a_b' })).map((t) => t.subject), ['file a_b.txt']);
    assert.strictEqual((await threads.listThreads({ q: 'discount' })).length, 2, 'a plain search is still a substring match');
});

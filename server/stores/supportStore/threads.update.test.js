// @typecheck strict
/**
 * supportStore.updateThread against a real Postgres (PGlite behind db.js's
 * pool, testUtils/pglitePool.js).
 *
 * The column literal comes from a map and nothing else, so a caller's key can
 * neither name a column nor carry SQL into one: an unknown key is dropped, and
 * a patch of only unknown keys writes nothing. The SLA pause follows the
 * status unless the caller sets it, and every write bumps updated_at.
 *
 * Run: cd server && node --test stores/supportStore/threads.update.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('./schema');
const threads = require('./threads');

before(() => initDB());
after(close);

async function thread() {
    const { rows } = await pg.query(
        `INSERT INTO support_threads (organization_id, requester_email, source, subject, updated_at)
         VALUES ('org-1', 'r@example.test', 'in_app', 'Invoice', NOW() - INTERVAL '1 day') RETURNING id`,
    );
    return rows[0].id;
}
const row = async (/** @type {string} */ id) => (await pg.query(
    'SELECT organization_id, subject, priority, status, assignee_user_id, sla_paused, updated_at FROM support_threads WHERE id = $1', [id],
)).rows[0];

test('a known field is written, and the timestamp goes with it', async () => {
    const id = await thread();
    const before = await row(id);
    const out = await threads.updateThread(id, { priority: 'high' });
    const after = await row(id);
    assert.strictEqual(after.priority, 'high');
    assert.strictEqual(out.priority, 'high');
    assert.ok(new Date(after.updated_at) > new Date(before.updated_at));
});

test('an unknown key names no column and reaches no SQL', async () => {
    const id = await thread();
    const before = await row(id);
    await threads.updateThread(id, {
        organization_id: 'other-org',
        "status = 'closed', assignee_user_id": 'attacker',
    });
    assert.deepStrictEqual(await row(id), before, 'nothing mapped changed: no write at all');
});

test('an unknown key alongside a known one does not widen the write', async () => {
    const id = await thread();
    await threads.updateThread(id, { subject: 'Re: factuur', organization_id: 'other-org' });
    const after = await row(id);
    assert.strictEqual(after.subject, 'Re: factuur');
    assert.strictEqual(after.organization_id, 'org-1', 'the caller does not get to name a column');
});

test('sla_paused is derived from the status transition, and an explicit value wins', async () => {
    const id = await thread();
    await threads.updateThread(id, { status: 'awaiting_user' });
    assert.strictEqual((await row(id)).sla_paused, true, 'waiting on the customer pauses the clock');
    await threads.updateThread(id, { status: 'open' });
    assert.strictEqual((await row(id)).sla_paused, false, 'any other status resumes it');
    await threads.updateThread(id, { status: 'awaiting_user', sla_paused: false });
    assert.strictEqual((await row(id)).sla_paused, false, 'an explicit sla_paused is not overruled');
});

test('the update touches only the thread it names', async () => {
    const a = await thread();
    const b = await thread();
    await threads.updateThread(a, { priority: 'urgent' });
    assert.notStrictEqual((await row(b)).priority, 'urgent');
});

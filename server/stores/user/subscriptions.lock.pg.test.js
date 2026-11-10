// @typecheck
/**
 * The row-locked subscription writes (setOrgSubscriptionWithLock and the two
 * ...RespectingOverride wrappers), against a real Postgres (pglite): the
 * FOR UPDATE read, the decision and the write are ONE transaction on ONE
 * client, so the lock is still held when the row is written.
 *
 * Run: cd server && node --test stores/user/subscriptions.lock.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, query, close } = usePglitePool();
const db = require('../../db');
const { initDB } = require('./schema');
const subs = require('./subscriptions');

/** Every statement, tagged with the connection it travelled on. */
let seen = [];
const record = (via) => (sql, params) => {
    seen.push({ via, sql: String(sql).trim() });
    return query(sql, params);
};
db.pool.query = /** @type {any} */ (record('pool'));
db.pool.connect = /** @type {any} */ (async () => ({ query: record('tx'), release() {} }));

const FUTURE = new Date(Date.now() + 3600_000).toISOString();
const row = async (table, col, id) => (await pg.query(`SELECT * FROM ${table} WHERE ${col} = $1`, [id])).rows[0];
const orgRow = (id) => row('organization_subscriptions', 'organization_id', id);

/** The statements between BEGIN and COMMIT/ROLLBACK, and what closed them. */
function transaction() {
    const tx = seen.filter((s) => s.via === 'tx').map((s) => s.sql);
    return { statements: tx.slice(tx.indexOf('BEGIN') + 1, -1), end: tx[tx.length - 1] };
}
const writesOutsideTx = () => seen.filter((s) => s.via === 'pool' && /^(UPDATE|INSERT)/i.test(s.sql));

before(async () => {
    await initDB();
    await pg.query(`INSERT INTO organizations (id, name) VALUES ('org1', 'Acme')`);
    await pg.query(`INSERT INTO users (id, username) VALUES ('u1', 'u1')`);
});
after(close);

beforeEach(async () => {
    await pg.query('DELETE FROM organization_subscriptions');
    await pg.query('DELETE FROM consumer_subscriptions');
    assert.equal(await subs.setOrgSubscription('org1', { status: 'active', payment_status: 'paid' }), true);
    assert.equal(await subs.setConsumerSubscription('u1', { status: 'active', payment_status: 'paid' }), true);
    seen = [];
});

test('setOrgSubscriptionWithLock writes on the client that holds the row lock', async () => {
    const out = await subs.setOrgSubscriptionWithLock('org1', { status: 'suspended', manual_override_until: FUTURE, manual_override_by: 'admin-a' });
    assert.equal(out.ok, true);
    assert.equal(out.displaced, false);
    assert.equal(out.snapshot.status, 'active');

    const { statements, end } = transaction();
    assert.match(statements[0], /FROM organization_subscriptions WHERE organization_id = \$1 FOR UPDATE$/);
    assert.match(statements[1], /^UPDATE "?organization_subscriptions"?/);
    assert.equal(end, 'COMMIT');
    assert.deepEqual(writesOutsideTx(), []);
    assert.equal((await orgRow('org1')).status, 'suspended');
});

test('a second admin who overwrites a live override is reported as displacing it', async () => {
    await subs.setOrgSubscriptionWithLock('org1', { manual_override_until: FUTURE, manual_override_by: 'admin-a' });
    const out = await subs.setOrgSubscriptionWithLock('org1', { manual_override_until: FUTURE, manual_override_by: 'admin-b' });
    assert.equal(out.displaced, true);
    assert.equal(out.snapshot.manual_override_by, 'admin-a');
    assert.equal((await orgRow('org1')).manual_override_by, 'admin-b');
});

test('setOrgSubscriptionWithLock answers ok:false and leaves the row when the write is refused', async () => {
    // max_users is an INTEGER column: Postgres refuses the value.
    const out = await subs.setOrgSubscriptionWithLock('org1', { status: 'suspended', max_users: 'not-a-number' });
    assert.equal(out.ok, false);
    assert.equal(transaction().end, 'ROLLBACK');
    assert.equal((await orgRow('org1')).status, 'active');
});

test('the override decision and the write share one transaction (organisation)', async () => {
    const full = { status: 'past_due', payment_status: 'failed' };
    const stripped = { payment_status: 'failed' };

    assert.deepEqual(await subs.setOrgSubscriptionRespectingOverride('org1', full, stripped), { applied: 'full', overrideActive: false });
    let { statements, end } = transaction();
    assert.match(statements[0], /FOR UPDATE$/);
    assert.match(statements[1], /^UPDATE/);
    assert.equal(end, 'COMMIT');
    assert.deepEqual(writesOutsideTx(), []);
    assert.equal((await orgRow('org1')).status, 'past_due');

    await subs.setOrgSubscription('org1', { status: 'active', manual_override_until: FUTURE, manual_override_by: 'admin-a' });
    seen = [];
    assert.deepEqual(await subs.setOrgSubscriptionRespectingOverride('org1', full, stripped), { applied: 'stripped', overrideActive: true });
    ({ statements, end } = transaction());
    assert.equal(statements.length, 2);
    assert.deepEqual(writesOutsideTx(), []);
    assert.equal((await orgRow('org1')).status, 'active', 'the admin-held status is not overwritten');

    seen = [];
    assert.deepEqual(await subs.setOrgSubscriptionRespectingOverride('org1', full, {}), { applied: 'none', overrideActive: true });
    assert.equal(transaction().statements.length, 1, 'an empty stripped payload writes nothing');
});

test('the override decision and the write share one transaction (consumer)', async () => {
    const out = await subs.setConsumerSubscriptionRespectingOverride('u1', { status: 'past_due' }, {});
    assert.deepEqual(out, { applied: 'full', overrideActive: false });
    const { statements, end } = transaction();
    assert.match(statements[0], /FROM consumer_subscriptions WHERE user_id = \$1 FOR UPDATE$/);
    assert.match(statements[1], /^UPDATE/);
    assert.equal(end, 'COMMIT');
    assert.deepEqual(writesOutsideTx(), []);
    assert.equal((await row('consumer_subscriptions', 'user_id', 'u1')).status, 'past_due');
});

test('a subscriber without a row is inserted inside the transaction', async () => {
    await pg.query('DELETE FROM organization_subscriptions');
    seen = [];
    assert.deepEqual(await subs.setOrgSubscriptionRespectingOverride('org1', { status: 'active' }, {}), { applied: 'full', overrideActive: false });
    assert.match(transaction().statements[1], /^INSERT INTO organization_subscriptions/);
    assert.equal((await orgRow('org1')).status, 'active');
});

test('a refused write under the lock rejects, so a webhook does not report it as applied', async () => {
    await assert.rejects(() => subs.setOrgSubscriptionRespectingOverride('org1', { status: 'past_due', max_users: 'not-a-number' }, {}));
    assert.equal(transaction().end, 'ROLLBACK');
    assert.equal((await orgRow('org1')).status, 'active');
    await assert.rejects(() => subs.setOrgSubscriptionRespectingOverride('org1', { status: 'no-such-status' }, {}), /Invalid subscription status/);
});

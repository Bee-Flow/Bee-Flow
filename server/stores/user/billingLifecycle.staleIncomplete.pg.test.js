// @typecheck
/**
 * cancelStaleIncompleteSubscriptions is a sweep: a row whose write the
 * database refuses is counted and left `incomplete` for the next tick, and
 * the rows after it are still cancelled and audited. Real store on PGlite.
 *
 * Run: cd server && node --test stores/user/billingLifecycle.staleIncomplete.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { guardedPglitePool, STATUS_WRITE } = require('../../testUtils/stripeWebhookKit');

const { pg, close, failWrites } = guardedPglitePool();
const { initDB } = require('./schema');
const subs = require('./subscriptions');
const { cancelStaleIncompleteSubscriptions } = require('./billingLifecycle');

const ORGS = ['org1', 'org2', 'org3'];
const statuses = async (table, col) => Object.fromEntries((await pg.query(`SELECT ${col} AS id, status FROM ${table} ORDER BY ${col}`)).rows.map((r) => [r.id, r.status]));
const audited = async () => (await pg.query(`SELECT target_id FROM subscription_audit_log WHERE action = 'cancel_stale_incomplete' ORDER BY target_id`)).rows.map((r) => r.target_id);

before(async () => {
    await initDB();
    for (const id of ORGS) await pg.query('INSERT INTO organizations (id, name) VALUES ($1, $1)', [id]);
    await pg.query(`INSERT INTO users (id, username) VALUES ('u1', 'u1')`);
});
after(close);

/** Three organisations and one consumer, all `incomplete` for a month. */
beforeEach(async () => {
    failWrites(null);
    for (const t of ['organization_subscriptions', 'consumer_subscriptions', 'subscription_audit_log']) await pg.query(`DELETE FROM ${t}`);
    for (const id of ORGS) assert.equal(await subs.setOrgSubscription(id, { status: 'incomplete' }), true);
    assert.equal(await subs.setConsumerSubscription('u1', { status: 'incomplete' }), true);
    await pg.query(`UPDATE organization_subscriptions SET created_at = NOW() - INTERVAL '30 days'`);
    await pg.query(`UPDATE consumer_subscriptions SET created_at = NOW() - INTERVAL '30 days'`);
});

test('every stale row is cancelled and audited', async () => {
    assert.deepEqual(await cancelStaleIncompleteSubscriptions(14), { orgs: 3, consumers: 1, failed: 0 });
    assert.deepEqual(await statuses('organization_subscriptions', 'organization_id'), { org1: 'cancelled', org2: 'cancelled', org3: 'cancelled' });
    assert.deepEqual(await statuses('consumer_subscriptions', 'user_id'), { u1: 'cancelled' });
    assert.deepEqual(await audited(), ['org1', 'org2', 'org3', 'u1']);
});

test('one refused row is counted and stays incomplete; the rows after it are still cancelled', async () => {
    // Only the first status write is refused.
    let writes = 0;
    failWrites({ test: (sql) => STATUS_WRITE.test(sql) && ++writes === 1 });
    const result = await cancelStaleIncompleteSubscriptions(14);
    assert.deepEqual(result, { orgs: 2, consumers: 1, failed: 1 });

    const orgs = await statuses('organization_subscriptions', 'organization_id');
    const left = Object.keys(orgs).filter((id) => orgs[id] === 'incomplete');
    assert.equal(left.length, 1);
    assert.deepEqual(await statuses('consumer_subscriptions', 'user_id'), { u1: 'cancelled' });
    assert.deepEqual(await audited(), [...ORGS.filter((id) => id !== left[0]), 'u1'], 'no audit row for the row that was not written');

    // The next tick takes the row that was left.
    failWrites(null);
    assert.deepEqual(await cancelStaleIncompleteSubscriptions(14), { orgs: 1, consumers: 0, failed: 0 });
});

test('a row younger than the threshold is left alone', async () => {
    await pg.query(`UPDATE organization_subscriptions SET created_at = NOW() WHERE organization_id = 'org2'`);
    assert.deepEqual(await cancelStaleIncompleteSubscriptions(14), { orgs: 2, consumers: 1, failed: 0 });
    assert.equal((await statuses('organization_subscriptions', 'organization_id')).org2, 'incomplete');
});

// @typecheck
/**
 * BFSF-245/249: when a plan is assigned, the per-org limit override columns
 * that the caller does not set go back to NULL so the plan governs, also when
 * the plan stays the same and the write is a deliberate assignment
 * (`resetLimits`). A write that merely re-sends the current plan_id (Stripe's
 * subscription.updated) leaves overrides alone. Real Postgres (pglite).
 *
 * Run: cd server && node --test stores/user/subscriptions.resetLimits.pg.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { usePglitePool } = require('../../testUtils/pglitePool');

// The real db.js over PGlite: the pool is the seam, no module mocking.
const { pg, close } = usePglitePool();
const { initDB } = require('./schema');
const subs = require('./subscriptions');

const ORG = 'org_launch';
const STALE = { max_agents: 5, max_knowledge_sources: 3, max_cost_per_month: 2, max_users: 1 };

before(async () => {
    await initDB();
    await pg.query(`INSERT INTO organizations (id, name) VALUES ($1, 'Launch org')`, [ORG]);
    await pg.query(`INSERT INTO subscription_plans (id, name, price) VALUES ('free', 'Free', 0), ('launch', 'Launch', 30)`);
});
beforeEach(async () => {
    await pg.query('DELETE FROM organization_subscriptions');
    await subs.setOrgSubscription(ORG, { plan_id: 'launch', status: 'active', ...STALE });
});
after(close);

async function limits() {
    const { rows } = await pg.query(
        'SELECT plan_id, max_agents, max_knowledge_sources, max_cost_per_month, max_users FROM organization_subscriptions WHERE organization_id = $1',
        [ORG],
    );
    return rows[0];
}

test('assigning the SAME plan on purpose clears the stale overrides', async () => {
    assert.ok(await subs.setOrgSubscription(ORG, { plan_id: 'launch' }, { resetLimits: true }));
    assert.deepEqual(await limits(), { plan_id: 'launch', max_agents: null, max_knowledge_sources: null, max_cost_per_month: null, max_users: null });
});

test('re-sending the current plan without resetLimits (a Stripe sync) keeps overrides', async () => {
    await subs.setOrgSubscription(ORG, { plan_id: 'launch', status: 'active' });
    assert.deepEqual(await limits(), { plan_id: 'launch', ...STALE });
});

test('a plan change clears the overrides without being asked', async () => {
    await subs.setOrgSubscription(ORG, { plan_id: 'free' });
    assert.deepEqual(await limits(), { plan_id: 'free', max_agents: null, max_knowledge_sources: null, max_cost_per_month: null, max_users: null });
});

test('a limit written explicitly with the assignment wins; the others are cleared', async () => {
    await subs.setOrgSubscription(ORG, { plan_id: 'launch', max_users: 25 }, { resetLimits: true });
    assert.deepEqual(await limits(), { plan_id: 'launch', max_agents: null, max_knowledge_sources: null, max_cost_per_month: null, max_users: 25 });
});

test('a write without plan_id never clears, even with resetLimits', async () => {
    await subs.setOrgSubscription(ORG, { notes: 'x' }, { resetLimits: true });
    assert.deepEqual(await limits(), { plan_id: 'launch', ...STALE });
});

test('setOrgSubscriptionWithLock passes resetLimits through', async () => {
    const r = await subs.setOrgSubscriptionWithLock(ORG, { plan_id: 'launch' }, { resetLimits: true });
    assert.equal(r.ok, true);
    assert.equal(r.snapshot?.max_agents, 5, 'the snapshot is the pre-image');
    assert.equal((await limits()).max_agents, null);
});

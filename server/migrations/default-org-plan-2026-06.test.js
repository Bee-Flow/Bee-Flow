/**
 * The default-org-plan migration (BFSF-226) — ensure-default promotion or
 * creation of the Free org plan plus the report-only census of existing
 * no-plan orgs — on a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js) behind db.js's pool (testUtils/pglitePool.js),
 * with the plans, organisations and subscriptions of each case seeded.
 *
 * Run: node --test server/migrations/default-org-plan-2026-06.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow, insertRows } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool(ladderPglite());
const { up } = require('./default-org-plan-2026-06');
test.after(close);

const state = {
    /** @param {Array<Record<string, unknown>>} rows */
    plans: (rows) => insertRows(pg, 'subscription_plans', rows.map((r) => ({ is_public: true, ...r, created_at: new Date(Date.UTC(2026, 0, Number(r.created_at))).toISOString() }))),
};
const defaults = async () => (await pg.query('SELECT * FROM subscription_plans WHERE is_default = TRUE')).rows;
const snapshot = async () => JSON.stringify((await pg.query('SELECT * FROM subscription_plans ORDER BY id')).rows);

test.beforeEach(async () => {
    await pg.exec('TRUNCATE organization_subscriptions, subscription_plans, organizations CASCADE');
    process.env.DEPLOYMENT_MODE = 'cloud';
});

test('no default, Free plan exists → promoted to the single default', async () => {
    await state.plans([
        { id: 'free-1', name: 'Free', plan_type: 'organization', price: 0, is_default: false, created_at: 1 },
        { id: 'paid-1', name: 'Bee Flow', plan_type: 'organization', price: 30, is_default: false, created_at: 2 },
        { id: 'zero-old', name: 'Zero', plan_type: 'organization', price: 0, is_default: false, created_at: 0 },
        { id: 'free-user', name: 'Free', plan_type: 'user', price: 0, is_default: false, created_at: 0 },
    ]);
    await up();
    assert.deepEqual((await defaults()).map(p => p.id), ['free-1'], 'the row named Free wins over an older €0 one; a user plan never');
});

test('no Free-named plan → the oldest €0 org plan (or untyped) is promoted', async () => {
    await state.plans([
        { id: 'zero-new', name: 'Zero B', plan_type: 'organization', price: 0, is_default: false, created_at: 5 },
        { id: 'zero-old', name: 'Zero A', plan_type: null, price: 0, is_default: false, created_at: 3 },
    ]);
    await up();
    assert.deepEqual((await defaults()).map(p => p.id), ['zero-old']);
});

test('no default, no Free plan → one is created as the default (Free, €0, org)', async () => {
    await state.plans([{ id: 'paid-1', name: 'Bee Flow', plan_type: 'organization', price: 30, is_default: false, created_at: 1 }]);
    await up();
    const d = await defaults();
    assert.equal(d.length, 1);
    const free = d[0];
    assert.equal(free.name, 'Free');
    assert.equal(free.price, 0);
    assert.equal(free.plan_type, 'organization');
    assert.equal(free.is_public, false);
    assert.equal(free.currency, 'EUR');
    assert.equal((await pg.query('SELECT 1 FROM subscription_plans')).rows.length, 2);
});

test('re-run is a no-op once a default exists', async () => {
    await state.plans([{ id: 'free-1', name: 'Free', plan_type: 'organization', price: 0, is_default: false, created_at: 1 }]);
    await up();
    const after1 = await snapshot();
    await up();
    assert.equal(await snapshot(), after1, 'second run must not write');
    assert.deepEqual((await defaults()).map(p => p.id), ['free-1']);
});

test('pre-existing default is never clobbered', async () => {
    await state.plans([
        { id: 'free-1', name: 'Free', plan_type: 'organization', price: 0, is_default: false, created_at: 1 },
        { id: 'paid-1', name: 'Bee Flow', plan_type: 'organization', price: 30, is_default: true, created_at: 2 },
    ]);
    const before = await snapshot();
    await up();
    assert.equal(await snapshot(), before, 'must not write when a default exists');
    assert.deepEqual((await defaults()).map(p => p.id), ['paid-1']);
});

test('census reports no-plan orgs but writes nothing to subscriptions', async () => {
    await state.plans([{ id: 'free-1', name: 'Free', plan_type: 'organization', price: 0, is_default: true, created_at: 1 }]);
    await insertRows(pg, 'organizations', [{ id: 'org-a', name: 'Has plan' }, { id: 'org-b', name: 'No plan' }]);
    await insertRow(pg, 'organization_subscriptions', { id: 'sub-a', organization_id: 'org-a', plan_id: 'free-1' });
    const before = await snapshot();
    const orphanCount = await up();
    assert.equal(orphanCount, 1, 'one org without a subscription row');
    assert.equal(await snapshot(), before, 'census is report-only');
    assert.equal((await pg.query('SELECT 1 FROM organization_subscriptions')).rows.length, 1, 'no subscription rows created');
});

test('non-cloud deployment mode skips entirely', async () => {
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    await state.plans([{ id: 'free-1', name: 'Free', plan_type: 'organization', price: 0, is_default: false, created_at: 1 }]);
    const res = await up();
    assert.equal(res, null);
    assert.equal((await defaults()).length, 0);
});

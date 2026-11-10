// @typecheck
/**
 * stale-free-limits-repair-2026-11 (BFSF-249) against a real Postgres
 * (pglite): clears only the Free signature (5 agents + 3 knowledge sources)
 * on paid plans, is idempotent, has a dry run that writes nothing, and
 * --revert puts the values back without overwriting a later admin edit.
 *
 * Run: cd server && node --test migrations/stale-free-limits-repair-2026-11.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { up, down } = require('./stale-free-limits-repair-2026-11');

before(async () => {
    await pg.exec(`
        CREATE TABLE subscription_plans (id TEXT PRIMARY KEY, name TEXT, price REAL, max_agents INTEGER, max_knowledge_sources INTEGER);
        CREATE TABLE organization_subscriptions (organization_id TEXT PRIMARY KEY, plan_id TEXT, max_agents INTEGER,
            max_knowledge_sources INTEGER, max_users INTEGER, updated_at TIMESTAMPTZ);
        CREATE TABLE subscription_audit_log (id TEXT PRIMARY KEY, action TEXT, target_type TEXT, target_id TEXT,
            changed_by TEXT, old_values TEXT, new_values TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
        INSERT INTO subscription_plans VALUES
            ('free', 'Free', 0, 5, 3), ('launch', 'Launch', 30, NULL, NULL), ('small', 'Small', 10, 5, 3);
    `);
});
beforeEach(async () => {
    await pg.exec(`
        DELETE FROM organization_subscriptions; DELETE FROM subscription_audit_log;
        INSERT INTO organization_subscriptions (organization_id, plan_id, max_agents, max_knowledge_sources, max_users) VALUES
            ('stale',     'launch', 5,  3,    7),
            ('free',      'free',   5,  3,    NULL),
            ('custom',    'launch', 20, 3,    NULL),
            ('onlyagent', 'launch', 5,  NULL, NULL),
            ('tightplan', 'small',  5,  3,    NULL),
            ('clean',     'launch', NULL, NULL, NULL);
    `);
});
after(close);

async function row(id) {
    const { rows } = await pg.query('SELECT max_agents, max_knowledge_sources, max_users FROM organization_subscriptions WHERE organization_id = $1', [id]);
    return rows[0];
}

test('clears only the Free signature on a more generous paid plan, nothing else', async () => {
    const r = await up();
    assert.deepEqual(r.orgIds, ['stale']);
    assert.equal(r.cleared, 1);
    assert.deepEqual(await row('stale'), { max_agents: null, max_knowledge_sources: null, max_users: 7 }, 'other overrides stay');
    assert.deepEqual(await row('free'), { max_agents: 5, max_knowledge_sources: 3, max_users: null }, 'Free plan untouched');
    assert.deepEqual(await row('custom'), { max_agents: 20, max_knowledge_sources: 3, max_users: null });
    assert.deepEqual(await row('onlyagent'), { max_agents: 5, max_knowledge_sources: null, max_users: null });
    assert.deepEqual(await row('tightplan'), { max_agents: 5, max_knowledge_sources: 3, max_users: null }, 'plan is not more generous');
    const { rows: audit } = await pg.query('SELECT action, target_id, old_values FROM subscription_audit_log');
    assert.deepEqual(audit.map(a => [a.action, a.target_id]), [['stale_free_limits_cleared', 'stale']]);
    assert.deepEqual(JSON.parse(audit[0].old_values), { max_agents: 5, max_knowledge_sources: 3 });
});

test('a dry run writes nothing', async () => {
    const r = await up({ dryRun: true });
    assert.deepEqual(r.orgIds, ['stale']);
    assert.equal(r.cleared, 0);
    assert.deepEqual(await row('stale'), { max_agents: 5, max_knowledge_sources: 3, max_users: 7 });
    assert.equal((await pg.query('SELECT 1 FROM subscription_audit_log')).rows.length, 0);
});

test('a second run is a no-op', async () => {
    await up();
    const again = await up();
    assert.equal(again.found, 0);
    assert.equal((await pg.query('SELECT 1 FROM subscription_audit_log')).rows.length, 1);
});

test('--revert restores the cleared values but never overwrites a later admin edit', async () => {
    await up();
    await pg.query(`UPDATE organization_subscriptions SET max_agents = 50 WHERE organization_id = 'stale'`);
    const r = await down();
    assert.equal(r.restored, 1);
    assert.deepEqual(await row('stale'), { max_agents: 50, max_knowledge_sources: 3, max_users: 7 });
    assert.deepEqual(await row('clean'), { max_agents: null, max_knowledge_sources: null, max_users: null }, 'never-touched rows stay');
});

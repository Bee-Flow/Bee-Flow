// @typecheck
'use strict';

/**
 * getSystemStats and getAllAgents, narrowed to the caller's organisations.
 *
 * Both fed the admin reports (routes/reports.js) from every organisation on
 * the server: the permission said the caller may read reports, nothing said
 * about whom. The narrowing is in the WHERE now, so this runs the SQL
 * against a REAL Postgres (@electric-sql/pglite, in-process): agents on
 * their own column, conversations through the agent they belong to. An
 * organisation scope of null (the super admin) narrows nothing; an array
 * narrows to exactly those organisations; an empty array finds nothing.
 *
 * Run: cd server && node --test stores/agent/agentStats.orgScope.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..', '..');

const { PGlite } = require('@electric-sql/pglite');
const { pgliteQuery } = require('../../testUtils/pglitePool');
const pg = new PGlite();
const q = pgliteQuery(pg);

// Both stores read through db.js's getOne/getAll; those answer from this
// PGlite. The schema init is skipped: the two tables are created below with
// exactly the columns the statements under test read.
const { mockModule: mock } = require('../../testUtils/moduleMock');
mock(path.join(SERVER, 'db.js'), {
    getOne: async (sql, params = []) => (await q(sql, params)).rows[0] || null,
    getAll: async (sql, params = []) => (await q(sql, params)).rows,
    run: async (sql, params = []) => { await q(sql, params); },
    exec: async (sql) => { await pg.exec(sql); },
    pool: { query: async () => { throw new Error('the default pool must not be used here'); } },
});
mock(path.join(__dirname, 'initSchema.js'), { initDB: async () => {} });

const { getSystemStats } = require('./agentStats');
const { getAllAgents } = require('./agentPublishing');

before(async () => {
    await pg.exec(`CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT, owner_id TEXT, organization_id TEXT, config TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pg.exec(`CREATE TABLE agent_conversations (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, messages_json TEXT DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pg.exec(`CREATE TABLE agent_tools (agent_id TEXT, component_id TEXT)`);
    await pg.exec(`INSERT INTO agents (id, name, owner_id, organization_id, config) VALUES
        ('a-org-a', 'Support',  'u-a', 'org_a', '{}'),
        ('a-org-b', 'Sales',    'u-b', 'org_b', '{}'),
        ('a-sys',   'System',   'system', NULL, '{}')`);
    await pg.exec(`INSERT INTO agent_conversations (id, agent_id, user_id, messages_json, created_at) VALUES
        ('c1', 'a-org-a', 'u-a', '[{"r":"u"},{"r":"a"}]', '2026-09-01T10:00:00Z'),
        ('c2', 'a-org-b', 'u-b', '[{"r":"u"}]',           '2026-09-02T10:00:00Z'),
        ('c3', 'a-org-b', 'u-b', '[{"r":"u"},{"r":"a"},{"r":"u"}]', '2026-09-03T10:00:00Z')`);
});
after(async () => { await pg.close(); });

test('an organisation sees its own agents and conversations, and no other\'s', async () => {
    const stats = await getSystemStats(null, null, { orgIds: ['org_a'] });
    assert.strictEqual(Number(stats.totalAgents), 1);
    assert.strictEqual(Number(stats.totalConversations), 1);
    assert.strictEqual(stats.totalMessages, 2);
    assert.deepStrictEqual(Object.keys(stats.agentMessageCounts), ['a-org-a']);

    const agents = await getAllAgents({ orgIds: ['org_a'] });
    assert.deepStrictEqual(agents.map((a) => a.id), ['a-org-a']);
});

test('the same, inside a period', async () => {
    const stats = await getSystemStats('2026-09-02T00:00:00Z', null, { orgIds: ['org_b'] });
    assert.strictEqual(Number(stats.totalConversations), 2);
    assert.strictEqual(stats.totalMessages, 4);
    assert.deepStrictEqual(Object.keys(stats.agentMessageCounts), ['a-org-b']);
    const orgA = await getSystemStats('2026-09-02T00:00:00Z', null, { orgIds: ['org_a'] });
    assert.strictEqual(Number(orgA.totalConversations), 0, 'org A\'s only conversation is before the period');
});

test('the super admin\'s scope (null) is every organisation, as before', async () => {
    const stats = await getSystemStats();
    assert.strictEqual(Number(stats.totalAgents), 2, 'the system agent is left out, as before');
    assert.strictEqual(Number(stats.totalConversations), 3);
    assert.strictEqual(stats.totalMessages, 6);
    const agents = await getAllAgents();
    assert.deepStrictEqual(agents.map((a) => a.id).sort(), ['a-org-a', 'a-org-b']);
    const explicitNull = await getAllAgents({ orgIds: null });
    assert.strictEqual(explicitNull.length, 2);
});

test('a caller of no organisation sees nothing', async () => {
    const stats = await getSystemStats(null, null, { orgIds: [] });
    assert.strictEqual(Number(stats.totalAgents), 0);
    assert.strictEqual(Number(stats.totalConversations), 0);
    assert.deepStrictEqual(await getAllAgents({ orgIds: [] }), []);
});

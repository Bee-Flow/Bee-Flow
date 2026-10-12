'use strict';

/**
 * Deleting an agent sweeps the automation links that named it
 * (automation_agent_bindings.agent_id is a soft reference, so nothing cascades),
 * against a REAL Postgres (@electric-sql/pglite behind db.js's pool).
 *
 * Pinned:
 *   - forceDeleteAgent and deleteAgent drop that agent's rows and leave the
 *     rows of other agents alone;
 *   - an install where the automation tables do not exist yet still deletes
 *     the agent (the sweep is best effort and probe-first).
 *
 * Run: cd server && node --test stores/agent/agentCrud.bindings.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const agentSchema = require('./initSchema');
const agents = require('./agentCrud');
const bindingsMigration = require('../../migrations/automation-agent-bindings-2026-10');

const OWNER = 'alice';
const bindingsOf = async (agentId) => (await pg.query(
    'SELECT automation_id FROM automation_agent_bindings WHERE agent_id = $1 ORDER BY automation_id', [agentId],
)).rows.map((r) => r.automation_id);

before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT)`);
    await agentSchema.initDB();
    await pg.exec(`CREATE TABLE automations (id TEXT PRIMARY KEY)`);
    await pg.exec(`INSERT INTO automations (id) VALUES ('a1'), ('a2')`);
    await bindingsMigration.up({ exec: (sql) => pg.exec(sql) });
});
after(async () => { await close(); });

test('force delete drops the links to that agent and only those', async () => {
    const gone = (await agents.createAgent('Gone', '', 'p', OWNER)).id;
    const stays = (await agents.createAgent('Stays', '', 'p', OWNER)).id;
    await pg.query(`INSERT INTO automation_agent_bindings (id, automation_id, agent_id) VALUES ('b1', 'a1', $1), ('b2', 'a2', $1), ('b3', 'a1', $2)`, [gone, stays]);

    assert.strictEqual(await agents.forceDeleteAgent(gone), true);
    assert.deepStrictEqual(await bindingsOf(gone), []);
    assert.deepStrictEqual(await bindingsOf(stays), ['a1']);
});

test('the owner\'s plain delete sweeps them too', async () => {
    const mine = (await agents.createAgent('Mine', '', 'p', OWNER)).id;
    await pg.query(`INSERT INTO automation_agent_bindings (id, automation_id, agent_id) VALUES ('b4', 'a1', $1)`, [mine]);
    assert.strictEqual(await agents.deleteAgent(mine, OWNER), true);
    assert.deepStrictEqual(await bindingsOf(mine), []);
});

test('without the automation tables the agent is still deleted', async () => {
    await pg.exec('DROP TABLE automation_agent_bindings');
    const lone = (await agents.createAgent('Lone', '', 'p', OWNER)).id;
    assert.strictEqual(await agents.forceDeleteAgent(lone), true);
});

// @typecheck
'use strict';

/**
 * Deleting an agent removes its conversations and their messages, against a
 * REAL Postgres (@electric-sql/pglite behind db.js's pool). The sweep of the
 * automation links that named the agent is the automation module's, pinned in
 * agentCrud.bindings.automation.pg.test.js; here there is no automation table,
 * and the delete does not need one.
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

const OWNER = 'alice';

before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT)`);
    await agentSchema.initDB();
});
after(async () => { await close(); });

test('deleting an agent removes its conversations and their messages, and only those', async () => {
    await require('./conversationMessages').initMessagesTable();
    const gone = (await agents.createAgent('Chatted', '', 'p', OWNER)).id;
    const stays = (await agents.createAgent('Other', '', 'p', OWNER)).id;
    await pg.query(`INSERT INTO agent_conversations (id, agent_id, user_id) VALUES ('cv-gone', $1, 'bob'), ('cv-stays', $2, 'bob')`, [gone, stays]);
    await pg.query(`INSERT INTO conversation_messages (id, conversation_id, role, content, seq) VALUES ('mg', 'cv-gone', 'user', 'x', 1), ('ms', 'cv-stays', 'user', 'y', 1)`);

    assert.strictEqual(await agents.forceDeleteAgent(gone), true);
    const left = (await pg.query('SELECT conversation_id FROM conversation_messages ORDER BY conversation_id')).rows.map((r) => r.conversation_id);
    assert.deepStrictEqual(left, ['cv-stays']);
    assert.strictEqual((await pg.query(`SELECT COUNT(*)::int AS n FROM agent_conversations WHERE agent_id = $1`, [gone])).rows[0].n, 0);
});

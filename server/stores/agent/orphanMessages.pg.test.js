// @typecheck
/**
 * The boot-time sweep of orphaned conversation_messages rows, against a real
 * Postgres (PGlite behind db.js): a row whose conversation is in neither
 * parent table goes, every other row stays, and nothing is swept while a
 * parent table is missing.
 *
 * Run: cd server && node --test stores/agent/orphanMessages.pg.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { purgeOrphanedMessages } = require('./orphanMessages.mts');
after(close);

const MESSAGES_DDL = `CREATE TABLE conversation_messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, conversation_type TEXT NOT NULL DEFAULT 'agent',
    role TEXT NOT NULL, content TEXT, seq INTEGER NOT NULL DEFAULT 0)`;

/** @returns {Promise<string[]>} */
async function remaining() {
    const { rows } = await pg.query('SELECT id FROM conversation_messages ORDER BY id');
    return rows.map((r) => /** @type {{ id: string }} */ (r).id);
}

test('nothing is swept while a parent table is missing', async () => {
    await pg.exec(MESSAGES_DDL);
    await pg.exec('CREATE TABLE agent_conversations (id TEXT PRIMARY KEY)');
    await pg.exec(`INSERT INTO conversation_messages (id, conversation_id, conversation_type, role) VALUES ('x1', 'gone', 'agent', 'user')`);
    assert.strictEqual(await purgeOrphanedMessages(), 0);
    assert.deepStrictEqual(await remaining(), ['x1']);
});

test('only rows whose conversation is in neither parent table go', async () => {
    await pg.exec('CREATE TABLE direct_conversations (id TEXT PRIMARY KEY)');
    await pg.exec(`INSERT INTO agent_conversations (id) VALUES ('ac1')`);
    await pg.exec(`INSERT INTO direct_conversations (id) VALUES ('dc1')`);
    await pg.exec(`INSERT INTO conversation_messages (id, conversation_id, conversation_type, role) VALUES
        ('a1', 'ac1', 'agent', 'user'), ('d1', 'dc1', 'direct', 'user'),
        ('d2', 'ac1', 'direct', 'user'), ('o1', 'gone-direct', 'direct', 'user'),
        ('n1', 'gone', 'notebook', 'user')`);
    assert.strictEqual(await purgeOrphanedMessages(), 2);
    assert.deepStrictEqual(await remaining(), ['a1', 'd1', 'd2', 'n1']);
    assert.strictEqual(await purgeOrphanedMessages(), 0, 'a second run is a no-op');
});

'use strict';

/**
 * A fresh database where the messages init runs before the conversation
 * tables exist (boot starts every store's init at once): the init must fail
 * so the memo runs it again, and the next call must add messages_migrated.
 * Before the fix the init resolved, and every turn write then failed with
 * `column "messages_migrated" does not exist` until a restart.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');
const { pg, query } = usePglitePool();
const storeInit = require('../lib/storeInit');
const convMessages = require('./conversationMessages');

after(async () => { await pg.close?.(); });

/** @param {string} table */
async function hasFlag(table) {
    const r = await query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'messages_migrated'`,
        [table],
    );
    return r.rows.length === 1;
}

test('messages init before the parent tables exist fails, and the next call adds messages_migrated', async () => {
    storeInit._resetAllForTests();
    await assert.rejects(convMessages.initMessagesTable(), /parent conversation table does not exist yet/);

    await query(`CREATE TABLE agent_conversations (id TEXT PRIMARY KEY)`);
    await query(`CREATE TABLE direct_conversations (id TEXT PRIMARY KEY)`);

    await convMessages.initMessagesTable();
    assert.ok(await hasFlag('agent_conversations'), 'agent_conversations.messages_migrated missing');
    assert.ok(await hasFlag('direct_conversations'), 'direct_conversations.messages_migrated missing');
});

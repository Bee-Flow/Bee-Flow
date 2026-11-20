// @typecheck strict
/**
 * A conversation a Cowork run creates (`origin = 'cowork'`) is kept and opens by id, but it is not a chat: the chat
 * list, the per-agent list, "the latest conversation with this agent" and the chat search leave it out.
 *
 * On a real Postgres (PGlite behind db.js, testUtils/pglitePool.js), on the store's own schema.
 *
 * Run: cd server && node --test stores/agent/agentConversations.origin.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pg, close } = require('../../testUtils/pglitePool').usePglitePool();
const agentConversations = require('./agentConversations');

const USER = 'user-origin';
/** @type {{ id: string }} */
let chat;
/** @type {{ id: string }} */
let cowork;

before(async () => {
    // The agent schema, then the message rows (one PGlite session: one after the other).
    for (const mod of ['./initSchema', './conversationMessages']) await require(mod).initDB();
    await pg.query("INSERT INTO agents (id, name, owner_id) VALUES ('agent-o', 'Agent', $1)", [USER]);
    chat = await agentConversations.createNewConversation('agent-o', USER);
    await pg.query("UPDATE agent_conversations SET title = 'Quarterly offer', updated_at = NOW() - INTERVAL '1 hour' WHERE id = $1", [chat.id]);
    cowork = await agentConversations.createNewConversation('agent-o', USER, { origin: 'cowork' });
    await pg.query("UPDATE agent_conversations SET title = 'Quarterly offer from the mail run' WHERE id = $1", [cowork.id]);
});
after(close);

test('the run gets its own conversation, marked as coming from Cowork', async () => {
    const { rows } = await pg.query('SELECT id, origin FROM agent_conversations WHERE agent_id = $1 ORDER BY origin NULLS FIRST', ['agent-o']);
    assert.deepStrictEqual(rows.map((r) => r.origin), [null, 'cowork']);
});

test('the chat lists and the latest-conversation lookup leave a Cowork conversation out', async () => {
    assert.deepStrictEqual((await agentConversations.listAllConversations(USER)).map((c) => c.id), [chat.id]);
    assert.deepStrictEqual((await agentConversations.listConversations('agent-o', USER)).map((c) => c.id), [chat.id]);
    const latest = await agentConversations.getConversation('agent-o', USER);
    assert.strictEqual(latest?.id, chat.id, 'opening the agent continues the chat, not the newer Cowork run');
});

test('the chat search leaves a Cowork conversation out', async () => {
    const hits = await agentConversations.searchConversations(USER, 'Quarterly', {}, null);
    assert.deepStrictEqual(hits.map((c) => c.id), [chat.id]);
});

test('a Cowork conversation still opens by its id', async () => {
    const byId = await agentConversations.getConversationById(cowork.id);
    assert.strictEqual(byId?.id, cowork.id);
});

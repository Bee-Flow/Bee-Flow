/**
 * Conversations go with their messages, agents with their conversations, and a
 * seeded system agent arrives with its tools, in one transaction each, against
 * a real Postgres (PGlite behind the real db.js). A trigger refuses the last
 * write; nothing of the writes before it may remain.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test stores/agent/conversationDeletes.atomic.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('./initSchema');
const convMessages = require('./conversationMessages');
const { clearConversation, deleteConversationById } = require('./agentConversations');
const { deleteDirectConversation } = require('./directConversations');
const { deleteAgent, forceDeleteAgent } = require('./agentCrud');
const { seedSystemAgents } = require('./systemAgents');

const REFUSED = 'u-refused';

before(async () => {
    await initDB();
    await convMessages.initDB();
    await pg.exec(`
        CREATE FUNCTION refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'write refused';
        END $$;
        CREATE TRIGGER refuse_agent_conv BEFORE DELETE ON agent_conversations
            FOR EACH ROW WHEN (OLD.user_id = '${REFUSED}') EXECUTE FUNCTION refuse_write();
        CREATE TRIGGER refuse_direct_conv BEFORE DELETE ON direct_conversations
            FOR EACH ROW WHEN (OLD.user_id = '${REFUSED}') EXECUTE FUNCTION refuse_write();
        CREATE TRIGGER refuse_agent BEFORE DELETE ON agents
            FOR EACH ROW WHEN (OLD.name = 'refused agent') EXECUTE FUNCTION refuse_write();
        CREATE TRIGGER refuse_tool BEFORE INSERT ON agent_tools
            FOR EACH ROW WHEN (NEW.agent_id = 'system-orgintel-scout') EXECUTE FUNCTION refuse_write();
    `);
});
after(close);

let n = 0;
async function agent(name = 'A') {
    const id = `ag-${++n}`;
    await pg.query(`INSERT INTO agents (id, name, owner_id) VALUES ($1, $2, 'owner')`, [id, name]);
    return id;
}
async function agentConversation(agentId, userId) {
    const id = `ac-${++n}`;
    await pg.query('INSERT INTO agent_conversations (id, agent_id, user_id) VALUES ($1, $2, $3)', [id, agentId, userId]);
    await pg.query(`INSERT INTO conversation_messages (id, conversation_id, role, content) VALUES ($1, $2, 'user', 'hi')`, [`m-${id}`, id]);
    return id;
}
const messagesOf = async (conversationId) => Number((await pg.query('SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1', [conversationId])).rows[0].n);

test('clearConversation: a failing conversation delete keeps the messages', async () => {
    const a = await agent();
    const c = await agentConversation(a, REFUSED);
    await assert.rejects(() => clearConversation(a, REFUSED), /write refused/);
    assert.strictEqual(await messagesOf(c), 1);
});

test('deleteConversationById: a failing conversation delete keeps the messages; a good one takes them along', async () => {
    const a = await agent();
    const c = await agentConversation(a, REFUSED);
    await assert.rejects(() => deleteConversationById(c), /write refused/);
    assert.strictEqual(await messagesOf(c), 1);
    const ok = await agentConversation(a, 'u-ok');
    await deleteConversationById(ok);
    assert.strictEqual(await messagesOf(ok), 0);
});

test('deleteDirectConversation: a failing conversation delete keeps the messages', async () => {
    await pg.query(`INSERT INTO direct_conversations (id, user_id) VALUES ('dc-1', $1)`, [REFUSED]);
    await pg.query(`INSERT INTO conversation_messages (id, conversation_id, conversation_type, role, content) VALUES ('m-dc-1', 'dc-1', 'direct', 'user', 'hi')`);
    await assert.rejects(() => deleteDirectConversation('dc-1', REFUSED), /write refused/);
    assert.strictEqual(await messagesOf('dc-1'), 1);
});

test('forceDeleteAgent and deleteAgent: a failing agent delete keeps its tools and conversations', async () => {
    const a = await agent('refused agent');
    await pg.query(`INSERT INTO agent_tools (id, agent_id, component_id) VALUES ('t-1', $1, 'c1')`, [a]);
    const c = await agentConversation(a, 'u-ok');
    await assert.rejects(() => forceDeleteAgent(a), /write refused/);
    assert.strictEqual(Number((await pg.query('SELECT COUNT(*)::int AS n FROM agent_tools WHERE agent_id = $1', [a])).rows[0].n), 1);
    assert.strictEqual(await messagesOf(c), 1);
    await assert.rejects(() => deleteAgent(a, 'owner'), /write refused/);
    assert.strictEqual(await messagesOf(c), 1);
});

test('deleteAgent: the agent goes with its conversations and their messages', async () => {
    const a = await agent();
    const c = await agentConversation(a, 'u-ok');
    assert.strictEqual(await deleteAgent(a, 'owner'), true);
    assert.strictEqual(await messagesOf(c), 0);
    assert.strictEqual(Number((await pg.query('SELECT COUNT(*)::int AS n FROM agent_conversations WHERE id = $1', [c])).rows[0].n), 0);
});

test('seedSystemAgents: a failing tool insert leaves no system agent without its tools', async () => {
    await assert.rejects(() => seedSystemAgents(), /write refused/);
    assert.strictEqual(Number((await pg.query(`SELECT COUNT(*)::int AS n FROM agents WHERE id = 'system-orgintel-scout'`)).rows[0].n), 0);
    await pg.exec('DROP TRIGGER refuse_tool ON agent_tools;');
    await seedSystemAgents();
    assert.ok(Number((await pg.query(`SELECT COUNT(*)::int AS n FROM agent_tools WHERE agent_id = 'system-orgintel-scout'`)).rows[0].n) > 0);
});

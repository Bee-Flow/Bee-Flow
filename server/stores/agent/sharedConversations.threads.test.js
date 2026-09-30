'use strict';

/**
 * GET /api/projects/:id/threads, the rows listProjectThreads answers with,
 * against a REAL Postgres (@electric-sql/pglite behind db.js's pool,
 * testUtils/pglitePool.js): the contract is a property of the UNION query
 * itself.
 *
 * The workspace opens a shared AGENT chat through its agent (the hub selects
 * the agent, then the conversation). The rows used to carry no agent id at
 * all, so every shared agent chat in a project answered "This chat belongs to
 * an agent you cannot open", even for its owner. A direct chat has no agent:
 * its agentId is null, never a stray value from the other half of the UNION.
 *
 * Run: cd server && node --test stores/agent/sharedConversations.threads.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

// The real db.js, its pool answered by pglite: no module mocking. Every title
// below is plaintext, so listProjectThreads never resolves a key (it only does
// for an encrypted title), and no key store is needed.
const { pg, close } = usePglitePool();
const { listProjectThreads } = require('./sharedConversations');

before(async () => {
    const cols = `id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, project_id TEXT,
        shared_scope TEXT NOT NULL DEFAULT 'private',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
    await pg.exec(`CREATE TABLE direct_conversations (${cols})`);
    await pg.exec(`CREATE TABLE agent_conversations (${cols}, agent_id TEXT NOT NULL)`);
    await pg.exec(`
        INSERT INTO direct_conversations (id, user_id, title, project_id, shared_scope, updated_at) VALUES
            ('d1', 'ada', 'Pricing research', 'p1', 'project', '2026-09-03T10:00:00Z'),
            ('d2', 'ada', 'Still private', 'p1', 'private', '2026-09-04T10:00:00Z');
        INSERT INTO agent_conversations (id, user_id, title, project_id, shared_scope, agent_id, updated_at) VALUES
            ('a1', 'bob', 'Contract review', 'p1', 'project', 'agent-legal', '2026-09-05T10:00:00Z'),
            ('a2', 'bob', 'Other project', 'p2', 'project', 'agent-legal', '2026-09-06T10:00:00Z');
    `);
});
after(close);

test('a shared agent chat carries the agent it belongs to', async () => {
    const threads = await listProjectThreads('p1');
    const agentThread = threads.find(t => t.id === 'a1');
    assert.ok(agentThread, 'the shared agent chat is listed');
    assert.strictEqual(agentThread.type, 'agent');
    assert.strictEqual(agentThread.agentId, 'agent-legal');
    assert.strictEqual(agentThread.ownerId, 'bob');
});

test('a shared direct chat has no agent', async () => {
    const threads = await listProjectThreads('p1');
    const direct = threads.find(t => t.id === 'd1');
    assert.ok(direct, 'the shared direct chat is listed');
    assert.strictEqual(direct.type, 'direct');
    assert.strictEqual(direct.agentId, null);
});

test('only this project\'s shared chats, newest first', async () => {
    const threads = await listProjectThreads('p1');
    assert.deepStrictEqual(threads.map(t => t.id), ['a1', 'd1']);
});

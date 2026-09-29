'use strict';

/**
 * `getAgentChatStats` — the batch behind "312 conversations · last used 2
 * minutes ago", and behind the delete guard's question "is the history I am
 * about to destroy mine?".
 *
 * Against a REAL Postgres (@electric-sql/pglite, in-process), because every
 * property that matters is a property of the SQL: a FILTER that excludes one
 * person, a COUNT(DISTINCT) over users, a MAX over updated_at, and the fact
 * that an agent nobody chatted with gets an entry of zeros rather than no
 * entry at all.
 *
 * Why not getAgentStats: it reads EVERY `messages_json` of the agent into
 * Node, and its `lastUpdated` is `agents.updated_at` — when the agent was
 * last EDITED, not when it was last used. Both are wrong for a list.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/agentStats.chat.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..', '..');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

async function q(sql, params) {
    const res = Array.isArray(params) && params.length > 0 ? await pg.query(sql, params) : await pg.query(sql);
    return { rows: res.rows || [], rowCount: (res.rows || []).length };
}
const db = { query: q };

// db.js is mocked so requiring the store opens no pool; every call in this
// suite passes its own `db`, so `initDB()` is deliberately never reached.
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}
mock(path.join(SERVER, 'db.js'), {
    pool: { query: async () => { throw new Error('the default pool must not be used here'); } },
    run: async () => {}, getOne: async () => null, getAll: async () => [], exec: async () => {},
});

const { getAgentChatStats } = require('./agentStats');

const A1 = 'agent-1';
const A2 = 'agent-2';

before(async () => {
    await pg.exec(`CREATE TABLE agent_conversations (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pg.exec(`INSERT INTO agent_conversations (id, agent_id, user_id, updated_at) VALUES
        ('c1','agent-1','me',    '2026-09-01T10:00:00Z'),
        ('c2','agent-1','me',    '2026-09-02T10:00:00Z'),
        ('c3','agent-1','a-colleague','2026-09-05T10:00:00Z'),
        ('c4','agent-2','me',    '2026-08-01T10:00:00Z')`);
});
after(async () => { await pg.close(); });

test('counts conversations and people, and dates the LAST one', async () => {
    const out = await getAgentChatStats([A1], { db });
    const s = out.get(A1);
    assert.strictEqual(s.conversationCount, 3);
    assert.strictEqual(s.userCount, 2);
    assert.strictEqual(s.lastUsedAt, '2026-09-05T10:00:00.000Z');
});

test('othersConversationCount excludes exactly one person — the asker', async () => {
    // This is what the delete guard reads. "Only my own history goes" must
    // never be said about a published agent a colleague has been using.
    const mine = await getAgentChatStats([A1], { excludeUserId: 'me', db });
    assert.strictEqual(mine.get(A1).othersConversationCount, 1);
    const theirs = await getAgentChatStats([A1], { excludeUserId: 'a-colleague', db });
    assert.strictEqual(theirs.get(A1).othersConversationCount, 2);
});

test('with nobody named, EVERY conversation counts as somebody else\'s', async () => {
    // The safe reading: an unnamed asker has no history to waive.
    const out = await getAgentChatStats([A1], { db });
    assert.strictEqual(out.get(A1).othersConversationCount, 3);
    const explicitNull = await getAgentChatStats([A1], { excludeUserId: null, db });
    assert.strictEqual(explicitNull.get(A1).othersConversationCount, 3);
});

test('an agent whose only conversations are the asker\'s own has nothing of anyone else\'s', async () => {
    const out = await getAgentChatStats([A2], { excludeUserId: 'me', db });
    assert.strictEqual(out.get(A2).conversationCount, 1);
    assert.strictEqual(out.get(A2).othersConversationCount, 0, 'throwing away your own draft stays one click');
});

test('every requested id gets an entry, even one nobody ever chatted with', async () => {
    const out = await getAgentChatStats([A1, 'agent-never-used'], { db });
    assert.deepStrictEqual([...out.keys()].sort(), ['agent-1', 'agent-never-used']);
    assert.deepStrictEqual(out.get('agent-never-used'), {
        conversationCount: 0, userCount: 0, othersConversationCount: 0, lastUsedAt: null,
    });
});

test('several agents in ONE round trip', async () => {
    let calls = 0;
    const counting = { query: async (...a) => { calls += 1; return q(...a); } };
    const out = await getAgentChatStats([A1, A2, 'agent-never-used'], { db: counting });
    assert.strictEqual(calls, 1, 'one GROUP BY, not one query per agent');
    assert.strictEqual(out.get(A1).conversationCount, 3);
    assert.strictEqual(out.get(A2).conversationCount, 1);
});

test('duplicate ids do not double-count, and nothing in means nothing asked', async () => {
    const out = await getAgentChatStats([A1, A1], { db });
    assert.strictEqual(out.get(A1).conversationCount, 3);
    let calls = 0;
    const counting = { query: async (...a) => { calls += 1; return q(...a); } };
    assert.strictEqual((await getAgentChatStats([], { db: counting })).size, 0);
    assert.strictEqual((await getAgentChatStats(null, { db: counting })).size, 0);
    assert.strictEqual(calls, 0);
});

test('lastUsedAt is an ISO string, not a Date the JSON layer has to guess at', async () => {
    const out = await getAgentChatStats([A1], { db });
    assert.strictEqual(typeof out.get(A1).lastUsedAt, 'string');
});

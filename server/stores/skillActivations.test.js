// @typecheck
/**
 * skillActivations — the "last used" write behind the Skills overview, against
 * a real Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js).
 *
 * The static path fires on EVERY chat turn, so a 40-turn chat must stay one
 * row with a current timestamp (the natural-key upsert); a repeat within the
 * TTL costs no round-trip; skills.last_used_at is stamped; old rows are pruned;
 * and a database failure never throws.
 *
 * Run: cd server && node --test stores/skillActivations.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const db = require('../db');
const store = require('./skillActivations');

before(async () => {
    await pg.exec('CREATE TABLE skills (id TEXT PRIMARY KEY, last_used_at TIMESTAMPTZ)');
    await pg.exec("INSERT INTO skills (id) VALUES ('s1'), ('s2'), ('s3')");
    await store.initDB();
});
after(close);
beforeEach(async () => {
    store._resetCache();
    await pg.exec("DELETE FROM skill_activations; UPDATE skills SET last_used_at = NULL");
});

const rows = async () => (await pg.query(
    'SELECT skill_id, agent_id, conversation_id, user_id, source, at FROM skill_activations ORDER BY skill_id, conversation_id',
)).rows;

/** Count the statements that reach the pool while `fn` runs. */
async function statementsDuring(fn) {
    const real = db.pool.query;
    let n = 0;
    db.pool.query = /** @type {any} */ (async (/** @type {any[]} */ ...a) => { n += 1; return /** @type {any} */ (real)(...a); });
    try { await fn(); } finally { db.pool.query = real; }
    return n;
}

test('a static activation is one row per (skill, conversation, agent, source), and a later turn refreshes `at`', async () => {
    assert.strictEqual(await store.recordActivations({ skillIds: ['s1', 's1', 's2'], agentId: 'a1', conversationId: 'c1', userId: 'u1', source: 'static' }), 2);
    const first = await rows();
    assert.deepStrictEqual(first.map((r) => [r.skill_id, r.agent_id, r.conversation_id, r.user_id, r.source]),
        [['s1', 'a1', 'c1', 'u1', 'static'], ['s2', 'a1', 'c1', 'u1', 'static']]);
    await pg.query("UPDATE skill_activations SET at = NOW() - INTERVAL '1 hour'");

    store._resetCache();
    await store.recordActivations({ skillIds: ['s1'], agentId: 'a1', conversationId: 'c1', source: 'static' });
    const after = await rows();
    assert.strictEqual(after.length, 2, 'the static path fires every turn; a chat is one row');
    const s1 = after.find((r) => r.skill_id === 's1');
    assert.ok(Date.now() - new Date(s1.at).getTime() < 60_000, '"last used" says when, not when the chat started');
    assert.strictEqual(s1.user_id, 'u1', 'a turn without a user keeps the one already known');
});

test('a repeat within the TTL costs no round-trip at all; another conversation is another use', async () => {
    await store.recordActivations({ skillIds: ['s1'], agentId: 'a1', conversationId: 'c1', source: 'static' });
    const n = await statementsDuring(async () => {
        assert.strictEqual(await store.recordActivations({ skillIds: ['s1'], agentId: 'a1', conversationId: 'c1', source: 'static' }), 0);
    });
    assert.strictEqual(n, 0, 'no INSERT, no last_used_at stamp, no prune');
    assert.strictEqual(await store.recordActivations({ skillIds: ['s1'], agentId: 'a1', conversationId: 'c2', source: 'static' }), 1);
    assert.strictEqual((await rows()).length, 2);
});

test('without a conversation and agent the key columns are empty strings, so repeats still collide', async () => {
    // NULLs do not collide in a UNIQUE index: the ephemeral-chat path would write a row per turn.
    await store.recordActivations({ skillIds: ['s1'], source: 'ai_step' });
    store._resetCache();
    await store.recordActivations({ skillIds: ['s1'], source: 'ai_step' });
    assert.deepStrictEqual((await rows()).map((r) => [r.agent_id, r.conversation_id, r.user_id, r.source]), [['', '', null, 'ai_step']]);
});

test('an unknown source falls back to static instead of writing junk', async () => {
    await store.recordActivations({ skillIds: ['s1'], source: 'whatever' });
    assert.strictEqual((await rows())[0].source, 'static');
});

test('skills.last_used_at is stamped and old rows are pruned, for exactly the skills touched', async () => {
    await pg.query(`INSERT INTO skill_activations (skill_id, conversation_id, at) VALUES
        ('s1', 'old', NOW() - INTERVAL '181 days'), ('s1', 'recent', NOW() - INTERVAL '10 days'),
        ('s3', 'old', NOW() - INTERVAL '181 days')`);
    await store.recordActivations({ skillIds: ['s1', 's2'] });
    const stamped = (await pg.query('SELECT id FROM skills WHERE last_used_at IS NOT NULL ORDER BY id')).rows.map((r) => r.id);
    assert.deepStrictEqual(stamped, ['s1', 's2']);
    const left = (await rows()).map((r) => `${r.skill_id}:${r.conversation_id}`);
    assert.ok(!left.includes('s1:old'), `older than ${store.RETENTION_DAYS} days is pruned`);
    assert.ok(left.includes('s1:recent'));
    assert.ok(left.includes('s3:old'), 'a skill not touched is not pruned');
});

test('empty or garbage input writes nothing', async () => {
    const n = await statementsDuring(async () => {
        assert.strictEqual(await store.recordActivations({ skillIds: [] }), 0);
        assert.strictEqual(await store.recordActivations({ skillIds: /** @type {any} */ ([null, 42, '']) }), 0);
        assert.strictEqual(await store.recordActivations(/** @type {any} */ ({})), 0);
    });
    assert.strictEqual(n, 0);
});

test('a database failure never throws, and the failed write is not remembered as done', async () => {
    await pg.exec('ALTER TABLE skills RENAME TO skills_away');
    try {
        assert.strictEqual(await store.recordActivations({ skillIds: ['s1'] }), 0, 'a chat turn must not pay for telemetry');
    } finally {
        await pg.exec('ALTER TABLE skills_away RENAME TO skills');
    }
    assert.strictEqual(await store.recordActivations({ skillIds: ['s1'] }), 1, 'the next turn writes it');
    assert.ok((await pg.query("SELECT last_used_at FROM skills WHERE id = 's1'")).rows[0].last_used_at);
});

test('getLastActivationBySkillIds answers the latest activation per skill', async () => {
    await pg.query(`INSERT INTO skill_activations (skill_id, agent_id, conversation_id, source, at) VALUES
        ('s1', 'a1', 'c1', 'static', '2026-09-01T10:00:00Z'), ('s1', 'a2', 'c2', 'activate_skill', '2026-08-01T10:00:00Z'),
        ('s2', '', 'c3', 'ai_step', '2026-07-01T10:00:00Z')`);
    assert.deepStrictEqual(await store.getLastActivationBySkillIds(['s1', 's2', 's9']), {
        s1: { at: '2026-09-01T10:00:00.000Z', agentId: 'a1', source: 'static' },
        s2: { at: '2026-07-01T10:00:00.000Z', agentId: null, source: 'ai_step' },
    });
    assert.deepStrictEqual(await store.getLastActivationBySkillIds([]), {});
});

test('getLastActivationByAgent answers per agent for one skill', async () => {
    await pg.query(`INSERT INTO skill_activations (skill_id, agent_id, conversation_id, at) VALUES
        ('s1', 'a1', 'c1', '2026-09-01T10:00:00Z'), ('s1', 'a1', 'c2', '2026-09-02T10:00:00Z'),
        ('s2', 'a2', 'c1', '2026-09-03T10:00:00Z')`);
    assert.deepStrictEqual(await store.getLastActivationByAgent('s1', ['a1', 'a2']), { a1: '2026-09-02T10:00:00.000Z' });
    assert.deepStrictEqual(await store.getLastActivationByAgent('s1', []), {});
    assert.deepStrictEqual(await store.getLastActivationByAgent(null, ['a1']), {});
});

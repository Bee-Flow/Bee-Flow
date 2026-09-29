/**
 * skillActivations — the "last used" write behind the Skills overview.
 *
 * DB-free: ../db is stubbed via require.cache. Pins the natural-key upsert
 * (the static path fires on EVERY chat turn — a 40-turn chat must be one
 * row, with a current timestamp), the in-process TTL cache that keeps that
 * turn free, the last_used_at stamp, the retention prune and the
 * never-throws contract.
 *
 * Run: node --test --test-force-exit stores/skillActivations.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const calls = [];
let failNext = false;
const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        run: async (sql, params = []) => {
            if (failNext) { failNext = false; throw new Error('db down'); }
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            return { rowCount: 1, rows: [] };
        },
        getAll: async (sql, params = []) => {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            if (/DISTINCT ON \(skill_id\)/.test(sql)) {
                return [{ skill_id: 's1', agent_id: 'a1', source: 'static', at: '2026-09-01T10:00:00.000Z' }];
            }
            if (/GROUP BY agent_id/.test(sql)) return [{ agent_id: 'a1', at: '2026-09-02T10:00:00.000Z' }];
            return [];
        },
        exec: async () => undefined,
        makeStoreInit: (tag, fn) => { let p = null; return () => (p ||= Promise.resolve().then(fn)); },
    },
};

const store = require('./skillActivations');

beforeEach(() => { calls.length = 0; failNext = false; store._resetCache(); });

test('a static activation upserts on (skill, conversation, agent, source) and refreshes `at`', async () => {
    const n = await store.recordActivations({ skillIds: ['s1', 's1', 's2'], agentId: 'a1', conversationId: 'c1', userId: 'u1', source: 'static' });
    assert.strictEqual(n, 2, 'one row per distinct skill');
    const inserts = calls.filter(c => /INSERT INTO skill_activations/.test(c.sql));
    assert.strictEqual(inserts.length, 2);
    for (const ins of inserts) {
        assert.match(ins.sql, /ON CONFLICT \(skill_id, conversation_id, agent_id, source\)/, 'the static path fires every turn; a chat is one row');
        assert.match(ins.sql, /DO UPDATE SET at = NOW\(\)/, '"last used" must still say when, not when the chat started');
        assert.deepStrictEqual(ins.params.slice(1, 5), ['a1', 'c1', 'u1', 'static']);
    }
});

test('a repeat within the TTL costs no round-trip at all (the static path runs on every turn)', async () => {
    await store.recordActivations({ skillIds: ['s1'], agentId: 'a1', conversationId: 'c1', source: 'static' });
    calls.length = 0;
    const n = await store.recordActivations({ skillIds: ['s1'], agentId: 'a1', conversationId: 'c1', source: 'static' });
    assert.strictEqual(n, 0);
    assert.strictEqual(calls.length, 0, 'no INSERT, no last_used_at stamp, no prune');
    // A different conversation, agent or source is a different use.
    await store.recordActivations({ skillIds: ['s1'], agentId: 'a1', conversationId: 'c2', source: 'static' });
    assert.strictEqual(calls.filter(c => /INSERT INTO skill_activations/.test(c.sql)).length, 1);
});

test('without a conversation and agent the key columns are empty strings, never NULL', async () => {
    // NULLs do not collide in a UNIQUE index — the ephemeral-chat path would
    // then write a row per turn again.
    await store.recordActivations({ skillIds: ['s1'], source: 'ai_step' });
    const ins = calls.find(c => /INSERT INTO skill_activations/.test(c.sql));
    assert.deepStrictEqual(ins.params, ['s1', '', '', null, 'ai_step']);
});

test('an unknown source falls back to static instead of writing junk', async () => {
    await store.recordActivations({ skillIds: ['s1'], source: 'whatever' });
    const ins = calls.find(c => /INSERT INTO skill_activations/.test(c.sql));
    assert.strictEqual(ins.params[4], 'static');
});

test('skills.last_used_at is stamped and old rows are pruned, for exactly the skills touched', async () => {
    await store.recordActivations({ skillIds: ['s1', 's2'] });
    const stamp = calls.find(c => /UPDATE skills SET last_used_at = NOW\(\)/.test(c.sql));
    assert.ok(stamp, 'last_used_at stamp');
    assert.deepStrictEqual(stamp.params[0], ['s1', 's2']);
    const prune = calls.find(c => /DELETE FROM skill_activations/.test(c.sql));
    assert.ok(prune, 'retention prune');
    assert.deepStrictEqual(prune.params[0], ['s1', 's2']);
    assert.strictEqual(prune.params[1], String(store.RETENTION_DAYS));
});

test('empty or garbage input writes nothing', async () => {
    assert.strictEqual(await store.recordActivations({ skillIds: [] }), 0);
    assert.strictEqual(await store.recordActivations({ skillIds: [null, 42, ''] }), 0);
    assert.strictEqual(await store.recordActivations({}), 0);
    assert.strictEqual(calls.length, 0);
});

test('a database failure never throws — a chat turn must not pay for telemetry', async () => {
    failNext = true;
    const n = await store.recordActivations({ skillIds: ['s1'] });
    assert.strictEqual(n, 0);
    // …and the failed write is not remembered as done, or the next turn
    // would skip it too and the skill would never get a "last used".
    calls.length = 0;
    assert.strictEqual(await store.recordActivations({ skillIds: ['s1'] }), 1);
    assert.ok(calls.some(c => /INSERT INTO skill_activations/.test(c.sql)));
});

test('getLastActivationBySkillIds maps DISTINCT ON rows to { skillId: {at, agentId, source} }', async () => {
    const m = await store.getLastActivationBySkillIds(['s1', 's9']);
    assert.deepStrictEqual(m, { s1: { at: '2026-09-01T10:00:00.000Z', agentId: 'a1', source: 'static' } });
    assert.deepStrictEqual(await store.getLastActivationBySkillIds([]), {});
});

test('getLastActivationByAgent answers per agent for one skill', async () => {
    const m = await store.getLastActivationByAgent('s1', ['a1', 'a2']);
    assert.deepStrictEqual(m, { a1: '2026-09-02T10:00:00.000Z' });
    assert.deepStrictEqual(await store.getLastActivationByAgent('s1', []), {});
    assert.deepStrictEqual(await store.getLastActivationByAgent(null, ['a1']), {});
});

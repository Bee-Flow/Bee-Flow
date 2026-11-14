// @typecheck
/**
 * agents-published-config: the schema half is replay-safe, the backfill half
 * is idempotent, skips system agents, and writes nothing on --dry-run. On a
 * real Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js) over the
 * agents columns the migration reads.
 *
 * Run: cd server && node --test migrations/agents-published-config.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../testUtils/pglitePool');
const { insertRows } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool();
const migration = require('./agents-published-config');
test.after(close);

const PUBLISHED = ['published_config', 'published_system_prompt', 'published_version', 'published_rev', 'published_at'];

test.beforeEach(async () => {
    await pg.exec(`DROP TABLE IF EXISTS agents;
        CREATE TABLE agents (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, system_prompt TEXT, config TEXT)`);
    await migration.up();
    await insertRows(pg, 'agents', [
        { id: 'a1', owner_id: 'u1', rev: 3, system_prompt: 'p1', config: '{"knowledge_base_ids":["kb1"]}' },
        { id: 'a2', owner_id: 'u2', rev: 1, system_prompt: 'p2', config: 'not json' },
        { id: 'sys', owner_id: 'system', rev: 1, system_prompt: 'sup', config: '{}' },
        { id: 'swarm', owner_id: 'swarm', rev: 1, system_prompt: 'sw', config: '{}' },
        { id: 'done', owner_id: 'u1', rev: 5, system_prompt: 'p', config: '{}', published_version: 2, published_config: { a: 1 }, published_rev: 5 },
    ]);
});

/** @param {string} id */
const agent = async (id) => (await pg.query('SELECT * FROM agents WHERE id = $1', [id])).rows[0];

test('up() is schema only and survives a replay', async () => {
    await migration.up();
    await migration.up();
    const { rows } = await pg.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name LIKE 'published%' ORDER BY column_name`);
    assert.deepEqual(rows.map(r => [r.column_name, r.data_type]), [
        ['published_at', 'timestamp with time zone'],
        ['published_config', 'jsonb'],
        ['published_rev', 'integer'],
        ['published_system_prompt', 'text'],
        ['published_version', 'integer'],
    ]);
    const version = rows.find(r => r.column_name === 'published_version');
    assert.deepEqual([version.is_nullable, version.column_default], ['NO', '0']);
    assert.equal((await agent('a1')).published_version, 0, 'up() never writes rows');
    assert.equal((await agent('a1')).published_config, null);
});

test('backfill exports exist and are NOT part of up()', () => {
    assert.equal(typeof migration.backfillPublished, 'function');
    assert.equal(typeof migration.up, 'function');
});

test('--dry-run counts candidates and writes nothing', async () => {
    const r = await migration.backfillPublished({ dryRun: true });
    assert.deepEqual(r, { dryRun: true, candidates: 2, updated: 0, invalidConfig: ['a2'] });
    for (const id of ['a1', 'a2']) assert.equal((await agent(id)).published_version, 0);
});

test('backfill copies the concept, skips system agents and already-published rows, is idempotent', async () => {
    const r = await migration.backfillPublished();
    assert.deepEqual(r, { dryRun: false, candidates: 2, updated: 2, invalidConfig: ['a2'] });
    const a1 = await agent('a1');
    assert.deepEqual(a1.published_config, { knowledge_base_ids: ['kb1'] });
    assert.equal(a1.published_system_prompt, 'p1');
    assert.equal(a1.published_version, 1);
    assert.equal(a1.published_rev, 3);
    assert.ok(a1.published_at);
    assert.deepEqual((await agent('a2')).published_config, {}, 'invalid JSON publishes as {} and is reported');
    for (const id of ['sys', 'swarm']) {
        const sys = await agent(id);
        assert.equal(sys.published_version, 0, 'system agents always follow live');
        assert.equal(sys.published_config, null);
    }
    const done = await agent('done');
    assert.equal(done.published_version, 2, 'an agent already in split mode is left alone');
    assert.deepEqual(done.published_config, { a: 1 });

    const again = await migration.backfillPublished();
    assert.deepEqual(again, { dryRun: false, candidates: 0, updated: 0, invalidConfig: [] });
});

test('a concept saved between SELECT and UPDATE is skipped, not frozen at the stale snapshot', async () => {
    const db = require('../db');
    const saved = db.pool.query;
    db.pool.query = /** @type {any} */ (async (/** @type {any} */ sql, /** @type {any} */ params) => {
        const out = await saved(sql, params);
        if (/^\s*SELECT id, config, rev/.test(String(sql))) await pg.query("UPDATE agents SET rev = 4, system_prompt = 'p1 new' WHERE id = 'a1'");
        return out;
    });
    try {
        const r = await migration.backfillPublished();
        assert.equal(r.updated, 1, 'only a2 was written');
    } finally { db.pool.query = saved; }
    const a1 = await agent('a1');
    assert.equal(a1.published_version, 0);
    assert.deepEqual(PUBLISHED.map(c => a1[c]).slice(0, 2), [null, null], 'nothing frozen from the stale read');
});

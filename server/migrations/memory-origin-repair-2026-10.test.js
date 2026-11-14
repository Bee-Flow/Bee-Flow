// @typecheck
/**
 * memory-origin-repair on a real Postgres (the boot ladder's schema on PGlite,
 * testUtils/pgliteTemplate.js): which rows it relabels and which it leaves.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('./memory-origin-repair-2026-10');
const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { ladderPglite, newPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, db } = pgliteDb(ladderPglite());
test.after(() => pg.close());

/** @param {string} id @param {string} origin */
const memory = (id, origin) => insertRow(pg, 'user_memories', { id, user_id: 'u1', type: 'fact', content: id, origin });
/** @param {string} id */
const originOf = async (id) => (await pg.query('SELECT origin FROM user_memories WHERE id = $1', [id])).rows[0].origin;

test('relabels only explicit rows that have a memory_sources row', async () => {
    await memory('explicit-sourced', 'explicit');
    await memory('explicit-typed', 'explicit');
    await memory('inferred-sourced', 'inferred');
    await insertRow(pg, 'memory_sources', { id: 's1', memory_id: 'explicit-sourced', conversation_id: 'c1' });
    await insertRow(pg, 'memory_sources', { id: 's2', memory_id: 'inferred-sourced', conversation_id: 'c1' });
    await migration.up({ run: db.query });
    assert.equal(await originOf('explicit-sourced'), 'inferred');
    assert.equal(await originOf('explicit-typed'), 'explicit', 'a row the user wrote, with no source, stays explicit');
    assert.equal(await originOf('inferred-sourced'), 'inferred');
    await migration.up({ run: db.query });
    assert.equal(await originOf('explicit-typed'), 'explicit', 'idempotent');
});

test('a database without the column is skipped, not a failure', async () => {
    const bare = pgliteDb(newPglite());
    try {
        await bare.pg.exec('CREATE TABLE user_memories (id TEXT PRIMARY KEY); CREATE TABLE memory_sources (memory_id TEXT)');
        await migration.up({ run: bare.db.query });
    } finally { await bare.pg.close(); }
});

test('the migration is registered, or it never runs', () => {
    assert.ok(LOOSE_MIGRATIONS.includes('memory-origin-repair-2026-10'));
});

// @typecheck
'use strict';
/**
 * skills.agent_only and skills.category on a real Postgres (PGlite): an
 * existing skill reads "usable everywhere" and "no category" afterwards, and
 * a rerun changes nothing.
 * Run: cd server && node --test migrations/skills-agent-only-category-2026-11.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const migration = require('./skills-agent-only-category-2026-11');

const { pg } = pgliteDb();
const migrationDb = { exec: (/** @type {string} */ sql) => pg.exec(sql) };

before(async () => {
    await pg.exec(`CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
    await pg.exec(`INSERT INTO skills (id, name) VALUES ('old', 'A skill from before')`);
});
after(async () => { await pg.close(); });

test('adds agent_only (false for existing rows) and category (NULL), idempotently', async () => {
    await migration.up(migrationDb);
    await migration.up(migrationDb);
    const { rows } = await pg.query(`SELECT agent_only, category FROM skills WHERE id = 'old'`);
    assert.deepStrictEqual({ ...rows[0] }, { agent_only: false, category: null });
});

test('a skill without a table yet is no error: the store creates the table with the columns', async () => {
    await pg.exec('DROP TABLE skills');
    await migration.up(migrationDb);
    await pg.exec(`CREATE TABLE skills (id TEXT PRIMARY KEY)`);
});

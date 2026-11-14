/**
 * The webpage store's schema init against a real Postgres (PGlite behind the
 * real db.js): what it leaves in the catalog (columns with type, default and
 * nullability, indexes, constraints) and which statements it sends, in which
 * order. The golden holds both, so a statement that moves, changes one
 * character or disappears shows, and so does a catalog that comes out
 * different. A second boot (through the ledger) and a third (every statement
 * sent again) leave the catalog exactly as the first did.
 *
 * Refresh (only for a deliberate schema change):
 *   cd server && UPDATE_GOLDEN=1 node --require ./testUtils/registerFeatures.js --test stores/webpage/schema.catalog.pg.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const db = require('../../db');
const storeInit = require('../lib/storeInit');
const { initDB } = require('./schema');

const GOLDEN_PATH = path.join(__dirname, 'schema.catalog.golden.json');

// Every statement about the webpage tables that reaches the pool, in order.
// The ledger's own bookkeeping and the transaction framing are left out.
/** @type {string[]} */
let sent = [];
const aboutWebpages = (/** @type {string} */ text) => text.includes('webpage') && !text.includes('schema_migrations');
const record = (/** @type {Function} */ query) => async (/** @type {any} */ sql, /** @type {any} */ params) => {
    const text = typeof sql === 'string' ? sql : String(sql?.text || '');
    if (aboutWebpages(text)) sent.push(text);
    return query(sql, params);
};
const pooled = { query: db.pool.query, connect: db.pool.connect };
db.pool.query = /** @type {any} */ (record(pooled.query));
db.pool.connect = /** @type {any} */ (async () => {
    const client = await /** @type {any} */ (pooled.connect)();
    return { ...client, query: record(client.query) };
});

after(async () => {
    db.pool.query = pooled.query;
    db.pool.connect = pooled.connect;
    await close();
});

const rows = async (/** @type {string} */ sql) => (await pg.query(sql)).rows;

async function catalog() {
    return {
        columns: await rows(`
            SELECT table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
              FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name LIKE 'webpage%'
             ORDER BY table_name, ordinal_position`),
        indexes: await rows(`
            SELECT tablename, indexname, indexdef
              FROM pg_indexes
             WHERE schemaname = 'public' AND tablename LIKE 'webpage%'
             ORDER BY tablename, indexname`),
        constraints: await rows(`
            SELECT c.conrelid::regclass::text AS table_name, c.conname, c.contype, pg_get_constraintdef(c.oid) AS definition
              FROM pg_constraint c
             WHERE c.conrelid::regclass::text LIKE 'webpage%'
             ORDER BY 1, 2`),
    };
}

const digest = (/** @type {string} */ text) => crypto.createHash('sha256').update(text).digest('hex');
const head = (/** @type {string} */ text) => text.replace(/\s+/g, ' ').trim().slice(0, 70);

/** One boot of the store's schema, with what it sent. */
async function boot() {
    storeInit._resetAllForTests();
    sent = [];
    await initDB();
    return sent.map((text) => ({ sha256: digest(text), head: head(text) }));
}

/** @type {Awaited<ReturnType<typeof catalog>>} */
let first;
/** @type {{ sha256: string, head: string }[]} */
let firstStatements;

test('a fresh boot sends the recorded statements in order and leaves the recorded catalog', async () => {
    firstStatements = await boot();
    first = await catalog();
    const actual = JSON.parse(JSON.stringify({ statements: firstStatements, catalog: first }));
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
    assert.deepEqual(actual.statements, golden.statements);
    assert.deepEqual(actual.catalog, golden.catalog);
});

test('a second boot, through the ledger, leaves the catalog as it was', async () => {
    await boot();
    assert.deepEqual(await catalog(), first);
});

test('a boot that sends every statement again sends the same ones and leaves the catalog as it was', async () => {
    const saved = process.env.BEEFLOW_DDL_LEDGER;
    process.env.BEEFLOW_DDL_LEDGER = 'off';
    try {
        const again = await boot();
        assert.deepEqual(again, firstStatements);
        assert.deepEqual(await catalog(), first);
    } finally {
        if (saved === undefined) delete process.env.BEEFLOW_DDL_LEDGER;
        else process.env.BEEFLOW_DDL_LEDGER = saved;
    }
});

test('the version backfill numbers rows without a number after the highest one the page has', async () => {
    await pg.query(`INSERT INTO webpages (id, user_id, name) VALUES ('wp-seq', 'u1', 'p')`);
    await pg.query(`
        INSERT INTO webpage_versions (id, webpage_id, seq, created_at) VALUES
            ('v-a', 'wp-seq', 4, '2026-01-01T00:00:00Z'),
            ('v-b', 'wp-seq', NULL, '2026-01-03T00:00:00Z'),
            ('v-c', 'wp-seq', NULL, '2026-01-02T00:00:00Z')`);
    const saved = process.env.BEEFLOW_DDL_LEDGER;
    process.env.BEEFLOW_DDL_LEDGER = 'off';
    try {
        await boot();
    } finally {
        if (saved === undefined) delete process.env.BEEFLOW_DDL_LEDGER;
        else process.env.BEEFLOW_DDL_LEDGER = saved;
    }
    const numbered = await rows(`SELECT id, seq FROM webpage_versions WHERE webpage_id = 'wp-seq' ORDER BY id`);
    assert.deepEqual(numbered, [{ id: 'v-a', seq: 4 }, { id: 'v-b', seq: 6 }, { id: 'v-c', seq: 5 }]);
});

'use strict';

/**
 * `direct_conversations.knowledge_base_ids` — does the boot DDL actually put
 * the column there, and may every replica keep running it?
 *
 * The unit tests around this column all stub the database, so none of them can
 * tell whether the ALTER is even valid SQL. This one runs the REAL
 * `stores/agent/initSchema` against a REAL Postgres and reads the ground truth
 * out of information_schema — the same reasoning (and the same pglite facade)
 * as migrateDb.integration.test.js, which asserts tables and not columns.
 *
 * What it pins:
 *
 *   - the column exists, and it is JSONB. Not TEXT-holding-JSON like
 *     labels_json on this same table: the containment operator used to scrub a
 *     deleted base out of its consumers (`@> to_jsonb($1::text)`) only works on
 *     jsonb, and every other knowledge_base_ids in the product is jsonb.
 *   - it is NOT NULL with a `[]` default, so "no knowledge bases" has exactly
 *     one representation and a row can never read as null.
 *   - rows that existed BEFORE the migration come out as `[]`, not null.
 *   - the statement is idempotent: it is boot DDL, so every replica runs it on
 *     every start, and a second run must change nothing.
 *
 * pglite is real Postgres (WASM, in-process, already a devDependency), so this
 * suite always runs — no container, no self-skip.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/initSchema.kb.integration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.join(__dirname, '..', '..');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adaptResult(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const command = fields.length > 0 ? 'SELECT' : String(sql).trim().split(/\s+/)[0].toUpperCase();
    const rowCount = fields.length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command };
}

async function rawQuery(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adaptResult(await pg.exec(sql), sql);
    return adaptResult(await pg.query(sql), sql);
}

const client = { query: (sql, params) => rawQuery(sql, params), release: () => {} };

function mock(absId, exportsObj) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exportsObj;
    m.loaded = true;
    require.cache[p] = m;
}

mock(path.join(SERVER, 'db.js'), {
    pool: { query: rawQuery, connect: async () => client, end: async () => {} },
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql, []),
    getClient: async () => client,
    // A REAL transaction: runDdl opens a SAVEPOINT per statement, which
    // Postgres refuses outside a transaction block. A withTransaction that
    // merely hands over a client would make this suite prove nothing about the
    // path the boot actually takes.
    withTransaction: async (fn) => {
        await client.query('BEGIN');
        try {
            const out = await fn(client);
            await client.query('COMMIT');
            return out;
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch { /* already aborted */ }
            throw e;
        }
    },
    makeStoreInit: (tag, schemaFn) => {
        let promise = null;
        return function ensureInit() {
            if (!promise) promise = Promise.resolve().then(schemaFn).catch((err) => { promise = null; throw err; });
            return promise;
        };
    },
    isSqlStateError: (e) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code),
    getRedis: () => null,
    redisHealthy: () => false,
    disconnectRedis: async () => {},
    getPoolStats: () => ({}),
});

const { initDB } = require('./initSchema');

/** The exact statement initSchema runs, so "idempotent" is tested on the real text. */
const ALTER = `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS knowledge_base_ids JSONB NOT NULL DEFAULT '[]'::jsonb`;

async function columnInfo() {
    const { rows } = await rawQuery(`
        SELECT data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_name = 'direct_conversations' AND column_name = 'knowledge_base_ids'
    `);
    return rows[0] || null;
}

test('a pre-existing row survives the migration and reads as "no knowledge bases"', async () => {
    // Written the way a database from BEFORE this column looks: the table
    // exists, the column does not.
    await rawQuery(`
        CREATE TABLE IF NOT EXISTS direct_conversations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT DEFAULT 'New Chat',
            messages_json TEXT DEFAULT '[]',
            workspace_content TEXT DEFAULT '',
            model_tier TEXT DEFAULT 'fast',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await rawQuery(`INSERT INTO direct_conversations (id, user_id) VALUES ('legacy-1', 'alice')`);
    assert.strictEqual(await columnInfo(), null, 'the column must not exist yet');

    await initDB();

    const { rows } = await rawQuery(`SELECT knowledge_base_ids FROM direct_conversations WHERE id = 'legacy-1'`);
    assert.deepStrictEqual(rows[0].knowledge_base_ids, [], 'an old row must read as an empty list, never null');
});

test('the column is JSONB, NOT NULL, defaulted to an empty list', async () => {
    await initDB();
    const col = await columnInfo();
    assert.ok(col, 'knowledge_base_ids must exist after boot DDL');
    // jsonb, not text: the scrub form used elsewhere in the product
    // (`knowledge_base_ids @> to_jsonb($1::text)`) needs a real jsonb column.
    assert.strictEqual(col.data_type, 'jsonb');
    assert.strictEqual(col.is_nullable, 'NO');
    assert.match(String(col.column_default), /\[\]/);
});

test('jsonb containment works on it — a deleted base can be found and scrubbed', async () => {
    await initDB();
    await rawQuery(`INSERT INTO direct_conversations (id, user_id, knowledge_base_ids)
                    VALUES ('c-scrub', 'alice', '["kb-a","kb-b"]'::jsonb)
                    ON CONFLICT (id) DO UPDATE SET knowledge_base_ids = EXCLUDED.knowledge_base_ids`);
    const { rows } = await rawQuery(
        `SELECT id FROM direct_conversations WHERE knowledge_base_ids @> to_jsonb($1::text)`, ['kb-b']
    );
    assert.deepStrictEqual(rows.map(r => r.id), ['c-scrub']);
});

test('re-running the statement changes nothing — every replica boots this', async () => {
    await initDB();
    const before = await columnInfo();
    await rawQuery(`INSERT INTO direct_conversations (id, user_id, knowledge_base_ids)
                    VALUES ('c-keep', 'alice', '["kb-a"]'::jsonb)
                    ON CONFLICT (id) DO UPDATE SET knowledge_base_ids = EXCLUDED.knowledge_base_ids`);

    await rawQuery(ALTER);
    await rawQuery(ALTER);

    assert.deepStrictEqual(await columnInfo(), before, 'the column definition must not drift');
    const { rows } = await rawQuery(`SELECT knowledge_base_ids FROM direct_conversations WHERE id = 'c-keep'`);
    assert.deepStrictEqual(rows[0].knowledge_base_ids, ['kb-a'], 'stored data must survive a re-run');
});

test('a NULL cannot be written into it — "nothing" has one representation', async () => {
    await initDB();
    await assert.rejects(
        () => rawQuery(`INSERT INTO direct_conversations (id, user_id, knowledge_base_ids) VALUES ('c-null', 'alice', NULL)`),
        /null value|not-null|violates/i
    );
});

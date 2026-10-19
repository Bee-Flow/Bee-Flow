'use strict';

/**
 * The automation credential store's schema init against a REAL Postgres
 * (@electric-sql/pglite behind db.js's pool, testUtils/pglitePool.js), on a
 * database that holds BOTH the old `routine_credentials` table and the new
 * `automation_credentials` one, each with its own indexes. That happens when an
 * image from before the 2026-10 rename runs after one from after it on the same
 * volume. The index renames used to run unguarded there, collided with the new
 * table's indexes and failed the init on every call, which also broke the
 * trigger bus's vault lookup (#279).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./automationCredentialStore');

const TABLE = (name) => `
    CREATE TABLE ${name} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        expires_at TIMESTAMPTZ,
        scope TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_refresh_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, provider)
    );
    CREATE INDEX idx_${name}_user ON ${name}(user_id);
    CREATE INDEX idx_${name}_status ON ${name}(status);
`;

before(async () => {
    await pg.exec(TABLE('routine_credentials') + TABLE('automation_credentials'));
});
after(close);

async function indexesOf(table) {
    const { rows } = await pg.query(`SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname LIKE 'idx_%' ORDER BY indexname`, [table]);
    return rows.map((r) => r.indexname);
}

test('init succeeds when routine_credentials and automation_credentials both exist', async () => {
    await store.initDB();
    assert.deepStrictEqual(await indexesOf('automation_credentials'), ['idx_automation_credentials_status', 'idx_automation_credentials_user']);
    // The old table is left as it is: its rows (if any) are an operator's call.
    assert.deepStrictEqual(await indexesOf('routine_credentials'), ['idx_routine_credentials_status', 'idx_routine_credentials_user']);
});

test('the store reads on that database (the trigger bus path)', async () => {
    assert.strictEqual(await store.getCredential('nobody', 'microsoft'), null);
    assert.deepStrictEqual(await store.listProvidersForUser('nobody'), []);
});

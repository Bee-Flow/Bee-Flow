'use strict';

/**
 * The scope migration, against a REAL Postgres.
 *
 * It moves a PRIMARY KEY, drops two NOT NULLs, replaces a unique index and adds
 * a foreign key on live tenant data. Every one of those is irreversible in the
 * direction that matters, and the failure mode of a half-applied run is not an
 * error — it is a tenant whose rows nothing can address. So this drives the
 * genuine `up()` against @electric-sql/pglite (real Postgres, WASM, in-process,
 * already the harness under stores/lib/pgAppEngine.test.js) rather than reading
 * the source.
 *
 * The three properties worth the harness:
 *   - an existing organisation keeps every row and gains scope_kind='org';
 *   - a SECOND run changes nothing — in particular it does not drop and rebuild
 *     the primary key, which is what a name-based guard would have done on a
 *     fresh install (Postgres names the new PK `datatable_models_pkey` too);
 *   - what the migration EXISTS for actually becomes possible afterwards: a row
 *     with no organisation at all.
 *
 * Run: cd server && node --test --test-force-exit migrations/datatable-scope-2026-09.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

const executed = [];   // every statement the migration ran, in order

function adaptResult(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const rowCount = fields.length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command: String(sql).trim().split(/\s+/)[0].toUpperCase() };
}

async function rawQuery(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adaptResult(await pg.exec(sql), sql);
    return adaptResult(await pg.query(sql), sql);
}

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

mock(path.join(SERVER, 'db.js'), {
    run: (sql, params) => { executed.push(String(sql).replace(/\s+/g, ' ').trim()); return rawQuery(sql, params); },
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql, []),
});

const { up, pkCovers } = require('./datatable-scope-2026-09');

const ORG_A = 'org-alpha';
const ORG_B = 'org-beta';

/** The schema EXACTLY as it stood before this migration. */
async function createLegacySchema() {
    await pg.exec(`
        CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE datatables (
            id               TEXT PRIMARY KEY,
            organization_id  TEXT NOT NULL,
            owner_user_id    TEXT NOT NULL,
            project_id       TEXT,
            key              TEXT NOT NULL,
            name             TEXT NOT NULL,
            description      TEXT NOT NULL DEFAULT '',
            is_published     BOOLEAN NOT NULL DEFAULT FALSE,
            shared_groups    JSONB   NOT NULL DEFAULT '[]'::jsonb,
            write_mode       TEXT    NOT NULL DEFAULT 'grants',
            row_scope        TEXT    NOT NULL DEFAULT 'all',
            retention_days   INTEGER,
            retention_field  TEXT    NOT NULL DEFAULT 'created_at',
            row_count        INTEGER NOT NULL DEFAULT 0,
            data_version     INTEGER NOT NULL DEFAULT 0,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX uq_datatables_org_key ON datatables(organization_id, lower(key));
        CREATE TABLE datatable_models (
            organization_id  TEXT PRIMARY KEY,
            model            JSONB   NOT NULL DEFAULT '{}'::jsonb,
            model_version    INTEGER NOT NULL DEFAULT 0,
            schema_stamp     INTEGER NOT NULL DEFAULT 0,
            size_bytes       BIGINT  NOT NULL DEFAULT 0
        );
        CREATE TABLE datatable_grants (
            id             TEXT PRIMARY KEY,
            datatable_id   TEXT NOT NULL REFERENCES datatables(id) ON DELETE CASCADE,
            grantee_type   TEXT NOT NULL,
            grantee_id     TEXT NOT NULL,
            grade          TEXT NOT NULL,
            granted_by     TEXT NOT NULL
        );
        CREATE TABLE automation_datatable_usage (
            organization_id TEXT NOT NULL,
            datatable_id    TEXT NOT NULL REFERENCES datatables(id) ON DELETE CASCADE,
            automation_id   TEXT NOT NULL,
            step_id         TEXT NOT NULL,
            mode            TEXT NOT NULL,
            columns         JSONB NOT NULL DEFAULT '[]'::jsonb,
            PRIMARY KEY (automation_id, step_id)
        );
    `);
    await rawQuery("INSERT INTO organizations (id, name) VALUES ($1,$2), ($3,$4)",
        [ORG_A, 'Alpha', ORG_B, 'Beta']);
    await rawQuery(`INSERT INTO datatables (id, organization_id, owner_user_id, key, name, row_count)
                    VALUES ('tbl_a', $1, 'u1', 'customers', 'Customers', 7),
                           ('tbl_b', $2, 'u2', 'customers', 'Customers', 3)`, [ORG_A, ORG_B]);
    await rawQuery(`INSERT INTO datatable_models (organization_id, model, model_version)
                    VALUES ($1, '{"tables":[]}'::jsonb, 4), ($2, '{"tables":[]}'::jsonb, 1)`, [ORG_A, ORG_B]);
    await rawQuery(`INSERT INTO datatable_grants (id, datatable_id, grantee_type, grantee_id, grade, granted_by)
                    VALUES ('dtg_1', 'tbl_a', 'user', 'u9', 'viewer', 'u1')`);
    await rawQuery(`INSERT INTO automation_datatable_usage
                        (organization_id, datatable_id, automation_id, step_id, mode)
                    VALUES ($1, 'tbl_a', 'auto_1', 's1', 'read')`, [ORG_A]);
}

const one = async (sql, params) => (await rawQuery(sql, params)).rows[0];

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await createLegacySchema();
});

after(async () => { await pg.close(); });

// ── The first run ───────────────────────────────────────────────────────────

test('an existing organisation keeps its rows and gains scope_kind = org', async () => {
    await up();

    const rows = (await rawQuery('SELECT id, scope_kind, scope_id, organization_id, row_count FROM datatables ORDER BY id')).rows;
    assert.deepStrictEqual(rows, [
        { id: 'tbl_a', scope_kind: 'org', scope_id: ORG_A, organization_id: ORG_A, row_count: 7 },
        { id: 'tbl_b', scope_kind: 'org', scope_id: ORG_B, organization_id: ORG_B, row_count: 3 },
    ], 'a backfill that lost a row or a counter would be silent data loss');

    const models = (await rawQuery('SELECT scope_kind, scope_id, model_version FROM datatable_models ORDER BY scope_id')).rows;
    assert.deepStrictEqual(models, [
        { scope_kind: 'org', scope_id: ORG_A, model_version: 4 },
        { scope_kind: 'org', scope_id: ORG_B, model_version: 1 },
    ]);

    // Grants and usage rows inherit the scope of the table they hang off.
    assert.deepStrictEqual(
        await one('SELECT scope_kind, scope_id FROM datatable_grants WHERE id = $1', ['dtg_1']),
        { scope_kind: 'org', scope_id: ORG_A });
    assert.deepStrictEqual(
        await one('SELECT scope_kind, scope_id FROM automation_datatable_usage WHERE automation_id = $1', ['auto_1']),
        { scope_kind: 'org', scope_id: ORG_A });
});

test('the primary key moves to the scope, and uniqueness follows it', async () => {
    assert.strictEqual(await pkCovers('datatable_models', ['scope_kind', 'scope_id']), true);

    const idx = (await rawQuery(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'datatables' ORDER BY indexname`)).rows.map(r => r.indexname);
    assert.ok(idx.includes('uq_datatables_scope_key'));
    assert.ok(!idx.includes('uq_datatables_org_key'),
        'two indexes claiming the same uniqueness would disagree the moment one scope is not an org');
});

test('the tenancy columns are NOT NULL and organization_id no longer is', async () => {
    const nullable = async (table, col) => (await one(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`, [table, col])).is_nullable;
    assert.strictEqual(await nullable('datatables', 'scope_id'), 'NO');
    assert.strictEqual(await nullable('datatable_models', 'scope_id'), 'NO');
    // The whole point: an account with no organisation could not own a row.
    assert.strictEqual(await nullable('datatables', 'organization_id'), 'YES');
    assert.strictEqual(await nullable('datatable_models', 'organization_id'), 'YES');
    assert.strictEqual(await nullable('automation_datatable_usage', 'organization_id'), 'YES');
});

test('the organizations FK is added as the metadata backstop', async () => {
    const fk = await one(
        `SELECT confdeltype FROM pg_constraint
          WHERE conname = 'fk_datatables_organization' AND conrelid = 'datatables'::regclass`);
    assert.ok(fk, 'a FK cannot drop a schema, but it makes the metadata half impossible to forget');
    assert.strictEqual(fk.confdeltype, 'c', 'ON DELETE CASCADE');

    // And it really cascades: deleting an organisation takes its rows with it.
    await rawQuery(`INSERT INTO organizations (id, name) VALUES ('org-doomed', 'Doomed')`);
    await rawQuery(`INSERT INTO datatables (id, scope_kind, scope_id, organization_id, owner_user_id, key, name)
                    VALUES ('tbl_doomed', 'org', 'org-doomed', 'org-doomed', 'u3', 'x', 'X')`);
    await rawQuery(`DELETE FROM organizations WHERE id = 'org-doomed'`);
    assert.strictEqual(await one(`SELECT id FROM datatables WHERE id = 'tbl_doomed'`), undefined);
});

// ── What it exists for ──────────────────────────────────────────────────────

test('a PERSONAL row becomes possible, and does not collide with an org one', async () => {
    await rawQuery(`INSERT INTO datatables (id, scope_kind, scope_id, organization_id, owner_user_id, key, name)
                    VALUES ('tbl_mine', 'user', 'u-solo', NULL, 'u-solo', 'customers', 'Customers')`);
    await rawQuery(`INSERT INTO datatable_models (scope_kind, scope_id, organization_id, model)
                    VALUES ('user', 'u-solo', NULL, '{"tables":[]}'::jsonb)`);
    assert.strictEqual(
        (await rawQuery(`SELECT COUNT(*)::int AS n FROM datatables WHERE key = 'customers'`)).rows[0].n, 3,
        'an org and an account may each own a `customers` — they are different tenants');

    // ...but a second `customers` in the SAME scope still cannot exist.
    await assert.rejects(
        () => rawQuery(`INSERT INTO datatables (id, scope_kind, scope_id, organization_id, owner_user_id, key, name)
                        VALUES ('tbl_dupe', 'user', 'u-solo', NULL, 'u-solo', 'Customers', 'Again')`),
        /duplicate key|unique/i,
        'the case-insensitive uniqueness has to survive the move to the scope');
});

// ── The second run ──────────────────────────────────────────────────────────

test('a second run changes nothing — and does NOT rebuild the primary key', async () => {
    const snapshot = async () => ({
        tables: (await rawQuery('SELECT * FROM datatables ORDER BY id')).rows,
        models: (await rawQuery('SELECT * FROM datatable_models ORDER BY scope_kind, scope_id')).rows,
        grants: (await rawQuery('SELECT * FROM datatable_grants ORDER BY id')).rows,
        usage: (await rawQuery('SELECT * FROM automation_datatable_usage ORDER BY automation_id')).rows,
    });
    const before = await snapshot();

    executed.length = 0;
    await up();

    assert.deepStrictEqual(await snapshot(), before);
    // The guard is asked of pg_index, not of pg_constraint by NAME: Postgres
    // calls the new key `datatable_models_pkey` too, so a name check would find
    // it, drop it and rebuild it — dropping a primary key on live tenant data
    // every single boot.
    const dropped = executed.filter(sql => /DROP CONSTRAINT/i.test(sql));
    assert.deepStrictEqual(dropped, [], `the PK swap must be skipped, got: ${dropped.join(' | ')}`);
    assert.strictEqual(await pkCovers('datatable_models', ['scope_kind', 'scope_id']), true);
    // ...and no second foreign key of the same name.
    assert.strictEqual(
        (await rawQuery(`SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'fk_datatables_organization'`)).rows[0].n, 1);
});

test('it is a no-op on a deployment that has no datatables at all', async () => {
    // A fresh install reaches this migration before datatableStore.createSchema
    // has run. Probing first is what keeps the ladder from logging a failure
    // for every new deployment.
    const fresh = new PGlite();
    const realQuery = require(path.join(SERVER, 'db.js')).getOne;
    require(path.join(SERVER, 'db.js')).getOne = async (sql, params) => {
        const r = Array.isArray(params) && params.length
            ? await fresh.query(sql, params) : await fresh.query(sql);
        return (r.rows || [])[0] || null;
    };
    try {
        await up();   // must not throw
    } finally {
        require(path.join(SERVER, 'db.js')).getOne = realQuery;
        await fresh.close();
    }
});

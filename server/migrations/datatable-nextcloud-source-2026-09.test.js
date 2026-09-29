'use strict';

/**
 * The mirror-source migration, against a REAL Postgres.
 *
 * Small on purpose (two nullable columns, two partial indexes), but the two
 * index expressions are exactly where a migration can pass a regex test and
 * fail the boot: an index over a `::timestamptz` cast is refused by Postgres
 * as not IMMUTABLE, and that is what the first draft of this file did. So the
 * genuine `up()` runs on pglite, twice, and the second run changes nothing.
 *
 * Run: cd server && node --test migrations/datatable-nextcloud-source-2026-09.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..');
const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

async function rawQuery(sql, params) {
    const r = (Array.isArray(params) && params.length) ? await pg.query(sql, params) : await pg.query(sql);
    return { rows: r.rows || [] };
}
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p); m.exports = exports; m.loaded = true; require.cache[p] = m;
}
mock(path.join(SERVER, 'db.js'), { exec: (sql) => rawQuery(sql, []), run: rawQuery, getOne: async () => null, getAll: async () => [] });

const { up } = require('./datatable-nextcloud-source-2026-09');

before(async () => {
    await pg.exec(`CREATE TABLE datatables (id TEXT PRIMARY KEY, organization_id TEXT, managed_kind TEXT)`);
    await pg.exec(`INSERT INTO datatables (id, organization_id, managed_kind) VALUES ('tbl_a', 'org', NULL)`);
});
after(async () => { await pg.close(); });

test('adds the two columns and the two partial indexes, and is idempotent', async () => {
    await up();
    await up();
    const cols = await rawQuery(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'datatables' ORDER BY ordinal_position`);
    assert.deepStrictEqual(cols.rows.map(r => [r.column_name, r.data_type]).slice(-2), [['source', 'jsonb'], ['sync_state', 'jsonb']]);
    const idx = await rawQuery(`SELECT indexname FROM pg_indexes WHERE tablename = 'datatables' ORDER BY indexname`);
    assert.ok(idx.rows.some(r => r.indexname === 'idx_datatables_nc_table'));
    assert.ok(idx.rows.some(r => r.indexname === 'idx_datatables_nc_due'));
    // an existing row reads as an ordinary table
    const row = await rawQuery(`SELECT source, sync_state FROM datatables WHERE id = 'tbl_a'`);
    assert.strictEqual(row.rows[0].source, null);
    assert.strictEqual(row.rows[0].sync_state, null);
});

test('the fan-out and the due-list queries the store runs are answerable', async () => {
    await pg.exec(`INSERT INTO datatables (id, organization_id, managed_kind, source, sync_state)
                   VALUES ('tbl_m', 'org', 'nextcloud_table', '{"ncTableId": 4}', '{"nextRunAt": "2000-01-01T00:00:00.000Z", "status": "ok"}')`);
    const fan = await rawQuery(`SELECT id FROM datatables WHERE managed_kind = 'nextcloud_table' AND organization_id = $1 AND (source->>'ncTableId')::int = $2`, ['org', 4]);
    assert.deepStrictEqual(fan.rows.map(r => r.id), ['tbl_m']);
    const due = await rawQuery(`SELECT id FROM datatables WHERE managed_kind = 'nextcloud_table' AND (sync_state IS NULL OR sync_state->>'nextRunAt' <= $1) AND sync_state->>'status' IS DISTINCT FROM 'running'`, [new Date().toISOString()]);
    assert.deepStrictEqual(due.rows.map(r => r.id), ['tbl_m']);
});

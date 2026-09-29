'use strict';

/**
 * The spreadsheet-source migration, against a REAL Postgres.
 *
 * Two partial indexes, and the two index expressions are exactly where a
 * migration can pass a regex test and fail the boot: an index over a
 * `::timestamptz` or `::int` cast is refused by Postgres as not IMMUTABLE.
 * So the genuine `up()` runs on pglite, twice, and the second run changes
 * nothing. The fan-out and the due-list queries the store runs — with the
 * kinds INLINED, as the store does — are then asked for real.
 *
 * Run: cd server && node --test migrations/datatable-spreadsheet-source-2026-09.test.js
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

const { up } = require('./datatable-spreadsheet-source-2026-09');

before(async () => {
    await pg.exec(`CREATE TABLE datatables (id TEXT PRIMARY KEY, organization_id TEXT, managed_kind TEXT, source JSONB, sync_state JSONB)`);
    await pg.exec(`INSERT INTO datatables (id, organization_id, managed_kind) VALUES ('tbl_a', 'org', NULL)`);
});
after(async () => { await pg.close(); });

test('adds the two partial indexes, and is idempotent', async () => {
    await up();
    await up();
    const idx = await rawQuery(`SELECT indexname FROM pg_indexes WHERE tablename = 'datatables' ORDER BY indexname`);
    assert.ok(idx.rows.some(r => r.indexname === 'idx_datatables_source_file'));
    assert.ok(idx.rows.some(r => r.indexname === 'idx_datatables_source_due'));
    // an existing row reads as an ordinary table
    const row = await rawQuery(`SELECT source, sync_state FROM datatables WHERE id = 'tbl_a'`);
    assert.strictEqual(row.rows[0].source, null);
    assert.strictEqual(row.rows[0].sync_state, null);
});

test('the file fan-out and the due list over both kinds are answerable', async () => {
    await pg.exec(`INSERT INTO datatables (id, organization_id, managed_kind, source, sync_state) VALUES
        ('tbl_nc', 'org', 'nextcloud_table', '{"ncTableId": 4}', '{"nextRunAt": "2000-01-01T00:00:00.000Z", "status": "ok"}'),
        ('tbl_ss', 'org', 'spreadsheet_file', '{"provider": "onedrive", "file": {"id": "01ABC", "path": "/Documents/facturen.xlsx"}}', '{"nextRunAt": "2000-01-01T00:00:00.000Z", "status": "ok"}'),
        ('tbl_other', 'org2', 'spreadsheet_file', '{"provider": "onedrive", "file": {"id": "01ABC"}}', NULL),
        ('tbl_running', 'org', 'spreadsheet_file', '{"provider": "google_drive", "file": {"id": "g1"}}', '{"nextRunAt": "2000-01-01T00:00:00.000Z", "status": "running"}')`);
    const fan = await rawQuery(
        `SELECT id FROM datatables WHERE managed_kind = $1 AND organization_id = $2 AND source->>'provider' = $3 AND source->'file'->>'id' = $4`,
        ['spreadsheet_file', 'org', 'onedrive', '01ABC'],
    );
    assert.deepStrictEqual(fan.rows.map(r => r.id), ['tbl_ss'], 'narrowed to the organisation');
    const due = await rawQuery(
        `SELECT id FROM datatables
          WHERE managed_kind IN ('nextcloud_table', 'spreadsheet_file')
            AND (sync_state IS NULL OR sync_state->>'nextRunAt' <= $1)
            AND sync_state->>'status' IS DISTINCT FROM 'running'
          ORDER BY sync_state->>'nextRunAt' ASC NULLS FIRST, id ASC`,
        [new Date().toISOString()],
    );
    assert.deepStrictEqual(due.rows.map(r => r.id), ['tbl_other', 'tbl_nc', 'tbl_ss'], 'both kinds, never-run first, a running one skipped');
});

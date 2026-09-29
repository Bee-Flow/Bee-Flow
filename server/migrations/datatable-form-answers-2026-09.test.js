'use strict';

/**
 * The form-answers migration, against a REAL Postgres: the genuine `up()` on
 * pglite, twice (the second run changes nothing), then the one query the
 * store asks — with the kind INLINED, as the store does.
 *
 * Run: cd server && node --test migrations/datatable-form-answers-2026-09.test.js
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

const { up } = require('./datatable-form-answers-2026-09');

before(async () => {
    await pg.exec(`CREATE TABLE datatables (id TEXT PRIMARY KEY, organization_id TEXT, managed_kind TEXT, source JSONB, sync_state JSONB, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pg.exec(`INSERT INTO datatables (id, organization_id, managed_kind) VALUES ('tbl_a', 'org', NULL)`);
});
after(async () => { await pg.close(); });

test('adds the partial index, and is idempotent', async () => {
    await up();
    await up();
    const idx = await rawQuery(`SELECT indexname FROM pg_indexes WHERE tablename = 'datatables' ORDER BY indexname`);
    assert.ok(idx.rows.some(r => r.indexname === 'idx_datatables_form_answers_automation'));
    const row = await rawQuery(`SELECT source FROM datatables WHERE id = 'tbl_a'`);
    assert.strictEqual(row.rows[0].source, null);
});

test('"which table holds the answers to routine X" is answerable, oldest first', async () => {
    await pg.exec(`INSERT INTO datatables (id, organization_id, managed_kind, source, created_at) VALUES
        ('tbl_f2', 'org', 'form_answers', '{"automationId": "auto_1", "linked": false}', '2026-02-01'),
        ('tbl_f1', 'org', 'form_answers', '{"automationId": "auto_1", "linked": true}', '2026-01-01'),
        ('tbl_other', 'org', 'form_answers', '{"automationId": "auto_9"}', '2026-01-01'),
        ('tbl_nc', 'org', 'nextcloud_table', '{"ncTableId": 4, "automationId": "auto_1"}', '2026-01-01')`);
    const r = await rawQuery(
        `SELECT id FROM datatables WHERE managed_kind = 'form_answers' AND source->>'automationId' = $1 ORDER BY created_at ASC`,
        ['auto_1'],
    );
    assert.deepStrictEqual(r.rows.map(x => x.id), ['tbl_f1', 'tbl_f2']);
    const many = await rawQuery(
        `SELECT id FROM datatables WHERE managed_kind = 'form_answers' AND source->>'automationId' = ANY($1::text[]) ORDER BY created_at ASC`,
        [['auto_1', 'auto_9']],
    );
    assert.deepStrictEqual(many.rows.map(x => x.id).sort(), ['tbl_f1', 'tbl_f2', 'tbl_other']);
});

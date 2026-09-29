/**
 * A3 grandfather — existing orgs are stamped explicitly OFF, and a set flag
 * is never clobbered. Proven against real Postgres (@electric-sql/pglite
 * behind the db.js facade), not a string mock.
 *
 * Under test:
 *   - --dry-run writes nothing;
 *   - every org without a row gets {required:false} — which the reader
 *     normalises to false, i.e. the grandfather IS the default-off state;
 *   - ON CONFLICT DO NOTHING: an org whose duty was already set (on) keeps
 *     it, byte for byte, across every later boot;
 *   - a second run is a no-op;
 *   - the key prefix literal matches the reader module (drift guard).
 *
 * Run: cd server && node --test --test-force-exit migrations/org-mfa-required-2026-09.integration.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.join(__dirname, '..');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adaptResult(res) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const rowCount = (r.fields || []).length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, rowCount };
}
async function rawQuery(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params));
    return adaptResult(await pg.query(sql));
}
const dbPath = path.join(SERVER, 'db.js');
const m = new Module(dbPath);
m.exports = {
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql),
};
m.loaded = true;
require.cache[dbPath] = m;

const { up, CONFIG_KEY_PREFIX } = require('./org-mfa-required-2026-09');

const configRows = async () => {
    const r = await rawQuery(`SELECT key, value FROM config ORDER BY key`);
    return r.rows.map((x) => [x.key, x.value]);
};

before(async () => {
    await pg.exec(`
        CREATE TABLE organizations (id TEXT PRIMARY KEY);
        CREATE TABLE config (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await pg.query(`INSERT INTO organizations (id) VALUES ('org-1'), ('org-2')`);
    // org-2's duty was already switched ON before this ladder ran — the
    // exact row the grandfather must never touch.
    await pg.query(`INSERT INTO config (key, value) VALUES ($1, $2)`,
        [`${CONFIG_KEY_PREFIX}org-2`, JSON.stringify({ required: true, updatedBy: 'admin' })]);
});

test('registered in LOOSE_MIGRATIONS and the prefix matches the reader module', () => {
    const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');
    assert.ok(LOOSE_MIGRATIONS.includes('org-mfa-required-2026-09'),
        'an unregistered migration never runs (U6 duty)');
    const reader = fs.readFileSync(path.join(SERVER, 'core', 'entitlements', 'orgMfaRequired.js'), 'utf8');
    const rm = reader.match(/CONFIG_KEY_PREFIX = '([^']+)'/);
    assert.ok(rm, 'reader prefix literal not found');
    assert.strictEqual(CONFIG_KEY_PREFIX, rm[1],
        'migration and reader must stamp/read the same key family');
});

test('--dry-run reports but writes nothing', async () => {
    const beforeRows = await configRows();
    const n = await up({ dryRun: true });
    assert.strictEqual(n, 1, 'exactly org-1 lacks a row');
    assert.deepStrictEqual(await configRows(), beforeRows);
});

test('existing orgs get an explicit OFF row; a set flag is never clobbered', async () => {
    const n = await up();
    assert.strictEqual(n, 1);
    const rows = Object.fromEntries(await configRows());
    const stamped = JSON.parse(rows[`${CONFIG_KEY_PREFIX}org-1`]);
    assert.strictEqual(stamped.required, false, 'the grandfather stamps the default-off state, never on');
    assert.match(stamped.updatedBy, /^migration:/);
    // The reader normalises the stamped row to exactly the missing-value
    // default — grandfathered orgs behave as if never configured.
    const norm = fs.readFileSync(path.join(SERVER, 'core', 'entitlements', 'orgMfaRequired.js'), 'utf8');
    assert.match(norm, /stored\.required === true/, 'reader treats only explicit true as on');
    assert.deepStrictEqual(JSON.parse(rows[`${CONFIG_KEY_PREFIX}org-2`]),
        { required: true, updatedBy: 'admin' },
        'ON CONFLICT DO NOTHING must leave the admin-set duty untouched');
});

test('a second run is a byte-identical no-op', async () => {
    const beforeRows = await configRows();
    const n = await up();
    assert.strictEqual(n, 0);
    assert.deepStrictEqual(await configRows(), beforeRows);
});

test('an org created later is stamped off at the next tick — same as the reader default', async () => {
    await pg.query(`INSERT INTO organizations (id) VALUES ('org-3')`);
    const n = await up();
    assert.strictEqual(n, 1);
    const rows = Object.fromEntries(await configRows());
    assert.strictEqual(JSON.parse(rows[`${CONFIG_KEY_PREFIX}org-3`]).required, false,
        'a creation-time ON write would survive (row exists ⇒ DO NOTHING); absent that, off is stamped');
});

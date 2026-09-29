/**
 * Grant-grandfather for USER_FACING_CORE growth — proven against real
 * Postgres (@electric-sql/pglite behind the db.js facade, same seam as
 * migrateDb.integration.test.js), not a string mock.
 *
 * The properties under test:
 *   - --dry-run writes nothing (org rows AND marker);
 *   - an existing org keeps EXACTLY what it had, plus the new id — including
 *     an org that deliberately toggled a LEGACY id off (never resurrected);
 *   - a second run is a byte-identical no-op;
 *   - after the marker, an admin's toggle-off of the NEW id is respected by
 *     every later boot (the every-boot ladder must not fight the admin);
 *   - an org created after the grandfather is NOT auto-granted (new rows rely
 *     on the column DEFAULT, per stores/user/schema.js).
 *
 * The registry is mocked with one extra id ('x_test_capability') because
 * TODAY the real USER_FACING_CORE equals the seeded trio — the final test
 * pins that, which makes the migration a deliberate no-op in production
 * until the set actually grows.
 *
 * Run: cd server && node --test --test-force-exit migrations/org-granted-capabilities-2026-09.integration.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.join(__dirname, '..');

// ── pglite behind the db.js facade ─────────────────────────────────────────
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

function mock(absPath, exportsObj) {
    const m = new Module(absPath);
    m.exports = exportsObj;
    m.loaded = true;
    require.cache[absPath] = m;
}

mock(path.join(SERVER, 'db.js'), {
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql),
});

// The registry with one id beyond the seeded trio, to exercise the mechanism.
const TRIO = ['notebooks', 'projects', 'component_designer'];
const NEW_ID = 'x_test_capability';
mock(path.join(SERVER, 'core', 'entitlements', 'capabilityRegistry.js'), {
    USER_FACING_CORE: new Set([...TRIO, NEW_ID]),
});

const { up, newUserFacingCoreIds, SEEDED_DEFAULTS, MARKER_PREFIX } = require('./org-granted-capabilities-2026-09');
const SRC = fs.readFileSync(path.join(__dirname, 'org-granted-capabilities-2026-09.js'), 'utf8');

const grants = async () => {
    const r = await rawQuery(`SELECT id, "org_granted_capabilities" AS g FROM organizations ORDER BY id`);
    return r.rows.map((x) => [x.id, JSON.parse(x.g ?? 'null')]);
};
const markers = async () => (await rawQuery(`SELECT key FROM config ORDER BY key`)).rows.map((x) => x.key);

before(async () => {
    await pg.exec(`
        CREATE TABLE organizations (
            id TEXT PRIMARY KEY,
            "org_granted_capabilities" TEXT DEFAULT '["notebooks","projects","component_designer"]'
        );
        CREATE TABLE config (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    // org-a toggled component_designer OFF on purpose; org-b holds the default
    // trio; org-c/org-d are the '[]'/NULL shapes the schema backfill still owes
    // a seed (stores run before this migration in every real ladder).
    await pg.query(`INSERT INTO organizations (id, "org_granted_capabilities") VALUES
        ('org-a', '["notebooks","projects"]'),
        ('org-b', '["notebooks","projects","component_designer"]'),
        ('org-c', '[]'),
        ('org-d', NULL)`);
});

test('registered in LOOSE_MIGRATIONS, exports up(), and reads the REAL registry export', () => {
    const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');
    assert.ok(LOOSE_MIGRATIONS.includes('org-granted-capabilities-2026-09'),
        'an unregistered migration never runs (U6 duty)');
    assert.strictEqual(typeof up, 'function');
    assert.match(SRC, /require\.main === module/, 'runnable standalone for the checklist dry-run');
    // The real registry must actually export the set this migration reads —
    // proven on SOURCE because the module is mocked in this process.
    const reg = fs.readFileSync(path.join(SERVER, 'core', 'entitlements', 'capabilityRegistry.js'), 'utf8');
    assert.match(reg, /USER_FACING_CORE,\s*\n\};|USER_FACING_CORE,\n/, 'capabilityRegistry must export USER_FACING_CORE');
    assert.match(reg, /module\.exports\s*=\s*\{[\s\S]*USER_FACING_CORE,[\s\S]*?\};/);
});

test('--dry-run reports but writes nothing — no grants, no marker', async () => {
    const beforeGrants = await grants();
    const res = await up({ dryRun: true });
    assert.deepStrictEqual(res.ids, [NEW_ID]);
    assert.ok(res.appended >= 4, 'dry-run should have counted every org it would touch');
    assert.deepStrictEqual(await grants(), beforeGrants, 'dry-run must not change org rows');
    assert.deepStrictEqual(await markers(), [], 'dry-run must not write the marker either — the real run still has to happen');
});

test('an existing org keeps exactly what it had, plus the new id', async () => {
    await up();
    assert.deepStrictEqual(await grants(), [
        // The deliberate toggle-off of component_designer is NOT resurrected.
        ['org-a', ['notebooks', 'projects', NEW_ID]],
        ['org-b', [...TRIO, NEW_ID]],
        // '[]'/NULL rows keep their pending trio seed alongside the new id.
        ['org-c', [...TRIO, NEW_ID]],
        ['org-d', [...TRIO, NEW_ID]],
    ]);
    assert.deepStrictEqual(await markers(), [`${MARKER_PREFIX}${NEW_ID}`]);
});

test('a second run is a byte-identical no-op', async () => {
    const beforeGrants = await grants();
    const beforeMarkers = await markers();
    const res = await up();
    assert.strictEqual(res.appended, 0);
    assert.deepStrictEqual(await grants(), beforeGrants);
    assert.deepStrictEqual(await markers(), beforeMarkers);
});

test("after the marker, an admin's toggle-off of the new id survives every later boot", async () => {
    await pg.query(`UPDATE organizations SET "org_granted_capabilities" = $1 WHERE id = 'org-a'`,
        [JSON.stringify(['notebooks', 'projects'])]);
    await up();
    const rows = await grants();
    assert.deepStrictEqual(rows.find(([id]) => id === 'org-a')[1], ['notebooks', 'projects'],
        'a marker-bounded grandfather must never fight the org-admin');
});

test('an org created after the grandfather is not auto-granted', async () => {
    await pg.query(`INSERT INTO organizations (id) VALUES ('org-late')`);
    await up();
    const rows = await grants();
    assert.deepStrictEqual(rows.find(([id]) => id === 'org-late')[1], TRIO,
        'new rows get the column DEFAULT; the grandfather is for orgs that predate the toggle');
});

test('today the real registry equals the seeded trio — production run is a no-op by design', () => {
    // Extract the literal from the real source (the in-process module is mocked).
    const reg = fs.readFileSync(path.join(SERVER, 'core', 'entitlements', 'capabilityRegistry.js'), 'utf8');
    const m = reg.match(/const USER_FACING_CORE = new Set\(\[([^\]]*)\]\)/);
    assert.ok(m, 'USER_FACING_CORE literal not found');
    const ids = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    assert.deepStrictEqual(ids, [...SEEDED_DEFAULTS].sort(),
        'USER_FACING_CORE grew — that is fine, but it makes this migration LIVE: ' +
        'update stores/user/schema.js (column DEFAULT + backfill trio) and the release checklist (U10), ' +
        'then update this pin to the new set');
    // And the derived "new ids" logic sees the mocked growth.
    assert.deepStrictEqual(newUserFacingCoreIds(), [NEW_ID]);
});

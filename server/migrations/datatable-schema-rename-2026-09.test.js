'use strict';

/**
 * The `dtorg_<orgId>` → `dt_<sha256…>` schema rename, against a REAL Postgres.
 *
 * This migration runs ALTER SCHEMA on live customer data at boot, so a source
 * regex is not enough: the questions that matter are whether the rows survive,
 * whether a second run is a no-op and whether the half-failed state is left
 * alone rather than "cleaned up". Only a database can answer those.
 *
 * @electric-sql/pglite is already a devDependency and already the harness under
 * stores/lib/pgAppEngine.test.js, so this suite ALWAYS runs — no container, no
 * self-skip. The seam is db.js, stubbed through require.cache before the
 * migration (and datatableDbStore, which it reads the naming rule from) loads.
 *
 * Run: cd server && node --test --test-force-exit migrations/datatable-schema-rename-2026-09.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..');

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

// pglite is ONE connection, so every "client" is that connection and these
// tests must stay sequential — two overlapping transactions would interleave.
const client = { query: (sql, params) => rawQuery(sql, params), release: () => {} };

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

mock(path.join(SERVER, 'db.js'), {
    pool: { query: rawQuery, connect: async () => client },
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql, []),
    getClient: async () => client,
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
    getRedis: () => null,
    redisHealthy: () => false,
    isSqlStateError: (e) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code),
});

const { up } = require('./datatable-schema-rename-2026-09');
const { schemaNameFor, LEGACY_ORG_PREFIX } = require('../stores/datatableDbStore');

const legacyOf = (orgId) => LEGACY_ORG_PREFIX + orgId;
const hashedOf = (orgId) => schemaNameFor('org', orgId);

/** Does this schema exist? to_regnamespace is null rather than an error. */
async function schemaExists(name) {
    const res = await rawQuery(`SELECT to_regnamespace($1) IS NOT NULL AS ok`, [`"${name}"`]);
    return !!res.rows[0].ok;
}

/** A tenant with one table and one row, under the given schema name. */
async function seedTenant(orgId, schemaName, note) {
    await rawQuery(`INSERT INTO datatable_models (organization_id, model, model_version) VALUES ($1, $2::jsonb, 1)`,
        [orgId, JSON.stringify({ modelVersion: 1, tables: [] })]);
    await rawQuery(`CREATE SCHEMA "${schemaName}"`);
    await rawQuery(`CREATE TABLE "${schemaName}"."customers" (id TEXT PRIMARY KEY, note TEXT)`);
    await rawQuery(`INSERT INTO "${schemaName}"."customers" (id, note) VALUES ($1, $2)`, ['rec_1', note]);
}

/** Rows straight out of a named schema — the ground truth the rename must keep. */
async function notesIn(schemaName) {
    const res = await rawQuery(`SELECT note FROM "${schemaName}"."customers" ORDER BY id`);
    return res.rows.map(r => r.note);
}

// The three tenants, each in a different starting state.
const RENAMED = 'org-to-rename';
const BOTH = 'org-half-failed';
const NO_SCHEMA = 'org-without-rows';

before(async () => {
    await rawQuery(`CREATE TABLE datatable_models (
        organization_id TEXT PRIMARY KEY, model JSONB, model_version INTEGER)`);
    await seedTenant(RENAMED, legacyOf(RENAMED), 'the rows that must survive');
    // The half-failed state: rows under BOTH names. Nothing may be dropped.
    await seedTenant(BOTH, legacyOf(BOTH), 'legacy copy');
    await rawQuery(`CREATE SCHEMA "${hashedOf(BOTH)}"`);
    await rawQuery(`CREATE TABLE "${hashedOf(BOTH)}"."customers" (id TEXT PRIMARY KEY, note TEXT)`);
    await rawQuery(`INSERT INTO "${hashedOf(BOTH)}"."customers" (id, note) VALUES ($1, $2)`, ['rec_1', 'hashed copy']);
    // A model row whose org never created a schema — an org that opened Studio
    // and made no table.
    await rawQuery(`INSERT INTO datatable_models (organization_id, model, model_version) VALUES ($1, $2::jsonb, 1)`,
        [NO_SCHEMA, JSON.stringify({ modelVersion: 1, tables: [] })]);
});

after(async () => { await pg.close(); });

test('the legacy schema is renamed and every row comes with it', async () => {
    assert.ok(await schemaExists(legacyOf(RENAMED)), 'the pre-state has to be real, or this proves nothing');

    const warnings = captureConsole();
    try { await up(); } finally { warnings.restore(); }

    assert.strictEqual(await schemaExists(legacyOf(RENAMED)), false, 'the old name must be gone');
    assert.ok(await schemaExists(hashedOf(RENAMED)));
    // ALTER SCHEMA rewrites one catalog row and moves no bytes — assert that
    // rather than trust it, because the failure mode is an empty tenant.
    assert.deepStrictEqual(await notesIn(hashedOf(RENAMED)), ['the rows that must survive']);
});

test('a second run is a no-op — the guard is what makes it idempotent', async () => {
    const warnings = captureConsole();
    try { await up(); } finally { warnings.restore(); }

    assert.ok(await schemaExists(hashedOf(RENAMED)));
    assert.deepStrictEqual(await notesIn(hashedOf(RENAMED)), ['the rows that must survive']);
});

test('a tenant with BOTH names is left exactly as it is, and says so', async () => {
    // This is an orphan, not "already done": dropping either side would be
    // destroying rows nobody has looked at yet. The scan script is the fix.
    assert.ok(await schemaExists(legacyOf(BOTH)));
    assert.ok(await schemaExists(hashedOf(BOTH)));
    assert.deepStrictEqual(await notesIn(legacyOf(BOTH)), ['legacy copy']);
    assert.deepStrictEqual(await notesIn(hashedOf(BOTH)), ['hashed copy']);

    const warnings = captureConsole();
    try { await up(); } finally { warnings.restore(); }

    assert.deepStrictEqual(await notesIn(legacyOf(BOTH)), ['legacy copy'], 'the legacy rows must not be touched');
    assert.deepStrictEqual(await notesIn(hashedOf(BOTH)), ['hashed copy']);
    assert.ok(warnings.warned.some(m => /BOTH/.test(m) && new RegExp(BOTH).test(m)),
        'a silent orphan is one nobody ever merges');
});

test('an org with a model row but no schema is left alone, and does not fail the run', async () => {
    assert.strictEqual(await schemaExists(legacyOf(NO_SCHEMA)), false);
    assert.strictEqual(await schemaExists(hashedOf(NO_SCHEMA)), false,
        'the migration must never CREATE a schema — that is how an empty tenant is manufactured');
});

test('one tenant that cannot be renamed does not hold back the others', async () => {
    // A schema whose name is taken by something that is NOT a schema is the
    // stand-in for "this one ALTER fails". Every other tenant must still move,
    // because the alternative is a migration that gives up half-way.
    const BROKEN = 'org-that-throws';
    const LATE = 'org-behind-it';
    await seedTenant(BROKEN, legacyOf(BROKEN), 'broken');
    await seedTenant(LATE, legacyOf(LATE), 'behind the broken one');
    // Occupy the target name with a TABLE, so ALTER SCHEMA … RENAME TO fails.
    await rawQuery(`CREATE SCHEMA "${hashedOf(BROKEN)}"`);
    await rawQuery(`CREATE TABLE "${hashedOf(BROKEN)}"."squatter" (id TEXT)`);

    const warnings = captureConsole();
    try { await up(); } finally { warnings.restore(); }

    assert.ok(await schemaExists(hashedOf(LATE)), 'the tenant after the failure must still be renamed');
    assert.deepStrictEqual(await notesIn(hashedOf(LATE)), ['behind the broken one']);
    assert.deepStrictEqual(await notesIn(legacyOf(BROKEN)), ['broken'],
        'and the failing tenant keeps its rows under the name the fallback still resolves');
});

test('a fresh install with no datatable tables at all returns quietly', async () => {
    // The migration ladder runs on an empty database too. `SELECT … FROM
    // datatable_models` would abort the whole ladder there.
    await rawQuery('DROP TABLE datatable_models');
    const warnings = captureConsole();
    try {
        await up();
    } finally { warnings.restore(); }
    assert.deepStrictEqual(warnings.errored, []);
});

test('the migration is registered BEFORE the field-id repair, so it actually runs at boot', () => {
    const core = fs.readFileSync(path.join(SERVER, 'stores', 'automationStore', 'core.js'), 'utf8');
    assert.match(core, /'datatable-schema-rename-2026-09'/);
    // Order is load-bearing: datatable-field-ids runs real DDL through the
    // engine, and it should land in the schema this one leaves behind rather
    // than through the legacy-name fallback.
    assert.ok(core.indexOf("'datatable-schema-rename-2026-09'") < core.indexOf("'datatable-field-ids-2026-09'"));
});

/** Collect console output instead of printing it, and hand it back. */
function captureConsole() {
    const warned = [];
    const errored = [];
    const logged = [];
    const w = console.warn, e = console.error, l = console.log;
    console.warn = (...a) => warned.push(a.join(' '));
    console.error = (...a) => errored.push(a.join(' '));
    console.log = (...a) => logged.push(a.join(' '));
    return {
        warned, errored, logged,
        restore() { console.warn = w; console.error = e; console.log = l; },
    };
}

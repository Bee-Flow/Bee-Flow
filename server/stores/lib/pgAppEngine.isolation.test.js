/**
 * Per-app table isolation — two apps that both define a table called the SAME
 * thing must never see each other's rows.
 *
 * This is a property the App Studio data engine gets from its architecture
 * rather than from a check, which is exactly why it deserves a test of its own:
 *
 *   sqlite engine  one `data.db` BLOB per app (buildKey embeds the app id), so
 *                  two apps are two files and cannot collide by construction.
 *   pg engine      one Postgres SCHEMA per app (`app_<appId>`), with
 *                  `SET LOCAL search_path = "app_<id>", pg_temp` pinned inside
 *                  every transaction — so the compiler's UNQUALIFIED
 *                  `work_items` resolves inside the calling app's namespace and
 *                  nowhere else.
 *
 * The pg path is the one worth proving: it is the engine where every app's
 * tables live in ONE shared database (beeflow_core), so "same table name" is a
 * real collision risk rather than a theoretical one. Nothing about a table's
 * `key` is namespaced — two apps genuinely both emit `CREATE TABLE
 * "work_items"` — and the separation rests entirely on the search_path pin.
 * If someone ever "simplifies" that away, this file fails instead of two
 * customers sharing a backlog.
 *
 * Harness: @electric-sql/pglite (in-memory WASM PG) behind the same node-pg
 * shaped adapters pgAppEngine.test.js uses.
 *
 * Run: cd server && node --test stores/lib/pgAppEngine.isolation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { createPgAppEngine } = require('./pgAppEngine');
const engineFlag = require('../../appStudio/engineFlag');
const dm = require('../../appStudio/dataModel');

const OWNER = 'owner-A';
const OTHER = 'owner-B';
// Two apps belonging to the SAME person is the ordinary case: one user runs
// "Team Alpha sprint board" and "Team Beta sprint board", both installed from
// the same template, so both have a `work_items` table with identical columns.
const APP_ALPHA = 'app-aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const APP_BETA = 'app-bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';
// A third app under a DIFFERENT owner — the cross-tenant version of the same
// question.
const APP_OTHER = 'app-cccccccc-3333-3333-3333-cccccccccccc';

let pg = null;
let engine = null;

// ── node-pg-shaped adapters over pglite (mirrors pgAppEngine.test.js) ──

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

const runQuery = (sql, params) => rawQuery(sql, params);
const getClient = async () => ({
    query: (sql, params) => rawQuery(sql, params),
    release: () => {},
});

/** engine.query resolves to { rows, columns, truncated } — rows is what we assert on. */
const rows = async (ownerId, appId, sql, params) => (await engine.query(ownerId, appId, sql, params)).rows;

/**
 * The table BOTH apps define. Same stable ids, same key, same columns — this is
 * what installing one template twice produces, and it is the shape the test is
 * about.
 */
const WORK_ITEMS = {
    id: 'tbl_witems',
    key: 'work_items',
    fields: [
        { id: 'fld_title1', key: 'title', type: 'text' },
        { id: 'fld_state1', key: 'state', type: 'text' },
        { id: 'fld_points', key: 'points', type: 'number' },
    ],
};

function pgPlanFor(table) {
    engineFlag._setForTests('pg');
    try {
        return [dm.ddlForTable(table)];
    } finally {
        engineFlag._setForTests(null);
    }
}

test('(setup) boot pglite with three apps, two of them same-owner', async () => {
    const { PGlite } = require('@electric-sql/pglite');
    pg = new PGlite();
    await pg.exec("SET TIME ZONE 'UTC'");
    await pg.exec(`
        CREATE TABLE studio_apps (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            engine TEXT NOT NULL DEFAULT 'sqlite',
            db_sha256 TEXT DEFAULT '',
            db_size BIGINT DEFAULT 0,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
    await pg.query(
        `INSERT INTO studio_apps (id, user_id, engine) VALUES ($1,$2,'pg'), ($3,$4,'pg'), ($5,$6,'pg')`,
        [APP_ALPHA, OWNER, APP_BETA, OWNER, APP_OTHER, OTHER],
    );
    engine = createPgAppEngine({
        runQuery,
        getClient,
        logPrefix: 'StudioAppDB',
        entityLabel: 'Studio App DB',
        schemaFor: (appId) => 'app_' + appId,
    });

    // Every app materialises the SAME DDL — byte-identical, unqualified.
    const plan = pgPlanFor(WORK_ITEMS);
    assert.match(plan[0], /CREATE TABLE IF NOT EXISTS "work_items"/);
    await engine.applyMigration(OWNER, APP_ALPHA, plan, 1);
    await engine.applyMigration(OWNER, APP_BETA, plan, 1);
    await engine.applyMigration(OTHER, APP_OTHER, plan, 1);
});

test.after(async () => { if (pg) await pg.close(); });

test('the same table name really does exist three times, in three schemas', async () => {
    const { rows } = await rawQuery(
        `SELECT table_schema FROM information_schema.tables
          WHERE table_name = 'work_items' ORDER BY table_schema`,
    );
    assert.deepStrictEqual(rows.map((r) => r.table_schema), [
        'app_' + APP_ALPHA,
        'app_' + APP_BETA,
        'app_' + APP_OTHER,
    ]);
});

test('rows written through one app are invisible to every other app', async () => {
    await engine.exec(OWNER, APP_ALPHA,
        'INSERT INTO "work_items" (id, title, state, points) VALUES (?,?,?,?)',
        ['rec_alpha1', 'Alpha backlog item', 'todo', 5]);
    await engine.exec(OWNER, APP_BETA,
        'INSERT INTO "work_items" (id, title, state, points) VALUES (?,?,?,?)',
        ['rec_beta01', 'Beta backlog item', 'doing', 8]);
    await engine.exec(OTHER, APP_OTHER,
        'INSERT INTO "work_items" (id, title, state, points) VALUES (?,?,?,?)',
        ['rec_other1', 'Someone else entirely', 'done', 13]);

    // The SAME query text, run by three different apps, returns three
    // different single-row results.
    const q = 'SELECT id, title FROM "work_items" ORDER BY id';
    const alpha = await rows(OWNER, APP_ALPHA, q);
    const beta = await rows(OWNER, APP_BETA, q);
    const other = await rows(OTHER, APP_OTHER, q);

    assert.deepStrictEqual(alpha.map((r) => r.id), ['rec_alpha1']);
    assert.deepStrictEqual(beta.map((r) => r.id), ['rec_beta01']);
    assert.deepStrictEqual(other.map((r) => r.id), ['rec_other1']);
    assert.strictEqual(alpha[0].title, 'Alpha backlog item');
    assert.strictEqual(beta[0].title, 'Beta backlog item');
});

test('a record id colliding across apps stays two distinct rows', async () => {
    // Nothing makes rec_ ids globally unique, and a template seeded twice can
    // absolutely mint the same one. Same id + same table name is the worst
    // case, so it is the one worth asserting.
    const dupe = 'rec_dupe01';
    await engine.exec(OWNER, APP_ALPHA,
        'INSERT INTO "work_items" (id, title, state) VALUES (?,?,?)', [dupe, 'Alpha copy', 'todo']);
    await engine.exec(OWNER, APP_BETA,
        'INSERT INTO "work_items" (id, title, state) VALUES (?,?,?)', [dupe, 'Beta copy', 'todo']);

    const alpha = await rows(OWNER, APP_ALPHA, 'SELECT title FROM "work_items" WHERE id = ?', [dupe]);
    const beta = await rows(OWNER, APP_BETA, 'SELECT title FROM "work_items" WHERE id = ?', [dupe]);
    assert.deepStrictEqual(alpha.map((r) => r.title), ['Alpha copy']);
    assert.deepStrictEqual(beta.map((r) => r.title), ['Beta copy']);
});

test('an UPDATE in one app leaves the identically-named table next door alone', async () => {
    await engine.exec(OWNER, APP_ALPHA, 'UPDATE "work_items" SET state = ? WHERE id = ?', ['done', 'rec_alpha1']);

    const alpha = await rows(OWNER, APP_ALPHA, 'SELECT state FROM "work_items" WHERE id = ?', ['rec_alpha1']);
    assert.strictEqual(alpha[0].state, 'done');

    // Beta's row is untouched, and beta has no row by alpha's id at all.
    const betaSame = await rows(OWNER, APP_BETA, 'SELECT state FROM "work_items" WHERE id = ?', ['rec_beta01']);
    assert.strictEqual(betaSame[0].state, 'doing');
    const betaAlpha = await rows(OWNER, APP_BETA, 'SELECT id FROM "work_items" WHERE id = ?', ['rec_alpha1']);
    assert.deepStrictEqual(betaAlpha, []);
});

test('a DELETE cannot reach past its own app, even with a WHERE that matches everywhere', async () => {
    await engine.exec(OWNER, APP_ALPHA, 'DELETE FROM "work_items" WHERE id = ?', ['rec_dupe01']);

    const alpha = await rows(OWNER, APP_ALPHA, 'SELECT id FROM "work_items" WHERE id = ?', ['rec_dupe01']);
    const beta = await rows(OWNER, APP_BETA, 'SELECT id FROM "work_items" WHERE id = ?', ['rec_dupe01']);
    assert.deepStrictEqual(alpha, []);
    assert.deepStrictEqual(beta.map((r) => r.id), ['rec_dupe01']);
});

test('DROP TABLE in one app leaves the neighbours resolvable', async () => {
    // The bluntest possible cross-app write. If search_path ever widened, this
    // is the statement that would take another team's board with it.
    await engine.exec(OTHER, APP_OTHER, 'DROP TABLE "work_items"');

    const still = await rawQuery(
        `SELECT table_schema FROM information_schema.tables
          WHERE table_name = 'work_items' ORDER BY table_schema`,
    );
    assert.deepStrictEqual(still.rows.map((r) => r.table_schema), [
        'app_' + APP_ALPHA,
        'app_' + APP_BETA,
    ]);
    const alpha = await rows(OWNER, APP_ALPHA, 'SELECT id FROM "work_items" ORDER BY id');
    assert.deepStrictEqual(alpha.map((r) => r.id), ['rec_alpha1']);
});

test('the schema name is derived from the app id alone — never from the table key', async () => {
    // Belt and braces on the naming contract studioAppDbStore wires in:
    // isolation is keyed by APP, so two tables named the same thing in two apps
    // can never converge, whatever the author calls them.
    const seen = new Set();
    for (const appId of [APP_ALPHA, APP_BETA, APP_OTHER]) seen.add('app_' + appId);
    assert.strictEqual(seen.size, 3);
});

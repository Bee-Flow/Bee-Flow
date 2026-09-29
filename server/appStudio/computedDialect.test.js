/**
 * Stored computed columns must survive the dialect — proven by EXECUTING the
 * real template's DDL on a real Postgres (@electric-sql/pglite).
 *
 * The bug this pins: the SQLite → PG translation lived only in the one-off
 * migration script, so a migrated app was correct while a FRESH INSTALL of the
 * same template on the Postgres engine emitted `char(59)` into the generated
 * column and failed at CREATE TABLE. Nothing caught it, because every existing
 * test either ran on SQLite or ran the migrator.
 *
 * Run: cd server && node --test appStudio/computedDialect.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { translateComputedExpr, computedExprFor } = require('./computedDialect');

// ── The pure translation ────────────────────────────────────────────
test('char(n) becomes chr(n), and a char TYPE is left alone', () => {
    assert.equal(translateComputedExpr("a || char(59) || b"), 'a || chr(59) || b');
    assert.equal(translateComputedExpr("char(10) || char( 9 )"), 'chr(10) || chr(9)');
    // `CAST(x AS char(10))` is a type, not a call. Rewriting it to chr(10)
    // would silently replace the value with a tab-ish character.
    assert.equal(
        translateComputedExpr("CAST(code AS char(10))"),
        'CAST(code AS char(10))',
        'a char TYPE must not be rewritten',
    );
});

test('the REAL-trimming idiom becomes trim_scale', () => {
    assert.equal(
        translateComputedExpr("rtrim(rtrim(CAST(qty AS TEXT),'0'),'.')"),
        'trim_scale("qty")::text',
    );
});

test('portable SQL passes through untouched', () => {
    for (const expr of [
        'lower(name)',
        "COALESCE(a,'') || COALESCE(b,'')",
        "CASE WHEN qty IS NULL THEN 'incomplete' ELSE 'ok' END",
        'length_mm * width_mm / 1000000.0',
    ]) {
        assert.equal(translateComputedExpr(expr), expr, expr);
    }
});

test('computedExprFor only translates for pg', () => {
    const expr = "a || char(59) || b";
    assert.equal(computedExprFor(expr, 'sqlite'), expr, 'sqlite is the identity');
    assert.equal(computedExprFor(expr, 'pg'), 'a || chr(59) || b');
});

// ── The real template, executed on a real Postgres ──────────────────
test('the quote-intake model materialises on Postgres and computes correctly', async (t) => {
    // The flag is process-wide; node --test isolates processes, and this file
    // asserts nothing about the sqlite path beyond the pure functions above.
    const engineFlag = require('./engineFlag');
    engineFlag._setForTests('pg');

    const { canonicalizeDataModel, ddlForTable } = require('./dataModel');
    const { getTemplate } = require('./templates');

    const { model } = canonicalizeDataModel(getTemplate('app-quote-intake').dataModel);
    const lines = model.tables.find((x) => x.key === 'projectregels');
    assert.ok(lines, 'the projectlines table exists');
    assert.ok(lines.fields.some((f) => f.type === 'computed' && f.computed.stored),
        'and carries at least one stored computed column');

    let db;
    try {
        const { PGlite } = require('@electric-sql/pglite');
        db = new PGlite();
        await db.exec("SET TIME ZONE 'UTC'");
    } catch (e) {
        t.skip(`pglite unavailable: ${e.message}`);
        return;
    }

    const keyById = new Map(model.tables.map((tb) => [tb.id, tb.key]));
    // Every table, not just the interesting one: a template that cannot create
    // its schema is broken whichever table refuses.
    for (const table of model.tables) {
        await db.exec(ddlForTable(table, { tableKeyById: keyById }));
    }

    // The portal CSV is no longer a computed column (generate_file renders the
    // real file from the Portal-format table), so the template's remaining
    // stored computed column is regel_check — portable SQL by design. The
    // translated idioms (char(59), the rtrim pair) keep their own fixtures in
    // the pure tests above; this proves the whole model still MATERIALISES on
    // PG and that a non-translated expression computes correctly.
    await db.query(
        `INSERT INTO "projectregels" (id, created_by, pos, basisnaam, cad_bestand, aantal, materiaal, dikte_mm, nabewerking, op_count_1, bron_bestand, opmerking)
         VALUES ('rec_x', 'u1', 1, 'mw2604-01', 'MW2604-01.step', 4, 'RVS 304', 11, 'tappen', 6, 'MW2604-01.pdf', '')`,
    );
    const { rows } = await db.query('SELECT * FROM "projectregels" WHERE id = $1', ['rec_x']);
    assert.equal(rows[0].regel_check, 'ok', 'a complete line passes its own check');

    await db.query(
        `INSERT INTO "projectregels" (id, created_by, aantal, materiaal) VALUES ('rec_y', 'u1', 2, 'RVS 304')`,
    );
    const short = (await db.query('SELECT * FROM "projectregels" WHERE id = $1', ['rec_y'])).rows[0];
    assert.equal(short.regel_check, 'incomplete', 'a line without a CAD file or thickness is flagged');
});

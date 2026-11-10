/**
 * Changing the data model while the table holds rows, on Postgres (PGlite):
 * planMigration's statements and probes through the real per-app engine
 * (stores/lib/pgAppEngine applyMigration).
 *
 *   • spec: a stored computed field with a new expression gives the new value
 *     for every existing row (DROP + ADD … STORED inside the transaction);
 *   • ALTER COLUMN TYPE … USING for the safe pairs, with a dependent stored
 *     computed field dropped first and re-added after;
 *   • a refusing probe rolls the whole plan back; clear mode empties the values;
 *   • a failing statement keeps its plan index and SQLSTATE (1/0 → 22012).
 *
 * Run: cd server && node --test core/dataEngine/dataModel/fieldConversion.pglite.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { usePgAppEngine } = require('../../../testUtils/pgAppEngine.testkit');
const { planMigration, migrationPlan } = require('./migrationPlan');
const { migrationFailureFor } = require('../../../stores/studioAppData/migrationPreview.mts');

const OWNER = 'owner-conv';
let appSeq = 0;

const pgApp = usePgAppEngine(test);
const rawQuery = (sql, params) => pgApp.rawQuery(sql, params);

const LINES = (fields) => ({ tables: [{ id: 'tbl_lines1', key: 'lines', fields }] });
const computedField = (expr, key = 'dbl') => ({ id: 'fld_dbl', key, type: 'computed', computed: { expr, type: 'number', stored: true } });

/** A fresh app whose `lines` table holds `rows`. */
async function populated(model, rows) {
    const appId = `conv-${++appSeq}`;
    await rawQuery(`INSERT INTO studio_apps (id, user_id, engine) VALUES ($1, $2, 'pg')`, [appId, OWNER]);
    await pgApp.engine.applyMigration(OWNER, appId, migrationPlan({ tables: [] }, model, { dialect: 'pg' }));
    for (const [i, r] of rows.entries()) {
        const cols = Object.keys(r);
        await pgApp.engine.exec(OWNER, appId,
            `INSERT INTO "lines" (id, ${cols.map((c) => `"${c}"`).join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
            [`rec_${i}`, ...cols.map((c) => r[c])]);
    }
    return appId;
}

const apply = (appId, planned) => pgApp.engine.applyMigration(OWNER, appId, planned.statements, { probes: planned.probes });
const column = async (appId, sql) => (await pgApp.engine.query(OWNER, appId, sql)).rows;

test('spec: a stored computed field with a new expression gives the new value for every row', async () => {
    const QTY = { id: 'fld_qty', key: 'qty', type: 'number' };
    const before = LINES([QTY, computedField('qty * 2')]);
    const appId = await populated(before, [{ qty: 1 }, { qty: 2 }, { qty: 5 }]);
    const planned = planMigration(before, LINES([QTY, computedField('qty * 3')]), { dialect: 'pg' });
    const res = await apply(appId, planned);
    assert.deepStrictEqual((await column(appId, 'SELECT dbl FROM lines ORDER BY qty')).map((r) => Number(r.dbl)), [3, 6, 15]);
    const op = planned.ops.findIndex((o) => o.kind === 'recompute');
    assert.strictEqual(res.probed.find((p) => p.opIndex === op).n, 3);
});

test('ALTER TYPE … USING: text → number with a dependent stored field that survives the conversion', async () => {
    const AMT = { id: 'fld_amt', key: 'amount', type: 'text', default: '0' };
    const before = LINES([AMT, computedField('amount')]);
    // A text column read by a numeric generated column would not even create;
    // the dependent here is text concatenation.
    before.tables[0].fields[1] = { id: 'fld_lbl', key: 'label', type: 'computed', computed: { expr: "amount || '!'", stored: true } };
    const appId = await populated(before, [{ amount: '10' }, { amount: ' 9.5 ' }, { amount: '' }]);
    const after = LINES([{ ...AMT, type: 'number', default: 1 }, { id: 'fld_lbl', key: 'label', type: 'computed', computed: { expr: "amount::text || '!'", stored: true } }]);
    const planned = planMigration(before, after, { dialect: 'pg', convertTypes: true });
    assert.ok(planned.statements.some((s) => /ALTER COLUMN "amount" TYPE NUMERIC USING/.test(s)));
    await apply(appId, planned);
    const rows = await column(appId, 'SELECT amount, label FROM lines ORDER BY amount NULLS LAST');
    assert.deepStrictEqual(rows.map((r) => [r.amount === null ? null : Number(r.amount), r.label]), [[9.5, '9.5!'], [10, '10!'], [null, null]]);
});

test('integer ⇄ number ⇄ text, and select → text, keep the values', async () => {
    const N = { id: 'fld_n', key: 'n', type: 'number', subtype: 'integer' };
    const appId = await populated(LINES([N]), [{ n: 20 }, { n: 3 }]);
    await apply(appId, planMigration(LINES([N]), LINES([{ ...N, subtype: undefined }]), { dialect: 'pg', convertTypes: true }));
    await apply(appId, planMigration(LINES([{ ...N, subtype: undefined }]), LINES([{ ...N, type: 'text', subtype: undefined }]), { dialect: 'pg', convertTypes: true }));
    assert.deepStrictEqual((await column(appId, 'SELECT n FROM lines ORDER BY id')).map((r) => r.n), ['20', '3']);
});

test('refuse mode rolls the whole plan back and counts every bad value; clear mode empties them', async () => {
    const C = { id: 'fld_c', key: 'code', type: 'text' };
    const appId = await populated(LINES([C]), [{ code: '12' }, { code: '12,50' }, { code: '007' }, { code: null }]);
    const after = LINES([{ ...C, type: 'number', subtype: 'integer' }]);
    await assert.rejects(apply(appId, planMigration(LINES([C]), after, { dialect: 'pg', convertTypes: true })), (err) => {
        assert.strictEqual(err.code, 'migration_precondition');
        assert.strictEqual(err.probed[0].bad, 2);
        return true;
    });
    assert.deepStrictEqual((await column(appId, `SELECT data_type FROM information_schema.columns WHERE table_name = 'lines' AND column_name = 'code' AND table_schema = 'app_${appId}'`))[0], { data_type: 'text' });
    await apply(appId, planMigration(LINES([C]), after, { dialect: 'pg', convertTypes: true, onUnconvertible: 'clear' }));
    assert.deepStrictEqual((await column(appId, 'SELECT code FROM lines ORDER BY id')).map((r) => (r.code === null ? null : Number(r.code))), [12, null, null, null]);
});

test('a failing recompute keeps its plan index and SQLSTATE: 1/0 maps to division_by_zero', async () => {
    const QTY = { id: 'fld_qty', key: 'qty', type: 'number' };
    const before = LINES([QTY, computedField('qty * 2')]);
    const appId = await populated(before, [{ qty: 0 }]);
    const planned = planMigration(before, LINES([QTY, computedField('1 / qty')]), { dialect: 'pg' });
    await assert.rejects(apply(appId, planned), (err) => {
        assert.ok(Number.isInteger(err.migrationStatementIndex));
        const failure = migrationFailureFor(err, planned);
        assert.strictEqual(failure.reason, 'division_by_zero');
        assert.strictEqual(failure.fieldId, 'fld_dbl');
        assert.doesNotMatch(failure.message, /division by zero/, 'the fixed sentence, never the database text');
        return true;
    });
});

// A type change on a saved field used to save model-only, so a Postgres column
// can hold another storage type than its model field says. The conversions
// read the text form and still work.
test('drift: a NUMERIC column under a model text field converts to select and to number', async () => {
    const NUM = { id: 'fld_a', key: 'a', type: 'number' };
    const TXT = { ...NUM, type: 'text' };
    const appId = await populated(LINES([NUM]), [{ a: 1 }, { a: 2.5 }, { a: null }]);
    const toSelect = planMigration(LINES([TXT]), LINES([{ ...TXT, type: 'select', options: ['1'] }]), { dialect: 'pg', convertTypes: true });
    // text ⇄ select has no statement; the save's version stamp still runs the probe.
    await assert.rejects(pgApp.engine.applyMigration(OWNER, appId, toSelect.statements, { probes: toSelect.probes, targetVersion: 2 }), (err) => {
        assert.strictEqual(err.code, 'migration_precondition');
        assert.strictEqual(err.probed[0].bad, 1, '2.5 is not an option');
        return true;
    });
    await apply(appId, planMigration(LINES([TXT]), LINES([{ ...TXT, type: 'number' }]), { dialect: 'pg', convertTypes: true }));
    assert.deepStrictEqual((await column(appId, 'SELECT a FROM lines ORDER BY id')).map((r) => (r.a === null ? null : Number(r.a))), [1, 2.5, null]);
});

test('drift: a TEXT column under a model number field converts to integer', async () => {
    const TXT = { id: 'fld_b', key: 'b', type: 'text' };
    const NUM = { ...TXT, type: 'number' };
    const appId = await populated(LINES([TXT]), [{ b: '20' }, { b: ' 3.00 ' }, { b: '' }, { b: '1.5' }]);
    const after = LINES([{ ...NUM, subtype: 'integer' }]);
    await assert.rejects(apply(appId, planMigration(LINES([NUM]), after, { dialect: 'pg', convertTypes: true })), (err) => {
        assert.strictEqual(err.code, 'migration_precondition');
        assert.strictEqual(err.probed[0].bad, 1, 'only 1.5 has a fraction; blank is empty');
        return true;
    });
    await apply(appId, planMigration(LINES([NUM]), after, { dialect: 'pg', convertTypes: true, onUnconvertible: 'clear' }));
    assert.deepStrictEqual((await column(appId, 'SELECT b FROM lines ORDER BY id')).map((r) => (r.b === null ? null : Number(r.b))), [20, 3, null, null]);
});

test('a failing probe names its op, so the save reports a fixed failure instead of a 500', async () => {
    const C = { id: 'fld_c', key: 'code', type: 'text' };
    const appId = await populated(LINES([C]), [{ code: 'x' }]);
    const planned = planMigration(LINES([C]), LINES([{ ...C, type: 'number' }]), { dialect: 'pg', convertTypes: true });
    const broken = { ...planned, probes: planned.probes.map((p) => ({ ...p, sql: 'SELECT COUNT(*) AS n, 1 / 0 AS bad FROM "lines"' })) };
    await assert.rejects(apply(appId, broken), (err) => {
        assert.strictEqual(err.migrationOpIndex, planned.probes[0].opIndex);
        const failure = migrationFailureFor(err, broken);
        assert.strictEqual(failure.kind, 'convert');
        assert.strictEqual(failure.fieldId, 'fld_c');
        assert.strictEqual(failure.reason, 'division_by_zero');
        return true;
    });
});

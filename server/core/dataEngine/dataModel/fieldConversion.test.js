/**
 * fieldConversion.mts (pure): which type changes convert in place, the
 * unconvertible predicate, and the planner around it (planMigration ops,
 * probes and the step order). Real databases: appStudio/dataModel.tolerantDdl.test.js
 * (SQLite) and ./fieldConversion.pglite.test.js (Postgres).
 *
 * Run: cd server && node --test core/dataEngine/dataModel/fieldConversion.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { logicalType, fieldConversion, SAFE_CONVERSIONS, unconvertibleWhere, conversionDdl, exprMentions } = require('./fieldConversion.mts');
const { planMigration, migrationPlan } = require('./migrationPlan');

const fld = (over) => ({ id: 'fld_x', key: 'x', ...over });

test('logicalType: a number with subtype integer is its own kind', () => {
    assert.strictEqual(logicalType(fld({ type: 'number', subtype: 'integer' })), 'integer');
    assert.strictEqual(logicalType(fld({ type: 'number' })), 'number');
    assert.strictEqual(logicalType(fld({ type: 'select' })), 'select');
});

test('fieldConversion: same type is null; the eight safe pairs; the rest unsafe', () => {
    assert.strictEqual(fieldConversion(fld({ type: 'text' }), fld({ type: 'text' })), null);
    assert.strictEqual(SAFE_CONVERSIONS.size, 8);
    for (const pair of SAFE_CONVERSIONS) {
        const [from, to] = pair.split('>');
        const asField = (t) => (t === 'integer' ? fld({ type: 'number', subtype: 'integer' }) : fld({ type: t }));
        assert.deepStrictEqual(fieldConversion(asField(from), asField(to)), { from, to, safe: true }, pair);
    }
    assert.strictEqual(fieldConversion(fld({ type: 'text' }), fld({ type: 'bool' })).safe, false);
    assert.strictEqual(fieldConversion(fld({ type: 'text' }), fld({ type: 'relation' })).safe, false);
    assert.strictEqual(fieldConversion(fld({ type: 'text' }), fld({ type: 'computed' })).safe, false);
});

test('unconvertibleWhere: text → select names the options; lossless pairs have no predicate', () => {
    const sel = fld({ type: 'select', options: ['a', { value: "b'c", label: 'B' }] });
    assert.strictEqual(unconvertibleWhere({ from: 'text', to: 'select', safe: true }, 'x', sel, 'sqlite'),
        `("x" IS NOT NULL AND "x" <> '') AND "x" NOT IN ('a', 'b''c')`);
    assert.strictEqual(unconvertibleWhere({ from: 'number', to: 'text', safe: true }, 'x', fld({ type: 'text' }), 'pg'), null);
    assert.strictEqual(unconvertibleWhere({ from: 'integer', to: 'number', safe: true }, 'x', fld({ type: 'number' }), 'pg'), null);
    assert.match(unconvertibleWhere({ from: 'text', to: 'number', safe: true }, 'x', fld({ type: 'number' }), 'pg'), /btrim\(\("x"\)::text\) ~ /);
});

test('conversionDdl: Postgres ALTER TYPE USING with the default around it; SQLite shadow swap with the unique index', () => {
    const table = { id: 'tbl_t', key: 't' };
    const oldF = fld({ type: 'text', unique: true });
    const newF = fld({ type: 'number', unique: true, default: 1 });
    const conv = { from: 'text', to: 'number', safe: true };
    const pg = conversionDdl({ table, oldF, newF, conv, dialect: 'pg' });
    assert.deepStrictEqual(pg.map((s) => s.replace(/USING \(.*\)$/, 'USING (…)')), [
        'ALTER TABLE "t" ALTER COLUMN "x" DROP DEFAULT',
        'ALTER TABLE "t" ALTER COLUMN "x" DROP NOT NULL',
        'ALTER TABLE "t" ALTER COLUMN "x" TYPE NUMERIC USING (…)',
        'ALTER TABLE "t" ALTER COLUMN "x" SET DEFAULT 1',
    ]);
    const lite = conversionDdl({ table, oldF, newF, conv, dialect: 'sqlite' });
    assert.strictEqual(lite[0], 'DROP INDEX IF EXISTS "uq_tbl_t_fld_x"');
    assert.strictEqual(lite[1], 'ALTER TABLE "t" ADD COLUMN "_cv_fld_x" REAL DEFAULT 1');
    assert.match(lite[2], /^UPDATE "t" SET "_cv_fld_x" = /);
    assert.deepStrictEqual(lite.slice(3), [
        'ALTER TABLE "t" DROP COLUMN "x"',
        'ALTER TABLE "t" RENAME COLUMN "_cv_fld_x" TO "x"',
        'CREATE UNIQUE INDEX IF NOT EXISTS "uq_tbl_t_fld_x" ON "t" ("x")',
    ]);
    const sel = conversionDdl({ table, oldF: fld({ type: 'text' }), newF: fld({ type: 'select', options: ['a'] }), conv: { from: 'text', to: 'select', safe: true }, dialect: 'pg' });
    assert.deepStrictEqual(sel, [], 'text → select: same storage, nothing to run in refuse mode');
});

test('exprMentions ignores string literals and longer names', () => {
    assert.strictEqual(exprMentions('price * 2', 'price'), true);
    assert.strictEqual(exprMentions('"price" * 2', 'price'), true);
    assert.strictEqual(exprMentions("'price' || unit_price", 'price'), false);
    assert.strictEqual(exprMentions('price_net * 2', 'price'), false);
});

// ── planMigration ───────────────────────────────────────────────────

const T = (fields) => ({ tables: [{ id: 'tbl_a', key: 'items', fields }] });
const PRICE = { id: 'f1', key: 'price', type: 'text' };
const DBL = (expr = 'price * 2', key = 'dbl') => ({ id: 'f3', key, type: 'computed', computed: { expr, type: 'number', stored: true } });

test('migrationPlan() is planMigration().statements, and without convertTypes a type change emits nothing', () => {
    const before = T([PRICE]);
    const after = T([{ ...PRICE, type: 'number' }]);
    for (const dialect of ['sqlite', 'pg']) {
        assert.deepStrictEqual(migrationPlan(before, after, { dialect }), planMigration(before, after, { dialect }).statements);
        assert.deepStrictEqual(migrationPlan(before, after, { dialect }), []);
        assert.deepStrictEqual(planMigration(before, after, { dialect }).ops, []);
    }
});

test('a renamed stored computed field drops the OLD key', () => {
    const plan = migrationPlan(T([PRICE, DBL()]), T([PRICE, DBL('price * 2', 'twice')]), { dialect: 'pg' });
    assert.deepStrictEqual(plan[0], 'ALTER TABLE "items" DROP COLUMN IF EXISTS "dbl"');
    assert.match(plan[1], /ADD COLUMN IF NOT EXISTS "twice"/);
});

test('a dependent stored field is dropped before the conversion and re-added after; ops carry their statement range', () => {
    const before = T([PRICE, DBL()]);
    const after = T([{ ...PRICE, type: 'number' }, DBL()]);
    const { statements, ops, probes } = planMigration(before, after, { dialect: 'pg', convertTypes: true });
    assert.strictEqual(statements[0], 'ALTER TABLE "items" DROP COLUMN IF EXISTS "dbl"');
    assert.match(statements.at(-1), /ADD COLUMN IF NOT EXISTS "dbl"/);
    const conv = ops.find((o) => o.kind === 'convert');
    assert.deepStrictEqual([conv.first, conv.last, conv.from, conv.to], [1, 3, 'text', 'number']);
    const rec = ops.find((o) => o.kind === 'recompute');
    assert.deepStrictEqual([rec.reason, rec.first, rec.last], ['dependency', 4, 4]);
    assert.deepStrictEqual(probes.map((p) => [p.at, p.refuse]), [[1, true], [4, false]]);
});

test('probes refuse only in refuse mode; clear mode updates instead', () => {
    const before = T([{ id: 'f2', key: 'st', type: 'text' }]);
    const after = T([{ id: 'f2', key: 'st', type: 'select', options: ['a'] }]);
    const refuse = planMigration(before, after, { dialect: 'sqlite', convertTypes: true });
    assert.deepStrictEqual(refuse.statements, []);
    assert.strictEqual(refuse.probes[0].refuse, true);
    const clear = planMigration(before, after, { dialect: 'sqlite', convertTypes: true, onUnconvertible: 'clear' });
    assert.match(clear.statements[0], /^UPDATE "items" SET "st" = NULL WHERE /);
    assert.strictEqual(clear.probes[0].refuse, false);
    assert.strictEqual(clear.ops[0].action, 'clear');
});

test('an unsafe pair is an unsupported op with no statement', () => {
    const { statements, ops } = planMigration(T([PRICE]), T([{ ...PRICE, type: 'bool' }]), { dialect: 'pg', convertTypes: true });
    assert.deepStrictEqual(statements, []);
    assert.deepStrictEqual([ops[0].kind, ops[0].from, ops[0].to, ops[0].first], ['unsupported', 'text', 'bool', -1]);
});

test('a new stored computed field that reads a converted column waits for the conversion', () => {
    const before = T([PRICE]);
    const after = T([{ ...PRICE, type: 'number' }, DBL()]);
    const { statements, ops } = planMigration(before, after, { dialect: 'sqlite', convertTypes: true });
    assert.match(statements.at(-1), /ADD COLUMN "dbl" REAL GENERATED ALWAYS AS \(price \* 2\) VIRTUAL/);
    assert.deepStrictEqual(ops.map((o) => [o.kind, o.reason]), [['convert', 'type'], ['recompute', 'new']]);
});

/**
 * migrationPreview.mts: the dry run of a data model change (counts against the
 * current schema, nothing written), the save report and the fixed failure
 * reasons. The per-app engine is a real in-memory better-sqlite3 database
 * behind the engine's query() shape.
 *
 * Run: cd server && node --test stores/studioAppData/migrationPreview.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const dataModel = require('../../appStudio/dataModel');
const { bindCycleDeps } = require('./cycleDeps');
const {
    previewAgainst, buildMigrationReport, migrationFailureReason, migrationFailureFor, FAILURE_REASONS, summariseMigration,
} = require('./migrationPreview.mts');

let Database = null;
try { Database = require('better-sqlite3'); new Database(':memory:').close(); } catch { Database = null; }
const skip = (t) => !Database && t.skip('better-sqlite3 native binding unavailable');

/** A fake per-app engine over one sqlite handle; counts every query. */
function engineOver(db) {
    const calls = [];
    return {
        calls,
        query: async (_owner, _app, sql) => { calls.push(sql); return { rows: db.prepare(sql).all() }; },
    };
}

const model = (fields) => ({
    modelVersion: 1,
    tables: [{ id: 'tbl_tasks1', key: 'tasks', name: 'Tasks', fields, access: { default: 'app', roles: {}, rowFilters: {} } }],
    roles: [], roleMapping: { default: 'app', byGroup: {} },
});
const STATUS = { id: 'fld_aaa222', key: 'status', type: 'text', required: false, unique: false };
const DUE = { id: 'fld_aaa333', key: 'score2', type: 'computed', computed: { expr: 'score * 2', type: 'number', stored: true }, required: false, unique: false };
const SCORE = { id: 'fld_aaa444', key: 'score', type: 'number', required: false, unique: false };

function setup(t, before, rows) {
    const db = new Database(':memory:');
    t.after(() => db.close());
    dataModel.applyPlanTolerantly(db, dataModel.migrationPlan({ tables: [] }, before), { log: { warn() {} } });
    for (const [i, r] of rows.entries()) {
        db.prepare('INSERT INTO tasks (id, status, score) VALUES (?, ?, ?)').run(`rec_${i}`, r.status, r.score);
    }
    const engine = engineOver(db);
    bindCycleDeps({ dataModel, studioAppDbStore: engine, studioAppStore: null });
    return { db, engine };
}

test('spec: text → select with two unknown values is reported in the dry run, with samples; nothing is written', async (t) => {
    if (skip(t)) return;
    const before = model([STATUS, SCORE]);
    const { db, engine } = setup(t, before, [
        { status: 'open', score: 1 }, { status: 'done', score: 2 }, { status: 'later', score: 3 },
        { status: 'x'.repeat(80), score: 4 }, { status: '', score: 5 }, { status: null, score: 6 },
    ]);
    const snapshot = JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id').all());
    const after = model([{ ...STATUS, type: 'select', options: ['open', 'done'] }, SCORE]);
    const res = await previewAgainst('app1', 'owner1', after, { model: before, modelVersion: 4 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(res.currentVersion, 4, 'the version the save would start from, unchanged');
    const [conv] = res.report.converted;
    assert.strictEqual(conv.unconvertible, 2);
    assert.strictEqual(conv.rows, 6);
    assert.deepStrictEqual([conv.from, conv.to, conv.field, conv.action], ['text', 'select', 'status', 'refuse']);
    assert.strictEqual(conv.samples.length, 2);
    assert.ok(conv.samples.includes('later'));
    assert.ok(conv.samples.every((s) => s.length <= 61), 'samples are cut to 60 characters');
    assert.strictEqual(JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY id').all()), snapshot, 'no row changed');
    assert.ok(engine.calls.every((sql) => /^SELECT /.test(sql)), 'reads only');
    assert.match(res.report.summary, /2 value\(s\) cannot convert/);
});

test('recompute counts: a new expression and a new stored field on a populated table', async (t) => {
    if (skip(t)) return;
    const before = model([STATUS, SCORE, DUE]);
    setup(t, before, [{ status: 'a', score: 1 }, { status: 'b', score: 2 }, { status: 'c', score: 3 }]);
    const after = model([STATUS, SCORE, { ...DUE, computed: { ...DUE.computed, expr: 'score * 3' } },
        { id: 'fld_aaa111', key: 'plus', type: 'computed', computed: { expr: 'score + 1', type: 'number', stored: true }, required: false, unique: false }]);
    const res = await previewAgainst('app1', 'owner1', after, { model: before, modelVersion: 1 });
    assert.deepStrictEqual(res.report.recomputed.map((r) => [r.field, r.reason, r.rows]), [['plus', 'new', 3], ['score2', 'expression', 3]]);
    assert.deepStrictEqual(res.report.converted, []);
});

test('an invalid model is answered as such, before anything is counted', async () => {
    bindCycleDeps({ dataModel, studioAppDbStore: { query: async () => { throw new Error('must not query'); } }, studioAppStore: null });
    const res = await previewAgainst('app1', 'owner1', { tables: [{ id: 'x' }] }, null);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.invalid, true);
});

test('buildMigrationReport: unsupported pairs are listed; the summary keeps the plan line', () => {
    const plan = dataModel.planMigration(model([STATUS]), model([{ ...STATUS, type: 'bool' }]), { convertTypes: true, dialect: 'sqlite' });
    const report = buildMigrationReport(plan, []);
    assert.deepStrictEqual(report.unsupported.map((u) => [u.field, u.from, u.to]), [['status', 'text', 'bool']]);
    assert.match(report.summary, /^no schema change — tasks\.status text→bool/);
    assert.strictEqual(summariseMigration([]), 'no schema change');
});

test('migrationFailureReason maps codes to fixed ids, and migrationFailureFor never returns the database text', () => {
    assert.strictEqual(migrationFailureReason({ code: '22012' }), 'division_by_zero');
    assert.strictEqual(migrationFailureReason({ sqlState: '22P02', code: 'invalid_value' }), 'invalid_value');
    assert.strictEqual(migrationFailureReason({ code: 'SQLITE_ERROR', message: 'no such column: nope' }), 'unknown_column');
    assert.strictEqual(migrationFailureReason({ code: '42883' }), 'type_mismatch');
    assert.strictEqual(migrationFailureReason({ code: 'SQLITE_CONSTRAINT_UNIQUE' }), 'duplicate_values');
    assert.strictEqual(migrationFailureReason({ code: 'XX000', message: 'secret row value' }), 'other');
    const plan = dataModel.planMigration(model([STATUS, SCORE, DUE]), model([STATUS, SCORE, { ...DUE, computed: { ...DUE.computed, expr: 'nope * 2' } }]), { dialect: 'sqlite' });
    const failure = migrationFailureFor({ migrationStatementIndex: 1, code: 'SQLITE_ERROR', message: 'no such column: "customer value"' }, plan);
    assert.deepStrictEqual([failure.kind, failure.reason, failure.field], ['recompute', 'unknown_column', 'score2']);
    assert.strictEqual(failure.message, FAILURE_REASONS.unknown_column);
    assert.strictEqual(migrationFailureFor({ migrationStatementIndex: 0 }, plan), null, 'the drop is no op of its own');
    assert.strictEqual(migrationFailureFor(new Error('x'), plan), null);
});

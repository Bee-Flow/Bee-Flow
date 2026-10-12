/**
 * Key order survives the database: automation_run_steps.input_json/output_json
 * are JSON, not JSONB (JSONB stores an object's keys sorted, so a replayed or
 * resumed run saw `{ qty, sku, price }` for what a code step returned as
 * `{ sku, qty, price }`).
 *
 * Runs against a real Postgres (@electric-sql/pglite, in-process), through the
 * migration's injectable `exec`.
 *
 * Run: node --test migrations/automation-run-step-json-order-2026-10.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../testUtils/pgliteDb');

const { pg } = pgliteDb();
const migration = require('./automation-run-step-json-order-2026-10');
const deps = { exec: (sql) => pg.exec(sql) };
const up = () => migration.up(deps);

const OUTPUT = { text: 'Hello', lines: [{ sku: 'A1', qty: 2, price: 9.95 }, { sku: 'B2', qty: 1, price: 24.5 }] };
const colType = async (col) => (await pg.query(
    `SELECT data_type FROM information_schema.columns WHERE table_name = 'automation_run_steps' AND column_name = $1`, [col],
)).rows[0]?.data_type;
const insert = (stepId) => pg.query(
    `INSERT INTO automation_run_steps (run_id, step_id, step_type, input_json, output_json)
     VALUES ('r1', $1, 'code', $2, $2)
     ON CONFLICT (run_id, step_id, attempts) DO UPDATE SET output_json = EXCLUDED.output_json`,
    [stepId, JSON.stringify(OUTPUT)],
);
const read = async (stepId) => (await pg.query(
    `SELECT input_json, output_json FROM automation_run_steps WHERE step_id = $1`, [stepId],
)).rows[0];

before(async () => {
    // The shape automation-builder-2026-05-init creates.
    await pg.exec(`CREATE TABLE automation_run_steps (
        run_id TEXT NOT NULL, step_id TEXT NOT NULL, step_type TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1, input_json JSONB, output_json JSONB,
        PRIMARY KEY (run_id, step_id, attempts))`);
    await pg.exec(`CREATE TABLE automation_runs (id TEXT PRIMARY KEY, trigger_payload JSONB)`);
});
after(async () => { await pg.close(); });

test('JSONB loses the order the code step returned (the bug)', async () => {
    await insert('before');
    const { output_json } = await read('before');
    assert.deepEqual(Object.keys(output_json.lines[0]), ['qty', 'sku', 'price']);
});

test('after the migration the columns are JSON and a new row keeps its key order', async () => {
    await up();
    assert.equal(await colType('input_json'), 'json');
    assert.equal(await colType('output_json'), 'json');
    await insert('after');
    const row = await read('after');
    assert.deepEqual(Object.keys(row.output_json), ['text', 'lines']);
    assert.deepEqual(Object.keys(row.output_json.lines[0]), ['sku', 'qty', 'price']);
    assert.deepEqual(Object.keys(row.input_json.lines[0]), ['sku', 'qty', 'price']);
    assert.deepEqual(row.output_json, OUTPUT);
});

test('rows written before the migration are kept (already sorted: that order cannot be recovered)', async () => {
    const row = await read('before');
    assert.deepEqual(row.output_json, OUTPUT);
});

test('replayed on every boot: a second run changes nothing and the upsert still works', async () => {
    await up();
    assert.equal(await colType('output_json'), 'json');
    await insert('after'); // ON CONFLICT DO UPDATE
    assert.deepEqual(Object.keys((await read('after')).output_json.lines[0]), ['sku', 'qty', 'price']);
});

test('a bare-string and a null output still round-trip', async () => {
    await pg.query(`INSERT INTO automation_run_steps (run_id, step_id, step_type, output_json) VALUES ('r1','s-str','ai_step',$1), ('r1','s-null','ai_step',NULL)`, [JSON.stringify('plain text')]);
    assert.equal((await read('s-str')).output_json, 'plain text');
    assert.equal((await read('s-null')).output_json, null);
});

test('the trigger payload keeps its order too, and the run search still looks inside it', async () => {
    const answers = { supplier: 'Acme BV', category: 'Hardware', amount: 1200 };
    await pg.query(`INSERT INTO automation_runs (id, trigger_payload) VALUES ('r1', $1)`, [JSON.stringify(answers)]);
    const type = (await pg.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'automation_runs' AND column_name = 'trigger_payload'`,
    )).rows[0]?.data_type;
    assert.equal(type, 'json');
    const row = (await pg.query(`SELECT trigger_payload FROM automation_runs WHERE id = 'r1'`)).rows[0];
    assert.deepEqual(Object.keys(row.trigger_payload), ['supplier', 'category', 'amount']);
    // The shape of runListing.js's payload search, cast at query time.
    const hit = await pg.query(
        `SELECT id FROM automation_runs r WHERE EXISTS (SELECT 1 FROM jsonb_path_query(r.trigger_payload::jsonb, 'lax $.**') pv
            WHERE jsonb_typeof(pv) = 'string' AND (pv #>> '{}') ILIKE $1)`, ['%acme%'],
    );
    assert.deepEqual(hit.rows.map((r) => r.id), ['r1']);
});

test('no table yet: nothing to do', async () => {
    await pg.exec('DROP TABLE automation_run_steps');
    await pg.exec('DROP TABLE automation_runs');
    await up();
});

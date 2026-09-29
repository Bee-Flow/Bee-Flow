/**
 * Unit — the datatable field-id repair. DB-free: exercises `reconcileDdl`, the
 * half that decides what SQL a broken organisation needs, and pins the
 * registration.
 *
 * Run: node --test --test-force-exit migrations/datatable-field-ids-2026-09.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { reconcileDdl } = require('./datatable-field-ids-2026-09');
const { backfillModelFieldIds } = require('../core/dataEngine/dataModel/datatableFields');

function brokenModel() {
    // Exactly what the routes used to store: fields with no id.
    return {
        modelVersion: 1,
        tables: [{ id: 'tbl_a', key: 'das', name: 'das', fields: [{ key: 't', name: 'test', type: 'text' }] }],
    };
}

test('the repair covers both broken states: missing table AND missing column', () => {
    const { model } = backfillModelFieldIds(brokenModel());
    const plan = reconcileDdl(model);

    const creates = plan.filter(s => /CREATE TABLE/i.test(s));
    const adds = plan.filter(s => /ADD COLUMN/i.test(s));
    assert.strictEqual(creates.length, 1, 'one CREATE TABLE for the table');
    assert.match(creates[0], /IF NOT EXISTS/i, 'a table that already exists is left alone');
    assert.match(creates[0], /"t"/, 'the CREATE carries the author column, for a table that never existed');
    assert.strictEqual(adds.length, 1, 'one ADD COLUMN, for a table that exists without it');
    assert.match(adds[0], /IF NOT EXISTS/i);
});

test('every statement the repair emits only ADDS — nothing is dropped or renamed', () => {
    const { model } = backfillModelFieldIds({
        modelVersion: 1,
        tables: [
            { id: 'tbl_a', key: 'a', name: 'a', fields: [{ key: 'x', name: 'X', type: 'text' }, { key: 'y', name: 'Y', type: 'number' }] },
            { id: 'tbl_b', key: 'b', name: 'b', fields: [] },
        ],
    });
    for (const sql of reconcileDdl(model)) {
        assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN|INDEX)/i, sql);
        assert.doesNotMatch(sql, /RENAME/i, sql);
        assert.doesNotMatch(sql, /\bDELETE\b|\bTRUNCATE\b/i, sql);
    }
});

test('a healthy model still reconciles to idempotent no-ops, never an empty repair', () => {
    const healthy = {
        modelVersion: 1,
        tables: [{ id: 'tbl_a', key: 'a', name: 'a', fields: [{ id: 'fld_abc123', key: 'x', name: 'X', type: 'text' }] }],
    };
    const plan = reconcileDdl(healthy);
    assert.ok(plan.length >= 2);
    for (const sql of plan) assert.match(sql, /IF NOT EXISTS/i, sql);
});

test('an org with no tables needs no statements at all', () => {
    assert.deepStrictEqual(reconcileDdl({ tables: [] }), []);
    assert.deepStrictEqual(reconcileDdl(null), []);
});

test('the migration is registered, so it actually runs at boot', () => {
    const core = fs.readFileSync(path.join(__dirname, '..', 'stores', 'automationStore', 'core.js'), 'utf8');
    assert.match(core, /'datatable-field-ids-2026-09'/);
});

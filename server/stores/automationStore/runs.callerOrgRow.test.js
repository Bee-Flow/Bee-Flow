'use strict';

/**
 * The organisation run log shows a run on the starter's own connections as
 * status and timing only: its summary, error text and outcome belong to the
 * starter (rowToOrgRunRow).
 *
 * Run: node --test stores/automationStore/runs.callerOrgRow.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { rowToOrgRunRow } = require('./runs');
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

const ROW = (over = {}) => ({
    id: 'r1', automation_id: 'a1', user_id: 'owner', version: 1, status: 'error', mode: 'live', trigger_kind: 'manual',
    started_at: '2026-10-16T10:00:00Z', summary: 'private summary', error: 'private error', error_class: 'x',
    outcome_json: { code: 'c', params: { file: 'private.pdf' }, text: 'private outcome' },
    started_by_user_id: 'starter', connections_mode: 'caller', ...over,
});

test('a caller-mode run: summary, error and outcome are hidden from the organisation log, even for the owner', () => {
    for (const viewer of ['owner', 'colleague', null]) {
        const out = rowToOrgRunRow(ROW(), viewer);
        assert.strictEqual(out.status, 'error');
        assert.strictEqual(out.errorClass, 'x');
        assert.strictEqual(out.summary, null, String(viewer));
        assert.strictEqual(out.error, null, String(viewer));
        assert.strictEqual(out.outcome, null, String(viewer));
    }
    assert.strictEqual(rowToOrgRunRow(ROW(), 'owner').mine, true);
});

test('the starter sees their own run\'s text, an ordinary run is unchanged', () => {
    assert.strictEqual(rowToOrgRunRow(ROW(), 'starter').summary, 'private summary');
    const ordinary = rowToOrgRunRow(ROW({ connections_mode: null }), 'colleague');
    assert.strictEqual(ordinary.summary, 'private summary');
    assert.strictEqual(ordinary.error, 'private error');
});

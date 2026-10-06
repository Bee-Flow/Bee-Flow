/**
 * rowToRunStep's `bindingWarnings`: the mappings that found nothing while the
 * step ran, from automation_run_steps.binding_warnings.
 *
 * Proven: a stored list passes through verbatim; NULL, and a row from before
 * the column (or from a projection that does not select it), read null.
 *
 * Pure mapper, no DB. Run: cd server && node --test stores/automationStore/rowMappers.bindingWarnings.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rowToRunStep } = require('./rowMappers');

const row = (over = {}) => ({
    run_id: 'r1', step_id: 's1', parent_step_id: null, step_type: 'integration_action',
    attempts: 1, status: 'success', started_at: null, finished_at: null,
    input_json: null, output_json: null, error: null, error_class: null, branch_index: null,
    pii_summary: null, tools_withheld: null, error_info: null,
    ...over,
});

test('a stored list passes through untouched', () => {
    const list = [{ field: 'to', kind: 'ref', path: 'steps.a.output.x', reason: 'missing', count: 1, description: 'input "to" read steps.a.output.x: nothing there' }];
    assert.deepEqual(rowToRunStep(row({ binding_warnings: list })).bindingWarnings, list);
});

test('NULL and a row without the column read null', () => {
    assert.equal(rowToRunStep(row({ binding_warnings: null })).bindingWarnings, null);
    assert.equal(rowToRunStep(row()).bindingWarnings, null);
});

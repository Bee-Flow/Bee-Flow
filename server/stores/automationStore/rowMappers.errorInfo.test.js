/**
 * rowToRunStep's errorInfo (Studio → Automations handoff 5, round 4).
 *
 * Proven: a stored error_info passes through verbatim; a failed row written
 * before the column existed still gets a card, classified from its message,
 * step type and recorded input; a successful row, or one without an error
 * message, gets none; the old `error` string and errorRemediation are kept.
 *
 * Pure mapper, no DB. Run: cd server && node --test stores/automationStore/rowMappers.errorInfo.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { rowToRunStep } = require('./rowMappers');

function row(over = {}) {
    return {
        run_id: 'r1', step_id: 's1', parent_step_id: null, step_type: 'integration_action',
        attempts: 1, status: 'error', started_at: null, finished_at: null,
        input_json: null, output_json: null, error: null, error_class: null, branch_index: null,
        pii_summary: null, tools_withheld: null, error_info: null,
        ...over,
    };
}

test('a stored error_info passes through untouched', () => {
    const info = { code: 'nextcloud_no_access', settingKey: 'connection', fixes: [{ id: 'share_folder' }] };
    const out = rowToRunStep(row({ error: 'x', error_info: info }));
    assert.deepStrictEqual(out.errorInfo, info);
    assert.strictEqual(out.error, 'x');
});

test('a legacy failed row is classified from its message and recorded input', () => {
    const out = rowToRunStep(row({
        error: 'nextcloud_read_file failed: File not found: /Invoices/a.pdf',
        input_json: { path: '/Invoices/a.pdf' },
    }));
    assert.strictEqual(out.errorInfo.code, 'nextcloud_not_found');
    assert.strictEqual(out.errorInfo.settingKey, 'inputs.path');
    assert.strictEqual(out.errorInfo.title, 'Bee cannot find this file or folder');
    // The older one-line hint is still there for clients that read it.
    assert.ok(out.errorRemediation);
    assert.strictEqual(out.error, 'nextcloud_read_file failed: File not found: /Invoices/a.pdf');
});

test('a handled_error row gets a card too; success and message-less rows do not', () => {
    assert.strictEqual(rowToRunStep(row({ status: 'handled_error', error: 'Too Many Requests (429)' })).errorInfo.code, 'rate_limited');
    assert.strictEqual(rowToRunStep(row({ status: 'success', error: null })).errorInfo, null);
    assert.strictEqual(rowToRunStep(row({ status: 'error', error: null })).errorInfo, null);
    assert.strictEqual(rowToRunStep(row({ status: 'running', error: 'x' })).errorInfo, null);
});

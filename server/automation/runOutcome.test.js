'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildRunOutcome, resolveRunOutcome, describeOutput, reasonFor, joinNames, approvalSeats,
} = require('./runOutcome');

const definition = {
    trigger: { id: 't1', kind: 'manual' },
    steps: [
        { id: 's1', type: 'integration_action', tool: 'nextcloud_list_files', label: 'List files' },
        { id: 's2', type: 'integration_action', tool: 'nextcloud_read_file', label: 'Read invoice' },
        { id: 's3', type: 'notification', label: 'Tell me' },
        { id: 's4', type: 'approval', label: 'Finance check' },
        { id: 's5', type: 'form_page', label: 'Page two' },
        { id: 'w1', type: 'wait' },
    ],
};

const row = (stepId, extra = {}) => ({ stepId, parentStepId: null, stepType: 'integration_action', attempts: 1, status: 'success', ...extra });

test('success: a list of N names the step, the count, the noun and the folder', () => {
    const o = buildRunOutcome({
        status: 'success',
        definition,
        steps: [
            row('t1', { stepType: 'trigger', output: { hello: 1 } }),
            row('s1', { input: { path: '/' }, output: { files: [{ name: 'a.pdf', mimeType: 'application/pdf' }, { name: 'b', type: 'folder', path: '/b' }] } }),
            // A trailing message step does not say what the run did.
            row('s3', { stepType: 'notification', output: { sent: true } }),
            row('w1', { stepType: 'wait', output: { waitedSeconds: 5 } }),
        ],
    });
    assert.equal(o.code, 'success');
    assert.deepEqual(o.params, { step: 'List files', stepId: 's1', kind: 'list', count: 2, noun: 'files', where: '/' });
    assert.equal(o.text, 'List files: 2 files found in /');
});

test('success: a declared total wins over a truncated page, and one item is singular', () => {
    assert.deepEqual(describeOutput({ items: [{ a: 1 }], total: 40 }), { kind: 'list', count: 40, noun: 'items' });
    const o = buildRunOutcome({ status: 'success', definition, steps: [row('s1', { output: [{ subject: 'x', from: 'y' }] })] });
    assert.equal(o.params.noun, 'emails');
    assert.equal(o.text, 'List files: 1 email found');
});

test('success: a file names the file; a record carries at most two title-like values', () => {
    const file = buildRunOutcome({ status: 'success', definition, steps: [row('s2', { output: { filename: 'Invoice-2026-001.pdf', size: 12, body: 'secret text' } })] });
    assert.equal(file.params.kind, 'file');
    assert.equal(file.params.name, 'Invoice-2026-001.pdf');
    assert.equal(file.text, 'Read invoice: Invoice-2026-001.pdf');

    const rec = buildRunOutcome({ status: 'success', definition, steps: [row('s2', { output: { name: 'Acme BV', total: 1452, iban: 'NL00BANK0123456789', notes: 'x' } })] });
    assert.deepEqual(rec.params.fields, ['Acme BV', '1452']);
    assert.ok(!JSON.stringify(rec).includes('NL00BANK'), 'fields outside the allow-list never travel');
});

test('success: free text is never quoted, truncated output says nothing, no steps is "Finished"', () => {
    const text = buildRunOutcome({ status: 'success', definition, steps: [row('s2', { output: 'Dear Jan de Vries, ...' })] });
    assert.equal(text.params.kind, 'text');
    assert.equal(text.text, 'Finished with "Read invoice"');
    assert.ok(!JSON.stringify(text).includes('Jan'));
    assert.equal(describeOutput({ __truncated__: true, originalBytes: 9e6 }).kind, 'none');
    const none = buildRunOutcome({ status: 'success', definition, steps: [], handledErrorCount: 2 });
    assert.deepEqual(none, { code: 'success', params: { kind: 'none', handled: 2 }, text: 'Finished (2 step errors handled)' });
});

test('failed: stopped_at names the failing step and a classified reason, never the raw error', () => {
    const o = buildRunOutcome({
        status: 'error',
        definition,
        steps: [
            row('s1', { output: { files: [] } }),
            row('s2', { status: 'error', attempts: 1, input: { path: '/Invoices' }, error: 'HTTP 403 <html>body</html>', errorClass: 'PermissionError' }),
        ],
        error: { message: 'HTTP 403 <html>body</html>', errorClass: 'PermissionError' },
    });
    assert.equal(o.code, 'stopped_at');
    assert.deepEqual(o.params, { step: 'Read invoice', stepId: 's2', reasonCode: 'no_access', reason: 'no access to /Invoices', where: '/Invoices' });
    assert.equal(o.text, 'Stopped at "Read invoice": no access to /Invoices');
    assert.ok(!o.text.includes('html'));
});

test('failed: the last attempt decides; a handled error is not the failing step; no step means "Stopped:"', () => {
    const retried = buildRunOutcome({
        status: 'error', definition,
        steps: [
            row('s1', { status: 'handled_error' }),
            row('s2', { status: 'error', attempts: 1 }),
            row('s2', { status: 'error', attempts: 2, errorClass: 'TimeoutError' }),
        ],
        error: { message: 'x', errorClass: 'TimeoutError' },
    });
    assert.equal(retried.params.stepId, 's2');
    assert.equal(retried.params.reasonCode, 'timed_out');

    const timeout = buildRunOutcome({ status: 'error', definition, steps: [], error: { message: 'Run hard timeout', errorClass: 'AutomationError' } });
    assert.equal(timeout.params.step, null);
    assert.equal(timeout.text, 'Stopped: the run took longer than its time limit');
});

test('reasonFor: Nextcloud codes, step errorInfo and the unknown fallback', () => {
    assert.equal(reasonFor({ ncCode: 'SESSION_EXPIRED', errorClass: 'PermissionError' }).reasonCode, 'session_expired');
    assert.equal(reasonFor({ errorClass: 'IntegrationError', ncCode: 'NOT_FOUND' }, '/x').reason, '/x was not found');
    assert.deepEqual(reasonFor({ errorInfo: { code: 'folder_not_shared', title: 'The folder is not shared with you.' } }),
        { reasonCode: 'folder_not_shared', reason: 'the folder is not shared with you' });
    assert.deepEqual(reasonFor({}), { reasonCode: 'unexpected', reason: 'something unexpected went wrong' });
    assert.equal(reasonFor({ errorClass: 'guardrail_blocked' }).reasonCode, 'blocked_by_privacy');
});

test('waiting: approval names who, form names the page, confirm and cancelled have fixed sentences', () => {
    const ap = buildRunOutcome({ status: 'awaiting_approval', definition, awaitingStepId: 's4', waitingOn: ['S. de Boer'] });
    assert.deepEqual(ap, {
        code: 'waiting_approval',
        params: { step: 'Finance check', stepId: 's4', who: 'S. de Boer', whoCount: 1 },
        text: 'Waiting for approval from S. de Boer',
    });
    assert.equal(buildRunOutcome({ status: 'awaiting_approval', definition }).text, 'Waiting for approval');
    const form = buildRunOutcome({ status: 'awaiting_form', definition, awaitingStepId: 's5' });
    assert.equal(form.code, 'waiting_form');
    assert.equal(form.params.step, 'Page two');
    assert.equal(buildRunOutcome({ status: 'awaiting_confirm' }).code, 'waiting_confirm');
    assert.deepEqual(buildRunOutcome({ status: 'cancelled', cancelReason: 'already_running' }).params, { reasonCode: 'already_running' });
    assert.equal(buildRunOutcome({ status: 'cancelled' }).text, 'Stopped before it finished');
});

test('joinNames and approvalSeats', () => {
    assert.equal(joinNames(['A', 'B']), 'A and B');
    assert.equal(joinNames(['A', 'B', 'C', 'D', 'E']), 'A, B, C and 2 more');
    assert.equal(joinNames([]), null);
    assert.deepEqual(approvalSeats(null, 'owner'), [{ userId: 'owner' }]);
    assert.deepEqual(approvalSeats({ assigneeGroupId: 'g1' }, 'owner'), [{ groupId: 'g1' }]);
    assert.deepEqual(approvalSeats({ approvers: [{ userId: 'u1' }, { groupId: 'g2' }, {}] }, 'owner'), [{ userId: 'u1' }, { groupId: 'g2' }]);
});

test('resolveRunOutcome reads steps and names through its lookups and never throws', async () => {
    const o = await resolveRunOutcome(
        { runId: 'r1', status: 'awaiting_approval', definition, awaitingStepId: 's4', approval: { approvers: [{ userId: 'u1' }, { groupId: 'g1' }, { userId: 'gone' }] } },
        {
            getRunSteps: async () => [],
            nameOfUser: async (id) => (id === 'u1' ? 'Anna' : (() => { throw new Error('no such user'); })()),
            nameOfGroup: async () => 'Finance',
        },
    );
    assert.equal(o.params.who, 'Anna and Finance');

    const broken = await resolveRunOutcome({ runId: 'r2', status: 'success', definition }, {
        getRunSteps: async () => { throw new Error('db down'); },
    });
    assert.equal(broken.code, 'success');
});

/**
 * A batch that arrived corrupted is called corrupted, and a refused VALUE is
 * never handed back in the resend.
 *
 * Both measured on one live build, 2026-09-16 ("Invoices-Test" routine):
 *
 *  1. The call arrived as
 *     [{…}, {spec, label}, "$filter_files", "array_op", "},{spec:{op:"] —
 *     the second entry's tempId, type and the JSON between them, each as a
 *     bare array element. The batch was refused with `steps[1]: has no
 *     "type"`, which reads as "that step is wrong": the model redesigned a
 *     step that was fine while the actual problem was the transport.
 *
 *  2. A datatable step named "tbl_fact01", which does not exist. The refusal
 *     was right and listed the real ids — and then `resendAs` handed back the
 *     same step, "tbl_fact01" included. The suggestion IS the next call as far
 *     as the model is concerned, so the same refusal comes back.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/addSteps.corruptBatch.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { applyToolCall, emptyDefinition } = require('../builderTools');
const { resolveDatatableRef } = require('./datatableRefs');

const TABLES = [
    { id: 'tbl_ac8bd9ea1182', key: 'facturen', name: 'Facturen', canWrite: true, columns: [{ key: 'path', name: 'Path', type: 'text' }] },
    { id: 'tbl_d1afe9c85640', key: 'facturen_2', name: 'Facturen', canWrite: true, columns: [{ key: 'path', name: 'Path', type: 'text' }] },
];

function freshWrap() {
    return { userId: 'u_test', def: emptyDefinition(), _datatables: TABLES };
}

async function withTrigger() {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    return dw;
}

// ── 1. The mangled batch ────────────────────────────────────────────

test('entries that are not objects are reported as corrupted JSON, not as a wrong step', async () => {
    const dw = await withTrigger();
    const r = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 'list_files', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices-Test' } } } },
            { spec: { op: 'filter', arrayRef: 'steps.$list_files.output.items', expr: "item.type === 'file'" }, label: 'Filter for files only' },
            '$filter_files',
            'array_op',
            '},{spec:{op:',
        ],
    }, dw);

    assert.ok(r.error, 'the call is refused');
    assert.match(r.error, /steps\[2\]/, 'the first junk entry is named by index');
    assert.match(r.error, /corrupted/i, 'and the batch is called what it is');
    assert.doesNotMatch(r.error, /has no "type"/, 'never blamed on the entry that merely lost its type');
    assert.match(r._fixHint, /Resend the SAME steps/, 'the fix is to resend, not to redesign');
    assert.strictEqual(r.added, undefined, 'nothing was applied');
});

test('the junk values are shown, so the model can see what happened to its call', async () => {
    const dw = await withTrigger();
    const r = await applyToolCall('builder_add_steps', { steps: ['},{spec:{op:'] }, dw);
    assert.match(r.error, /\},\{spec:\{op:/, `the debris is quoted back: ${r.error}`);
});

test('a long junk value is cut rather than echoed whole', async () => {
    const dw = await withTrigger();
    const r = await applyToolCall('builder_add_steps', { steps: ['x'.repeat(400)] }, dw);
    assert.ok(r.error.length < 400, `the error stays readable: ${r.error.length} chars`);
    assert.match(r.error, /…/, 'and says it was cut');
});

test('a healthy batch is untouched by the check', async () => {
    const dw = await withTrigger();
    const r = await applyToolCall('builder_add_steps', {
        steps: [{ tempId: 'a', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/x' } } } }],
    }, dw);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.added.length, 1);
});

// ── 2. The refused value is not suggested back ──────────────────────

test('an unknown table id names the field it came from', () => {
    const r = resolveDatatableRef({ id: 'tbl_fact01', datatables: TABLES });
    assert.ok(r.error, 'still refused');
    assert.strictEqual(r._rejectedPath, 'datatableId', 'the refusal says which field carried the bad value');
    assert.match(r._fixHint, /ask the user which one/i, 'with several tables, asking beats guessing');
});

test('resendAs drops the invented datatableId instead of repeating it', async () => {
    const dw = await withTrigger();
    const r = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 'list_files', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/Invoices-Test' } } } },
            { tempId: 'check_dupes', type: 'datatable', spec: { datatableId: 'tbl_fact01', op: 'find_rows', where: [{ field: 'path', op: 'eq', value: { kind: 'literal', value: '/Invoices-Test' } }] } },
        ],
    }, dw);

    assert.ok(r.error, 'the step is still refused');
    assert.strictEqual(r.failedIndex, 1);
    const suggested = r.resendAs.args.steps[0];
    assert.ok(!('datatableId' in suggested.spec), `the refused id is gone from the suggestion: ${JSON.stringify(suggested.spec)}`);
    assert.ok(!JSON.stringify(r.resendAs).includes('tbl_fact01'), 'and nowhere else in it either');
    assert.match(r._fixHint, /"datatableId" REMOVED/, 'the model is told the field was taken out');
    assert.strictEqual(r.added.length, 1, 'the entry that landed stays landed');
    assert.strictEqual(suggested.spec.afterStepId, r.lastAppliedId, 'the anchor still chains it after what was built');
});

test('the rest of the refused step survives the strip, so only the bad value is lost', async () => {
    const dw = await withTrigger();
    const r = await applyToolCall('builder_add_steps', {
        steps: [{ tempId: 'dupes', type: 'datatable', spec: { datatableId: 'tbl_nope01', op: 'find_rows', limit: 5 } }],
    }, dw);
    const spec = r.resendAs.args.steps[0].spec;
    assert.strictEqual(spec.op, 'find_rows');
    assert.strictEqual(spec.limit, 5);
});

test('a refusal that is not about one value leaves the suggestion whole', async () => {
    const dw = await withTrigger();
    const r = await applyToolCall('builder_add_steps', {
        steps: [{ tempId: 'dupes', type: 'datatable', spec: { datatableId: 'tbl_ac8bd9ea1182', op: 'find_rows', where: [{ field: 'nonexistent_column', op: 'eq', value: { kind: 'literal', value: 'x' } }] } }],
    }, dw);
    if (r.error) {
        assert.doesNotMatch(String(r._fixHint || ''), /REMOVED/, 'nothing is stripped when no field was named');
    }
});

// ── 3. A step field at the root of the call ─────────────────────────

test('a step field sent at the root of the call is named, not silently dropped', async () => {
    const dw = await withTrigger();
    const r = await applyToolCall('builder_add_steps', {
        steps: [{ tempId: 'a', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/x' } } } }],
        type: 'integration_action',
    }, dw);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok((r._warnings || []).some((w) => /"type" sat at the root/.test(w)), `the stray key is reported: ${JSON.stringify(r._warnings)}`);
    assert.strictEqual(r.added.length, 1, 'and the batch still lands');
});

test('a clean call carries no root-key note', async () => {
    const dw = await withTrigger();
    const r = await applyToolCall('builder_add_steps', {
        steps: [{ tempId: 'a', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: { path: { kind: 'literal', value: '/x' } } } }],
    }, dw);
    assert.ok(!(r._warnings || []).some((w) => /sat at the root/.test(w)), JSON.stringify(r._warnings));
});

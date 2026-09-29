/**
 * A `resendAs` suggestion must be a call that can actually succeed.
 *
 * It is the SERVER saying "send exactly this ONE call next and nothing else"
 * (see the rung-2 wording in builderTools.rejectionLadder), so a suggestion
 * that repeats the defect is worse than none: the model obeys it, fails for the
 * same reason, and the round is spent.
 *
 * Measured 2026-09-16 on a live "Approve invoices" build. A four-entry batch
 * was refused at entry 2 because its approval prompt read
 * `{{steps.find_invoice.…}}` — a bare handle, which the error correctly
 * explained "is stored verbatim and dangles". The suggestion handed back
 * carried that same bare handle, plus `afterStepId: "set_review"` — a tempId,
 * i.e. the very dangling shape the message warns about — even though the
 * result's own `idMap` already said find_invoice → dt_9df157 and
 * set_review → dt_2b4701.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/resendSuggestion.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveHandlesForResend, resolveAnchor } = require('./tempRefs');

const ID_MAP = { find_invoice: 'dt_9df157', set_review: 'dt_2b4701' };

test('a bare handle in a template body is resolved to the minted id', () => {
    const spec = {
        approval: {
            prompt: 'Approve invoice {{steps.find_invoice.output.rows.0.invoice_number}} from '
                + '{{steps.find_invoice.output.rows.0.supplier}}?',
        },
    };
    const out = resolveHandlesForResend(spec, ID_MAP);
    assert.ok(!out.approval.prompt.includes('steps.find_invoice'), out.approval.prompt);
    assert.match(out.approval.prompt, /steps\.dt_9df157\.output\.rows\.0\.invoice_number/);
    assert.match(out.approval.prompt, /steps\.dt_9df157\.output\.rows\.0\.supplier/);
});

test('the $ form is resolved too — a suggestion may not carry either shape', () => {
    const out = resolveHandlesForResend({ p: 'x {{steps.$set_review.output.ok}} y' }, ID_MAP);
    assert.strictEqual(out.p, 'x {{steps.dt_2b4701.output.ok}} y');
});

test('handles are resolved wherever they sit — nested, in arrays, in ref paths', () => {
    const out = resolveHandlesForResend({
        where: { id: { kind: 'ref', path: 'steps.find_invoice.output.rows.0.id' } },
        list: ['steps.$find_invoice.output', { deep: 'steps.set_review.output' }],
    }, ID_MAP);
    assert.strictEqual(out.where.id.path, 'steps.dt_9df157.output.rows.0.id');
    assert.strictEqual(out.list[0], 'steps.dt_9df157.output');
    assert.strictEqual(out.list[1].deep, 'steps.dt_2b4701.output');
});

test('a name that was never built is left alone, so unknown still reads as unknown', () => {
    const out = resolveHandlesForResend({ p: 'steps.never_built.output' }, ID_MAP);
    assert.strictEqual(out.p, 'steps.never_built.output');
});

test('the anchor is resolved from a tempId, in both its forms', () => {
    assert.strictEqual(resolveAnchor('set_review', ID_MAP), 'dt_2b4701');
    assert.strictEqual(resolveAnchor('$set_review', ID_MAP), 'dt_2b4701');
});

test('an anchor that is already a real id passes through untouched', () => {
    assert.strictEqual(resolveAnchor('dt_2b4701', ID_MAP), 'dt_2b4701');
    assert.strictEqual(resolveAnchor(undefined, ID_MAP), undefined);
});

test('nothing else in the entry is rewritten', () => {
    // Only handles. A label that happens to contain the word "steps" is prose.
    const out = resolveHandlesForResend({ label: 'Two steps to approve', n: 3, on: true }, ID_MAP);
    assert.deepStrictEqual(out, { label: 'Two steps to approve', n: 3, on: true });
});

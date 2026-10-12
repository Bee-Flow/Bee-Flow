/**
 * Dry-run taint: which binding roots read synthesized data.
 *
 * `refIsSynthetic` cut the step id out of a path with
 * `/^steps\.([A-Za-z0-9_-]+)/` and `collectBindingPaths` found the roots of a
 * template or formula with a regex of its own, so a read in the bracket
 * spelling (`steps["read"]…`, `{{ steps['read'].output.id }}`) never counted:
 * a dry run then dispatched a live read with a sample id, the provider error
 * the taint tracking exists to prevent. Both now read with the shared grammar.
 *
 * Run: cd server && node --test core/automationRunner/shared.synthetic.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { refIsSynthetic, collectBindingPaths, stepInputsSynthetic } = require('./shared');

const RUN = {
    steps: { read: { output: { id: 'sample' }, synthesised: true }, real: { output: { id: 'x' } } },
    _syntheticLoopVars: { msg: true },
};
const CTX = { triggerSynthetic: false };

test('a bracketed step read is tainted like the dotted one', () => {
    assert.strictEqual(refIsSynthetic('steps.read.output.id', RUN, CTX), true);
    assert.strictEqual(refIsSynthetic('steps["read"].output.id', RUN, CTX), true);
    assert.strictEqual(refIsSynthetic("steps['read'].output.id", RUN, CTX), true);
    assert.strictEqual(refIsSynthetic('steps.real.output.id', RUN, CTX), false);
    assert.strictEqual(refIsSynthetic('steps.read_more.output.id', RUN, CTX), false);
});

test('a loop variable and the trigger are read the same way', () => {
    assert.strictEqual(refIsSynthetic('loop.msg["content-type"]', RUN, CTX), true);
    assert.strictEqual(refIsSynthetic('loop.other.id', RUN, CTX), false);
    assert.strictEqual(refIsSynthetic('trigger.output.messageId', RUN, { triggerSynthetic: true }), true);
    assert.strictEqual(refIsSynthetic('trigger', RUN, { triggerSynthetic: true }), true);
    assert.strictEqual(refIsSynthetic('triggered.x', RUN, { triggerSynthetic: true }), false);
    assert.strictEqual(refIsSynthetic('vars.x', RUN, { triggerSynthetic: true }), false);
});

test('template and formula reads are found in every spelling', () => {
    const paths = collectBindingPaths({
        a: { kind: 'template', value: 'Mail {{ steps["read"].output.id }} / {{loop.msg.subject}}' },
        b: { kind: 'expr', value: "steps['real'].output.n > 1 && trigger.output.x" },
        c: { kind: 'ref', path: 'steps.real.output.id' },
    });
    const roots = paths.map(p => p.replace(/^(steps|loop)(\.|\[["'])([A-Za-z_]+).*$/, '$1:$3').replace(/^trigger.*$/, 'trigger'));
    assert.deepStrictEqual(roots.sort(), ['loop:msg', 'steps:read', 'steps:real', 'steps:real', 'trigger']);
});

test('a step whose only tainted input is bracketed is synthetic', () => {
    const step = { inputs: { messageId: { kind: 'template', value: '{{ steps["read"].output.id }}' } } };
    assert.strictEqual(stepInputsSynthetic(step, RUN, CTX), true);
    const clean = { inputs: { messageId: { kind: 'template', value: '{{ steps["real"].output.id }}' } } };
    assert.strictEqual(stepInputsSynthetic(clean, RUN, CTX), false);
});

test('a formula read behind a minus sign is tainted (the runner reads it as minus, then the path)', () => {
    const synthetic = (value, ctx = CTX) => stepInputsSynthetic({ inputs: { v: { kind: 'expr', value } } }, RUN, ctx);
    for (const f of ['-steps.read.output.n', '100-steps.read.output.n', 'abs(-steps.read.output.n)', '10*-steps.read.output.n', 'x-loop.msg.id']) {
        assert.strictEqual(synthetic(f), true, f);
    }
    for (const f of ['-trigger.x', '1-trigger', 'trigger']) {
        assert.strictEqual(synthetic(f, { triggerSynthetic: true }), true, f);
        assert.strictEqual(synthetic(f), false, `${f} (real trigger)`);
    }
    // Quoted text is a value, not a read; another step is not this step.
    assert.strictEqual(synthetic("'steps.read'"), false);
    assert.strictEqual(synthetic('"use trigger here"', { triggerSynthetic: true }), false);
    assert.strictEqual(synthetic('-steps.real.output.n'), false);
    // A formula that does not parse is still scanned as text, erring toward
    // synthesising (it resolves to nothing at run time anyway).
    assert.strictEqual(synthetic('steps.read.output.n +'), true);
});

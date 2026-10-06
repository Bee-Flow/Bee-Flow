/**
 * `steps.$handle` resolution, read with the runner's path grammar.
 *
 * The resolver used to find handles with `/\bsteps\.\$(ident)/`, so a handle
 * in the bracket spelling (`steps["$read"]`, which the shared grammar and the
 * canvas both write for an id that needs it) was stored verbatim and dangled,
 * a bare handle in brackets was never reported, and `vars.steps.$x` (a member
 * called `steps`, not the run's steps) was rewritten as if it were one.
 *
 * Run: cd server && node --test automation/builderTools/tempRefs.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { rewriteTempRefs, resolveHandlesForResend } = require('./tempRefs');

const ID_MAP = { read: 'ac_1a2b3c', extract: 'ai_4d5e6f' };

function rewrite(value, idMap = ID_MAP) {
    const missing = [];
    const bare = [];
    const out = rewriteTempRefs(value, idMap, t => missing.push(t), (t, real) => bare.push([t, real]));
    return { out, missing, bare };
}

test('the dotted handle is resolved, the rest of the path kept byte for byte', () => {
    const { out, missing } = rewrite({ p: '{{ steps.$read.output["content-type"] }} and {{steps.$extract.output.items[0].name}}' });
    assert.strictEqual(out.p, '{{ steps.ac_1a2b3c.output["content-type"] }} and {{steps.ai_4d5e6f.output.items[0].name}}');
    assert.deepStrictEqual(missing, []);
});

test('a handle in the bracket spelling is resolved too, quote style kept', () => {
    const { out, missing } = rewrite({
        a: { kind: 'ref', path: 'steps["$read"].output.body' },
        b: "{{steps['$extract'].output.total}}",
    });
    assert.strictEqual(out.a.path, 'steps["ac_1a2b3c"].output.body');
    assert.strictEqual(out.b, "{{steps['ai_4d5e6f'].output.total}}");
    assert.deepStrictEqual(missing, []);
});

test('an unknown bracketed handle is reported as missing, not stored verbatim', () => {
    const { out, missing } = rewrite({ a: { kind: 'ref', path: 'steps["$nope"].output.x' } });
    assert.deepStrictEqual(missing, ['nope']);
    assert.strictEqual(out.a.path, 'steps["$nope"].output.x');
});

test('a bare handle in brackets is reported like the dotted one', () => {
    const { bare } = rewrite({ a: '{{ steps["read"].output.x }}' });
    assert.deepStrictEqual(bare, [['read', 'ac_1a2b3c']]);
});

test('a member called steps is not a step address', () => {
    const { out, missing, bare } = rewrite({ a: '{{vars.steps.$read.x}}', b: 'my_steps.$read' });
    assert.strictEqual(out.a, '{{vars.steps.$read.x}}');
    assert.strictEqual(out.b, 'my_steps.$read');
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual(bare, []);
});

test('a handle inside an expression is resolved; a longer id is not a prefix match', () => {
    const { out } = rewrite({ expr: 'steps.$read.output.n-1 > 0 && steps.$read_more == null' }, { read: 'r_1', read_more: 'r_2' });
    assert.strictEqual(out.expr, 'steps.r_1.output.n-1 > 0 && steps.r_2 == null');
});

test('a handle named after an Object member never resolves to it', () => {
    const { missing } = rewrite({ a: 'steps.$constructor.output' }, {});
    assert.deepStrictEqual(missing, ['constructor']);
});

test('resend: bracketed handles in both forms resolve to the minted id', () => {
    const out = resolveHandlesForResend({ a: '{{steps["read"].output.x}}', b: "steps['$extract'].output" }, ID_MAP);
    assert.strictEqual(out.a, '{{steps["ac_1a2b3c"].output.x}}');
    assert.strictEqual(out.b, "steps['ai_4d5e6f'].output");
});

// REGRESSION (review 2026-10): the path-reader rewrite skipped any `steps`
// right after a `$` or a `.`, so the model's `$steps.$calc…` / `.steps.$calc…`
// dialect (which aiPaths repairs) was no longer resolved, no handle was
// reported missing, and the dangling `steps.$calc` surfaced at finalize.
test('a leading $ or dot before steps still addresses a step; the prefix is kept byte for byte', () => {
    const { out, missing } = rewrite({
        a: { kind: 'ref', path: '$steps.$read.output.x' },
        b: '{{$steps.$read.output.x}}',
        c: '{{ $steps.$extract.output.total }}',
        d: '.steps.$read.output.x',
        e: '$$steps.$read.output',
    });
    assert.strictEqual(out.a.path, '$steps.ac_1a2b3c.output.x');
    assert.strictEqual(out.b, '{{$steps.ac_1a2b3c.output.x}}');
    assert.strictEqual(out.c, '{{ $steps.ai_4d5e6f.output.total }}');
    assert.strictEqual(out.d, '.steps.ac_1a2b3c.output.x');
    assert.strictEqual(out.e, '$$steps.ac_1a2b3c.output');
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual(rewrite({ a: '$steps.$nope.output' }).missing, ['nope']);
    assert.deepStrictEqual(rewrite({ a: '$steps.read.output' }).bare, [['read', 'ac_1a2b3c']]);
    assert.deepStrictEqual(resolveHandlesForResend({ a: '.steps.$read.output' }, ID_MAP), { a: '.steps.ac_1a2b3c.output' });
});

test('a $ or dot run that is itself the tail of a name or member is still not a start', () => {
    const { out, missing, bare } = rewrite({ a: 'vars.$steps.$read.x', b: 'x[0].steps.$read', c: 'a$steps.$read' });
    assert.deepStrictEqual(out, { a: 'vars.$steps.$read.x', b: 'x[0].steps.$read', c: 'a$steps.$read' });
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual(bare, []);
});

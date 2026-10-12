/**
 * The live-build harness compares a stored binding with the brief's
 * expectation by the path the RUN reads, not by its spelling.
 *
 * It recognised a ref expectation with `/^(loop|steps|trigger|vars|secrets)\./`
 * and compared strings byte for byte. The builder now stores paths in the
 * canonical spelling (`items[0].name`, `["content-type"]`), so a brief written
 * `items.0.name` reported a correct build as a mismatch, and an expectation in
 * the bracket spelling (`steps["a b"]…`) was taken for a literal.
 *
 * Run: cd server && node --test scripts/drive-builder.paths.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { bindingMismatch } = require('./drive-builder');

test('a stored canonical path matches an expectation in another spelling of the same path', () => {
    assert.strictEqual(bindingMismatch({ kind: 'ref', path: 'steps.a_1.output.items[0].name' }, 'steps.a_1.output.items.0.name'), null);
    assert.strictEqual(bindingMismatch({ kind: 'ref', path: 'loop.f["content-type"]' }, "loop.f['content-type']"), null);
    assert.strictEqual(bindingMismatch({ kind: 'ref', path: 'steps.a_1.output.items[0].name' }, 'steps.a_1.output.items[1].name'),
        'expected ref steps.a_1.output.items[1].name, got ref steps.a_1.output.items[0].name');
});

test('an expectation in the bracket spelling is a ref, not a literal', () => {
    assert.strictEqual(bindingMismatch({ kind: 'ref', path: 'steps["a 1"].output.x' }, 'steps["a 1"].output.x'), null);
    assert.match(bindingMismatch({ kind: 'literal', value: 'steps["a 1"].output.x' }, 'steps["a 1"].output.x'), /^expected ref/);
});

test('plain text is still a literal expectation', () => {
    assert.strictEqual(bindingMismatch({ kind: 'literal', value: 'steps to take' }, 'steps to take'), null);
    assert.strictEqual(bindingMismatch({ kind: 'literal', value: 4 }, 4), null);
});

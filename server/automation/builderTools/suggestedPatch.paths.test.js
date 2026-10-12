/**
 * _suggestedPatch op paths, read with the shared path grammar.
 *
 * The patch path parser split on dots and accepted `[n]` / `[?]` only, so a
 * key holding a dot or a bracket (a column called "e.mail", an input called
 * "items[]") could not be addressed at all, and a quoted key the canonical
 * writer emits (`values["Story Points"]`) was "malformed": the server's own
 * fix for that binding was skipped. Paths are now read with
 * shared/expr/path.mjs, plus the `[?]` entry placeholder this module adds.
 * Everything the old grammar accepted keeps its meaning (see
 * suggestedPatch.test.js, which pins it).
 *
 * Run: cd server && node --test automation/builderTools/suggestedPatch.paths.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parsePath, applyPatchOps, liftEntryPatch, canonicalJson } = require('./suggestedPatch');

test('quoted keys, in either quote style, hold dots, brackets and spaces', () => {
    assert.deepStrictEqual(parsePath('values["e.mail"]'), [{ key: 'values' }, { key: 'e.mail' }]);
    assert.deepStrictEqual(parsePath("inputs['items[]'].x"), [{ key: 'inputs' }, { key: 'items[]' }, { key: 'x' }]);
    assert.deepStrictEqual(parsePath('steps[?].spec.values["Story Points"]'), [{ key: 'steps' }, { index: '?' }, { key: 'spec' }, { key: 'values' }, { key: 'Story Points' }]);
    assert.deepStrictEqual(parsePath('["odd key"][0]'), [{ key: 'odd key' }, { index: 0 }]);
});

test('what the old grammar accepted is read the same', () => {
    assert.deepStrictEqual(parsePath('inputs.values.Story Points'), [{ key: 'inputs' }, { key: 'values' }, { key: 'Story Points' }]);
    assert.deepStrictEqual(parsePath('inputs.0'), [{ key: 'inputs' }, { key: '0' }]);
    assert.deepStrictEqual(parsePath('a-b.c'), [{ key: 'a-b' }, { key: 'c' }]);
});

test('what a patch cannot mean is refused', () => {
    assert.strictEqual(parsePath('values[*]'), null);
    assert.strictEqual(parsePath('values[name="x"]'), null);
    assert.strictEqual(parsePath('values[-1]'), null);
    assert.strictEqual(parsePath('values["unterminated]'), null);
    assert.strictEqual(parsePath('.x'), null);
    assert.strictEqual(parsePath('a..b'), null);
    assert.strictEqual(parsePath('a[0]x'), null);
});

test('a set on a quoted key lands on that key, and the line names it so it reads back', () => {
    const { args, applied, skipped } = applyPatchOps({ values: {} }, [{ op: 'set', path: 'values["e.mail"]', value: { kind: 'ref', path: 'loop.r.email' } }]);
    assert.deepStrictEqual(skipped, []);
    assert.deepStrictEqual(args.values, { 'e.mail': { kind: 'ref', path: 'loop.r.email' } });
    assert.match(applied[0], /^values\["e\.mail"\] = /);
});

test('a lifted op with a quoted key still finds its batch entry', () => {
    const entry = { type: 'datatable', spec: { values: { 'Story Points': { kind: 'ref', path: 'loop.x' } } } };
    const patch = liftEntryPatch({ ops: [{ op: 'set', path: 'values["Story Points"]', value: { kind: 'ref', path: 'loop.r.points' } }] }, 0, entry);
    assert.strictEqual(patch.ops[0].path, 'steps[0].spec.values["Story Points"]');
    assert.strictEqual(patch.ops[0].entrySig, canonicalJson(entry));
    // The batch comes back with an entry in front of it: the signature finds it.
    const res = applyPatchOps({ steps: [{ type: 'note' }, entry] }, patch);
    assert.deepStrictEqual(res.skipped, []);
    assert.deepStrictEqual(res.args.steps[1].spec.values['Story Points'], { kind: 'ref', path: 'loop.r.points' });
});

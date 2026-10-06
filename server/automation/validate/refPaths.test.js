'use strict';

/**
 * The validator's readers agree with the runner's: shared/expr path grammar
 * for paths and placeholders, the expression engine for expressions.
 *
 * Run: node --test automation/validate/refPaths.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    refHead, templateRefs, hasPlaceholder, isBareRefString, relativePathTokens, splitPathHead,
    findRefPaths, suggestPathSpelling, suggestExprSpelling, tryParseExpr, exprStepIds,
} = require('./refPaths');
const { getRelativePath, parsePath } = require('../expr');

test('refHead: root and step id for every spelling, the head read even when the tail breaks', () => {
    assert.deepStrictEqual([refHead('steps.s1.output.x').root, refHead('steps.s1.output.x').second], ['steps', 's1']);
    assert.strictEqual(refHead('steps["s1"].output').second, 's1');
    assert.strictEqual(refHead("steps['s 1'].output").second, 's 1');
    assert.strictEqual(refHead('loop.item.name').second, 'item');
    const broken = refHead('steps.s1.output.Story Points');
    assert.strictEqual(broken.valid, false);
    assert.strictEqual(broken.second, 's1');
    // A match segment is part of the grammar; on the root it is not a step id.
    assert.strictEqual(refHead('steps.s1.output.headers[name="Subject"].value').valid, true);
    assert.strictEqual(refHead('steps[id="s1"]').second, null);
});

test('templateRefs is quote-aware like the runner', () => {
    assert.deepStrictEqual(templateRefs('a {{ x.y }} b {{x["a}}b"]}} c {{}}'), ['x.y', 'x["a}}b"]']);
    assert.strictEqual(hasPlaceholder('{{steps.s1.output["a}b"]}}'), true);
    assert.strictEqual(hasPlaceholder('no {{ placeholder'), false);
});

test('isBareRefString matches the runner\'s reading of a bare data_extraction source', () => {
    assert.strictEqual(isBareRefString(' steps.s1.output.text '), true);
    assert.strictEqual(isBareRefString('loop.f.content'), true);
    assert.strictEqual(isBareRefString('secrets.key'), false);
    assert.strictEqual(isBareRefString('Some literal text'), false);
    assert.strictEqual(isBareRefString('stepsfoo.x'), false);
});

test('relativePathTokens accepts exactly what getRelativePath resolves', () => {
    const value = { order: { id: 7, 'content-type': 'json', lines: [{ sku: 'a' }, { sku: 'b' }] }, '$x': 1 };
    const cases = ['', '$', 'order.id', '$.order.id', '$["order"].id', 'order["content-type"]', 'order.lines[*].sku',
        'order.lines.0.sku', 'order.lines[-1].sku', 'order.lines[sku="b"].sku', '$x', 'order.missing'];
    for (const p of cases) assert.ok(relativePathTokens(p) !== null, `${p} reads`);
    for (const p of ['a b', 'items[', 'a..b', '$.', '.a']) {
        assert.strictEqual(relativePathTokens(p), null, `${p} does not read`);
        assert.strictEqual(getRelativePath(value, p), undefined, `${p}: and the runner agrees`);
    }
    assert.strictEqual(getRelativePath(value, '$.order.id'), 7, 'the JSONPath habit resolves at run time…');
    assert.deepStrictEqual(relativePathTokens('$.order.id').map(t => t.key), ['order', 'id'], '…and validates as the same path');
});

test('splitPathHead keeps the tail exactly as written', () => {
    assert.deepStrictEqual(splitPathHead('steps.read.output.files.0.name', 3).rest, 'files.0.name');
    assert.deepStrictEqual(splitPathHead('steps["read"].output[0]["a b"]', 3).rest, '[0]["a b"]');
    assert.deepStrictEqual(splitPathHead('steps.read.output', 3).rest, '');
    assert.strictEqual(splitPathHead('steps.read', 3), null);
});

test('findRefPaths finds every root in text, bracketed keys included, members excluded', () => {
    const found = findRefPaths('Hi {{trigger.output["e-mail"]}} and {{ vars.trigger.x }} / steps.s1.output.a', ['trigger', 'steps']);
    assert.deepStrictEqual(found.map(t => t.map(x => x.key)), [['trigger', 'output', 'e-mail'], ['steps', 's1', 'output', 'a']]);
});

test('suggestPathSpelling: the spelling the runner would read', () => {
    assert.strictEqual(suggestPathSpelling('steps.s1.output.fields.Story Points'), 'steps.s1.output.fields["Story Points"]');
    assert.strictEqual(suggestPathSpelling('steps.s1.output.items[abc].name'), 'steps.s1.output.items.abc.name');
    assert.strictEqual(suggestPathSpelling('steps.s1.output.items[0'), 'steps.s1.output.items[0]');
    assert.strictEqual(suggestPathSpelling('steps.s1.output..x.'), 'steps.s1.output.x');
    assert.strictEqual(suggestPathSpelling('steps.s1.output.a b.c[1]'), 'steps.s1.output["a b"].c[1]');
    // Nothing to suggest for a valid path, or for a calculation.
    assert.strictEqual(suggestPathSpelling('steps.s1.output.headers[name="x"].value'), null);
    assert.strictEqual(suggestPathSpelling('steps.s1.output.x | upper'), null);
    assert.strictEqual(suggestPathSpelling('steps.s1.output.x + 1'), null);
    for (const p of ['steps.s1.output.fields.Story Points', 'a[b]', 'x[0']) {
        const s = suggestPathSpelling(p);
        assert.ok(s === null || parsePath(s), `${p} → ${s} parses`);
    }
});

test('suggestExprSpelling: a path the expression grammar cannot read, or {{ }} around it', () => {
    assert.strictEqual(suggestExprSpelling('trigger.output.attachments.0.filename'), 'trigger.output.attachments[0].filename');
    assert.strictEqual(suggestExprSpelling('steps.s1.output.first-name'), 'steps.s1.output["first-name"]');
    assert.strictEqual(suggestExprSpelling('{{steps.s1.output.total}} > 5000'), 'steps.s1.output.total > 5000');
    assert.strictEqual(suggestExprSpelling('a +'), null);
});

test('exprStepIds: the steps an expression reads, never a quoted text or a match value', () => {
    const ids = (src) => exprStepIds(tryParseExpr(src).ast);
    assert.deepStrictEqual(ids('steps.a.output.x > steps["b"].output.y'), ['a', 'b']);
    assert.deepStrictEqual(ids('steps.a.output.note == "steps.zzz"'), ['a']);
    assert.deepStrictEqual(ids('steps.a.output.list[id="zzz"].v'), ['a']);
    assert.deepStrictEqual(ids('max(steps.a.output.n, 1) + vars.steps.q'), ['a']);
    assert.deepStrictEqual(ids('steps.a.output.items[steps.b.output.i]'), ['a', 'b']);
    assert.ok(tryParseExpr('a +').error);
});

/**
 * fields.mjs: SourceNodes from samples and schemas, the real overlay, and the
 * property that matters most: every node's legacy path resolves, through the
 * runtime's own walker, to the value its Source names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walkPath } from './legacy.mjs';
import { formatPath, isWild } from './source.mjs';
import {
    MAX_DEPTH, fieldsFromSample, textChildren, sampleFromSchema, overlayReal, deepOverlay, hasPath,
    previewOf, shapeOfSample,
} from './fields.mjs';

/** Every node of a field tree, depth first. */
function allNodes(fields) {
    const out = [];
    const visit = (f) => { out.push(f); (f.children || []).forEach(visit); };
    (fields || []).forEach(visit);
    return out;
}

/** The value a Source path names in `value`, `[*]` flattening one level like the walker. */
function valueAt(value, segs) {
    let cur = value;
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (isWild(seg)) {
            if (!Array.isArray(cur)) return undefined;
            const out = [];
            for (const el of cur) {
                const m = valueAt(el, segs.slice(i + 1));
                if (m === undefined) continue;
                if (Array.isArray(m)) out.push(...m); else out.push(m);
            }
            return out;
        }
        if (cur == null || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

const AWKWARD = {
    'Order date': '2026-01-01',
    'first-name': 'Jan',
    'a.b': 'dotted',
    'a"b': 'double quote',
    "it's": 'single quote',
    '*': 'star',
    'back\\slash': 'backslash',
    plain: { 'E-mail adres': 'jan@example.nl', nested: { 'zip code': '1234 AB' } },
    'line-items': [
        { 'unit price': 10, sku: 'A', tags: ['x'] },
        { 'unit price': 12, sku: 'B', extra: { 'deep key': true } },
    ],
};

test('property: every node path resolves through the legacy walker to the value its Source names', () => {
    const root = { steps: { s1: { output: AWKWARD } } };
    const nodes = allNodes(fieldsFromSample(AWKWARD, 'steps.s1.output'));
    assert.ok(nodes.length > 12);
    for (const n of nodes) {
        assert.equal(formatPath(n.source), n.path, `formatPath(source) is the node's path: ${n.path}`);
        const legacy = walkPath(n.path, root);
        assert.notEqual(legacy, undefined, `resolves at run time: ${n.path}`);
        assert.deepStrictEqual(legacy, valueAt(AWKWARD, n.source.path), `same value: ${n.path}`);
    }
});

test('keys with spaces, dots, quotes, a star and a hyphen are all offered, escaped', () => {
    const paths = fieldsFromSample(AWKWARD, 'steps.s1.output').map(f => f.path);
    assert.ok(paths.includes('steps.s1.output["Order date"]'));
    assert.ok(paths.includes('steps.s1.output["first-name"]'));
    assert.ok(paths.includes('steps.s1.output["a.b"]'));
    assert.ok(paths.includes(`steps.s1.output['a"b']`));
    assert.ok(paths.includes(`steps.s1.output["it's"]`));
    assert.ok(paths.includes('steps.s1.output["*"]'));
    assert.ok(paths.includes('steps.s1.output["back\\slash"]'));
});

test('keys the grammar cannot write, and an own __proto__, are left out', () => {
    const sample = JSON.parse('{"a]b":1,"x\\"y\'z":2,"__proto__":3,"ok":5}');
    assert.deepStrictEqual(fieldsFromSample(sample, 'trigger.output').map(f => f.key), ['ok']);
});

test('own keys named like built-ins (length, constructor, prototype) are offered and resolve', () => {
    // Regression: these were refused although the runtime walker resolves
    // every own key, so a product's or a video's `length` dropped out.
    const sample = { product: { length: 12, width: 3, constructor: 'x', prototype: 'p' } };
    const [product] = fieldsFromSample(sample, 'steps.a.output');
    assert.deepStrictEqual(product.children.map(f => f.key), ['length', 'width', 'constructor', 'prototype']);
    const root = { steps: { a: { output: sample } } };
    for (const f of product.children) assert.equal(walkPath(f.path, root), sample.product[f.key]);
    const [len] = fieldsFromSample({ length: 5 }, 'trigger.output');
    assert.equal(len.path, 'trigger.output.length');
    assert.equal(walkPath(len.path, { trigger: { output: { length: 5 } } }), 5);
});

test('objects open at any depth up to MAX_DEPTH', () => {
    let deep = { leaf: 1 };
    for (let i = 0; i < 10; i++) deep = { [`l${i}`]: deep };
    const nodes = allNodes(fieldsFromSample(deep, 'trigger.output'));
    assert.equal(Math.max(...nodes.map(n => n.labelParts.length)), MAX_DEPTH);
    const nested = fieldsFromSample({ Klant: { Adres: { Postcode: '1234' } } }, 'trigger.output');
    assert.equal(nested[0].children[0].children[0].path, 'trigger.output.Klant.Adres.Postcode');
    assert.deepStrictEqual(nested[0].children[0].children[0].labelParts.map(p => p.text), ['Klant', 'Adres', 'Postcode']);
});

test('a list of objects opens to its columns before any run; a plain list does not', () => {
    const [lines, tags] = fieldsFromSample({ lines: [{ sku: 'A' }, { sku: 'B', qty: 2 }], tags: ['a', 'b'] }, 'steps.s.output');
    assert.equal(lines.shape, 'table');
    assert.equal(lines.count, 2);
    assert.deepStrictEqual(lines.children.map(c => c.path), ['steps.s.output.lines[*].sku', 'steps.s.output.lines[*].qty']);
    assert.ok(isWild(lines.children[0].source.path[1]));
    assert.deepStrictEqual(lines.children[0].labelParts, [{ key: 'lines', text: 'Lines' }, { each: true }, { key: 'sku', text: 'Sku' }]);
    assert.equal(tags.shape, 'list');
    assert.equal(tags.children, undefined);
});

test('a JSON string is a json shape whose children come from the text, never as a legacy path', () => {
    const [body] = fieldsFromSample({ body: '{"id": 7, "customer": {"name": "Jan"}}' }, 'steps.h.output');
    assert.equal(body.shape, 'json');
    assert.equal(body.children, undefined, 'the legacy walker cannot read into a string');
    const kids = textChildren(body);
    assert.deepStrictEqual(kids.map(k => k.key), ['id', 'customer']);
    assert.equal(kids[0].path, null);
    assert.equal(kids[0].fromText, true);
    assert.deepStrictEqual(kids[1].children[0].source, { root: 'steps', id: 'h', path: ['body', 'customer', 'name'] });
    assert.deepStrictEqual(textChildren({ sample: 'plain text' }), []);
    assert.deepStrictEqual(textChildren({ sample: '[1, 2' }), []);
});

test('shapes and previews are language-free', () => {
    assert.equal(shapeOfSample(undefined), 'missing');
    assert.equal(shapeOfSample('x'), 'scalar');
    assert.equal(shapeOfSample(null), 'scalar');
    assert.equal(shapeOfSample({}), 'object');
    assert.equal(shapeOfSample([1]), 'list');
    assert.equal(shapeOfSample([{ a: 1 }]), 'table');
    assert.equal(shapeOfSample('[{"a":1}]'), 'json');
    assert.equal(previewOf('jan@voorbeeld.nl'), 'jan@voorbeeld.nl');
    assert.equal(previewOf('<parsed body>'), '');
    assert.equal(previewOf(42), '42');
    assert.equal(previewOf(false), 'false');
    assert.equal(previewOf({ a: 1 }), '');
    assert.equal(previewOf('x'.repeat(100)).length, 60);
    assert.equal(previewOf('two\n  lines'), 'two lines');
});

test('sampleFromSchema keeps nested objects and list items', () => {
    assert.deepStrictEqual(
        sampleFromSchema({ type: 'object', properties: {
            invoices: { type: 'array', items: { type: 'object', properties: { amount: { type: 'number' }, vendor: { type: 'string' } } } },
            meta: { type: 'object', properties: { pages: { type: 'integer' } } },
            tags: { type: 'array', items: { type: 'string' } },
            flag: { type: 'boolean' },
        } }),
        { invoices: [{ amount: 0, vendor: '<string>' }], meta: { pages: 0 }, tags: ['<string>'], flag: false },
    );
    assert.deepStrictEqual(sampleFromSchema({ urgency: 'string', score: 'number' }), { urgency: '<string>', score: 0 });
    assert.deepStrictEqual(sampleFromSchema([{ key: 'summary', type: 'string' }, { name: 'count', type: 'number' }]), { summary: '<string>', count: 0 });
    assert.equal(sampleFromSchema({ type: 'object' }), null);
    assert.equal(sampleFromSchema(null), null);
    assert.equal(sampleFromSchema([]), null);
});

test('overlayReal marks the keys a real output lacks, at any depth', () => {
    const fields = fieldsFromSample({ status: 200, data: '<parsed body>', rows: [{ a: 1, gone: 2 }] }, 'steps.h.output');
    const marked = overlayReal(fields, { status: 200, rows: [{ a: 5 }] });
    const byPath = Object.fromEntries(allNodes(marked).map(f => [f.path, f.confirmed]));
    assert.deepStrictEqual(byPath, {
        'steps.h.output.status': true,
        'steps.h.output.data': false,
        'steps.h.output.rows': true,
        'steps.h.output.rows[*].a': true,
        'steps.h.output.rows[*].gone': false,
    });
});

test('hasPath and deepOverlay', () => {
    assert.equal(hasPath({ a: [{ b: 1 }, {}] }, ['a', { wild: true }, 'b']), true);
    assert.equal(hasPath({ a: [{}, {}] }, ['a', { wild: true }, 'b']), false);
    assert.equal(hasPath({ a: [1, 2] }, ['a', 1]), true);
    assert.equal(hasPath({ a: [1, 2] }, ['a', 'length']), false);
    assert.equal(hasPath('text', ['data']), false);
    assert.deepStrictEqual(deepOverlay({ a: 1, b: { c: 1, d: 2 } }, { b: { c: 9 }, e: 3 }), { a: 1, b: { c: 9, d: 2 }, e: 3 });
    assert.deepStrictEqual(deepOverlay({ a: 1 }, [1]), [1]);
});

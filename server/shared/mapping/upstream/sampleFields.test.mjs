/**
 * sampleFields.mjs: the field helpers every describer shares, and the one
 * place a path is written. Every path offered must pass the runtime's own
 * gate (legacy.mjs REF_RE) and resolve through its walker.
 *
 * REGRESSION: every ref path used to be built by raw `${base}.${key}`. A JSON
 * key like "line-items" then produced `…output.line-items`, which the
 * runtime rejects outright, so a Loop or Filter bound to such a list looked
 * perfect at design time and failed every run with "arrayRef did not resolve
 * to an array".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REF_RE, walkPath } from '../legacy.mjs';
import { collectArrayPaths, resolveElementSample, elementFieldOptions, sampleToFields } from './index.mjs';

const pick = ({ key, path, sample }) => ({ key, path, sample });

// ── collectArrayPaths ───────────────────────────────────

const GROUPS = [{
    id: 's1', label: 'Gmail', kind: 'integration_action', basePath: 'steps.s1.output',
    fields: [
        { key: 'query', path: 'steps.s1.output.query', sample: 'q' },
        { key: 'results', path: 'steps.s1.output.results', sample: [{ id: 1 }] },
        {
            key: 'meta', path: 'steps.s1.output.meta', sample: { tags: ['a'] },
            children: [{ key: 'tags', path: 'steps.s1.output.meta.tags', sample: ['a'] }],
        },
    ],
}];

test('collectArrayPaths finds top-level array fields and nested children arrays', () => {
    assert.deepStrictEqual(collectArrayPaths(GROUPS).map(pick), [
        { key: 'results', path: 'steps.s1.output.results', sample: [{ id: 1 }] },
        { key: 'tags', path: 'steps.s1.output.meta.tags', sample: ['a'] },
    ]);
});

test('collectArrayPaths surfaces arrays that exist only in the preview sample overlay', () => {
    const previewSample = { steps: { s1: { output: { extra: [1, 2] } } } };
    const extra = collectArrayPaths(GROUPS, previewSample).find(p => p.path === 'steps.s1.output.extra');
    assert.deepStrictEqual(pick(extra), { key: 'extra', path: 'steps.s1.output.extra', sample: [1, 2] });
});

test('collectArrayPaths dedupes by path when the overlay repeats a design-time array', () => {
    const previewSample = { steps: { s1: { output: { results: [{ id: 9 }], extra: [1, 2] } } } };
    const out = collectArrayPaths(GROUPS, previewSample);
    const results = out.filter(p => p.path === 'steps.s1.output.results');
    assert.equal(results.length, 1);
    // The design-time sample wins (fields are scanned before the overlay).
    assert.deepStrictEqual(results[0].sample, [{ id: 1 }]);
    assert.deepStrictEqual(out.map(p => p.path), ['steps.s1.output.results', 'steps.s1.output.meta.tags', 'steps.s1.output.extra']);
});

test('collectArrayPaths offers a runtime-resolvable path for an overlay-only array', () => {
    const groups = [{ id: 's1', kind: 'http_request', basePath: 'steps.s1.output', fields: [] }];
    const previewSample = { steps: { s1: { output: { 'line-items': [{ sku: 'a1' }] } } } };
    const out = collectArrayPaths(groups, previewSample);
    assert.equal(out.length, 1);
    assert.equal(out[0].path, 'steps.s1.output["line-items"]');
    assert.ok(REF_RE.test(out[0].path));
    assert.deepStrictEqual(walkPath(out[0].path, previewSample), [{ sku: 'a1' }]);
});

// ── resolveElementSample / elementFieldOptions ──────────

test('resolveElementSample resolves a plain array ref to its first element', () => {
    const root = { steps: { s1: { output: { results: [{ a: 1 }] } } } };
    assert.deepStrictEqual(resolveElementSample('steps.s1.output.results', root), { a: 1 });
});

test('resolveElementSample is null for an empty array or a path that does not resolve', () => {
    assert.equal(resolveElementSample('steps.s1.output.results', { steps: { s1: { output: { results: [] } } } }), null);
    const root = { steps: { s1: { output: { results: [{ a: 1 }] } } } };
    assert.equal(resolveElementSample('steps.s1.output.nope', root), null);
    assert.equal(resolveElementSample('steps.zzz.output.results', root), null);
    assert.equal(resolveElementSample('', root), null);
    assert.equal(resolveElementSample('steps.s1.output.results', null), null);
});

test('resolveElementSample works through a [*] flatten (an element of the flattened array)', () => {
    const root = { steps: { s1: { output: { results: [{ tags: ['x', 'y'] }, { tags: ['z'] }] } } } };
    // results[*].tags flatten-maps to ['x','y','z'] → its first element.
    assert.equal(resolveElementSample('steps.s1.output.results[*].tags', root), 'x');
});

test('elementFieldOptions lists the top-level keys of an object element, and nothing for anything else', () => {
    assert.deepStrictEqual(elementFieldOptions({ email: 'a@b.c', amount: 5 }), [
        { key: 'email', sample: 'a@b.c' },
        { key: 'amount', sample: 5 },
    ]);
    for (const v of ['str', 42, [{ a: 1 }], null, undefined]) assert.deepStrictEqual(elementFieldOptions(v), []);
});

// ── sampleToFields ──────────────────────────────────────

test('sampleToFields brackets non-identifier keys, at top level and one level down', () => {
    const fields = sampleToFields(
        { ok: 1, 'line-items': 'x', meta: { 'content-type': 'application/json', plain: 1 } },
        'steps.s1.output',
    );
    const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
    assert.equal(byKey.ok.path, 'steps.s1.output.ok');
    assert.equal(byKey['line-items'].path, 'steps.s1.output["line-items"]');
    const children = Object.fromEntries(byKey.meta.children.map(c => [c.key, c.path]));
    assert.equal(children['content-type'], 'steps.s1.output.meta["content-type"]');
    assert.equal(children.plain, 'steps.s1.output.meta.plain');
    for (const f of fields) assert.ok(REF_RE.test(f.path), f.path);
});

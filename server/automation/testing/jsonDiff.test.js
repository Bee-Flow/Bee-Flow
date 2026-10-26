// @typecheck strict
'use strict';
/**
 * The structural diff the run compare is built on.
 * Run: cd server && node --test automation/testing/jsonDiff.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { diffJson } = require('./jsonDiff');

/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {Parameters<typeof diffJson>[2]} [opts]
 */
const diff = async (a, b, opts) => (await diffJson(a, b, opts)).changes;

test('equal values give no changes', async () => {
    const v = { a: 1, b: [1, { c: 'x' }], d: /** @type {null} */ (null) };
    const out = await diffJson(v, JSON.parse(JSON.stringify(v)));
    assert.deepStrictEqual(out, { changes: [], truncated: false });
});

test('added, removed, changed and type_changed, with paths and JSON text values', async () => {
    const changes = await diff(
        { keep: 1, gone: 'x', name: 'old', n: 1, nested: { deep: [1, 2] } },
        { keep: 1, name: 'new', n: '1', added: true, nested: { deep: [1, 3] } },
    );
    assert.deepStrictEqual(changes, [
        { path: 'gone', change: 'removed', before: '"x"' },
        { path: 'name', change: 'changed', before: '"old"', after: '"new"' },
        { path: 'n', change: 'type_changed', before: '1', after: '"1"' },
        { path: 'nested.deep[1]', change: 'changed', before: '2', after: '3' },
        { path: 'added', change: 'added', after: 'true' },
    ]);
});

test('an object turning into an array is a type change', async () => {
    const changes = await diff({ v: { a: 1 } }, { v: [1] });
    assert.deepStrictEqual(changes.map(c => [c.path, c.change]), [['v', 'type_changed']]);
});

test('null is its own type', async () => {
    const changes = await diff({ v: null }, { v: {} });
    assert.strictEqual(changes[0].change, 'type_changed');
});

test('arrays compare by index plus one length change', async () => {
    const changes = await diff({ items: [1, 2, 3] }, { items: [1, 9] });
    assert.deepStrictEqual(changes, [
        { path: 'items[1]', change: 'changed', before: '2', after: '9' },
        { path: 'items.length', change: 'changed', before: '3', after: '2' },
    ]);
});

test('a root array and keys that need quoting use the shared path format', async () => {
    const changes = await diff([{ 'a b': 1 }], [{ 'a b': 2 }]);
    assert.strictEqual(changes[0].path, '[0]["a b"]');
});

test('meta keys of a dry run and the full-output reference are ignored at any depth', async () => {
    const a = { x: 1, _dryRun: true, wouldHaveCalled: [{ tool: 't' }], inner: { httpCalls: [1], _fromScenario: true, fullOutputRef: { runId: 'r1' }, v: 1 } };
    const b = { x: 1, inner: { v: 1, _dryRunSyntheticInputs: true }, httpCalls: [2, 3] };
    assert.deepStrictEqual(await diff(a, b), []);
});

test('ignorePaths skips an exact path and everything below it, nothing else', async () => {
    const a = { id: 'a', meta: { at: 1, who: 'x' }, list: [{ t: 1 }], metadata: 1 };
    const b = { id: 'b', meta: { at: 2, who: 'y' }, list: [{ t: 2 }], metadata: 2 };
    const changes = await diff(a, b, { ignorePaths: ['id', 'meta', 'list[0].t'] });
    assert.deepStrictEqual(changes.map(c => c.path), ['metadata']);
});

test('values are cut to 200 characters of JSON text', async () => {
    const long = 'x'.repeat(500);
    const [c] = await diff({ s: long }, { s: 'short' });
    assert.ok((c.before?.length ?? 0) <= 200);
    assert.ok(c.before?.endsWith('…'));
    assert.strictEqual(c.after, '"short"');
    const [added] = await diff({}, { big: { list: Array.from({ length: 200 }, (_, i) => i) } });
    assert.ok((added.after?.length ?? 0) <= 200);
});

test('the cap stops the walk and sets truncated', async () => {
    const a = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    const b = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i + 1]));
    const out = await diffJson(a, b, { maxChanges: 5 });
    assert.strictEqual(out.changes.length, 5);
    assert.strictEqual(out.truncated, true);
    const exact = await diffJson({ a: 1, b: 1 }, { a: 2, b: 2 }, { maxChanges: 2 });
    assert.strictEqual(exact.truncated, false);
    const unlimited = await diffJson(a, b, { maxChanges: 0 });
    assert.strictEqual(unlimited.changes.length, 20);
});

test('a self-similar structure stops at the depth guard', async () => {
    /**
     * @param {number} n
     * @param {number} leaf
     * @returns {unknown}
     */
    const deep = (n, leaf) => (n === 0 ? leaf : { next: deep(n - 1, leaf) });
    const out = await diffJson(deep(100, 1), deep(100, 2));
    assert.strictEqual(out.changes.length, 1);
    assert.ok(out.changes[0].path.startsWith('next.next'));
});

test('an object with a kind goes to the registered differ, its changes prefixed with the path', async () => {
    /** @type {Array<Record<string, unknown>>} */
    const seen = [];
    const sample = {
        kind: 'sample_handle',
        matches: (/** @type {{ kind?: string }} */ v) => v.kind === 'sample_handle',
        diff: async (/** @type {{ id?: string }} */ a, /** @type {{ id?: string }} */ b, /** @type {{ path?: string, extra?: number }} */ ctx) => {
            seen.push({ a: a.id, b: b.id, path: ctx.path, extra: ctx.extra });
            return { changes: [{ path: 'rows', change: 'changed', before: '1', after: '2' }, { path: '[0].x', change: 'added', after: '1' }] };
        },
    };
    const differs = { differFor: (/** @type {{ kind?: string } | null} */ v) => (v && v.kind === 'sample_handle' ? sample : null) };
    const changes = await diff(
        { out: { data: { kind: 'sample_handle', id: 'a1' } } },
        { out: { data: { kind: 'sample_handle', id: 'b1' } } },
        { differs, ctx: { extra: 7 } },
    );
    assert.deepStrictEqual(changes.map(c => c.path), ['out.data.rows', 'out.data[0].x']);
    assert.deepStrictEqual(seen, [{ a: 'a1', b: 'b1', path: 'out.data', extra: 7 }]);
});

test('differ changes honour ignorePaths and the cap; a failing differ falls back to the plain walk', async () => {
    const many = {
        kind: 'k',
        matches: () => true,
        diff: async () => ({ changes: Array.from({ length: 10 }, (_, i) => ({ path: `c${i}`, change: 'changed', before: '1', after: '2' })) }),
    };
    const differs = { differFor: (/** @type {{ kind?: string } | null} */ v) => (v && v.kind === 'k' ? many : null) };
    const out = await diffJson({ h: { kind: 'k' } }, { h: { kind: 'k' } }, { differs, maxChanges: 3, ignorePaths: ['h.c0'] });
    assert.deepStrictEqual(out.changes.map(c => c.path), ['h.c1', 'h.c2', 'h.c3']);
    assert.strictEqual(out.truncated, true);

    const broken = { kind: 'k', matches: () => true, diff: async () => { throw new Error('boom'); } };
    const fallback = await diffJson({ h: { kind: 'k', v: 1 } }, { h: { kind: 'k', v: 2 } }, { differs: { differFor: () => broken } });
    assert.deepStrictEqual(fallback.changes.map(c => c.path), ['h.v']);
});

test('a kind that no differ claims is walked like any object', async () => {
    const changes = await diff({ h: { kind: 'plain', v: 1 } }, { h: { kind: 'plain', v: 2 } });
    assert.deepStrictEqual(changes.map(c => c.path), ['h.v']);
});

test('a key that only run B has is reported even when it shadows an inherited property name', async () => {
    const b = JSON.parse('{"keep":1,"constructor":"x","toString":2,"hasOwnProperty":3}');
    const changes = await diff({ keep: 1 }, b);
    assert.deepStrictEqual(changes.map(c => [c.path, c.change]), [
        ['constructor', 'added'], ['toString', 'added'], ['hasOwnProperty', 'added'],
    ]);
});

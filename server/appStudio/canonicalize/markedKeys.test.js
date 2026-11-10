// @typecheck
/**
 * canonicalize/markedKeys.js: the one pass that keeps a marked key of a data binding, and a
 * marked key of a groupBy or aggregates entry, with the mark's own `clean`.
 *
 * Every mark here is put into the live registry for the length of a test (the shipped ones are
 * taken out where a test needs the registry empty).
 * Run: node --test appStudio/canonicalize/markedKeys.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('../componentSpecs');
const { cleanBinding } = require('./bindings');

/** @typedef {{ code: string, path: string }} Note */

/**
 * Run `fn` with `binding` and `queryShape` marks in the live registry.
 * @param {{ binding?: Record<string, unknown>, queryShape?: Record<string, unknown> }} marks
 * @param {() => void} fn
 */
function withMarks(marks, fn) {
    /** @type {Array<() => void>} */
    const undo = [];
    for (const family of /** @type {const} */ (['binding', 'queryShape'])) {
        /** @type {Record<string, any>} */
        const table = specs.KEY_MARKS[family];
        for (const [key, mark] of Object.entries(marks[family] || {})) {
            assert.equal(Object.hasOwn(table, key), false, `${family}/${key} is free`);
            table[key] = mark;
            undo.push(() => { delete table[key]; });
        }
    }
    try {
        fn();
    } finally {
        for (const fn2 of undo) fn2();
    }
}

/** @param {unknown} raw @returns {{ out: any, notes: Note[] }} */
function clean(raw) {
    /** @type {Note[]} */
    const notes = [];
    const out = cleanBinding(raw, 'p', (/** @type {string} */ code, /** @type {string} */ path) => notes.push({ code, path }));
    return { out, notes };
}

const search = { since: 3, kinds: ['record', 'records'], shape: 'string ≤5', description: 'Free text.', clean: (/** @type {unknown} */ v) => (typeof v === 'string' ? v.slice(0, 5) : undefined) };

/**
 * Run `fn` with the shipped marks of both families taken out, as the registry was before any.
 * @param {() => void} fn
 */
function withoutShipped(fn) {
    /** @type {Array<() => void>} */
    const undo = [];
    for (const family of /** @type {const} */ (['binding', 'queryShape'])) {
        /** @type {Record<string, any>} */
        const table = specs.KEY_MARKS[family];
        for (const [key, mark] of Object.entries(table)) {
            delete table[key];
            undo.push(() => { table[key] = mark; });
        }
    }
    try {
        fn();
    } finally {
        for (const fn2 of undo) fn2();
    }
}

test('with nothing marked an unknown key of a binding is dropped, as it always was', () => withoutShipped(() => {
    assert.deepEqual(Object.keys(specs.KEY_MARKS.binding), []);
    assert.deepEqual(clean({ kind: 'records', tableId: 'tbl_x', zz_search: 'abc', limit: 3 }).out, { kind: 'records', tableId: 'tbl_x', limit: 3 });
    assert.deepEqual(clean({ kind: 'aggregate', tableId: 'tbl_x', groupBy: [{ field: 'a', zz_step: 5 }] }).out, { kind: 'aggregate', tableId: 'tbl_x', groupBy: [{ field: 'a' }] });
}));

test('a marked key is kept after the base keys, cleaned by its mark, on the kinds it is marked for', () => {
    withMarks({ binding: { zz_search: search } }, () => {
        assert.deepEqual(JSON.stringify(clean({ zz_search: 'abcdefgh', kind: 'records', tableId: 'tbl_x', pick: { row: 'first' }, limit: 3 }).out),
            '{"kind":"records","tableId":"tbl_x","limit":3,"pick":{"row":"first"},"zz_search":"abcde"}');
        assert.equal(clean({ kind: 'record', tableId: 'tbl_x', recordId: 'r1', zz_search: 'ab' }).out.zz_search, 'ab');
        // Not marked for these kinds: dropped like any unknown key.
        assert.equal('zz_search' in clean({ kind: 'aggregate', tableId: 'tbl_x', zz_search: 'ab' }).out, false);
        assert.equal('zz_search' in clean({ kind: 'dataset', datasetId: 'ds_x', zz_search: 'ab' }).out, false);
        // A second pass changes nothing.
        const once = clean({ kind: 'records', tableId: 'tbl_x', zz_search: 'abcdefgh' }).out;
        assert.deepEqual(clean(once).out, once);
    });
});

test('absent stays absent: a missing, null or undefined key, and a value its mark refuses, write nothing', () => {
    withMarks({ binding: { zz_search: search } }, () => {
        const bare = '{"kind":"records","tableId":"tbl_x"}';
        for (const value of [undefined, null, 5, {}, []]) {
            assert.equal(JSON.stringify(clean({ kind: 'records', tableId: 'tbl_x', zz_search: value }).out), bare, JSON.stringify(value));
        }
        assert.equal(JSON.stringify(clean({ kind: 'records', tableId: 'tbl_x' }).out), bare);
    });
});

test('a mark without kinds is kept on all four kinds, and its clean gets the path, the kind and push', () => {
    /** @type {unknown[]} */
    const seen = [];
    const expand = {
        since: 3, shape: '[string]', description: 'Related rows.',
        clean: (/** @type {unknown} */ v, /** @type {any} */ ctx) => {
            seen.push([ctx.path, ctx.kind]);
            if (!Array.isArray(v)) return undefined;
            if (v.length > 2) ctx.push('binding.zz_expand_capped', ctx.path, 'capped');
            return v.slice(0, 2);
        },
    };
    withMarks({ binding: { zz_expand: expand } }, () => {
        const authored = ['a', 'b', 'c'];
        const { out, notes } = clean({ kind: 'dataset', datasetId: 'ds_x', zz_expand: authored });
        assert.deepEqual(out, { kind: 'dataset', datasetId: 'ds_x', zz_expand: ['a', 'b'] });
        assert.deepEqual(notes, [{ code: 'binding.zz_expand_capped', path: 'p.zz_expand' }]);
        for (const kind of ['record', 'records', 'aggregate']) assert.deepEqual(clean({ kind, tableId: 'tbl_x', zz_expand: ['a'] }).out.zz_expand, ['a'], kind);
        assert.deepEqual(seen[0], ['p.zz_expand', 'dataset']);
        // The kept value is a copy: it never aliases what the author handed in.
        const same = { since: 3, shape: 's', description: 'd.', clean: (/** @type {unknown} */ v) => v };
        withMarks({ binding: { zz_same: same } }, () => {
            const list = [{ a: 1 }];
            const kept = clean({ kind: 'records', tableId: 'tbl_x', zz_same: list }).out.zz_same;
            assert.deepEqual(kept, list);
            assert.notEqual(kept, list);
            assert.notEqual(kept[0], list[0]);
        });
    });
});

test('a marked key never replaces a base key, and a binding of another kind is left alone', () => {
    const limit = { since: 3, shape: 's', description: 'd.', clean: () => 'marked' };
    // The loader refuses this mark (limit is a base key); the pass itself must not let it win either.
    withMarks({ binding: { limit, zz_search: search } }, () => {
        assert.equal(clean({ kind: 'records', tableId: 'tbl_x', limit: 3 }).out.limit, 3);
        assert.deepEqual(clean({ kind: 'formula', expr: '1', zz_search: 'ab' }).out, { kind: 'formula', expr: '1' });
        assert.deepEqual(clean({ kind: 'static', value: { zz_search: 'ab' } }).out, { kind: 'static', value: { zz_search: 'ab' } });
        assert.deepEqual(clean({ kind: 'connector', connectorId: 'con_x', zz_search: 'ab' }).out, { kind: 'connector', connectorId: 'con_x' });
    });
});

test('a marked entry key is kept on the entries of the list it names, after the base keys', () => {
    const step = { since: 3, entryKey: true, shape: 'number > 0', description: 'Bin width.', clean: (/** @type {unknown} */ v) => (typeof v === 'number' && v > 0 ? v : undefined) };
    withMarks({ queryShape: { 'groupBy.zz_step': step, 'aggregates.zz_distinct': { ...step, clean: (/** @type {unknown} */ v) => (v === true ? true : undefined) }, 'filter.zz_all': { since: 3, shape: 's', description: 'd.', uses: () => false } } }, () => {
        const { out } = clean({
            kind: 'aggregate', tableId: 'tbl_x',
            groupBy: [{ zz_step: 10, field: 'amount', as: 'bin', zz_distinct: true }, { field: 'b', zz_step: -1 }, { field: 'c', zz_step: null }],
            aggregates: [{ fn: 'count', zz_distinct: true, zz_step: 10 }, { fn: 'sum', field: 'a', zz_distinct: 'yes' }],
        });
        assert.equal(JSON.stringify(out.groupBy), '[{"field":"amount","as":"bin","zz_step":10},{"field":"b"},{"field":"c"}]');
        assert.equal(JSON.stringify(out.aggregates), '[{"fn":"count","zz_distinct":true},{"fn":"sum","field":"a"}]');
        assert.deepEqual(clean(out).out, out);
    });
});

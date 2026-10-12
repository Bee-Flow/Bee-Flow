/**
 * execSet — "Edit data" list mode + table operations.
 *
 * Single mode must stay byte-identical to the original 4-line executor
 * (every saved automation relies on it). List mode is the new contract:
 * `{items, count}` out, per-row `item`/`_index` scope, fields overlay,
 * then whole-table operations in listed order.
 *
 * Run: node --test core/automationRunner/execSet.list.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', {});
mock('../../stores/notificationStore', { createNotification: async () => ({}) });
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });

const { execSet, _setTest } = require('./engine');

const state = (items, extra = {}) => ({
    trigger: { output: { items } },
    steps: {},
    vars: {},
    secrets: {},
    loop: {},
    _templateWarnings: [],
    ...extra,
});
const REF = 'trigger.output.items';

// ── Single mode: byte-identical regression ───────────────────────────────────

test('single mode (no arrayRef key) resolves the fields map into one flat object', async () => {
    const r = await execSet({
        type: 'set',
        fields: {
            a: { kind: 'literal', value: 1 },
            b: { kind: 'ref', path: 'trigger.output.items' },
            c: { kind: 'expr', value: '2 + 3' },
        },
    }, {}, state(['x']));
    assert.deepStrictEqual(r.output, { a: 1, b: ['x'], c: 5 });
});

test('single mode: empty/missing fields yields {}, and undefined stays absent-style undefined', async () => {
    const r1 = await execSet({ type: 'set' }, {}, state([]));
    assert.deepStrictEqual(r1.output, {});
    // The ORIGINAL executor wrote resolveInputs' raw result — a missing ref is
    // undefined, NOT null. List mode differs deliberately; single mode must not.
    const r2 = await execSet({ type: 'set', fields: { x: { kind: 'ref', path: 'trigger.output.ghost' } } }, {}, state([]));
    assert.strictEqual('x' in r2.output, true);
    assert.strictEqual(r2.output.x, undefined);
});

test('single mode never resolves secrets', async () => {
    const r = await execSet(
        { type: 'set', fields: { s: { kind: 'ref', path: 'secrets.apiKey' } } },
        {}, state([], { secrets: { apiKey: 'hunter2' } }),
    );
    assert.strictEqual(r.output.s, undefined);
});

// ── List mode: overlay + scope ───────────────────────────────────────────────

test('list mode overlays fields on every row with item/_index in scope', async () => {
    const rows = [{ subject: 'Re: ISV', amount: '10' }, { subject: 'intro', amount: '3' }];
    const r = await execSet({
        type: 'set',
        arrayRef: REF,
        fields: {
            loud: { kind: 'expr', value: 'upper(item.subject)' },
            n: { kind: 'expr', value: 'number(item.amount) * 2' },
            pos: { kind: 'expr', value: '_index + 1' },
            viaRef: { kind: 'ref', path: 'item.subject' },
        },
    }, {}, state(rows));
    assert.strictEqual(r.output.count, 2);
    assert.deepStrictEqual(r.output.items[0], { subject: 'Re: ISV', amount: '10', loud: 'RE: ISV', n: 20, pos: 1, viaRef: 'Re: ISV' });
    assert.deepStrictEqual(r.output.items[1], { subject: 'intro', amount: '3', loud: 'INTRO', n: 6, pos: 2, viaRef: 'intro' });
});

test('list mode: non-object rows are wrapped as {value: row}; item stays the ORIGINAL scalar', async () => {
    const r = await execSet({
        type: 'set',
        arrayRef: REF,
        fields: { loud: { kind: 'expr', value: 'upper(item)' } },
    }, {}, state(['a', null, 7]));
    assert.deepStrictEqual(r.output.items, [
        { value: 'a', loud: 'A' },
        { value: null, loud: '' },   // upper(null) → '' (null-safe)
        { value: 7, loud: '7' },
    ]);
});

test('list mode: a field resolving to undefined is written as null, never clobbers-to-undefined', async () => {
    const rows = [{ keepMe: 'yes' }];
    const r = await execSet({
        type: 'set',
        arrayRef: REF,
        fields: { keepMe: { kind: 'ref', path: 'item.ghost' } },
    }, {}, state(rows));
    // The column survives as an explicit null — JSON.stringify would silently
    // drop an undefined and the row would LOOK like the edit never happened.
    assert.deepStrictEqual(r.output.items, [{ keepMe: null }]);
    assert.strictEqual(JSON.stringify(r.output.items[0]), '{"keepMe":null}');
});

test('list mode: rows in = rows out, and upstream rows are never mutated', async () => {
    const rows = [Object.freeze({ a: 1 }), Object.freeze({ a: 2 })];
    const st = state(rows);
    const r = await execSet({
        type: 'set',
        arrayRef: REF,
        fields: { b: { kind: 'expr', value: 'item.a * 10' } },
        operations: [{ op: 'rename', from: 'a', to: 'z' }],
    }, {}, st);
    assert.strictEqual(r.output.count, 2);
    assert.deepStrictEqual(st.trigger.output.items, [{ a: 1 }, { a: 2 }]);   // untouched
    assert.deepStrictEqual(r.output.items, [{ z: 1, b: 10 }, { z: 2, b: 20 }]);
});

test('list mode: malformed expr → _evalError, field null on all rows, rows still emitted', async () => {
    const r = await execSet({
        type: 'set',
        arrayRef: REF,
        fields: { broken: { kind: 'expr', value: 'item.amount >' }, ok: { kind: 'literal', value: 1 } },
    }, {}, state([{ x: 1 }, { x: 2 }]));
    assert.ok(r.output._evalError, 'parse error must surface');
    assert.deepStrictEqual(r.output.items, [{ x: 1, broken: null, ok: 1 }, { x: 2, broken: null, ok: 1 }]);
});

test('list mode: unresolved arrayRef is a SKIP passthrough; empty list is a plain success', async () => {
    const skipped = await execSet({ type: 'set', arrayRef: 'trigger.output.ghost', fields: {} }, {}, state([1]));
    assert.strictEqual(skipped.skippedReason, 'arrayref_unresolved');
    assert.deepStrictEqual(skipped.output.items, []);

    const empty = await execSet({ type: 'set', arrayRef: REF, fields: {}, operations: [{ op: 'rowId', target: 'id' }] }, {}, state([]));
    assert.strictEqual(empty.skippedReason, undefined);
    assert.deepStrictEqual(empty.output, { items: [], count: 0 });
});

test('list mode: collection cap throws collection_too_large; maxItems tightens the cap (never slices)', async () => {
    const big = Array.from({ length: 12_000 }, (_, i) => ({ i }));
    await assert.rejects(
        () => execSet({ type: 'set', arrayRef: REF, fields: {} }, {}, state(big)),
        (e) => e.errorClass === 'collection_too_large',
    );
    // Same contract as every collection op: a tighter maxItems LOWERS the
    // loud-failure threshold; it does not quietly truncate the table.
    await assert.rejects(
        () => execSet({ type: 'set', arrayRef: REF, maxItems: 100, fields: {} }, {}, state(Array.from({ length: 101 }, () => ({})))),
        (e) => e.errorClass === 'collection_too_large' && /max 100/.test(e.message),
    );
    const under = await execSet({ type: 'set', arrayRef: REF, maxItems: 100, fields: {} }, {}, state(Array.from({ length: 50 }, () => ({}))));
    assert.strictEqual(under.output.count, 50);
});

test('list mode: secrets are stripped from per-row expr and ref scopes', async () => {
    const r = await execSet({
        type: 'set',
        arrayRef: REF,
        fields: {
            viaExpr: { kind: 'expr', value: 'secrets.apiKey' },
            viaRef: { kind: 'ref', path: 'secrets.apiKey' },
        },
    }, {}, state([{}], { secrets: { apiKey: 'hunter2' } }));
    assert.deepStrictEqual(r.output.items, [{ viaExpr: null, viaRef: null }]);
});

// ── Operations ───────────────────────────────────────────────────────────────

const run = (operations, items, fields = {}) =>
    execSet({ type: 'set', arrayRef: REF, fields, operations }, {}, state(items));

test('rowId numbers rows in table order, with default and custom start', async () => {
    const r1 = await run([{ op: 'rowId', target: 'id' }], [{ a: 'x' }, { a: 'y' }]);
    assert.deepStrictEqual(r1.output.items, [{ a: 'x', id: 1 }, { a: 'y', id: 2 }]);
    const r2 = await run([{ op: 'rowId', target: 'id', start: 100 }], [{}, {}]);
    assert.deepStrictEqual(r2.output.items.map(x => x.id), [100, 101]);
});

test('groupId: composite keys, case-insensitive, first-appearance numbering', async () => {
    const rows = [
        { to: 'A@b.com', subject: 'Offer' },
        { to: 'a@B.com', subject: 'OFFER' },   // same group (case)
        { to: 'a@b.com', subject: 'Other' },   // different subject → new group
        { to: 'c@d.com', subject: 'Offer' },   // different to → new group
    ];
    const r = await run([{ op: 'groupId', target: 'thread', keys: ['to', 'subject'] }], rows);
    assert.deepStrictEqual(r.output.items.map(x => x.thread), [1, 1, 2, 3]);
});

test('groupId: missing/null/empty group together; 1 and "1" stay distinct', async () => {
    const rows = [{ k: null }, {}, { k: '' }, { k: 1 }, { k: '1' }];
    const r = await run([{ op: 'groupId', target: 'g', keys: ['k'] }], rows);
    assert.deepStrictEqual(r.output.items.map(x => x.g), [1, 1, 1, 2, 3]);
});

test('groupId: no row carries any key column → skipped with warning (typo guard)', async () => {
    const r = await run([{ op: 'groupId', target: 'g', keys: ['tpyo'] }], [{ a: 1 }, { a: 2 }]);
    assert.match(r.output.warning, /not present on any row/);
    assert.deepStrictEqual(r.output.items, [{ a: 1 }, { a: 2 }]);
});

test('rename moves the column, overwrites an existing target, skips rows without it', async () => {
    const rows = [{ old: 1, neu: 'x' }, { other: 2 }];
    const r = await run([{ op: 'rename', from: 'old', to: 'neu' }], rows);
    assert.deepStrictEqual(r.output.items, [{ neu: 1 }, { other: 2 }]);
});

test('keep projects to the listed columns; absent keys stay absent, not nulled', async () => {
    const rows = [{ a: 1, b: 2 }, { b: 3, c: 4 }];
    const r = await run([{ op: 'keep', keys: ['a', 'b'] }], rows);
    assert.deepStrictEqual(r.output.items, [{ a: 1, b: 2 }, { b: 3 }]);
});

test('remove deletes the listed columns', async () => {
    const r = await run([{ op: 'remove', keys: ['secret'] }], [{ a: 1, secret: 'x' }]);
    assert.deepStrictEqual(r.output.items, [{ a: 1 }]);
});

test('sort: numeric when both sides coerce, else case-insensitive string; nulls last both ways; stable', async () => {
    const rows = [{ n: '10' }, { n: 2 }, { n: null }, { n: 'apple' }, { n: 'Banana' }];
    const asc = await run([{ op: 'sort', key: 'n' }], rows);
    // numerics first by value, then strings CI, nulls last
    assert.deepStrictEqual(asc.output.items.map(x => x.n), [2, '10', 'apple', 'Banana', null]);
    const desc = await run([{ op: 'sort', key: 'n', direction: 'desc' }], rows);
    assert.deepStrictEqual(desc.output.items.map(x => x.n), ['Banana', 'apple', '10', 2, null]);
});

test('operations run strictly in listed order: sort-then-rowId numbers the SORTED order', async () => {
    const rows = [{ n: 3 }, { n: 1 }, { n: 2 }];
    const r = await run([
        { op: 'sort', key: 'n' },
        { op: 'rowId', target: 'id' },
    ], rows);
    assert.deepStrictEqual(r.output.items, [{ n: 1, id: 1 }, { n: 2, id: 2 }, { n: 3, id: 3 }]);
});

test('fields run BEFORE operations: a computed column is groupable and sortable', async () => {
    const rows = [{ email: 'X@a.com' }, { email: 'x@A.com' }, { email: 'y@b.com' }];
    const r = await run(
        [{ op: 'groupId', target: 'who', keys: ['norm'] }, { op: 'keep', keys: ['who'] }],
        rows,
        { norm: { kind: 'expr', value: 'lower(item.email)' } },
    );
    assert.deepStrictEqual(r.output.items, [{ who: 1 }, { who: 1 }, { who: 2 }]);
});

test('unknown operation is skipped with a warning, everything else still applies', async () => {
    const r = await run([{ op: 'explode' }, { op: 'rowId', target: 'id' }], [{ a: 1 }]);
    assert.match(r.output.warning, /unknown operation "explode"/);
    assert.deepStrictEqual(r.output.items, [{ a: 1, id: 1 }]);
});

test('reserved proto keys are inert as field names and operation targets', async () => {
    const r = await execSet({
        type: 'set',
        arrayRef: REF,
        fields: { ['__proto__']: { kind: 'literal', value: 'x' } },
        operations: [{ op: 'rowId', target: 'constructor' }, { op: 'rename', from: 'a', to: 'prototype' }],
    }, {}, state([{ a: 1 }]));
    assert.deepStrictEqual(r.output.items, [{ a: 1 }]);
    assert.strictEqual(Object.getPrototypeOf(r.output.items[0]), Object.prototype);
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('compileSetFields pre-parses only top-level exprs and reports the first parse error', () => {
    const { entries, parseError } = _setTest.compileSetFields({
        a: { kind: 'expr', value: '1 + 1' },
        b: { kind: 'expr', value: '((' },
        c: { kind: 'literal', value: 5 },
    });
    assert.ok(parseError);
    assert.strictEqual(entries.length, 3);
    assert.ok(entries[0].ast, 'valid expr is compiled');
    assert.strictEqual(entries[1].ast, null, 'broken expr falls back to a null literal');
    assert.strictEqual(entries[2].ast, null, 'literal is not compiled');
});

test('applySetOperations caps at 20 ops with a visible warning', () => {
    const ops = Array.from({ length: 25 }, (_, i) => ({ op: 'rowId', target: `id${i}` }));
    const { items, warnings } = _setTest.applySetOperations(ops, [{}]);
    assert.match(warnings[0], /first 20 operations/);
    assert.strictEqual('id19' in items[0], true);
    assert.strictEqual('id20' in items[0], false);
});

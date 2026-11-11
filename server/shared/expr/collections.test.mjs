/**
 * The collection functions, the literals and `??` beyond the golden corpus
 * (corpusCollections.mjs): the limits, what the parser calls each new node,
 * and that nothing changes an input.
 * Run: cd server && node --test shared/expr/collections.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, tryEvaluate, parseExpr, compile, collectEachCalls, readsItem, exprSince, EXPR_FUNCTIONS, EXPR_FUNCTION_NAMES } from './engine.mjs';
import { CASES } from './corpus.mjs';
import { COLLECTION_CASES } from './corpusCollections.mjs';
import { COLLECTION_FUNCTION_DOCS } from './collections.mjs';
import { MAX_RANGE_ITEMS, MAX_LITERAL_DEPTH, getMaxValueNodes, setMaxValueNodes, DEFAULT_MAX_VALUE_NODES, getMaxEachSteps, setMaxEachSteps } from './limits.mjs';

test('every addition is documented, callable and marked since: 3', () => {
    const names = ['sort', 'reverse', 'slice', 'groupBy', 'keys', 'values', 'merge', 'range', 'reduce'];
    assert.deepEqual(COLLECTION_FUNCTION_DOCS.map((d) => d.name), names);
    for (const name of names) {
        assert.ok(EXPR_FUNCTION_NAMES.includes(name), `${name} is a callable name`);
        const doc = EXPR_FUNCTIONS.find((d) => d.name === name);
        assert.equal(doc?.since, 3, `${name} carries since: 3`);
    }
    // Nothing older gained the mark.
    assert.deepEqual(EXPR_FUNCTIONS.filter((d) => d.since !== undefined).map((d) => d.name), names);
    assert.deepEqual([...EXPR_FUNCTIONS.map((d) => d.name)].sort(), [...EXPR_FUNCTION_NAMES].sort());
});

test('the new nodes: list, object, reduce and the ?? operator', () => {
    assert.deepEqual(parseExpr('[1, a]'), { kind: 'list', args: [{ kind: 'num', v: 1 }, { kind: 'path', segments: [{ kind: 'name', v: 'a' }] }] });
    assert.deepEqual(parseExpr('{ a: 1, "b c": 2 }'), { kind: 'object', keys: ['a', 'b c'], args: [{ kind: 'num', v: 1 }, { kind: 'num', v: 2 }] });
    assert.equal(parseExpr('a ?? b').op, '??');
    const r = parseExpr('reduce(xs, acc + it, 0)');
    assert.equal(r.kind, 'reduce');
    assert.deepEqual(r.args[1].a.segments[0], { kind: 'local', v: 'acc' });
    assert.deepEqual(r.args[1].b.segments[0], { kind: 'local', v: 'it' });
    // A tree written before the additions keeps its shape: `it` in map() is still { kind: 'local', v: 'it' }.
    assert.deepEqual(parseExpr('map(xs, it)').args[1], { kind: 'path', segments: [{ kind: 'local', v: 'it' }] });
});

test('acc and it are ordinary names outside their list function', () => {
    assert.deepEqual(compile('acc + it').refs.sort(), ['acc', 'it']);
    assert.equal(evaluate('acc + it', { acc: 1, it: 2 }), 3);
    assert.deepEqual(compile('map(xs, acc)').refs.sort(), ['acc', 'xs']);          // acc is only local in reduce()
    assert.deepEqual(compile('reduce(xs, acc + it, acc)').refs.sort(), ['acc', 'xs']); // the start value is outside the body
    assert.deepEqual(compile('reduce(xs, acc + it + item.x, 0)').refs.sort(), ['item', 'xs']);
    assert.deepEqual(compile('[a, { k: b }] ?? c').refs.sort(), ['a', 'b', 'c']);
});

test('readsItem: acc alone is not a read of the item, and reduce() is not listed as map/filter', () => {
    assert.equal(readsItem(parseExpr('map(xs, reduce(ys, acc + 1, 0))').args[1]), false);
    assert.equal(readsItem(parseExpr('map(xs, reduce(ys, acc + it, 0))').args[1]), false);   // the inner it
    assert.equal(readsItem(parseExpr('map(xs, reduce(it.ys, acc + 1, 0))').args[1]), true);
    assert.equal(readsItem(parseExpr('map(xs, reduce(ys, acc + 1, it))').args[1]), true);
    assert.equal(readsItem(parseExpr('map(xs, [it])').args[1]), true);
    assert.equal(readsItem(parseExpr('map(xs, { a: it.b })').args[1]), true);
    assert.deepEqual(collectEachCalls(parseExpr('reduce(xs, acc + len(filter(ys, it)), 0)')).map((c) => c.name), ['filter']);
});

test('no function changes its input', () => {
    const scope = { rows: [{ n: 2 }, { n: 1 }], o: { a: 1 } };
    const before = JSON.stringify(scope);
    for (const expr of ['sort(rows, "n")', 'reverse(rows)', 'slice(rows, 1)', 'groupBy(rows, "n")', 'merge(o, { a: 2, b: 3 })', 'keys(o)', 'values(o)', 'reduce(rows, merge(acc, it), o)']) {
        evaluate(expr, scope);
        assert.equal(JSON.stringify(scope), before, expr);
    }
    assert.notEqual(evaluate('sort(rows, "n")', scope), scope.rows);
    assert.notEqual(evaluate('merge(o)', scope), scope.o);
});

test('sort is stable, both ways, and needs no locale', () => {
    const rows = [{ k: 'b', i: 0 }, { k: 'a', i: 1 }, { k: 'B', i: 2 }, { k: 'a', i: 3 }, { i: 4 }];
    assert.deepEqual(evaluate('map(sort(rows, "k"), it.i)', { rows }), [1, 3, 2, 0, 4]);       // B before b: same letters, upper case first
    assert.deepEqual(evaluate('map(sort(rows, "k", "desc"), it.i)', { rows }), [0, 2, 1, 3, 4]); // ties keep their order, empty last
    assert.deepEqual(evaluate('sort(dates)', { dates: ['2026-07-04', '2025-12-31', '2026-01-01'] }), ['2025-12-31', '2026-01-01', '2026-07-04']);
    assert.deepEqual(evaluate('sort(xs, null, "DESC")', { xs: [1, 3, 2] }), [3, 2, 1]);
    assert.deepEqual(evaluate('sort(xs, null, "up")', { xs: [1, 3, 2] }), [1, 2, 3]);           // anything but desc is ascending
});

test('range stops at MAX_RANGE_ITEMS', () => {
    assert.equal(evaluate(`len(range(${MAX_RANGE_ITEMS}))`, {}), MAX_RANGE_ITEMS);
    const over = tryEvaluate(`range(${MAX_RANGE_ITEMS + 1})`, {});
    assert.match(over.error, /at most 10000 items/);
    assert.match(tryEvaluate('range(0, 1, 0.00001)', {}).error, /at most/);
    assert.deepEqual(evaluate('range(0, 1, 0.25)', {}), [0, 0.25, 0.5, 0.75]);
});

test('literals nest at most MAX_LITERAL_DEPTH deep', () => {
    const nest = (n) => `${'['.repeat(n)}1${']'.repeat(n)}`;
    assert.doesNotThrow(() => parseExpr(nest(MAX_LITERAL_DEPTH)));
    assert.throws(() => parseExpr(nest(MAX_LITERAL_DEPTH + 1)), /nest at most 32 deep/);
    assert.throws(() => parseExpr(`${'{a:'.repeat(MAX_LITERAL_DEPTH + 1)}1${'}'.repeat(MAX_LITERAL_DEPTH + 1)}`), /nest at most/);
    // Depth is nesting, not count: siblings are free.
    assert.doesNotThrow(() => parseExpr(`[${Array.from({ length: 100 }, () => '[1]').join(',')}]`));
});

test('a value that doubles every step is refused before it can be written out', () => {
    // 60 steps of [acc, acc] build 60 lists that would write out as 2^60 values.
    const doubled = tryEvaluate('reduce(range(60), [acc, acc], 0)', {});
    assert.match(doubled.error, /more than 1000000 items/);
    // The same through nested map() literals: `it` used twice per level.
    let expr = '[1]';
    for (let i = 0; i < 25; i++) expr = `map([${expr}], [it, it])`;
    assert.match(tryEvaluate(expr, {}).error, /more than 1000000 items/);
    // And through merge in a reduce.
    assert.match(tryEvaluate('reduce(range(60), { a: acc, b: acc }, 0)', {}).error, /more than/);
    // An honest accumulation is nowhere near it.
    assert.equal(evaluate('reduce(range(10000), acc + it, 0)', {}), 49995000);
    assert.equal(evaluate('len(map(range(10000), { n: it, sq: it * it }))', {}), 10000);
});

test('the size cap is a setting: 0 is unlimited, and the default comes back', () => {
    assert.equal(getMaxValueNodes(), DEFAULT_MAX_VALUE_NODES);
    try {
        setMaxValueNodes(10);
        assert.match(tryEvaluate('[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]', {}).error, /more than 10 items/);
        assert.deepEqual(evaluate('[1, 2, 3]', {}), [1, 2, 3]);
        setMaxValueNodes(0);
        assert.equal(getMaxValueNodes(), Infinity);
        assert.equal(tryEvaluate('len(reduce(range(22), [acc, acc], 0))', {}).value, 2);
    } finally {
        setMaxValueNodes(DEFAULT_MAX_VALUE_NODES);
    }
});

test('reduce counts every item against the shared item budget', () => {
    const was = getMaxEachSteps();
    try {
        setMaxEachSteps(50);
        assert.equal(evaluate('reduce(range(50), acc + 1, 0)', {}), 50);
        assert.match(tryEvaluate('reduce(range(51), acc + 1, 0)', {}).error, /more than 50 items/);
        assert.match(tryEvaluate('reduce(range(10), acc + sum(map(range(10), it)), 0)', {}).error, /more than 50 items/);
    } finally {
        setMaxEachSteps(was);
    }
});

test('a value that contains itself is measured without hanging', () => {
    const loop = { name: 'x' };
    loop.self = loop;
    assert.equal(evaluate('[loop, loop][0].name', { loop }), 'x');
});

test('?? only evaluates its right side when it is needed', () => {
    assert.equal(tryEvaluate('1 ?? range(99999999)', {}).value, 1);
    assert.match(tryEvaluate('missing ?? range(99999999)', {}).error, /at most/);
});

test('an object key named like a prototype member stays an own key', () => {
    const made = evaluate('merge({ __proto__: { polluted: true } }, { constructor: 1 })', {});
    assert.equal(Object.getPrototypeOf(made), Object.prototype);
    assert.equal(made.polluted, undefined);
    assert.equal(({}).polluted, undefined);
    assert.deepEqual(Object.keys(made).sort(), ['__proto__', 'constructor']);
});

test('exprSince: 3 for anything that was an error before, 0 for everything else', () => {
    for (const expr of ['[1]', '{}', 'a ?? b', 'reduce(xs, acc + it, 0)', 'sort(xs)', 'reverse(xs)', 'slice(xs, 1)', 'groupBy(xs, "k")',
        'keys(o)', 'values(o)', 'merge(a, b)', 'range(3)', 'map(xs, it.a ?? 0)', 'first(sort(xs)).name', 'a ? b : [c]', 'x[len(keys(o))]']) {
        assert.equal(exprSince(expr), 3, expr);
        assert.equal(exprSince(parseExpr(expr)), 3, expr);
    }
    const host = { mine: { pure: true, params: ['x'], body: parseExpr('x') } };
    assert.equal(exprSince('mine(1) + 1', { host }), 3);
    assert.equal(exprSince('mine(1) + 1'), 0);                 // does not parse without the table: nothing to need
    assert.equal(exprSince('1 +'), 0);
    // Every golden case from before the additions needs nothing; every case of the additions needs 3,
    // except the three that only show what did NOT change.
    const added = new Set(COLLECTION_CASES.map((c) => c.expr));
    for (const { expr } of CASES) if (!added.has(expr)) assert.equal(exprSince(expr), 0, expr);
    const unchanged = COLLECTION_CASES.filter((c) => exprSince(c.expr) === 0).map((c) => c.expr);
    assert.deepEqual(unchanged, ['item.tags[0]', 'form.qty || 5']);
});

test('objects: false keeps a brace the error it was, wherever it stands', () => {
    for (const expr of ['{ a: 1 }', '({ a: 1 })', '[{ a: 1 }]', 'merge(o, {})', '1 + }', '1 + + {']) {
        assert.throws(() => parseExpr(expr, { objects: false }), /Unexpected character in expression: [{}]/, expr);
    }
    assert.equal(tryEvaluate('{ a: 1 }', {}, { objects: false }).error, 'Unexpected character in expression: {');
    // A brace inside a text is text, and everything else still parses.
    assert.equal(evaluate('"{" + len([1, 2]) + (missing ?? "}")', {}, { objects: false }), '{2}');
    assert.equal(exprSince('{}', { objects: false }), 0);
});

test('groupBy keeps a text apart from a list or object whose JSON it spells', () => {
    const groups = evaluate('groupBy(["o:[1]", "[1]", [1], [1], { a: 1 }, "{\\"a\\":1}"], "")', {});
    assert.deepEqual(groups.map((g) => [g['key'], g.items.length]), [['o:[1]', 1], ['[1]', 1], [[1], 2], [{ a: 1 }, 1], ['{"a":1}', 1]]);
});

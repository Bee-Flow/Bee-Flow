/**
 * The list functions of the expression language and member access on a call
 * result: one test per function (map, filter, some, every, unique, sum with
 * and without a field, split/join), the implicit `it`, the item budget, and
 * the parse-time refusals.
 * Run: node --test server/shared/expr/functions.lists.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, parseExpr, compile, collectEachCalls, readsItem, collectHostCalls } from './engine.mjs';
import { getMaxEachSteps, setMaxEachSteps, DEFAULT_MAX_EACH_STEPS } from './limits.mjs';
import { CASES, SCOPE } from './corpus.mjs';
import { COLLECTION_CASES } from './corpusCollections.mjs';

const ROWS = [
    { id: 1, name: 'Ada', status: 'open', amount: 10, tags: ['x'] },
    { id: 2, name: 'Bo', status: 'done', amount: '5', tags: [] },
    { id: 3, name: 'Cy', status: 'open', amount: 'n/a', tags: ['x', 'y'] },
];
const scope = { rows: ROWS, vars: { min: 6 }, it: 'the root it', item: { status: 'open' } };
const ev = (src) => evaluate(src, scope);

test('member access on a call result: find(...).name, first(x).y, (a || b).name, f(x)[0]', () => {
    assert.equal(ev('find(rows, "id", 2).name'), 'Bo');
    assert.equal(ev('first(rows).status'), 'open');
    assert.equal(ev('(vars.none || first(rows)).name'), 'Ada');
    assert.equal(ev('split("a,b", ",")[1]'), 'b');
    assert.equal(ev('last(rows).tags[1]'), 'y');
    assert.equal(ev('find(rows, "id", 99).name'), undefined, 'nothing found reads on as nothing');
    assert.equal(ev('first(rows).constructor'), undefined, 'own properties only');
    assert.equal(ev('first(rows)["__proto__"]'), undefined);
});

test('a call without a segment parses to the tree it always had', () => {
    assert.deepEqual(parseExpr('first(rows)'), { kind: 'call', name: 'first', args: [{ kind: 'path', segments: [{ kind: 'name', v: 'rows' }] }] });
    assert.deepEqual(parseExpr('(a)'), { kind: 'path', segments: [{ kind: 'name', v: 'a' }] });
    assert.equal(parseExpr('first(rows).y').kind, 'path');
    assert.equal(parseExpr('first(rows).y').segments[0].kind, 'base');
});

test('every corpus formula parses the same without the new forms: no base/local/each node appears', () => {
    const NEW = /"kind":"(base|local|each)"/;
    const NEW_SYNTAX = /\)\s*[.[]|\b(map|filter|some|every)\(/;
    // The literals and reduce() came later still: their cases have their own file.
    const later = new Set(COLLECTION_CASES.map((c) => c.expr));
    for (const { expr } of CASES) {
        if (NEW_SYNTAX.test(expr) || later.has(expr)) continue;
        assert.doesNotMatch(JSON.stringify(parseExpr(expr)), NEW, expr);
    }
});

test('map: one value per item, the item read as it', () => {
    assert.deepEqual(ev('map(rows, it.name)'), ['Ada', 'Bo', 'Cy']);
    assert.deepEqual(ev('map(rows, it.id * 2)'), [2, 4, 6]);
    assert.deepEqual(ev('map(vars.none, it)'), []);
});

test('filter: the items for which the expression is true', () => {
    assert.deepEqual(ev('map(filter(rows, it.status == "open"), it.id)'), [1, 3]);
    assert.deepEqual(ev('filter(rows, number(it.amount) > vars.min)'), [ROWS[0]], 'the scope roots stay readable inside');
    assert.deepEqual(ev('filter("not a list", true)'), []);
});

test('some: true when one item passes; false for an empty list', () => {
    assert.equal(ev('some(rows, it.name == "Cy")'), true);
    assert.equal(ev('some(rows, it.name == "Zed")'), false);
    assert.equal(ev('some(first(rows).tags, it == "x")'), true);
    assert.equal(ev('some(last(rows).tags, false)'), false);
    assert.equal(ev('some(find(rows, "id", 2).tags, true)'), false, 'empty list');
});

test('every: true when every item passes; false for an empty list (like everyOf)', () => {
    assert.equal(ev('every(rows, it.id > 0)'), true);
    assert.equal(ev('every(rows, it.status == "open")'), false);
    assert.equal(ev('every(find(rows, "id", 2).tags, true)'), false);
    assert.equal(evaluate('everyOf(list, "==", 1)', { list: [] }), false, 'the same answer as everyOf');
});

test('unique: first occurrence kept, scalars strict, objects by value, optional key', () => {
    assert.deepEqual(evaluate('unique(l)', { l: [1, '1', 1, 'a', 'a'] }), [1, '1', 'a']);
    assert.deepEqual(evaluate('unique(l)', { l: [{ a: 1 }, { a: 1 }, { a: 2 }] }), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(ev('map(unique(rows, "status"), it.id)'), [1, 2]);
    assert.deepEqual(ev('unique(map(rows, it.status))'), ['open', 'done']);
    assert.deepEqual(ev('unique(vars.none)'), []);
});

test('sum: a list of numbers, or with a field the value under it in each item', () => {
    assert.equal(evaluate('sum(l)', { l: [1, '2', 'x', null] }), 3);
    assert.equal(ev('sum(rows, "amount")'), 15, 'non-numeric counts 0; "5" counts 5');
    assert.equal(ev('sum(rows, "missing")'), 0);
    assert.equal(ev('sum(rows)'), 0, 'objects without a field count 0, as before');
    assert.equal(evaluate('sum(l, "constructor")', { l: [{}, {}] }), 0, 'own properties only');
    assert.equal(ev('sum(map(rows, number(it.amount)))'), 15);
});

test('split and join (regression)', () => {
    assert.deepEqual(ev('split("a,b,,c", ",")'), ['a', 'b', '', 'c']);
    assert.deepEqual(ev('split("ab", "")'), ['a', 'b']);
    assert.equal(ev('join(map(rows, it.name), ", ")'), 'Ada, Bo, Cy');
    assert.equal(ev('join(split("a-b-c", "-"), "+")'), 'a+b+c');
    assert.equal(ev('join(vars.none, ",")'), '');
});

test('nested list functions: the inner it shadows the outer one', () => {
    assert.deepEqual(ev('map(rows, len(filter(it.tags, it == "x")))'), [1, 0, 1]);
    assert.deepEqual(ev('filter(rows, some(it.tags, it == "y"))'), [ROWS[2]]);
    assert.deepEqual(ev('map(filter(rows, it.status == "open"), map(it.tags, upper(it)))'), [['X'], ['X', 'Y']]);
});

test('it outside a list function is an ordinary root', () => {
    assert.equal(ev('it'), 'the root it');
    assert.deepEqual(compile('it.x').refs, ['it']);
    assert.deepEqual(compile('map(rows, it.x)').refs, ['rows'], 'the item is not a root');
    assert.deepEqual(compile('map(rows, it.x + vars.min)').refs.sort(), ['rows', 'vars']);
    assert.deepEqual(ev('map(rows, it.id)'), [1, 2, 3]);
    assert.equal(evaluate('item.status', scope), 'open', 'item keeps its meaning inside and outside');
    assert.deepEqual(ev('map(rows, item.status)'), ['open', 'open', 'open']);
});

test('collectEachCalls and readsItem', () => {
    const ast = parseExpr('map(rows, filter(it.tags, it == "x")) || some(rows, item.ok)');
    assert.deepEqual(collectEachCalls(ast).map((n) => n.name), ['map', 'filter', 'some']);
    const [map, , some] = collectEachCalls(ast);
    assert.equal(readsItem(map.args[1]), true);
    assert.equal(readsItem(some.args[1]), false);
    assert.equal(readsItem(parseExpr('map(rows, map(other, it))').args[1]), false, 'a nested body reads its own item');
});

test('a host call inside a list function body is refused at parse time', () => {
    const host = { isAbout: { check: () => null, fn: () => true } };
    assert.throws(() => parseExpr('filter(rows, isAbout(it.name, "a person"))', { host }), /cannot be used inside/);
    assert.equal(collectHostCalls(parseExpr('isAbout(first(rows).name, "a person")', { host })).length, 1, 'outside a body it still parses');
    assert.equal(evaluate('isAbout(first(rows).name, "a person")', scope, { host }), true);
});

test('arity: exactly a list and an expression', () => {
    assert.throws(() => parseExpr('map(rows)'), /takes a list and an expression/);
    assert.throws(() => parseExpr('map()'), /./);
    assert.throws(() => parseExpr('filter(rows, it, 1)'), /exactly two arguments/);
    assert.throws(() => parseExpr('first(rows)()'), /Trailing tokens/);
    assert.deepEqual(compile('map.x').refs, ['map'], 'a name without brackets is still a path root');
});

test('the item budget throws past EXPR_MAX_EACH_STEPS and names the limit; 0 is unlimited', () => {
    assert.equal(getMaxEachSteps(), DEFAULT_MAX_EACH_STEPS);
    const big = { l: Array.from({ length: 100 }, (_, i) => i) };
    try {
        setMaxEachSteps(150);
        assert.equal(evaluate('len(map(l, it))', big), 100);
        assert.throws(() => evaluate('map(l, map(l, it))', big), (e) => e.code === 'expr_limit' && /150/.test(e.message) && /EXPR_MAX_EACH_STEPS/.test(e.message));
        setMaxEachSteps(0);
        assert.equal(getMaxEachSteps(), Infinity);
        assert.equal(evaluate('len(map(l, map(l, it)))', big), 100);
    } finally {
        setMaxEachSteps(DEFAULT_MAX_EACH_STEPS);
    }
});

test('the budget is per evaluation, not per process', () => {
    const big = { l: Array.from({ length: 100 }, (_, i) => i) };
    try {
        setMaxEachSteps(150);
        for (let i = 0; i < 5; i++) assert.equal(evaluate('len(map(l, it))', big), 100);
    } finally {
        setMaxEachSteps(DEFAULT_MAX_EACH_STEPS);
    }
});

test('the corpus scope reads the same through the new forms', () => {
    assert.equal(evaluate('first(actions.search.result.rows).name', SCOPE), 'A');
});

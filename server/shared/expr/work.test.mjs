// @typecheck
/**
 * One evaluation has one work budget and a depth limit (limits.mjs spend,
 * guardSize), and whatever the runtime itself refuses (a stack that ran out)
 * leaves evaluate() as an ExprError.
 *
 * Run: cd server && node --test shared/expr/work.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert';
import { evaluate, parseExpr, tryEvaluate, ExprError } from './index.mjs';
import {
    DEFAULT_MAX_WORK, DEFAULT_MAX_VALUE_DEPTH, TEXT_CHARS_PER_UNIT, ExprLimitError,
    getMaxWork, setMaxWork, getMaxValueDepth, setMaxValueDepth, getMaxEachSteps, setMaxEachSteps,
} from './limits.mjs';

const eachSteps = getMaxEachSteps();
test.afterEach(() => { setMaxWork(DEFAULT_MAX_WORK); setMaxValueDepth(DEFAULT_MAX_VALUE_DEPTH); setMaxEachSteps(eachSteps); });

/** The limit error of a formula, or fail. @param {string} src @param {unknown} [scope] */
function limitOf(src, scope = {}) {
    try { evaluate(src, scope); } catch (e) {
        assert.ok(e instanceof ExprLimitError, `${src}: ${e instanceof Error ? `${e.name} ${e.message}` : e}`);
        return e.message;
    }
    return assert.fail(`${src} was not refused`);
}

test('list functions inside each other stop at the work budget, with the defaults', () => {
    // Each of these is short, stays under the item budget and under range()'s own ceiling.
    for (const src of [
        'map(range(10000), range(10000))',
        'map(range(10000), map(range(20), range(10000)))',
        'map(range(10000), sort(range(10000)))',
        'map(range(10000), groupBy(range(10000), "x"))',
        'reduce(range(10000), acc + len(reverse(range(10000))), 0)',
        'map(range(10000), slice(range(10000), 1))',
    ]) {
        assert.match(limitOf(src), /EXPR_MAX_WORK=10000000/, src);
    }
});

test('the budget counts lists, objects and texts a function, a literal or + hands back', () => {
    const cost = (/** @type {string} */ src, /** @type {unknown} */ scope = {}) => {
        // The smallest budget the formula passes with.
        let lo = 0;
        let hi = 100_000;
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            setMaxWork(mid);
            if (tryEvaluate(src, scope).error) lo = mid; else hi = mid;
        }
        return hi;
    };
    assert.strictEqual(cost('1 ?? 2'), 1); // nothing produced (a budget is at least 1)
    assert.strictEqual(cost('range(10)'), 11); // the list and its 10 items
    assert.strictEqual(cost('[1, 2, 3]'), 4);
    assert.strictEqual(cost('{ a: 1, b: 2 }'), 3);
    assert.strictEqual(cost('map(rows, it) ?? 0', { rows: [1, 2, 3] }), 4); // 3 visited items, 1 list
    assert.strictEqual(cost('filter(rows, it > 5) ?? 0', { rows: [1, 2, 3] }), 4); // visited, whether kept or not
    assert.strictEqual(cost('some(rows, it > 5) ?? 0', { rows: [1, 2, 3] }), 3);
    assert.strictEqual(cost('reduce(rows, acc + it, 0)', { rows: [1, 2, 3] }), 3);
    assert.strictEqual(cost('sort(rows)', { rows: [3, 1, 2] }), 4);
    // groupBy: the list of groups, and every item filed in one.
    assert.strictEqual(cost('groupBy(rows, "k")', { rows: [{ k: 1 }, { k: 1 }, { k: 2 }] }), 1 + 2 + 3);
    const s = 'x'.repeat(TEXT_CHARS_PER_UNIT * 5);
    assert.strictEqual(cost('upper(s) ?? ""', { s }), 5);
    assert.strictEqual(cost('(s + s) ?? ""', { s }), 10);
    assert.strictEqual(cost('split(s, "") ?? 0', { s }), 1 + s.length);
    // Reading the scope costs nothing, however large it is, and neither does a value handed on as it came.
    const rows = new Array(50_000).fill({ a: 1 });
    assert.strictEqual(cost('(len(rows) + count(rows[*].a)) ?? 0', { rows }), 1);
    assert.strictEqual(cost('len(default(rows, 0)) ?? 0', { rows }), 1);
    assert.strictEqual(cost('len(coalesce(missing, s)) ?? 0', { s }), 1);
});

test('a formula in the earlier language keeps exactly the limits it had', () => {
    // What a stored formula may do on large data today, it may do tomorrow: a text worked over per
    // row, a list split per row. Neither has anything the collection functions brought.
    setMaxWork(1000);
    const doc = 'Word '.repeat(20_000);
    const rows = new Array(500).fill({ word: 'word' });
    assert.strictEqual(evaluate('len(filter(rows, contains(lower(doc), it.word)))', { rows, doc }), 500);
    assert.strictEqual(evaluate('len(map(rows, len(split(doc, " "))))', { rows, doc }), 500);
    assert.strictEqual(evaluate('len(map(rows, upper(doc)))', { rows, doc }), 500);
    // Its visited items count against the item budget, as they always did, and against nothing else.
    assert.strictEqual(evaluate('len(map(rows, 1))', { rows: new Array(5000).fill(0) }), 5000);
    setMaxEachSteps(4999);
    assert.match(limitOf('len(map(rows, 1))', { rows: new Array(5000).fill(0) }), /EXPR_MAX_EACH_STEPS=4999/);
    setMaxEachSteps(eachSteps);
    // The same work in a formula that uses the newer language is counted whole.
    assert.match(limitOf('len(map(rows, upper(doc))) ?? 0', { rows, doc }), /EXPR_MAX_WORK=1000/);
    assert.match(limitOf('len(map(range(500), len(split(doc, " "))))', { doc }), /EXPR_MAX_WORK=1000/);
});

test('texts multiply like lists do, and stop at the same budget', () => {
    setMaxWork(100_000);
    assert.match(limitOf('map(range(10000), padStart("", 1000, "x"))'), /EXPR_MAX_WORK/);
    assert.strictEqual(evaluate('len(map(range(1000), padStart("", 100, "x")))', {}), 1000);
});

test('the budget is per evaluation: the next one starts at nothing', () => {
    setMaxWork(12);
    for (let i = 0; i < 5; i++) assert.strictEqual(evaluate('len(range(10))', {}), 10);
    assert.match(limitOf('[len(range(10)), len(range(10))]'), /more than 12 items/);
});

test('an author function spends from the budget of the formula that calls it', () => {
    setMaxWork(100);
    const host = { wide: { pure: true, params: ['n'], body: parseExpr('range(n)') } };
    assert.strictEqual(evaluate('len(wide(50))', {}, { host }), 50);
    assert.throws(() => evaluate('len(wide(50)) + len(wide(50))', {}, { host }), ExprLimitError);
});

test('a value nested past the depth limit is refused where it is built', () => {
    for (const src of [
        'reduce(range(10000), [acc], 0)',
        'reduce(range(10000), { a: acc }, 0)',
        'toStr(reduce(range(10000), [acc], 0))',
        'reduce(range(10000), merge({}, { a: acc }), 0)',
        'reduce(range(10000), map([1], acc), 0)',
        'reduce(range(10000), groupBy([acc], "x"), 0)',
        'equals(reduce(range(5000), [acc], 0), reduce(range(5000), [acc], 0))',
    ]) {
        assert.match(limitOf(src), /nested more than 100 deep \(EXPR_MAX_VALUE_DEPTH=100\)/, src);
    }
    // Up to the limit is a value like any other.
    assert.strictEqual(evaluate('len(toStr(reduce(range(99), [acc], 0)))', {}) > 0, true);
    assert.match(limitOf('reduce(range(101), [acc], 0)'), /nested more than 100 deep/);
});

test('an author function cannot nest deeper than the limit either', () => {
    const host = { wrap: { pure: true, params: ['x'], body: parseExpr('[x]') } };
    setMaxValueDepth(5);
    assert.deepStrictEqual(evaluate('wrap(wrap(1))', {}, { host }), [[1]]);
    assert.throws(() => evaluate('reduce(range(6), wrap(acc), 0)', {}, { host }), /nested more than 5 deep/);
    assert.throws(() => evaluate('wrap(deep)', { deep: [[[[[1]]]]] }, { host }), ExprLimitError);
});

test('both limits are settings: 0 is unlimited, and the defaults come back', () => {
    assert.strictEqual(getMaxWork(), DEFAULT_MAX_WORK);
    assert.strictEqual(getMaxValueDepth(), DEFAULT_MAX_VALUE_DEPTH);
    setMaxValueDepth(0);
    assert.strictEqual(getMaxValueDepth(), Infinity);
    assert.strictEqual(evaluate('len(reduce(range(300), [acc], 0))', {}), 1);
    setMaxWork(0);
    assert.strictEqual(getMaxWork(), Infinity);
    setMaxEachSteps(0);
    assert.strictEqual(evaluate('sum(map(range(3000), len(range(4000))))', {}), 12_000_000);
});

test('what the runtime refuses leaves evaluate() as an ExprError, never a RangeError', () => {
    // A value from the scope nested deeper than toStr, == and JSON can walk.
    /** @type {unknown} */
    let deep = 0;
    for (let i = 0; i < 50_000; i++) deep = [deep];
    for (const src of ['toStr(x)', 'x == 1', 'x + ""', 'unique([x, x])', 'groupBy([x], "")', 'join(x, ",")']) {
        let caught;
        try { evaluate(src, { x: deep }); } catch (e) { caught = e; }
        // Whatever a function makes of it, the only thing it may throw is an ExprError.
        if (caught !== undefined) assert.ok(caught instanceof ExprError && !(caught instanceof RangeError), `${src}: ${caught}`);
    }
    assert.throws(() => evaluate('toStr(x)', { x: deep }), ExprLimitError);
    assert.strictEqual(typeof tryEvaluate('toStr(x)', { x: deep }).error, 'string');
    // Built by the formula with the depth limit switched off: still an ExprError.
    setMaxValueDepth(0);
    assert.throws(() => evaluate('toStr(reduce(range(10000), [acc], 0))', {}), ExprLimitError);
    // A formula text nested deeper than the parser can follow.
    const nested = `${'('.repeat(50_000)}1${')'.repeat(50_000)}`;
    assert.throws(() => parseExpr(nested), ExprLimitError);
    assert.throws(() => evaluate(nested, {}), ExprLimitError);
    // An error that is not the runtime's stays what it was.
    assert.throws(() => evaluate('nope(1)', {}), (e) => e instanceof ExprError && !(e instanceof ExprLimitError));
});

/**
 * An author's own functions (userFunctions.mjs) and the pure host hook in the
 * engine that runs them.
 * Run: cd server && node --test shared/expr/userFunctions.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, tryEvaluate, parseExpr, compile, collectHostCalls } from './engine.mjs';
import { collectUserCalls } from './astWalk.mjs';
import { compileUserFunctions, isFunctionIdentifier } from './userFunctions.mjs';
import { MAX_USER_FUNCTIONS, MAX_USER_FUNCTION_PARAMS, getMaxEachSteps, setMaxEachSteps } from './limits.mjs';
import { TOPIC_HOST_SPEC } from './topics.mjs';

const DEFS = [
    { name: 'fullName', params: ['p'], expr: 'trim(concat(p.first, " ", p.last))' },
    { name: 'withVat', params: ['amount', 'rate'], expr: 'round(amount * (1 + rate), 2)' },
    { name: 'gross', params: ['row'], expr: 'withVat(row.price * row.qty, 0.21)' },
    { name: 'answer', params: [], expr: '42' },
];
const SCOPE = { people: [{ first: 'Ada', last: 'Lovelace' }, { first: 'Alan', last: 'Turing' }], row: { price: 10, qty: 3 }, vars: { rate: 0.5 } };

test('functions compile into a host table and are called like built-in ones', () => {
    const { host, problems } = compileUserFunctions(DEFS);
    assert.deepEqual(problems, []);
    assert.deepEqual(Object.keys(host), ['fullName', 'withVat', 'gross', 'answer']);
    assert.equal(evaluate('fullName(people[0])', SCOPE, { host }), 'Ada Lovelace');
    assert.equal(evaluate('gross(row)', SCOPE, { host }), 36.3);
    assert.equal(evaluate('answer() + 1', SCOPE, { host }), 43);
    assert.equal(evaluate('withVat(100, vars.rate)', SCOPE, { host }), 150);
    // Inside map/filter/reduce and inside each other: a pure function needs no answer first.
    assert.deepEqual(evaluate('map(people, fullName(it))', SCOPE, { host }), ['Ada Lovelace', 'Alan Turing']);
    assert.equal(evaluate('reduce(people, acc + len(fullName(it)), 0)', SCOPE, { host }), 23);
    assert.equal(evaluate('withVat(withVat(100, 0.1), 0.1)', SCOPE, { host }), 121);
    assert.equal(evaluate('fullName(people[1]).length', SCOPE, { host }), 11);
});

test('without the table every one of them is still an unknown function', () => {
    for (const d of DEFS) assert.throws(() => parseExpr(`${d.name}()`), /Unknown function/);
    assert.deepEqual(compileUserFunctions(undefined), { host: {}, problems: [] });
    assert.deepEqual(compileUserFunctions([]), { host: {}, problems: [] });
});

test('a call is a usercall node: its arguments are counted, and it is not something to ask first', () => {
    const { host } = compileUserFunctions(DEFS);
    const ast = parseExpr('withVat(form.amount, 0.21) + answer()', { host });
    assert.deepEqual(collectUserCalls(ast).map((c) => c.name), ['withVat', 'answer']);
    assert.deepEqual(collectHostCalls(ast), []);
    assert.deepEqual(compile('withVat(form.amount, vars.rate)', { host }).refs.sort(), ['form', 'vars']);
    assert.throws(() => parseExpr('withVat(1)', { host }), /withVat\(\) takes 2 arguments \(amount, rate\)/);
    assert.throws(() => parseExpr('answer(1)', { host }), /takes 0 arguments/);
    assert.throws(() => parseExpr('fullName()', { host }), /takes 1 argument \(p\)/);
});

test('a function reads only its parameters', () => {
    const { host, problems } = compileUserFunctions([
        { name: 'leaky', params: ['x'], expr: 'x + vars.rate' },
        { name: 'usesIt', params: ['x'], expr: 'x + it' },
        { name: 'fine', params: ['xs'], expr: 'sum(map(xs, it * 2))' },
    ]);
    assert.deepEqual(problems.map((p) => [p.name, p.code]), [['leaky', 'function.reads_outside'], ['usesIt', 'function.reads_outside']]);
    assert.match(problems[0].message, /reads vars/);
    assert.equal(evaluate('fine([1, 2])', {}, { host }), 6);
    // The function with a problem still parses where it is called, and says why it has no answer.
    assert.match(tryEvaluate('leaky(1)', SCOPE, { host }).error, /reads vars/);
    // The caller's `it` and scope never leak in: a parameter of the same name wins, nothing else is visible.
    const shadow = compileUserFunctions([{ name: 'pick', params: ['vars'], expr: 'vars.rate' }]);
    assert.equal(evaluate('pick({ rate: 9 })', SCOPE, { host: shadow.host }), 9);
});

test('recursion is refused, direct and through other functions', () => {
    const { host, problems } = compileUserFunctions([
        { name: 'selfish', params: ['n'], expr: 'n <= 0 ? 0 : selfish(n - 1)' },
        { name: 'ping', params: ['n'], expr: 'pong(n)' },
        { name: 'pong', params: ['n'], expr: 'pang(n)' },
        { name: 'pang', params: ['n'], expr: 'ping(n)' },
        { name: 'outside', params: ['n'], expr: 'ping(n) + 1' },
        { name: 'ok', params: ['n'], expr: 'n + 1' },
    ]);
    assert.deepEqual(problems.map((p) => [p.name, p.code]), [
        ['selfish', 'function.recursive'], ['ping', 'function.recursive'], ['pong', 'function.recursive'], ['pang', 'function.recursive'],
    ]);
    assert.match(tryEvaluate('selfish(3)', {}, { host }).error, /calling itself/);
    assert.match(tryEvaluate('outside(3)', {}, { host }).error, /calling itself/);   // it calls one that has no answer
    assert.equal(evaluate('ok(1)', {}, { host }), 2);
});

test('the engine stops a recursive table it was handed without the check', () => {
    const host = { loop: { pure: true, params: ['n'] } };
    host.loop.body = parseExpr('loop(n + 1)', { host });
    assert.match(tryEvaluate('loop(0)', {}, { host }).error, new RegExp(`more than ${MAX_USER_FUNCTIONS} deep`));
});

test('names: no built-in, no reserved word, no duplicate, nothing that is not a plain name', () => {
    const { problems, host } = compileUserFunctions([
        { name: 'sum', params: [], expr: '1' },
        { name: 'reduce', params: [], expr: '1' },
        { name: 'map', params: [], expr: '1' },
        { name: 'it', params: [], expr: '1' },
        { name: 'twice', params: ['x'], expr: 'x * 2' },
        { name: 'twice', params: ['x'], expr: 'x * 3' },
        { name: 'has space', params: [], expr: '1' },
        { name: '9lives', params: [], expr: '1' },
        { name: 'isAbout', params: [], expr: '1' },
        { name: 42, params: [], expr: '1' },
        null,
        { name: 'p1', params: ['a', 'a'], expr: 'a' },
        { name: 'p2', params: ['acc'], expr: 'acc' },
        { name: 'p3', params: 'x', expr: 'x' },
        { name: 'p4', params: Array.from({ length: MAX_USER_FUNCTION_PARAMS + 1 }, (_, i) => `a${i}`), expr: '1' },
        { name: 'empty', params: [], expr: '  ' },
        { name: 'broken', params: [], expr: '1 +' },
        { name: 'long', params: [], expr: '1 + 1 + 1' },
    ], { reserved: ['isAbout'], maxExprLength: 5 });
    assert.deepEqual(problems.map((p) => p.code), [
        'function.name_taken', 'function.name_taken', 'function.name_taken', 'function.name', 'function.duplicate', 'function.name',
        'function.name', 'function.name_taken', 'function.name', 'function.name', 'function.params', 'function.params', 'function.params',
        'function.params', 'function.expr', 'function.parse_error', 'function.too_long',
    ]);
    assert.deepEqual(problems.map((p) => p.index), [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    assert.equal(evaluate('twice(2)', {}, { host }), 4);                 // the first definition stands
    assert.equal(evaluate('sum([1, 2])', {}, { host }), 3);             // a built-in is never replaced
    assert.equal(isFunctionIdentifier('_a1'), true);
    assert.equal(isFunctionIdentifier('a-b'), false);
    assert.equal(isFunctionIdentifier('é'), false);
    assert.equal(isFunctionIdentifier('a'.repeat(41)), false);
});

test('a name from the prototype is an own entry or nothing', () => {
    const { host, problems } = compileUserFunctions([{ name: '__proto__', params: [], expr: '1' }, { name: 'constructor', params: [], expr: '2' }]);
    assert.deepEqual(problems, []);
    assert.equal(Object.getPrototypeOf(host), Object.prototype);
    assert.equal(evaluate('__proto__() + constructor()', {}, { host }), 3);
    assert.throws(() => parseExpr('toString()', { host }), /Unknown function/);
    assert.throws(() => parseExpr('hasOwnProperty("a")', { host: {} }), /Unknown function/);
});

test('at most MAX_USER_FUNCTIONS functions', () => {
    const many = Array.from({ length: MAX_USER_FUNCTIONS + 1 }, (_, i) => ({ name: `f${i}`, params: [], expr: String(i) }));
    const { host, problems } = compileUserFunctions(many);
    assert.deepEqual(problems.map((p) => p.code), ['function.too_many']);
    assert.equal(Object.keys(host).length, MAX_USER_FUNCTIONS);
    assert.deepEqual(compileUserFunctions(many.slice(0, MAX_USER_FUNCTIONS)).problems, []);
    assert.deepEqual(compileUserFunctions('nope').problems.map((p) => p.code), ['function.list']);
});

test('calls count against the item budget, so functions that fan out cannot multiply work', () => {
    // f0 = 1, f(n) = f(n-1) + f(n-1): 2^29 calls without a budget.
    const defs = [{ name: 'f0', params: [], expr: '1' }];
    for (let i = 1; i < MAX_USER_FUNCTIONS; i++) defs.push({ name: `f${i}`, params: [], expr: `f${i - 1}() + f${i - 1}()` });
    const { host, problems } = compileUserFunctions(defs);
    assert.deepEqual(problems, []);
    assert.equal(evaluate('f10()', {}, { host }), 1024);
    const was = getMaxEachSteps();
    try {
        setMaxEachSteps(5000);
        assert.match(tryEvaluate('f29()', {}, { host }).error, /more than 5000 items/);
    } finally {
        setMaxEachSteps(was);
    }
});

test('a function that doubles its argument is measured like a reduce step', () => {
    const { host } = compileUserFunctions([{ name: 'pair', params: ['x'], expr: 'merge({ a: x }, { b: x })' }]);
    assert.deepEqual(evaluate('pair(1)', {}, { host }), { a: 1, b: 1 });
    assert.match(tryEvaluate('reduce(range(60), pair(acc), 0)', {}, { host }).error, /more than 1000000 items/);
});

test('a pure host entry with fn, next to a host function that must be asked first', () => {
    const host = { shout: { pure: true, params: ['s'], fn: (s) => `${String(s).toUpperCase()}!` }, ...TOPIC_HOST_SPEC };
    assert.deepEqual(evaluate('map(xs, shout(it))', { xs: ['a', 'b'] }, { host }), ['A!', 'B!']);
    const ast = parseExpr('shout(a) == "X!" && isAbout(a, "a greeting")', { host });
    assert.deepEqual(collectHostCalls(ast).map((c) => c.name), ['isAbout']);
    assert.deepEqual(collectUserCalls(ast).map((c) => c.name), ['shout']);
    // The rule for host functions that need an answer first is unchanged.
    assert.throws(() => parseExpr('map(xs, isAbout(it, "a greeting"))', { host }), /cannot be used inside/);
    assert.throws(() => parseExpr('reduce(xs, acc || isAbout(it, "a greeting"), false)', { host }), /cannot be used inside/);
    // A pure entry without fn or body has no answer.
    assert.match(tryEvaluate('later(1)', {}, { host: { later: { pure: true, params: ['x'] } } }).error, /no answer here/);
});

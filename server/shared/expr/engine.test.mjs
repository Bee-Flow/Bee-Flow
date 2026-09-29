/**
 * Server-side run of the golden corpus under `node --test`.
 * Run from repo root: node --test shared/expr/engine.test.mjs
 * The client (agent-hub vitest) runs the SAME corpus + cross-checks the
 * server re-export — see agent-hub/.../AppStudio/state/sharedExpr.parity.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, tryEvaluate, parseExpr, compile, FUNCTIONS, EXPR_FUNCTIONS, EXPR_FUNCTION_NAMES } from './engine.mjs';
import { SCOPE, CASES, REJECT } from './corpus.mjs';

test('golden corpus evaluates as expected (server/Node)', () => {
    for (const { expr, expected } of CASES) {
        assert.deepEqual(evaluate(expr, SCOPE), expected, `expr: ${expr}`);
    }
});

test('rejected expressions throw at parse/eval time', () => {
    for (const expr of REJECT) {
        assert.throws(() => parseExpr(expr), `should reject: ${expr}`);
    }
});

test('tryEvaluate never throws and reports errors', () => {
    const ok = tryEvaluate('1 + 1', SCOPE);
    assert.equal(ok.value, 2);
    assert.equal(ok.error, null);
    const bad = tryEvaluate('unknownFn(1)', SCOPE);
    assert.equal(bad.value, undefined);
    assert.ok(bad.error);
});

test('compile reports referenced roots without executing', () => {
    const { refs } = compile('actions.search.result.count + form.amount * vars.rate');
    assert.deepEqual([...refs].sort(), ['actions', 'form', 'vars']);
});

test('ExprError carries a character index for the inspector', () => {
    try { parseExpr('1 + '); assert.fail('should throw'); }
    catch (e) { assert.equal(typeof e.index, 'number'); }
});

// REGRESSION: member access on a STRING used to be gated on
// `typeof cur === 'object'`, so `…body.length > 5` was permanently false
// inside a condition while the identical path in a ref binding (or a {{…}}
// template) resolved to 11 — a silently wrong branch with a green status.
// The own-property gate alone is the correct rule; it auto-boxes primitives
// and still blocks the prototype chain.
test('string members resolve in expressions exactly as they do in a ref binding', () => {
    const state = { steps: { s1: { output: { body: 'hello world' } } } };
    assert.equal(evaluate('steps.s1.output.body.length', state), 11);
    assert.equal(evaluate('steps.s1.output.body.length > 5', state), true);
    assert.equal(evaluate('steps.s1.output.body[0]', state), 'h');
    // …and the prototype chain stays shut on primitives.
    assert.equal(evaluate('steps.s1.output.body.toUpperCase', state), undefined);
    assert.equal(evaluate('steps.s1.output.body["constructor"]', state), undefined);
    assert.equal(evaluate('steps.s1.output.body.__proto__', state), undefined);
});

// ── The scientific-maths surface ───────────────────────────────────────────
// WHY THIS EXISTS: an App Studio user asked the builder for an "advanced
// calculator". It could not be built — the whitelist had no pow/sqrt/ln/log/
// trig, no ^ operator and no π/e — and nothing in the product said so, so the
// AI invented an architectural excuse instead. These tests pin the fix, and
// (more importantly) pin the TOTALITY rule that lets a keypad app divide by
// zero or take the root of a negative without painting "NaN" on the screen.

// Every name added for that fix. Keeping the list literal (rather than
// deriving it) means dropping a function is a test failure, not a silent
// regression in the builder's vocabulary.
const MATH_NAMES = [
    'PI', 'E', 'pow', 'sqrt', 'cbrt', 'exp', 'ln', 'log10', 'log',
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
    'degrees', 'radians', 'sign', 'trunc', 'mod', 'hypot', 'factorial',
];

test('every maths name is callable and documented for the syntax-help panel', () => {
    const documented = new Set(EXPR_FUNCTIONS.map((f) => f.name));
    for (const name of MATH_NAMES) {
        assert.equal(typeof FUNCTIONS[name], 'function', `FUNCTIONS.${name} missing`);
        assert.ok(EXPR_FUNCTION_NAMES.includes(name), `EXPR_FUNCTION_NAMES missing ${name}`);
        assert.ok(documented.has(name), `EXPR_FUNCTIONS has no entry for ${name}`);
    }
    // EXPR_FUNCTIONS and the whitelist must describe the SAME set — the FE
    // syntax-help spec asserts this too, but failing here names the culprit.
    assert.deepEqual([...documented].sort(), [...EXPR_FUNCTION_NAMES].sort());
});

// random() is the one function deliberately refused: this engine's contract is
// that the same expression + scope evaluates identically in Node and in the
// browser, and that a formula may be recomputed at any time without changing
// its answer. See the comment block in functions.mjs.
test('random() is NOT in the whitelist — nondeterminism is refused by design', () => {
    for (const name of ['random', 'rand', 'now', 'today', 'uuid']) {
        assert.equal(FUNCTIONS[name], undefined, `${name} must not be callable`);
    }
    assert.throws(() => parseExpr('random()'), /Unknown function/);
});

// TOTALITY: the property the UI depends on. Not one maths helper may throw,
// and not one may hand back NaN or ±Infinity — those render as the literal
// text "NaN"/"Infinity" in a stat and poison every node downstream.
test('no maths helper throws, or returns NaN/Infinity, for any degenerate input', () => {
    const NASTY = [
        null, undefined, '', '   ', 'abc', NaN, Infinity, -Infinity,
        0, -0, 1, -1, 0.5, -0.5, 2, 1e308, -1e308, 1e-320,
        true, false, [], [1, 2], {}, { a: 1 }, '0', '-1', '1e309',
    ];
    for (const name of MATH_NAMES) {
        const fn = FUNCTIONS[name];
        for (const a of NASTY) {
            for (const b of NASTY) {
                let out;
                assert.doesNotThrow(() => { out = fn(a, b); }, `${name}(${String(a)}, ${String(b)}) threw`);
                if (typeof out === 'number') {
                    assert.ok(Number.isFinite(out), `${name}(${String(a)}, ${String(b)}) returned ${out}`);
                }
            }
        }
    }
});

test('degenerate maths inputs return null — the engine\'s one "no value" signal', () => {
    // Domain errors, poles and overflows all collapse to the same null, so a
    // downstream `ifNull(…, 0)` or a blank stat is the whole error handling a
    // no-code author has to write.
    for (const expr of [
        'sqrt(-1)', 'ln(0)', 'ln(-1)', 'log10(0)', 'log(4, 1)', 'pow(0, -1)',
        'pow(2, 10000)', 'exp(1000)', 'asin(2)', 'acos(-2)', 'factorial(-1)',
        'factorial(1000000000)', 'factorial(2.5)', 'mod(1, 0)', 'hypot()',
        'sqrt("abc")', 'pow(missing.x, 2)', 'cbrt(missing.x)', 'sign(missing.x)',
    ]) {
        assert.equal(evaluate(expr, SCOPE), null, `expected null from ${expr}`);
    }
});

test('^ precedence: right-associative, and tighter than unary minus', () => {
    // The two answers a formula language has to commit to. Both match Python;
    // JS refuses to choose and makes `-2 ** 2` a syntax error, which is not an
    // option for a field a non-programmer types into.
    assert.equal(evaluate('2 ^ 3 ^ 2', {}), 512);   // 2^(3^2) — NOT (2^3)^2 = 64
    assert.equal(evaluate('-2 ^ 2', {}), -4);       // -(2^2)  — NOT (-2)^2 = 4
    assert.equal(evaluate('(-2) ^ 2', {}), 4);
    assert.equal(evaluate('2 ^ -2', {}), 0.25);
    assert.equal(evaluate('2 * 3 ^ 2', {}), 18);
    assert.equal(evaluate('-2 ^ 2 ^ 3', {}), -256); // -(2^(2^3))
    // The operator is literally pow(), so it cannot drift from the function.
    assert.equal(evaluate('2 ^ 10', {}), FUNCTIONS.pow(2, 10));
    assert.equal(evaluate('2 ^ 10000', {}), null);
    assert.equal(evaluate('"x" ^ 2', {}), null);
});

test('the constants are zero-argument CALLS, not scope roots', () => {
    // Decision: PI()/E() are whitelist entries. A bare `PI` is a scope path in
    // this grammar, so making them roots would mean injecting them into every
    // scope in three runtimes AND teaching validate.js about them; as calls
    // nothing else in the system has to change, and no scope key can shadow
    // them. `compile()` — the exact call validate.js makes — proves it: a
    // formula using them references NO roots at all, so it cannot ever trip
    // the "unknown formula root" warning.
    assert.equal(evaluate('PI()', {}), Math.PI);
    assert.equal(evaluate('E()', {}), Math.E);
    assert.deepEqual(compile('round(PI() * pow(form.r, 2), 2)').refs, ['form']);
    assert.deepEqual(compile('degrees(atan2(E(), PI()))').refs, []);
    // A bare `PI` stays an ordinary (unset) path — no silent constant.
    assert.equal(evaluate('PI', {}), undefined);
    assert.equal(evaluate('PI', { PI: 3 }), 3);
});

test('a scientific formula compiles the way validate.js compiles it', () => {
    // validateFormula() in server/appStudio/validate.js does exactly this:
    // compile() for the syntax check, then checks the referenced ROOTS. A
    // formula built from the new vocabulary has to survive both halves.
    const expr = 'round(sqrt(pow(form.a, 2) + pow(form.b, 2)) * sin(radians(form.angle)), 4)';
    const { refs } = compile(expr);
    assert.deepEqual(refs, ['form']);
    assert.equal(evaluate(expr, { form: { a: 3, b: 4, angle: 90 } }), 5);
    // …and the `^` spelling of the same thing.
    assert.equal(evaluate('round(sqrt(form.a ^ 2 + form.b ^ 2), 4)', { form: { a: 3, b: 4 } }), 5);
});

test('the binding resolver agrees with the engine on string members', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { walkPath } = require('../../automation/bind.js');
    const state = { steps: { s1: { output: { body: 'hello world' } } } };
    for (const path of ['steps.s1.output.body.length', 'steps.s1.output.body[0]', 'steps.s1.output.body.toUpperCase']) {
        assert.deepEqual(evaluate(path, state), walkPath(path, state), `path: ${path}`);
    }
});

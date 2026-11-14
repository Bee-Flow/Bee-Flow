// @typecheck strict
/**
 * utils/envNumber.mts: numeric settings from the environment.
 *
 * Every test uses its own variable name, so the once-per-name warning of one
 * test does not hide the warning another test looks for.
 *
 * Run: cd server && node --test utils/envNumber.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { envInt, envNumber } = require('./envNumber.mts');

let seq = 0;
/** A fresh variable name, set to `value` (or left unset for undefined). */
function setVar(/** @type {string | undefined} */ value, prefix = 'BF_ENVNUM_TEST') {
    seq += 1;
    const name = `${prefix}_${seq}`;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return name;
}

/** The console.warn calls made while `fn` runs (log.js writes to the console outside production). */
function warnsDuring(/** @type {import('node:test').TestContext} */ t, /** @type {() => void} */ fn) {
    const warn = t.mock.method(console, 'warn', () => {});
    fn();
    const calls = warn.mock.calls.map((c) => String(c.arguments[0]));
    warn.mock.restore();
    return calls;
}

test('unset and empty give the default without a warning', (t) => {
    const unset = setVar(undefined);
    const empty = setVar('');
    const blank = setVar('   ');
    const warns = warnsDuring(t, () => {
        assert.strictEqual(envInt(unset, 30), 30);
        assert.strictEqual(envInt(empty, 30, { min: 1 }), 30);
        assert.strictEqual(envNumber(blank, 0.5), 0.5);
    });
    assert.deepStrictEqual(warns, []);
});

test('a valid value is used as given', (t) => {
    const a = setVar('120');
    const b = setVar(' 45 ');
    const c = setVar('0.25');
    const warns = warnsDuring(t, () => {
        assert.strictEqual(envInt(a, 30, { min: 1 }), 120);
        assert.strictEqual(envInt(b, 30), 45);
        assert.strictEqual(envNumber(c, 0.6, { positive: true }), 0.25);
    });
    assert.deepStrictEqual(warns, []);
});

test('0 is used when there is no lower bound or min is 0', (t) => {
    const a = setVar('0');
    const b = setVar('0');
    const warns = warnsDuring(t, () => {
        assert.strictEqual(envInt(a, 300_000), 0);
        assert.strictEqual(envInt(b, 300_000, { min: 0 }), 0);
    });
    assert.deepStrictEqual(warns, []);
});

test('0 falls back to the default, with a warning, under min: 1 or positive', (t) => {
    const a = setVar('0');
    const b = setVar('0');
    const warns = warnsDuring(t, () => {
        assert.strictEqual(envInt(a, 60, { min: 1 }), 60);
        assert.strictEqual(envNumber(b, 0.6, { positive: true }), 0.6);
    });
    assert.strictEqual(warns.length, 2);
    assert.match(warns[0], new RegExp(`${a}="0" is not an integer at least 1; using the default 60`));
    assert.match(warns[1], /is not a number above 0; using the default 0\.6/);
});

test('garbage gives the default and names the variable and the rejected value', (t) => {
    const a = setVar('60rpm');
    const b = setVar('abc');
    const c = setVar('1.5');
    const warns = warnsDuring(t, () => {
        assert.strictEqual(envInt(a, 60, { min: 1 }), 60);
        assert.strictEqual(envNumber(b, 25), 25);
        assert.strictEqual(envInt(c, 10), 10, 'a fraction is not an integer');
    });
    assert.strictEqual(warns.length, 3);
    assert.ok(warns[0].includes(`${a}="60rpm"`), warns[0]);
    assert.ok(warns[1].includes(`${b}="abc" is not a number`), warns[1]);
    assert.ok(warns[2].includes(`${c}="1.5" is not an integer`), warns[2]);
});

test('a value outside min/max gives the default', (t) => {
    const low = setVar('-5');
    const high = setVar('5000');
    const warns = warnsDuring(t, () => {
        assert.strictEqual(envInt(low, 4, { min: 1 }), 4);
        assert.strictEqual(envInt(high, 100, { min: 1, max: 1000 }), 100);
    });
    assert.strictEqual(warns.length, 2);
    assert.ok(warns[1].includes('at least 1 and at most 1000'), warns[1]);
});

test('the warning is given once per name', (t) => {
    const name = setVar('nope');
    const warns = warnsDuring(t, () => {
        for (let i = 0; i < 3; i++) assert.strictEqual(envInt(name, 7), 7);
    });
    assert.strictEqual(warns.length, 1);
});

test('the value of a secret-looking name is never logged', (t) => {
    const name = setVar('12x-ignored', 'BF_ENVNUM_TEST_API_TOKEN');
    const warns = warnsDuring(t, () => {
        assert.strictEqual(envInt(name, 7), 7);
    });
    assert.strictEqual(warns.length, 1);
    assert.ok(!warns[0].includes('12x-ignored'), warns[0]);
    assert.ok(warns[0].includes(name), warns[0]);
});

test('it never throws', () => {
    const name = setVar('\u0000');
    assert.doesNotThrow(() => envInt(name, 1, { min: 1 }));
    assert.doesNotThrow(() => envNumber(setVar('Infinity'), 1));
});

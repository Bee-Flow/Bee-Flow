'use strict';
/**
 * errorShape — what of a thrown error may be written down: the class and the
 * code, never the message (which can quote a row value).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { errorShape, errorLabel, stackFrames } = require('./errorShape');

const pgError = () => Object.assign(
    new Error('duplicate key value violates unique constraint\nDETAIL: Key (email)=(jan@example.com) already exists.'),
    { code: '23505' },
);

test('errorShape keeps the class and the SQLSTATE, never the message', () => {
    assert.deepStrictEqual(errorShape(pgError()), { name: 'Error', code: '23505' });
    assert.deepStrictEqual(errorShape(new TypeError('x of undefined')), { name: 'TypeError', code: null });
});

test('errorShape copes with values that are not errors', () => {
    assert.deepStrictEqual(errorShape(null), { name: 'Error', code: null });
    assert.deepStrictEqual(errorShape('a string'), { name: 'Error', code: null });
    assert.deepStrictEqual(errorShape({ name: 'X', code: { nested: 'jan@example.com' } }), { name: 'X', code: null },
        'a code that is not a string or number is dropped, not stringified');
});

test('errorLabel names the class and the code', () => {
    assert.strictEqual(errorLabel(pgError()), 'Error (code 23505)');
    assert.strictEqual(errorLabel(new RangeError('jan@example.com')), 'RangeError');
});

test('stackFrames keeps the "at" lines and drops every line of a multi-line message', () => {
    const frames = stackFrames(pgError());
    assert.ok(frames.length > 0, 'the frames are kept');
    assert.ok(frames.split('\n').every(l => /^\s+at\s/.test(l)));
    assert.ok(!frames.includes('jan@example.com') && !frames.includes('duplicate key'));
    assert.strictEqual(stackFrames(null), '');
});

test('stackFrames drops a message line that is shaped like a frame', () => {
    const e = new Error('lookup failed\n    at jan@example.com (users.email)');
    const frames = stackFrames(e);
    assert.ok(frames.length > 0, 'the real frames are kept');
    assert.ok(!frames.includes('jan@example.com'));
});

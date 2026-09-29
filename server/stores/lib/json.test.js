/**
 * DB-free unit test for stores/lib/json.js (M6).
 * Run: cd server && node --test --test-force-exit --test-timeout=30000 stores/lib/json.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { parseJSON, parseJSONObject, fromJsonb, safeParse } = require('./json');

test('parseJSON: array/object hydrated by pg passes through unchanged (same ref)', () => {
    const arr = [1, 2]; const obj = { a: 1 };
    assert.strictEqual(parseJSON(arr, null), arr);
    assert.strictEqual(parseJSON(obj, null), obj);
});

test('parseJSON: valid JSON string is parsed', () => {
    assert.deepEqual(parseJSON('{"a":1}', null), { a: 1 });
    assert.deepEqual(parseJSON('[1,2,3]', []), [1, 2, 3]);
});

test('parseJSON: invalid JSON string returns fallback', () => {
    assert.deepEqual(parseJSON('{not json', { def: true }), { def: true });
    assert.equal(parseJSON('nope', 'FB'), 'FB');
});

test('parseJSON: null/undefined return fallback via ?? tail', () => {
    assert.equal(parseJSON(null, 'FB'), 'FB');
    assert.equal(parseJSON(undefined, 'FB'), 'FB');
});

test('parseJSON: non-string primitives use ?? tail (not fallback for falsy-but-present)', () => {
    // number/boolean are present (not null/undefined) → returned as-is
    assert.equal(parseJSON(0, 'FB'), 0);
    assert.equal(parseJSON(false, 'FB'), false);
});

test('fromJsonb: null-coalesces undefined to null, passes through everything else', () => {
    assert.equal(fromJsonb(undefined), null);
    assert.equal(fromJsonb(null), null);
    const o = { x: 1 };
    assert.strictEqual(fromJsonb(o), o);
    assert.equal(fromJsonb(0), 0);
    assert.equal(fromJsonb(''), '');
});

test('safeParse: parses or returns fallback (no object passthrough)', () => {
    assert.deepEqual(safeParse('{"a":1}', null), { a: 1 });
    assert.equal(safeParse('bad', 'FB'), 'FB');
    assert.equal(safeParse(undefined, 'FB'), 'FB'); // JSON.parse(undefined) throws → fallback
});

// ── parseJSONObject ───────────────────────────────────────────────────────────
// The twelve stores that used to carry their own copy split on one question:
// what does a column holding a bare scalar mean? Here it means "not the object
// or array this column should hold", so the caller gets its fallback.

test('parseJSONObject agrees with parseJSON on everything that is real data', () => {
    for (const v of [{ a: 1 }, [1, 2], '{"a":1}', '[1,2]', 'not json', null, undefined]) {
        assert.deepStrictEqual(
            parseJSONObject(v, 'FB'), parseJSON(v, 'FB'),
            `they must not diverge on ${JSON.stringify(v) ?? String(v)}`,
        );
    }
});

test('parseJSONObject answers a bare scalar with the fallback', () => {
    assert.strictEqual(parseJSONObject(0, 'FB'), 'FB');
    assert.strictEqual(parseJSONObject(7, 'FB'), 'FB');
    assert.strictEqual(parseJSONObject(false, 'FB'), 'FB');
    // …which is exactly where parseJSON differs: there a scalar is data.
    assert.strictEqual(parseJSON(0, 'FB'), 0);
    assert.strictEqual(parseJSON(7, 'FB'), 7);
});

test('parseJSONObject passes an empty object and an empty array through', () => {
    const empty = {};
    assert.strictEqual(parseJSONObject(empty, 'FB'), empty, 'no falsiness test on an object');
    assert.deepStrictEqual(parseJSONObject([], 'FB'), []);
});

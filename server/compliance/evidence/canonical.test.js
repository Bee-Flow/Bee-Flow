/**
 * canonicalJSON must be a function of the VALUE, stable across the Postgres
 * JSONB round-trip: key order, number spelling, whitespace and `undefined`
 * must not change the digest. These tests pin that contract — a change here
 * invalidates every stored payload_hash.
 *
 * Run: cd server && node --test --test-force-exit compliance/evidence/canonical.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { canonicalJSON, hashPayload, compareCodePoints } = require('./canonical');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// What node-postgres hands back for a JSONB column: the document re-parsed
// from Postgres' own printing of it (keys in JSONB order, numerics shortest).
function jsonbRoundTrip(value) {
    return JSON.parse(JSON.stringify(value));
}

test('object key order does not matter', () => {
    const a = canonicalJSON({ status: 'pass', details: 'ok', evidence: { b: 1, a: 2 } });
    const b = canonicalJSON({ evidence: { a: 2, b: 1 }, details: 'ok', status: 'pass' });
    assert.equal(a, b);
    assert.equal(a, '{"details":"ok","evidence":{"a":2,"b":1},"status":"pass"}');
});

test('keys sort by code point, not by UTF-16 code unit', () => {
    // U+FFFF is one code unit (0xFFFF); U+10000 is a surrogate pair whose first
    // unit is 0xD800 — code-unit order puts it FIRST, code-point order LAST.
    const s = canonicalJSON({ '\u{10000}': 1, '￿': 2, 'a': 3 });
    assert.equal(s, '{"a":3,"￿":2,"\u{10000}":1}');
    assert.ok(compareCodePoints('￿', '\u{10000}') < 0);
    assert.ok(compareCodePoints('b', 'a') > 0);
    assert.equal(compareCodePoints('ab', 'ab'), 0);
    assert.ok(compareCodePoints('a', 'ab') < 0, 'a prefix sorts before the longer string');
});

test('{a:1.0} and {a:1} canonicalise identically (JSONB prints numerics shortest)', () => {
    assert.equal(canonicalJSON({ a: 1.0 }), canonicalJSON({ a: 1 }));
    assert.equal(canonicalJSON({ a: 1.0 }), '{"a":1}');
    assert.equal(canonicalJSON({ a: 1e0 }), '{"a":1}');
    // A double whose shortest form is long survives the round-trip unchanged.
    assert.equal(canonicalJSON({ a: 0.1 + 0.2 }), '{"a":0.30000000000000004}');
    assert.equal(canonicalJSON({ a: 1e21 }), canonicalJSON(jsonbRoundTrip({ a: 1e21 })));
});

test('undefined properties are dropped; undefined in arrays becomes null', () => {
    assert.equal(canonicalJSON({ a: undefined, b: 1 }), '{"b":1}');
    assert.equal(canonicalJSON({ a: undefined, b: 1 }), canonicalJSON({ b: 1 }));
    assert.equal(canonicalJSON([1, undefined, 3]), '[1,null,3]');
    assert.equal(canonicalJSON({ fn() {}, b: 2 }), '{"b":2}');
});

test('Date becomes its ISO string, like the JSONB write path', () => {
    const d = new Date('2026-09-14T10:00:00.000Z');
    assert.equal(canonicalJSON({ at: d }), '{"at":"2026-09-14T10:00:00.000Z"}');
    assert.equal(canonicalJSON({ at: d }), canonicalJSON({ at: '2026-09-14T10:00:00.000Z' }));
});

test('NaN and Infinity become null; BigInt throws', () => {
    assert.equal(canonicalJSON({ a: NaN, b: Infinity, c: -Infinity }), '{"a":null,"b":null,"c":null}');
    assert.throws(() => canonicalJSON({ a: 10n }), TypeError);
});

test('unicode strings are preserved and escaped like JSON.stringify', () => {
    const v = { naam: 'Zoë — “Bee Flow” 🐝', pad: 'a/b\\c\n"q"' };
    const s = canonicalJSON(v);
    assert.equal(JSON.parse(s).naam, v.naam);
    assert.equal(JSON.parse(s).pad, v.pad);
    assert.equal(s, canonicalJSON(jsonbRoundTrip(v)));
    // Non-NFC input stays non-NFC on both sides: stable, but not equivalent to NFC.
    assert.notEqual(canonicalJSON({ s: 'é' }), canonicalJSON({ s: 'é' }));
});

test('nested arrays keep element order and canonicalise their objects', () => {
    const v = { rows: [[{ z: 1, a: 2 }, { b: [3, { y: 1, x: 2 }] }], []], n: null, t: true };
    assert.equal(canonicalJSON(v), '{"n":null,"rows":[[{"a":2,"z":1},{"b":[3,{"x":2,"y":1}]}],[]],"t":true}');
    assert.notEqual(canonicalJSON({ a: [1, 2] }), canonicalJSON({ a: [2, 1] }), 'array order is significant');
});

test('scalars and empties at the top level', () => {
    assert.equal(canonicalJSON(null), 'null');
    assert.equal(canonicalJSON(undefined), 'null');
    assert.equal(canonicalJSON('x'), '"x"');
    assert.equal(canonicalJSON(3), '3');
    assert.equal(canonicalJSON({}), '{}');
    assert.equal(canonicalJSON([]), '[]');
    assert.equal(canonicalJSON(-0), '0');
});

test('the canonical form is idempotent across a simulated JSONB round-trip', () => {
    // The runner's evidence payload shape, with the traps that broke the old
    // recompute: key order, trailing .0, a Date, an undefined field.
    const written = {
        status: 'warn',
        evidence: { rows_30d: 12.0, latest_captured_at: new Date('2026-09-14T09:12:00Z'), sample: [3, 1, 2] },
        details: undefined,
        run_type: 'scheduled',
        subject: null,
    };
    // JSONB stores the document; a reader gets a fresh object with JSONB key order.
    const stored = jsonbRoundTrip(written);
    const reordered = { subject: stored.subject, run_type: stored.run_type, evidence: { sample: stored.evidence.sample, latest_captured_at: stored.evidence.latest_captured_at, rows_30d: 12 }, status: stored.status };
    assert.equal(canonicalJSON(written), canonicalJSON(reordered));
    assert.equal(hashPayload(written), hashPayload(reordered));
});

test('hashPayload is sha256 over the canonical form; falsy payloads hash as {}', () => {
    assert.equal(hashPayload({ b: 1, a: 2 }), sha256('{"a":2,"b":1}'));
    assert.match(hashPayload({ x: 1 }), /^[0-9a-f]{64}$/);
    assert.equal(hashPayload(null), sha256('{}'));
    assert.equal(hashPayload(undefined), sha256('{}'));
    assert.equal(hashPayload({}), sha256('{}'));
    // Tampering with a value changes the digest.
    assert.notEqual(hashPayload({ status: 'pass' }), hashPayload({ status: 'fail' }));
});

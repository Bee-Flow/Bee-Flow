'use strict';
/**
 * Look-alike properties: same length and class at every position, never the
 * original, stable per key, different per org key, collision-free within a
 * set, keepFixed honoured only in its safe shape.
 *
 * Run: node --test core/privacy/customData/mask.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
    maskKeyFor, maskExample, maskExamples, hasMaskable, proposeKeepFixed, acceptedKeepFixed, keepFixedShapeOk,
} = require('./mask');

const KEY = Buffer.alloc(32, 7);
const OPTS = { key: KEY, orgId: 'org-a', typeId: 'cdt_0123456789' };

function classOf(ch) {
    if (/\p{Nd}/u.test(ch)) return 'digit';
    if (/\p{Lu}/u.test(ch) || /\p{Lt}/u.test(ch)) return 'upper';
    if (/\p{L}/u.test(ch)) return 'lower';
    return `keep:${ch}`;
}

test('same code-point length and class at every position, and every maskable character changes', () => {
    for (const value of ['KL-12345', 'Falcon', 'Émile-Zola 7', 'abc.DEF/123', 'x', 'ÄÖÜ ßé', '中文42']) {
        const out = maskExample(value, OPTS);
        const a = Array.from(value);
        const b = Array.from(out);
        assert.equal(b.length, a.length, value);
        a.forEach((ch, i) => {
            const cls = classOf(ch);
            if (cls.startsWith('keep:')) {
                assert.equal(b[i], ch, `${value}[${i}] kept`);
            } else {
                assert.equal(classOf(b[i]) === cls || (cls === 'lower' && /[a-z]/.test(b[i])), true, `${value}[${i}] class`);
                assert.notEqual(b[i], ch, `${value}[${i}] changed`);
            }
        });
        assert.notEqual(out, value);
    }
});

test('an upper-case letter never becomes its own ASCII fold', () => {
    for (let counter = 0; counter < 200; counter += 1) {
        assert.notEqual(maskExample('É', { ...OPTS, counter }), 'E');
        assert.notEqual(maskExample('ü', { ...OPTS, counter }), 'u');
    }
});

test('deterministic per key, and a different key gives different look-alikes', () => {
    assert.equal(maskExample('KL-12345', OPTS), maskExample('KL-12345', OPTS));
    const other = { ...OPTS, key: Buffer.alloc(32, 8) };
    const same = ['KL-12345', 'Falcon', 'AB-998877'].filter((v) => maskExample(v, OPTS) === maskExample(v, other));
    assert.deepEqual(same, []);
});

test('the key is HKDF of the master key per org', () => {
    const k1 = maskKeyFor('org-a', { master: 'm'.repeat(64) });
    const k2 = maskKeyFor('org-b', { master: 'm'.repeat(64) });
    assert.equal(k1.length, 32);
    assert.notDeepEqual(k1, k2);
    assert.deepEqual(k1, Buffer.from(crypto.hkdfSync('sha256', 'm'.repeat(64), 'org-a', 'beeflow:custom-data-mask:v1', 32)));
    assert.throws(() => maskKeyFor('org-a', { master: '' }), /MASTER_ENCRYPTION_KEY/);
});

test('long values draw from a stream longer than one HMAC block', () => {
    const value = '1234567890'.repeat(10);
    const out = maskExample(value, OPTS);
    assert.equal(out.length, 100);
    assert.ok(Array.from(out).every((ch, i) => /\d/.test(ch) && ch !== value[i]));
});

test('a set of look-alikes never collides and never equals or contains a real example', () => {
    // Two-digit values: a look-alike of one is very likely to be another real
    // one unless the re-draw works.
    const examples = Array.from({ length: 10 }, (_, i) => String(10 + i * 9));
    const pairs = maskExamples(examples, OPTS);
    const looks = pairs.map((p) => p.lookalike);
    assert.ok(looks.every(Boolean));
    assert.equal(new Set(looks).size, looks.length);
    for (const l of looks) assert.ok(!examples.includes(l), l);

    const longer = ['ABC-123', 'abc-124', 'XYZ-900'];
    for (const { lookalike } of maskExamples(longer, OPTS)) {
        for (const ex of longer) assert.ok(!lookalike.toLowerCase().includes(ex.toLowerCase()));
    }
});

test('an example with nothing maskable gets no look-alike', () => {
    const pairs = maskExamples(['---', 'KL-1'], OPTS);
    assert.equal(pairs[0].lookalike, null);
    assert.ok(pairs[1].lookalike);
    assert.equal(hasMaskable('KL-', ['KL-']), false);
});

test('keepFixed keeps the fixed part and masks the rest', () => {
    const out = maskExample('KL-12345', { ...OPTS, keepFixed: ['KL-'] });
    assert.ok(out.startsWith('KL-'));
    assert.notEqual(out.slice(3), '12345');
    assert.match(out, /^KL-\d{5}$/);
});

test('keepFixed proposal: pattern only, shared prefix/suffix, at most 4 letters', () => {
    assert.deepEqual(proposeKeepFixed(['KL-12345', 'KL-99812'], 'pattern'), ['KL-']);
    assert.deepEqual(proposeKeepFixed(['KL-12345', 'KL-99812'], 'ai'), []);
    assert.deepEqual(proposeKeepFixed(['KL-12345', 'KL-99812'], 'words'), []);
    assert.deepEqual(proposeKeepFixed(['KL-12345'], 'pattern'), []);
    assert.deepEqual(proposeKeepFixed(['ABCDE-1', 'ABCDE-2'], 'pattern'), []);
    assert.deepEqual(proposeKeepFixed(['12-NL', '99-NL'], 'pattern'), ['-NL']);
    assert.deepEqual(proposeKeepFixed(['12', '34'], 'pattern'), []);
});

test('keepFixed sent by a client is accepted only in its safe shape', () => {
    const ex = ['KL-12345', 'KL-99812'];
    assert.deepEqual(acceptedKeepFixed(['KL-'], ex, 'pattern'), ['KL-']);
    assert.deepEqual(acceptedKeepFixed(['KL-'], ex, 'ai'), []);
    assert.deepEqual(acceptedKeepFixed(['KL-12345'], ex, 'pattern'), [], 'a whole value is never fixed');
    assert.deepEqual(acceptedKeepFixed(['Falcon'], ['Falcon1', 'Falcon2'], 'pattern'), [], 'more than 4 letters');
    assert.deepEqual(acceptedKeepFixed(['XY-'], ex, 'pattern'), [], 'not shared by the examples');
    assert.equal(keepFixedShapeOk('12'), false);
    assert.equal(keepFixedShapeOk('KL-'), true);
});

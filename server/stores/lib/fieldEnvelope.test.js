const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
    isEnvelope, buildEnvelope, openEnvelope,
    encryptField, decryptField, FieldDecryptError,
} = require('./fieldEnvelope');

const KEY = crypto.createHash('sha256').update('field-envelope-test-key').digest();
const OTHER_KEY = crypto.createHash('sha256').update('a-different-key').digest();
const AAD = 'msg:conv-1:u-1';

test('round-trips a string', () => {
    const env = buildEnvelope('hello world', KEY, AAD);
    assert.strictEqual(openEnvelope(env, KEY, AAD), 'hello world');
});

test('ciphertext does not contain the plaintext', () => {
    const env = buildEnvelope('super secret salary figure', KEY, AAD);
    assert.ok(!JSON.stringify(env).includes('salary'), 'plaintext must not survive in the envelope');
});

test('each encryption uses a fresh IV', () => {
    const a = buildEnvelope('same input', KEY, AAD);
    const b = buildEnvelope('same input', KEY, AAD);
    assert.notStrictEqual(a.iv, b.iv, 'IV reuse under one key breaks GCM');
    assert.notStrictEqual(a.ct, b.ct);
});

test('wrong key fails loudly rather than returning junk', () => {
    const env = buildEnvelope('x', KEY, AAD);
    assert.throws(() => openEnvelope(env, OTHER_KEY, AAD), FieldDecryptError);
});

test('wrong AAD fails loudly (context binding holds)', () => {
    const env = buildEnvelope('x', KEY, AAD);
    assert.throws(() => openEnvelope(env, KEY, 'msg:conv-2:u-1'), FieldDecryptError);
});

test('tampered ciphertext fails loudly', () => {
    const env = buildEnvelope('x', KEY, AAD);
    const flipped = env.ct.startsWith('a') ? 'b' + env.ct.slice(1) : 'a' + env.ct.slice(1);
    assert.throws(() => openEnvelope({ ...env, ct: flipped }, KEY, AAD), FieldDecryptError);
});

// ── Format detection ────────────────────────────────────────────────────────
// These are what make a config flip safe. Reads must key off the value, never
// off the current setting.

test('isEnvelope recognises objects and JSON strings, rejects ordinary text', () => {
    const env = buildEnvelope('x', KEY, AAD);
    assert.strictEqual(isEnvelope(env), true, 'object form');
    assert.strictEqual(isEnvelope(JSON.stringify(env)), true, 'string form');

    for (const notEnv of [
        'just a chat message',
        '{"role":"user","content":"hi"}',
        '[]',
        '',
        null,
        undefined,
        42,
        '{ this is not json',
        JSON.stringify({ _bfenc: 99, ct: 'x' }),   // wrong version
        JSON.stringify({ _bfenc: 1 }),             // no ciphertext
    ]) {
        assert.strictEqual(isEnvelope(notEnv), false, `should not be an envelope: ${String(notEnv).slice(0, 30)}`);
    }
});

test('a message that merely mentions the marker is not treated as an envelope', () => {
    const decoy = JSON.stringify({ role: 'user', content: 'what does _bfenc mean?' });
    assert.strictEqual(isEnvelope(decoy), false);
    assert.strictEqual(decryptField(decoy, { key: KEY, aad: AAD }), decoy);
});

// ── Toggle semantics ────────────────────────────────────────────────────────

test('encryption OFF stores plaintext unchanged', () => {
    const out = encryptField('plain body', { key: KEY, aad: AAD, encrypt: false });
    assert.strictEqual(out, 'plain body');
});

test('no key means plaintext even when policy says encrypt', () => {
    const out = encryptField('plain body', { key: null, aad: AAD, encrypt: true });
    assert.strictEqual(out, 'plain body', 'must never emit an unopenable value');
});

test('null/undefined pass through both ways', () => {
    for (const v of [null, undefined]) {
        assert.strictEqual(encryptField(v, { key: KEY, aad: AAD, encrypt: true }), v);
        assert.strictEqual(decryptField(v, { key: KEY, aad: AAD }), v);
    }
});

test('turning encryption ON leaves older plaintext rows readable', () => {
    // Row written before the switch.
    const legacy = 'written while encryption was off';
    // Read after the switch — same key context now available.
    assert.strictEqual(decryptField(legacy, { key: KEY, aad: AAD }), legacy);
});

test('turning encryption OFF leaves older encrypted rows readable', () => {
    const written = encryptField('written while encryption was on', { key: KEY, aad: AAD, encrypt: true });
    assert.ok(isEnvelope(written));
    // Policy now says off; the read path still opens it because the VALUE is an envelope.
    assert.strictEqual(decryptField(written, { key: KEY, aad: AAD }), 'written while encryption was on');
});

test('mixed table: encrypted and plaintext rows both read correctly', () => {
    const rows = [
        encryptField('row A', { key: KEY, aad: AAD, encrypt: true }),
        'row B',
        encryptField('row C', { key: KEY, aad: AAD, encrypt: true }),
        'row D',
    ];
    const read = rows.map(r => decryptField(r, { key: KEY, aad: AAD }));
    assert.deepStrictEqual(read, ['row A', 'row B', 'row C', 'row D']);
});

test('an envelope with no key available throws instead of yielding empty', () => {
    const written = encryptField('secret', { key: KEY, aad: AAD, encrypt: true });
    assert.throws(
        () => decryptField(written, { key: null, aad: AAD }),
        FieldDecryptError,
        'a missing key must not silently read as empty — that is how attachment sidecars get destroyed'
    );
});

test('asObject form is usable for JSONB columns', () => {
    const obj = encryptField('x', { key: KEY, aad: AAD, encrypt: true, asObject: true });
    assert.strictEqual(typeof obj, 'object', 'JSONB readers branch on typeof === object');
    assert.strictEqual(obj._bfenc, 1);
    assert.strictEqual(decryptField(obj, { key: KEY, aad: AAD }), 'x');
});

test('survives a JSONB round-trip through the driver (object -> string -> object)', () => {
    const obj = encryptField('pii map contents', { key: KEY, aad: AAD, encrypt: true, asObject: true });
    const asStoredByPg = JSON.parse(JSON.stringify(obj));
    assert.strictEqual(decryptField(asStoredByPg, { key: KEY, aad: AAD }), 'pii map contents');
});

test('handles multi-byte content without corruption', () => {
    const text = 'Beëindig de overeenkomst — €1.250,50 · 日本語 · 🐝';
    const env = buildEnvelope(text, KEY, AAD);
    assert.strictEqual(openEnvelope(env, KEY, AAD), text);
});

test('handles a large body', () => {
    const big = 'x'.repeat(200_000);
    assert.strictEqual(openEnvelope(buildEnvelope(big, KEY, AAD), KEY, AAD), big);
});

test('empty string round-trips and is distinguishable from null', () => {
    const env = encryptField('', { key: KEY, aad: AAD, encrypt: true });
    assert.strictEqual(decryptField(env, { key: KEY, aad: AAD }), '');
});

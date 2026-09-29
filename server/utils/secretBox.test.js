/**
 * Unit — secretBox AES-256-GCM (H12). DB-free. Proves round-trip, byte-level
 * compatibility with the old inline crypto (existing DB rows must still
 * decrypt), salt isolation, and that the scrypt key is derived only once.
 * Run: node --test utils/secretBox.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { createSecretBox } = require('./secretBox');

const SOURCE = 'a'.repeat(48); // stand-in for a >=32 char SESSION_SECRET
const SALT = 'support-inbox-salt';

// Faithful copy of the OLD inline implementation, to prove format compatibility.
function oldEncrypt(source, salt, tokens) {
    const key = crypto.scryptSync(source, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(JSON.stringify(tokens), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

test('round-trips an object', () => {
    const box = createSecretBox(SOURCE, SALT);
    const obj = { access_token: 'x', refresh_token: 'y', expiry: 123 };
    assert.deepStrictEqual(box.decrypt(box.encrypt(obj)), obj);
});

test('decrypts a blob produced by the OLD inline implementation (row compatibility)', () => {
    const box = createSecretBox(SOURCE, SALT);
    const legacyBlob = oldEncrypt(SOURCE, SALT, { a: 1, b: 'two' });
    assert.deepStrictEqual(box.decrypt(legacyBlob), { a: 1, b: 'two' });
});

test('old code can decrypt a blob produced by secretBox (format is byte-identical)', () => {
    const box = createSecretBox(SOURCE, SALT);
    const blob = box.encrypt({ hello: 'world' });
    // Decrypt with a fresh hand-rolled decipher using the same derivation.
    const key = crypto.scryptSync(SOURCE, SALT, 32);
    const [ivHex, tagHex, data] = blob.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    d.setAuthTag(Buffer.from(tagHex, 'hex'));
    let out = d.update(data, 'hex', 'utf8'); out += d.final('utf8');
    assert.deepStrictEqual(JSON.parse(out), { hello: 'world' });
});

test('emits the iv:tag:hex three-part format', () => {
    const box = createSecretBox(SOURCE, SALT);
    const parts = box.encrypt({ x: 1 }).split(':');
    assert.strictEqual(parts.length, 3);
    assert.strictEqual(parts[0].length, 32, '16-byte IV as hex');
    assert.strictEqual(parts[1].length, 32, '16-byte GCM tag as hex');
});

test('distinct salts do not cross-decrypt (compromise isolation preserved)', () => {
    const a = createSecretBox(SOURCE, 'support-inbox-salt');
    const b = createSecretBox(SOURCE, 'other-store-salt');
    assert.strictEqual(b.decrypt(a.encrypt({ secret: 1 })), null, 'wrong-salt box returns null, not the plaintext');
});

test('decrypt returns null (never throws) on tampered / malformed input', () => {
    const box = createSecretBox(SOURCE, SALT);
    assert.strictEqual(box.decrypt(null), null);
    assert.strictEqual(box.decrypt(''), null);
    assert.strictEqual(box.decrypt('garbage'), null);
    const blob = box.encrypt({ x: 1 });
    const tampered = blob.slice(0, -2) + (blob.endsWith('00') ? 'ff' : '00');
    assert.strictEqual(box.decrypt(tampered), null, 'auth-tag mismatch → null');
});

test('scrypt key is derived only once per box (memoized)', () => {
    let calls = 0;
    const realScrypt = crypto.scryptSync;
    crypto.scryptSync = (...args) => { calls += 1; return realScrypt(...args); };
    try {
        const box = createSecretBox(SOURCE, SALT);
        box.encrypt({ a: 1 });
        box.encrypt({ b: 2 });
        box.decrypt(box.encrypt({ c: 3 }));
        assert.strictEqual(calls, 1, 'scryptSync called once despite multiple ops');
    } finally {
        crypto.scryptSync = realScrypt;
    }
});

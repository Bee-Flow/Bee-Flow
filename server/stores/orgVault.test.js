/**
 * Unit tests for orgVault — per-org AES-256-GCM secret encryption.
 * Run: node stores/orgVault.test.js
 */

const assert = require('assert');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'test-master-key-for-unit-tests-32chars!!';

const vault = require('./orgVault');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('orgVault');

test('round-trips a string under the same org', () => {
    const env = vault.encrypt('hunter2', 'org-A');
    assert.strictEqual(typeof env, 'string');
    assert.strictEqual(vault.decrypt(env, 'org-A'), 'hunter2');
});

test('envelope is the shared routine-vault-v1 tag', () => {
    const env = JSON.parse(vault.encrypt('x', 'org-A'));
    assert.strictEqual(env._encrypted, 'routine-vault-v1');
    assert.ok(env.iv && env.authTag && env.data);
});

test('a different org cannot decrypt (per-org isolation)', () => {
    const env = vault.encrypt('secret', 'org-A');
    assert.strictEqual(vault.decrypt(env, 'org-B'), null);
});

test('tampered ciphertext fails auth → null', () => {
    const env = JSON.parse(vault.encrypt('secret', 'org-A'));
    env.data = (env.data[0] === 'a' ? 'b' : 'a') + env.data.slice(1);
    assert.strictEqual(vault.decrypt(JSON.stringify(env), 'org-A'), null);
});

test('empty / nullish input encrypts to null', () => {
    assert.strictEqual(vault.encrypt('', 'org-A'), null);
    assert.strictEqual(vault.encrypt(null, 'org-A'), null);
    assert.strictEqual(vault.encrypt(undefined, 'org-A'), null);
});

test('decrypt of junk / non-envelope returns null (no throw)', () => {
    assert.strictEqual(vault.decrypt('not json', 'org-A'), null);
    assert.strictEqual(vault.decrypt(JSON.stringify({ _encrypted: 'other' }), 'org-A'), null);
    assert.strictEqual(vault.decrypt(null, 'org-A'), null);
});

test('encryptJSON / decryptJSON round-trip an object', () => {
    const blob = { url: 'https://yt.example', token: 'abc123' };
    const env = vault.encryptJSON(blob, 'org-Z');
    assert.deepStrictEqual(vault.decryptJSON(env, 'org-Z'), blob);
});

// Seal with an explicit derivation label, independent of the module's code.
function sealWithLabel(label, plaintext, orgId) {
    const crypto = require('crypto');
    const key = crypto.createHmac('sha256', process.env.MASTER_ENCRYPTION_KEY).update(`${label}${orgId}`).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return JSON.stringify({ _encrypted: 'routine-vault-v1', iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') });
}

test('reads what every older release wrote (routine-vault label), so an upgrade keeps its org keys', () => {
    assert.strictEqual(vault.decrypt(sealWithLabel('beeflow:routine-vault:v1:org:', 'org-root', 'org-A'), 'org-A'), 'org-root');
});

test('writes with the routine-vault label, so an older release can still read it after a rollback', () => {
    const crypto = require('crypto');
    const env = JSON.parse(vault.encrypt('x', 'org-A'));
    const key = crypto.createHmac('sha256', process.env.MASTER_ENCRYPTION_KEY).update('beeflow:routine-vault:v1:org:org-A').digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(env.authTag, 'hex'));
    assert.strictEqual(decipher.update(Buffer.from(env.data, 'hex')) + decipher.final('utf8'), 'x');
});

test('still reads what the 2026-10-04 builds wrote under the automation-vault label', () => {
    assert.strictEqual(vault.decrypt(sealWithLabel('beeflow:automation-vault:v1:org:', 'written-in-between', 'org-A'), 'org-A'), 'written-in-between');
    assert.strictEqual(vault.decrypt(sealWithLabel('beeflow:automation-vault:v1:org:', 'x', 'org-A'), 'org-B'), null);
});

test('decryptJSON wrong org → null', () => {
    const env = vault.encryptJSON({ a: 1 }, 'org-Z');
    assert.strictEqual(vault.decryptJSON(env, 'org-Y'), null);
});

test('orgVaultKey requires an orgId', () => {
    assert.throws(() => vault.orgVaultKey(''), /orgId required/);
});

test('two encryptions of the same value differ (random IV)', () => {
    assert.notStrictEqual(vault.encrypt('same', 'org-A'), vault.encrypt('same', 'org-A'));
});

console.log(`\norgVault: ${passed} passed\n`);

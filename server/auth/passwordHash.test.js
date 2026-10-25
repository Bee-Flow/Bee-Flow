// @typecheck noImplicitAny
/**
 * auth/passwordHash.js: argon2id for every new login hash, bcrypt hashes that
 * already exist keep verifying, and needsRehash says which ones to upgrade.
 *
 * Run: cd server && node --test auth/passwordHash.test.js
 */
'use strict';

// These tests cover the opt-in argon2id write path; the default (bcrypt) is in
// passwordHash.rollout.test.js.
process.env.PASSWORD_HASH_ALGORITHM = 'argon2id';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const argon2 = require('argon2');
const passwords = require('./passwordHash');

test('hash() makes an argon2id hash with the OWASP baseline parameters', async () => {
    const h = await passwords.hash('correct horse battery staple');
    assert.match(h, /^\$argon2id\$v=19\$/);
    for (const part of ['m=19456', 't=2', 'p=1']) assert.ok(h.includes(part), `${part} missing from ${h}`);
    assert.equal(passwords.isArgon2Hash(h), true);
    assert.equal(passwords.isBcryptHash(h), false);
});

test('hash() salts: the same password never gives the same hash twice', async () => {
    assert.notEqual(await passwords.hash('same'), await passwords.hash('same'));
});

test('verify() accepts the right password and refuses a wrong one for argon2id', async () => {
    const h = await passwords.hash('Sunflower-42');
    assert.equal(await passwords.verify('Sunflower-42', h), true);
    assert.equal(await passwords.verify('sunflower-42', h), false);
});

test('verify() keeps accepting existing bcrypt hashes ($2a$ and $2b$, cost 10 and 12)', async () => {
    const b = await bcrypt.hash('Legacy-pass-1', 4); // bcryptjs writes $2b$
    assert.match(b, /^\$2b\$/);
    assert.equal(await passwords.verify('Legacy-pass-1', b), true);
    assert.equal(await passwords.verify('Legacy-pass-2', b), false);

    // A $2a$ hash as older bcryptjs versions wrote them.
    const a = b.replace(/^\$2b\$/, '$2a$');
    assert.equal(await passwords.verify('Legacy-pass-1', a), true);

    const cost12 = bcrypt.hashSync('Admin-Pass-12', 12);
    assert.equal(await passwords.verify('Admin-Pass-12', cost12), true);
});

test('verify() answers exactly what bcryptjs answered for a value that is no hash at all', async () => {
    assert.equal(await passwords.verify('x', 'not-a-hash'), await bcrypt.compare('x', 'not-a-hash'));
    assert.equal(await passwords.verify('x', ''), await bcrypt.compare('x', ''));
});

test('needsRehash(): bcrypt yes, current argon2id no, argon2 with other parameters yes', async () => {
    assert.equal(passwords.needsRehash(bcrypt.hashSync('pw', 4), 'pw'), true);
    assert.equal(passwords.needsRehash(await passwords.hash('pw'), 'pw'), false);
    const weaker = await argon2.hash('pw', { type: argon2.argon2id, memoryCost: 8192, timeCost: 1, parallelism: 1 });
    assert.equal(passwords.needsRehash(weaker, 'pw'), true);
    assert.equal(passwords.needsRehash('', 'pw'), false);
    assert.equal(passwords.needsRehash('not-a-hash', 'pw'), false);
});

test('needsRehash() leaves a bcrypt hash alone when the password is past bcrypt\'s 72 bytes', () => {
    // bcrypt compared only the first 72 bytes, so the submitted tail may differ
    // from the real one; re-hashing it would lock the real password out.
    const long = 'a'.repeat(80);
    const h = bcrypt.hashSync(long, 4);
    assert.equal(bcrypt.compareSync('a'.repeat(72) + 'DIFFERENT', h), true, 'bcrypt truncates');
    assert.equal(passwords.needsRehash(h, long), false);
    assert.equal(passwords.needsRehash(h, 'a'.repeat(72)), true);
    // 72 bytes counted as UTF-8, not characters.
    assert.equal(passwords.needsRehash(h, 'é'.repeat(37)), false);
});
